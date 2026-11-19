import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { withScope } from '../src/db.mjs'
import { mockEmbedder } from '../src/embed.mjs'
import { ingestEvent, sha256 } from '../src/ingest.mjs'
import { runIndexer } from '../src/indexer.mjs'
import { search } from '../src/search.mjs'
import { freshDb } from './helpers.mjs'

let db
const embedder = mockEmbedder()
let n = 0
const ev = over => {
  n += 1
  return {
    schema_version: 1, tenant_id: 'ts', project_id: 'p', event_id: `ev-${n}`, run_id: 'r', kind: 'message.requested', occurred_at: '2026-06-01T00:00:00Z',
    source_system: 'test', source_id: 'src', source_seq: n, source_sha256: sha256(`s${n}`), body: { summary: 'nothing much' }, ...over,
  }
}
before(async () => {
  db = await freshDb()
  const events = [
    ev({ occurred_at: '2026-01-01T00:00:00Z', body: { summary: 'quarterly ledger reconciliation january' } }),
    ev({ occurred_at: '2026-06-01T00:00:00Z', body: { summary: 'quarterly ledger reconciliation june' } }),
    ev({ kind: 'authorization.denied', agent_id: 'dsbot:bot-chief', body: { summary: 'authorization denied message_bot by Chief to Writer: recipient-off', reason: 'recipient-off', action: 'message_bot', outcome: 'denied', actor_name: 'Chief', target_name: 'Writer' } }),
    ev({ body: { summary: 'review requested', target_name: '审阅者' } }),
    ev({ private_agent_id: 'dsbot:bot-p', body: { summary: 'private vault inventory' } }),
  ]
  for (const e of events) await withScope(db.pool, { tenant: 'ts', role: 'ingest' }, c => ingestEvent(c, e))
  await runIndexer(db.pool, 'ts', embedder)
})
after(async () => { await db.drop() })
const find = (query, extra = {}, pool = db.pool) => search(pool, { tenant: 'ts', project: 'p', principal: 'u', query, mode: 'lexical', ...extra }, embedder)

test('time filters use when the event happened, not when it was indexed', async () => {
  const all = await find('quarterly reconciliation')
  assert.equal(all.results.length, 2)
  const recent = await find('quarterly reconciliation', { from: '2026-05-01T00:00:00Z' })
  assert.deepEqual(recent.results.map(r => r.snippet.match(/january|june/)[0]), ['june'])
  assert.equal(new Date(recent.results[0].occurred_at).toISOString(), '2026-06-01T00:00:00.000Z')
})

test('a refusal is found by its words, its reason with or without the dash, and the Bot it was aimed at', async () => {
  for (const q of ['authorization', 'denied', 'recipient off', 'recipient-off', 'Writer']) {
    const r = await find(q)
    assert.ok(r.results.some(x => x.kind === 'authorization.denied'), q)
  }
})

test('names in any script are searchable', async () => {
  const r = await find('审阅者')
  assert.equal(r.results.length, 1)
})

test('a private chunk is filtered in SQL, even for a login that bypasses row-level security', async () => {
  const asOwner = await find('private vault inventory', { agent: '' }, db.admin)
  assert.equal(asOwner.results.length, 0)
  const asBot = await find('private vault inventory', { agent: 'dsbot:bot-p' }, db.admin)
  assert.equal(asBot.results.length, 1)
})

test('tsquery operators in a query are plain text', async () => {
  const r = await find("a & b | !c :* 'x' \\ (y)")
  assert.ok(Array.isArray(r.results))
})
