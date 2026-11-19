import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { withScope } from '../src/db.mjs'
import { mockEmbedder } from '../src/embed.mjs'
import { IngestError, ingestEvent } from '../src/ingest.mjs'
import { runIndexer } from '../src/indexer.mjs'
import { search } from '../src/search.mjs'
import { envelope, freshDb } from './helpers.mjs'

let db
before(async () => { db = await freshDb() })
after(async () => { await db.drop() })

const ingest = (env, opts) => withScope(db.pool, { tenant: env.tenant_id, role: 'ingest' }, c => ingestEvent(c, env, opts))

test('an event is ingested once; a replay or retry changes nothing', async () => {
  const env = envelope({ body: { summary: 'first' } })
  assert.deepEqual(await ingest(env), { inserted: true })
  assert.deepEqual(await ingest({ ...env, event_id: 'retry-of-same-source' }), { inserted: false })
  const { rows } = await db.admin.query('select count(*)::int n from events where source_id = $1 and source_seq = $2', [env.source_id, env.source_seq])
  assert.equal(rows[0].n, 1)
  const outbox = await db.admin.query('select count(*)::int n from ingestion_outbox where event_id = $1', [env.event_id])
  assert.equal(outbox.rows[0].n, 1)
})

test('prompts, reasoning and unverifiable outcomes are refused at the door', async () => {
  await assert.rejects(ingest(envelope({ body: { 'llm.prompt': 'secret plan' } })), /metadata-only/)
  await assert.rejects(ingest(envelope({ body: { reasoning: 'thinking' } })), IngestError)
  await assert.rejects(ingest(envelope({ verified_outcome: 'PASS' })), /only be set by a verifier/)
  await assert.rejects(ingest(envelope({ source_sha256: 'nope' })), /source_sha256/)
  assert.deepEqual(await ingest(envelope({ verified_outcome: 'PASS' }), { fromVerifier: true }), { inserted: true })
})

