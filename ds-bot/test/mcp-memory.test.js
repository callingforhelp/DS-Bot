import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { MCP_TOOLS, MEMORY_MCP_TOOLS, SWARM_MCP_TOOLS, clientTools, toolsForClient } from '../src/host/mcp-server.js'
import { fakeContext } from './fake-ctx.js'

test('toolsForClient keeps legacy MCP_TOOLS unchanged and unlocks memory/swarm tools by ACL', () => {
  const legacy = toolsForClient({ id: 'c1', bots: ['a'], rooms: [] })
  assert.deepEqual(legacy.map(t => t.name), MCP_TOOLS.map(t => t.name))

  const readOnly = toolsForClient({ id: 'c2', bots: ['a'], rooms: [], memoryScopes: ['read'] })
  const readNames = new Set(readOnly.map(t => t.name))
  assert.equal(readNames.has('mem_search'), true)
  assert.equal(readNames.has('mem_context'), true)
  assert.equal(readNames.has('mem_ingest'), false)
  assert.equal(readNames.has('mem_code_search'), false)
  assert.equal(readNames.has('swarm_status'), false)

  const full = toolsForClient({ id: 'c3', bots: ['a'], rooms: [], memoryScopes: ['read', 'write', 'code', 'team'], swarmAccess: true })
  assert.equal(full.length, MCP_TOOLS.length + MEMORY_MCP_TOOLS.length + SWARM_MCP_TOOLS.length)
})

test('clientTools enforces memoryScopes, memoryMode, and swarmAccess ACLs', async () => {
  const calls = []
  const fakeRt = {
    state: { bots: {}, rooms: {}, questions: {}, views: {} },
    load: async () => {},
    botOf: () => undefined,
    roomOf: () => undefined,
    isMain: () => false,
    live: new Map(),
    hybridSearch: async (q) => { calls.push(['hybridSearch', q]); return [{ id: '1', text: 'hit' }] },
    codeSearch: async (q) => { calls.push(['codeSearch', q]); return [{ commitSha: 'abc1234' }] },
    ingestObservation: async (o) => { calls.push(['ingest', o]); return { ingested: true } },
    swarmsView: () => ({ sw1: { id: 'sw1', status: 'active' } }),
    artifactsView: () => ({ a1: { id: 'a1', title: 'Spec' } }),
  }

  const denied = clientTools(fakeRt, { id: 'c1', name: 'Legacy', bots: [], rooms: [] })
  await assert.rejects(() => denied('mem_search', { query: 'test' }), /lacks memory scope "read"/)
  await assert.rejects(() => denied('mem_ingest', { text: 'hello' }), /lacks memory scope "write"/)
  await assert.rejects(() => denied('mem_code_search', { commit: 'abc' }), /lacks memory scope "code"/)
  await assert.rejects(() => denied('swarm_status', {}), /does not have swarm access/)

  const incognito = clientTools(fakeRt, { id: 'c2', name: 'Incog', bots: [], rooms: [], memoryScopes: ['read', 'write'], memoryMode: 'incognito' })
  const searchRes = await incognito('mem_search', { query: 'sqlite' })
  assert.equal(searchRes.results.length, 1)
  const ingestRes = await incognito('mem_ingest', { text: 'should not save' })
  assert.deepEqual(ingestRes, { ingested: false, mode: 'incognito' })

  const silent = clientTools(fakeRt, { id: 'c3', name: 'Silent', bots: [], rooms: [], memoryScopes: ['read', 'write'], memoryMode: 'silent' })
  const silentSearch = await silent('mem_search', { query: 'sqlite' })
  assert.deepEqual(silentSearch, { results: [], mode: 'silent' })
  const silentIngest = await silent('mem_ingest', { text: 'save me' })
  assert.equal(silentIngest.ingested, true)

  const swarmClient = clientTools(fakeRt, { id: 'c4', name: 'Swarm', bots: [], rooms: [], memoryScopes: ['read', 'code'], swarmAccess: true })
  const sw = await swarmClient('swarm_status', { swarmId: 'sw1' })
  assert.equal(sw.swarm.id, 'sw1')
  const code = await swarmClient('mem_code_search', { commit: 'abc' })
  assert.equal(code.results.length, 1)
  const arts = await swarmClient('artifact_list', {})
  assert.equal(arts.artifacts.length, 1)
})

test('createRuntime installs all memory, artifact, and swarm modules cleanly', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-mcp-mem-'))
  try {
    const ctx = fakeContext()
    const rt = createRuntime(ctx, { home, memory: true })
    assert.equal(typeof rt.hybridSearch, 'function')
    assert.equal(typeof rt.codeSearch, 'function')
    assert.equal(typeof rt.ingestObservation, 'function')
    assert.equal(typeof rt.artifactsView, 'function')
    assert.equal(typeof rt.swarmsView, 'function')
    assert.equal(typeof rt.swarmToolsForSession, 'function')
    assert.equal(typeof rt.resolveMemoryMode, 'function')
    assert.deepEqual(rt.state.artifacts, {})
    assert.deepEqual(rt.state.swarms, {})
    assert.deepEqual(rt.state.sessionMemoryModes, {})
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
