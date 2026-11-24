import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as memoryEmbeddings from '../src/host/memory-embeddings.js'
import * as memoryIndex from '../src/host/memory-index.js'

function createTestRuntime(t, { embedder } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-mem-idx-test-'))
  const disposers = []
  const rt = {
    home,
    state: { prefs: {}, capabilities: { items: {} }, artifacts: {} },
    config: { disableAutoEmbed: true, ...(embedder ? { embedder } : {}) },
    ctx: {
      effect: (fn) => {
        const cleanup = fn()
        if (typeof cleanup === 'function') disposers.push(cleanup)
      },
    },
    warn: () => {},
  }
  memoryEmbeddings.install(rt)
  memoryIndex.install(rt)
  t.after(async () => {
    for (const d of disposers) await d()
    rmSync(home, { recursive: true, force: true })
  })
  return rt
}

test('memory-index initializes database and handles upsert and search', async t => {
  const rt = createTestRuntime(t)
  const id = rt.memoryIndexUpsert({
    id: 'doc:1',
    kind: 'memory',
    scopeKey: 'team',
    topic: 'architecture',
    title: 'Architecture Overview',
    body: 'The database uses SQLite FTS5 for full text retrieval.',
  })
  assert.equal(id, 'doc:1')

  const search = await rt.hybridSearch('SQLite')
  assert.equal(search.mode, 'lexical')
  assert.equal(search.hits.length, 1)
  assert.equal(search.hits[0].id, 'doc:1')
  assert.equal(search.hits[0].topic, 'architecture')

  // Search with empty query returns recent docs
  const recent = await rt.hybridSearch('')
  assert.equal(recent.mode, 'recent')
  assert.equal(recent.hits.length, 1)
  assert.equal(recent.hits[0].id, 'doc:1')
})

test('memory-index soft delete and restore', async t => {
  const rt = createTestRuntime(t)
  rt.memoryIndexUpsert({
    id: 'doc:del',
    kind: 'memory',
    title: 'Temporary doc',
    body: 'Content to be removed',
  })
  assert.ok(rt.memoryIndexGet('doc:del'))

  rt.memoryIndexDelete('doc:del')
  assert.ok(rt.memoryIndexGet('doc:del').deletedAt !== null)

  const searchAfterDel = await rt.hybridSearch('Content')
  assert.equal(searchAfterDel.hits.length, 0)

  rt.memoryIndexRestore('doc:del')
  assert.equal(rt.memoryIndexGet('doc:del').deletedAt, null)
})

test('memory-index privacy boundary prevents leaking private docs', async t => {
  const rt = createTestRuntime(t)
  rt.memoryIndexUpsert({
    id: 'doc:priv',
    kind: 'memory',
    scopeKey: 'bot:secret-bot',
    botId: 'secret-bot',
    title: 'Private Journal',
    body: 'Super confidential plans',
    isPrivate: true,
  })

  // Without allowPrivateBotId, it should not be returned
  const publicSearch = await rt.hybridSearch('confidential')
  assert.equal(publicSearch.hits.length, 0)
  assert.equal(rt.memoryIndexGet('doc:priv'), null)

  // With allowPrivateBotId matching, it should be visible
  const privateSearch = await rt.hybridSearch('confidential', { allowPrivateBotId: 'secret-bot' })
  assert.equal(privateSearch.hits.length, 1)
  assert.equal(privateSearch.hits[0].id, 'doc:priv')

  const doc = rt.memoryIndexGet('doc:priv', { allowPrivateBotId: 'secret-bot' })
  assert.ok(doc)
  assert.equal(doc.id, 'doc:priv')
})

test('memory-index observations support idempotency and listing', async t => {
  const rt = createTestRuntime(t)
  const obs1 = rt.insertObservationRow({
    id: 'obs:1',
    idempotencyKey: 'idem-1',
    sessionId: 'sess-1',
    title: 'Refactored auth',
    summary: 'Changed JWT validation',
    facts: ['Supports HS256 and RS256'],
  })
  assert.equal(obs1.inserted, true)
  assert.equal(obs1.duplicate, false)

  // Duplicate idempotencyKey
  const obsDup = rt.insertObservationRow({
    id: 'obs:dup',
    idempotencyKey: 'idem-1',
    title: 'Duplicate auth',
    summary: 'Different summary',
  })
  assert.equal(obsDup.inserted, false)
  assert.equal(obsDup.duplicate, true)

  const list = rt.listRecentObservations({ sessionId: 'sess-1' })
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'obs:1')
  assert.equal(list[0].title, 'Refactored auth')
})

test('memory-index hybrid search incorporates embedding vectors', async t => {
  const calls = []
  const embedder = async (text) => {
    calls.push(text)
    // 3-dimensional mock vector
    return { vector: [0.5, 0.5, 0.7071], model: 'mock-3d' }
  }
  const rt = createTestRuntime(t, { embedder })

  rt.memoryIndexUpsert({
    id: 'doc:vec',
    kind: 'memory',
    title: 'Vector document',
    body: 'Deep learning semantic search',
  })

  // Flush background embedding queue
  await rt.memoryIndexFlushEmbeddings()
  assert.ok(calls.length > 0)

  const res = await rt.hybridSearch('semantic search')
  assert.equal(res.hits.length, 1)
  assert.equal(res.hits[0].id, 'doc:vec')
  assert.ok(res.hits[0].score > 0)
  assert.equal(res.mode, 'hybrid')
})

test('cross-bot hybrid search returns shared team and public bot docs while hiding private bot docs', async t => {
  const rt = createTestRuntime(t)
  rt.botOf = id => ({
    b1: { id: 'b1', name: 'Reader', private: false },
    b2: { id: 'b2', name: 'Coder', private: false },
    b3: { id: 'b3', name: 'SecretBot', private: true },
  }[id])

  rt.memoryIndexUpsert({
    id: 'mem:team-1',
    kind: 'memory',
    scopeKey: 'team',
    title: 'Deploy target',
    body: 'Production deploy uses staging blue-green rollout',
  })
  rt.memoryIndexUpsert({
    id: 'mem:b2-1',
    kind: 'memory',
    scopeKey: 'bot:b2',
    botId: 'b2',
    title: 'Coder note',
    body: 'Coder verified blue-green rollout health checks',
  })
  rt.memoryIndexUpsert({
    id: 'mem:b3-1',
    kind: 'memory',
    scopeKey: 'bot:b3',
    botId: 'b3',
    title: 'Private note',
    body: 'Private blue-green rollout secret key note',
    isPrivate: true,
  })

  // Other Bot b1 sees team + non-private b2, never private b3.
  const forB1 = await rt.hybridSearch('blue-green rollout', { allowPrivateBotId: 'b1' })
  assert.deepEqual(forB1.hits.map(h => h.id).sort(), ['mem:b2-1', 'mem:team-1'])

  // Private Bot b3 itself can see its own private doc alongside team + b2.
  const forB3 = await rt.hybridSearch('blue-green rollout', { allowPrivateBotId: 'b3' })
  assert.deepEqual(forB3.hits.map(h => h.id).sort(), ['mem:b2-1', 'mem:b3-1', 'mem:team-1'])
})
