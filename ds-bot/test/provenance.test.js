import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as memoryEmbeddings from '../src/host/memory-embeddings.js'
import * as memoryIndex from '../src/host/memory-index.js'
import * as memoryPrivacy from '../src/host/memory-privacy.js'
import * as provenance from '../src/host/provenance.js'

function createTestRuntime(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-prov-test-'))
  const disposers = []
  const listeners = new Map()
  const rt = {
    home,
    state: { prefs: {}, bots: { b1: { id: 'b1', name: 'Bot 1' } } },
    teamTools: [],
    selfOf: (sid) => (sid === 's1' ? 'b1' : undefined),
    workDirOf: () => '/repos/my-project',
    ctx: {
      on: (event, handler) => {
        const list = listeners.get(event) ?? []
        list.push(handler)
        listeners.set(event, list)
      },
      emit: (event, session, payload) => {
        for (const handler of listeners.get(event) ?? []) {
          handler(session, payload)
        }
      },
      effect: (fn) => {
        const cleanup = fn()
        if (typeof cleanup === 'function') disposers.push(cleanup)
      },
    },
    warn: () => {},
  }
  memoryPrivacy.install(rt)
  memoryEmbeddings.install(rt)
  memoryIndex.install(rt)
  provenance.install(rt)

  t.after(async () => {
    for (const d of disposers) await d()
    rmSync(home, { recursive: true, force: true })
  })
  return rt
}

test('extractGitSignals parses git outputs correctly', () => {
  const commitText = '[feat-branch 98bad02] add provenance tracking\n 2 files changed, 50 insertions(+)'
  const s1 = provenance.extractGitSignals(commitText)
  assert.equal(s1.commitSha, '98bad02')
  assert.equal(s1.branch, 'feat-branch')

  const prText = 'Created PR: https://github.com/my-org/my-repo/pull/42 successfully'
  const s2 = provenance.extractGitSignals(prText)
  assert.equal(s2.prUrl, 'https://github.com/my-org/my-repo/pull/42')
  assert.equal(s2.prNumber, 42)

  const statusText = 'On branch fix/bug-123\nYour branch is up to date'
  const s3 = provenance.extractGitSignals(statusText)
  assert.equal(s3.branch, 'fix/bug-123')

  const switchText = "Switched to branch 'develop'"
  const s4 = provenance.extractGitSignals(switchText)
  assert.equal(s4.branch, 'develop')

  const remoteText = 'origin  git@github.com:my-org/my-repo.git (fetch)'
  const s5 = provenance.extractGitSignals(remoteText)
  assert.equal(s5.repoRemote, 'github.com/my-org/my-repo')
})

test('provenance captures events and enables bot_code_search', async t => {
  const rt = createTestRuntime(t)

  // 1. Session workspace changes event
  rt.ctx.emit('session/event', { id: 's1' }, {
    type: 'workspace/changes',
    seq: 1,
    data: { turn: 1, files: ['src/index.js', 'src/utils.js'] },
  })

  // 2. Tool result with git signals
  rt.ctx.emit('session/event', { id: 's1' }, {
    type: 'tool/result',
    seq: 2,
    data: {
      message: {
        content: '[feat/new-ui a1b2c3d] Refactor UI components\nhttps://github.com/test/repo/pull/101',
      },
    },
  })

  // 3. Turn end triggers flush
  rt.ctx.emit('session/event', { id: 's1' }, {
    type: 'turn/end',
    seq: 3,
    data: { turn: 1 },
  })

  const results = rt.codeSearch({ commit: 'a1b2c3d' }, { botId: 'b1' })
  assert.ok(results.length > 0)
  assert.equal(results[0].commitSha, 'a1b2c3d')
  assert.equal(results[0].prNumber, 101)
  assert.ok(results[0].files.includes('src/index.js'))

  // Execute bot_code_search tool
  const tool = rt.teamTools.find((d) => d.name === 'bot_code_search')
  assert.ok(tool)
  const output = await tool.execute({ query: 'Refactor' }, { agent: { id: 's1' } })
  assert.match(output, /commit a1b2c3d/)
  assert.match(output, /PR https:\/\/github.com\/test\/repo\/pull\/101/)
})

test('provenance respects privacy mode and bot isolation', async t => {
  const rt = createTestRuntime(t)
  rt.selfOf = (sid) => (sid === 's-priv' ? 'b-priv' : 'b1')
  rt.botOf = (id) => (id === 'b-priv' ? { id: 'b-priv', private: true } : { id: 'b1' })

  // Record a private provenance entry
  rt.recordProvenance({
    botId: 'b-priv',
    sessionId: 's-priv',
    commitSha: 'priv123456',
    files: ['secrets.txt'],
    diffSummary: 'private work',
    isPrivate: true,
  })

  // b1 cannot see b-priv's private provenance
  const b1Results = rt.codeSearch({ commit: 'priv123456' }, { botId: 'b1' })
  assert.equal(b1Results.length, 0)

  // b-priv can see its own private provenance
  const privResults = rt.codeSearch({ commit: 'priv123456' }, { botId: 'b-priv' })
  assert.equal(privResults.length, 1)
  assert.equal(privResults[0].commitSha, 'priv123456')

  // When canWriteMemory returns false, recordProvenance returns null
  rt.canWriteMemory = () => false
  const blocked = rt.recordProvenance({
    botId: 'b1',
    sessionId: 's1',
    commitSha: 'blocked123',
    files: ['file.js'],
  })
  assert.equal(blocked, null)
})
