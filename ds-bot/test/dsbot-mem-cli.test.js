import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  openStore,
} from '../src/mem-cli/local-store.js'
import {
  callLocal,
} from '../src/mem-cli/mcp-bridge.js'
import {
  runHook,
} from '../src/mem-cli/hooks.js'
import {
  installAgent,
} from '../src/mem-cli/installer.js'
import {
  migrateMemory,
} from '../src/mem-cli/migrate.js'
import { runDoctor } from '../src/mem-cli/doctor.js'

test('local store: save, FTS search, provenance and library', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-mem-store-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const store = await openStore(dir)
  try {
    assert.equal(store.integrity(), 'ok')
    const saved = store.save({
      text: 'Architectural decision: Use WAL mode in SQLite for cross-agent memory.',
      topic: 'sqlite-arch',
      repo: 'ds-bot',
    })
    assert.equal(saved.created, true)
    assert.ok(saved.id > 0)

    // FTS search
    const hits = store.search('SQLite WAL')
    assert.ok(hits.length > 0)
    assert.equal(hits[0].topic, 'sqlite-arch')

    // Provenance
    const provId = store.linkProvenance({
      commit: 'abc1234',
      pr: 'https://github.com/deepseek-ai/ds-bot/pull/42',
      session: 'sess-1',
      repo: 'ds-bot',
      files: ['src/mem-cli/index.js'],
    })
    assert.ok(provId > 0)

    const codeHits = store.codeSearch('abc1234')
    assert.equal(codeHits.length, 1)
    assert.equal(codeHits[0].commit_sha, 'abc1234')

    // Library: skill & artifact
    store.libraryPut('skill', 'test-skill', '# Test Skill Body')
    const skill = store.libraryGet('skill', 'test-skill')
    assert.equal(skill.body, '# Test Skill Body')

    store.libraryPut('artifact', 'report', 'Report content')
    const art = store.libraryGet('artifact', 'report')
    assert.equal(art.body, 'Report content')

    // Swarm
    const noteId = store.swarmPost('swarm-1', 'Worker finished step 1', 'worker-a')
    assert.ok(noteId > 0)
    const notes = store.swarmRead('swarm-1')
    assert.equal(notes.length, 1)
    assert.equal(notes[0].author, 'worker-a')

    // Secret protection
    assert.throws(() => {
      store.save({ text: 'My secret token is sk-12345678901234567890' })
    }, /looks like a secret/)
  } finally {
    store.close()
  }
})

test('mcp bridge: callLocal offline tool execution', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-mem-mcp-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const store = await openStore(dir)
  try {
    const res = await callLocal(store, 'mem_save', { text: 'Memory via MCP', topic: 'mcp-test' })
    assert.equal(res.isError, undefined)
    const parsed = JSON.parse(res.content[0].text)
    assert.equal(parsed.created, true)

    const searchRes = await callLocal(store, 'mem_search', { query: 'MCP' })
    const hits = JSON.parse(searchRes.content[0].text)
    assert.ok(hits.length > 0)
  } finally {
    store.close()
  }
})

test('hook contracts: Antigravity nested systemMessage & Claude format', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-mem-hook-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const store = await openStore(dir)
  store.save({ text: 'Always verify repo HEAD before applying changes', topic: 'rules', repo: 'ds-bot' })
  store.close()

  // Antigravity SessionStart
  const agyRes = await runHook({
    agent: 'agy',
    event: 'SessionStart',
    payload: { conversationId: 'c1', cwd: '/workspace/ds-bot' },
    dir,
    spawnFlush: false,
  })
  assert.ok(agyRes.injectSteps, 'Antigravity SessionStart must return injectSteps')
  assert.ok(agyRes.injectSteps[0].systemMessage.systemMessage.includes('<dsbot-memory-context>'))

  // Antigravity PostToolUse must return empty object {}
  const agyPost = await runHook({
    agent: 'agy',
    event: 'PostToolUse',
    payload: { toolCall: { name: 'run_command', args: { CommandLine: 'git status' } } },
    dir,
    spawnFlush: false,
  })
  assert.deepEqual(agyPost, {})

  // Antigravity Stop must return empty object {} (never "decision":"continue")
  const agyStop = await runHook({
    agent: 'agy',
    event: 'Stop',
    payload: { conversationId: 'c1', transcriptPath: '/tmp/dummy.jsonl' },
    dir,
    spawnFlush: false,
  })
  assert.deepEqual(agyStop, {})
  assert.equal(agyStop.decision, undefined)
})

