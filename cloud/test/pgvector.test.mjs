import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { withScope } from '../src/db.mjs'
import { mockEmbedder } from '../src/embed.mjs'
import { ingestEvent } from '../src/ingest.mjs'
import { runIndexer } from '../src/indexer.mjs'
import { search } from '../src/search.mjs'
import { envelope, freshDb } from './helpers.mjs'

// The same corpus through the array fallback and through pgvector: the ranked answers agree.
let plain
let native
before(async () => {
  plain = await freshDb()
  native = await freshDb({ optional: ['002_pgvector.optional.sql'] })
})
after(async () => { await plain.drop(); await native.drop() })

const texts = [
  'router drops the null check on empty input',
  'paint schedule parser handles empty rows',
  'retry limits are bounded in the dispatcher',
  'weekly planning notes about budget and agenda',
  'blocked message_bot call recipient-off',
]

async function load(db, embedder) {
  for (const [i, summary] of texts.entries()) {
    const env = envelope({ tenant_id: 'tv', event_id: `v-${i}`, source_system: 'pgv', source_id: 's', source_seq: i, source_sha256: String(i).padStart(64, 'a'), body: { summary } })
    await withScope(db.pool, { tenant: 'tv', role: 'ingest' }, c => ingestEvent(c, env))
  }
  await runIndexer(db.pool, 'tv', embedder, { limit: 100 })
}

test('pgvector is used when its column exists, and ranks agree with the array fallback', async () => {
  const embedder = mockEmbedder()
  await load(plain, embedder)
  await load(native, embedder)
  const ask = db => search(db.pool, { tenant: 'tv', project: 'proj', principal: 'u', query: 'null check router empty input', mode: 'vector' }, embedder)
  const a = await ask(plain)
  const b = await ask(native)
  assert.equal(a.vectorEngine, 'array')
  assert.equal(b.vectorEngine, 'pgvector')
  assert.deepEqual(b.results.map(r => r.snippet), a.results.map(r => r.snippet))
  assert.match(b.results[0].snippet, /null check/)
  const stored = await native.admin.query('select vector_dims(embedding_v) d from retrieval_chunks limit 1')
  assert.equal(stored.rows[0].d, 256)
})

test('vectors of another embedding model are never compared', async () => {
  const other = { model: 'mock-other-8', dim: 8, embed: async t => t.map(() => Array.from({ length: 8 }, (_, i) => i + 1)) }
  const env = envelope({ tenant_id: 'tv', event_id: 'v-other', source_system: 'pgv', source_id: 's', source_seq: 99, source_sha256: 'b'.repeat(64), body: { summary: 'a document embedded by a different model' } })
  await withScope(native.pool, { tenant: 'tv', role: 'ingest' }, c => ingestEvent(c, env))
  await runIndexer(native.pool, 'tv', other)
  // A 256-d query must not touch the 8-d row: that would raise a dimension error in SQL.
  const res = await search(native.pool, { tenant: 'tv', project: 'proj', principal: 'u', query: 'document', mode: 'vector' }, mockEmbedder())
  assert.equal(res.vectorUsed, true)
  assert.ok(res.results.every(r => !/different model/.test(r.snippet)))
})