test('authoritative events stay durable when the embedding provider is down, then replay without duplicates', async () => {
  const env = envelope({ tenant_id: 'tenant-b', body: { summary: 'blocked message_bot call: recipient-off for Writer', commit: 'abc1234def' } })
  await ingest(env)
  let down = true
  const embedder = mockEmbedder({ fail: () => down })
  const first = await runIndexer(db.pool, 'tenant-b', embedder)
  assert.equal(first.embedFailed, 1)
  // Lexical search already answers while the vectors are missing.
  const lexical = await search(db.pool, { tenant: 'tenant-b', project: 'proj', principal: 'u', query: 'abc1234def', mode: 'hybrid' }, embedder)
  assert.equal(lexical.vectorUsed, false)
  assert.equal(lexical.results.length, 1)
  assert.match(lexical.results[0].source_ref, /^dsh-session:session-1#/)
  // The retry waits out its backoff; make it due, bring the provider back, replay.
  await db.admin.query("update ingestion_outbox set next_retry_at = now() where tenant_id = 'tenant-b'")
  down = false
  const second = await runIndexer(db.pool, 'tenant-b', embedder)
  assert.equal(second.embedded, 1)
  const chunks = await db.admin.query("select count(*)::int n, count(embedding)::int e from retrieval_chunks where tenant_id = 'tenant-b'")
  assert.deepEqual(chunks.rows[0], { n: 1, e: 1 })
  await db.admin.query("update ingestion_outbox set status = 'retry', next_retry_at = now() where tenant_id = 'tenant-b'")
  await runIndexer(db.pool, 'tenant-b', embedder)
  assert.equal((await db.admin.query("select count(*)::int n from retrieval_chunks where tenant_id = 'tenant-b'")).rows[0].n, 1, 'a replay adds no chunk')
})

test('an exact error or commit and a paraphrase both retrieve the right evidence, with citations', async () => {
  const embedder = mockEmbedder()
  await ingest(envelope({ tenant_id: 'tenant-c', body: { summary: 'Capy approved the merge after fixing the null check in the router' }, source_system: 'ledger' }))
  await ingest(envelope({ tenant_id: 'tenant-c', body: { summary: 'Devin pushed commit 9f8e7d6c to the feature branch' }, agent_id: 'devin' }))
  await ingest(envelope({ tenant_id: 'tenant-c', body: { summary: 'weekly planning notes about the paint schedule' }, agent_id: 'chief' }))
  await runIndexer(db.pool, 'tenant-c', embedder)
  const exact = await search(db.pool, { tenant: 'tenant-c', project: 'proj', principal: 'u', query: '9f8e7d6c' }, embedder)
  assert.match(exact.results[0].snippet, /9f8e7d6c/)
  const para = await search(db.pool, { tenant: 'tenant-c', project: 'proj', principal: 'u', query: 'router null check review approved' }, embedder)
  assert.match(para.results[0].snippet, /null check/)
  const capyOnly = await search(db.pool, { tenant: 'tenant-c', project: 'proj', principal: 'u', query: 'approved merge push commit', botId: 'devin' }, embedder)
  assert.ok(capyOnly.results.every(r => /9f8e7d6c/.test(r.snippet)))
})

test('queries and ingests cannot cross a tenant, and a private agent\'s rows stay private', async () => {
  const embedder = mockEmbedder()
  await ingest(envelope({ tenant_id: 'tenant-d', body: { summary: 'tenant d confidential roadmap' } }))
  await ingest(envelope({ tenant_id: 'tenant-d', body: { summary: 'private agent scratch notes roadmap' }, private_agent_id: 'secret-bot' }))
  await runIndexer(db.pool, 'tenant-d', embedder)
  const other = await search(db.pool, { tenant: 'tenant-c', project: 'proj', principal: 'u', query: 'roadmap' }, embedder)
  assert.ok(other.results.every(r => !/roadmap/.test(r.snippet)), 'another tenant never sees tenant d\'s content')
  const seen = await search(db.pool, { tenant: 'tenant-d', project: 'proj', principal: 'u', query: 'roadmap', agent: 'someone-else' }, embedder)
  assert.deepEqual(seen.results.map(r => /private/.test(r.snippet)), [false])
  const owner = await search(db.pool, { tenant: 'tenant-d', project: 'proj', principal: 'u', query: 'roadmap', agent: 'secret-bot' }, embedder)
  assert.equal(owner.results.length, 2)
  // A write for another tenant is refused by the database, not only by application code.
  await assert.rejects(withScope(db.pool, { tenant: 'tenant-c', role: 'ingest' }, c => ingestEvent(c, envelope({ tenant_id: 'tenant-d' }))), /row-level security/)
  // A hostile identifier is data, never SQL.
  const evil = await search(db.pool, { tenant: 'tenant-d', project: "proj' or '1'='1", principal: 'u', query: "roadmap'; drop table events;--" }, embedder)
  assert.equal(evil.results.length, 0, 'an unknown project returns nothing')
  assert.equal((await db.admin.query('select count(*)::int n from events')).rows[0].n > 0, true)
})

test('secrets are redacted before they are indexed, and the query log keeps a fingerprint, not the words', async () => {
  const embedder = mockEmbedder()
  await ingest(envelope({ tenant_id: 'tenant-e', body: { summary: 'deploy used password=hunter2 and sk-abcdefghijklmnopqrstuvwx for user a@b.com' } }))
  await runIndexer(db.pool, 'tenant-e', embedder)
  const { rows } = await db.admin.query("select text from retrieval_chunks where tenant_id = 'tenant-e'")
  assert.doesNotMatch(rows[0].text, /hunter2|sk-abcdef|a@b\.com/)
  await search(db.pool, { tenant: 'tenant-e', project: 'proj', principal: 'u', query: 'deploy password=hunter2' }, embedder)
  const log = await db.admin.query("select query_fp, filters::text f from retrieval_queries where tenant_id = 'tenant-e'")
  assert.match(log.rows[0].query_fp, /^[0-9a-f]{64}$/)
  assert.doesNotMatch(JSON.stringify(log.rows), /hunter2/)
})