test('installer idempotency across all agents in temp directories', async (t) => {
  const tempHome = mkdtempSync(join(tmpdir(), 'dsbot-mem-install-test-'))
  t.after(() => rmSync(tempHome, { recursive: true, force: true }))

  const binPath = '/test/bin/dsbot-mem'
  const memDir = join(tempHome, '.ds-bot', 'mem')

  // Run install across all agents
  const agents = ['agy', 'claude', 'codex', 'cursor', 'grok', 'pi']
  for (const agent of agents) {
    installAgent(agent, { binPath, memDir, home: tempHome })
  }

  // Snapshot files
  const claudeSettings1 = readFileSync(join(tempHome, '.claude', 'settings.json'), 'utf8')
  const codexHooks1 = readFileSync(join(tempHome, '.codex', 'hooks.json'), 'utf8')
  const cursorHooks1 = readFileSync(join(tempHome, '.cursor', 'hooks.json'), 'utf8')

  // Run install a second time
  for (const agent of agents) {
    installAgent(agent, { binPath, memDir, home: tempHome })
  }

  // Verify byte identity (no duplicate hook entries)
  const claudeSettings2 = readFileSync(join(tempHome, '.claude', 'settings.json'), 'utf8')
  const codexHooks2 = readFileSync(join(tempHome, '.codex', 'hooks.json'), 'utf8')
  const cursorHooks2 = readFileSync(join(tempHome, '.cursor', 'hooks.json'), 'utf8')

  assert.equal(claudeSettings1, claudeSettings2, 'Claude settings must be idempotent')
  assert.equal(codexHooks1, codexHooks2, 'Codex hooks must be idempotent')
  assert.equal(cursorHooks1, cursorHooks2, 'Cursor hooks must be idempotent')
})

test('migrate-memory dry-run and secret screening', async (t) => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'dsbot-mem-mig-source-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'dsbot-mem-mig-state-'))
  t.after(() => {
    rmSync(sourceDir, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  })

  // Create test markdown files
  writeFileSync(join(sourceDir, 'MEMORY.md'), '# Index\n\n- [[test-topic]]\n')
  writeFileSync(
    join(sourceDir, 'test-topic.md'),
    '# Title\n\n## Section One\nNormal architectural notes.\n\n## Section Two\nContains key: sk-abcdefghijklmnopqrstuv\nAnd normal conclusion.\n',
  )

  const report = migrateMemory({ source: sourceDir, dir: stateDir, dryRun: true })
  assert.equal(report.dryRun, true)
  assert.equal(report.files.length, 2)
  assert.ok(report.secretLinesSkipped > 0, 'Secret line should be screened out')

  // Source files must be unchanged
  const content = readFileSync(join(sourceDir, 'test-topic.md'), 'utf8')
  assert.ok(content.includes('sk-abcdefghijklmnopqrstuv'), 'Source file must remain untouched')
})

test('doctor diagnostics', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-mem-doc-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const rep = await runDoctor({ dir })
  assert.ok(rep.sqlite.ok)
  assert.equal(rep.sqlite.integrity, 'ok')
})

test('mcp bridge: supports mem_ingest, mem_context, mem_mode offline aliases', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-mem-alias-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const store = await openStore(dir)
  try {
    const saved = await callLocal(store, 'mem_ingest', { text: 'Alias ingest fact', topic: 'alias', repo: 'ds-bot' }, { dir })
    assert.equal(saved.isError, undefined)
    const ctx = await callLocal(store, 'mem_context', { query: 'Alias', repo: 'ds-bot' }, { dir })
    assert.ok(JSON.parse(ctx.content[0].text).context.includes('Alias ingest fact'))
    const setMode = await callLocal(store, 'mem_mode', { mode: 'silent' }, { dir })
    assert.equal(JSON.parse(setMode.content[0].text).mode, 'silent')
  } finally {
    store.close()
  }
})
