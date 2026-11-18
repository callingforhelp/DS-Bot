import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createApi } from '../src/api.mjs'
import { authorizeAction } from '../src/authz.mjs'
import { apiClient, sign } from '../src/client.mjs'
import { acquireWriterLease, dispatchPending } from '../src/controller.mjs'
import { appUrl, makePool, withScope } from '../src/db.mjs'
import { mockEmbedder } from '../src/embed.mjs'
import { runIndexer } from '../src/indexer.mjs'
import { localObjectStore } from '../src/objectstore.mjs'
import { mockDaytona, runJob } from '../src/worker.mjs'
import { freshDb } from './helpers.mjs'

const principals = {
  alice: { secret: 'alice-secret', tenants: ['t1'], scopes: ['read-only'], role: 'user' },
  limited: { secret: 'limited-secret', tenants: ['t1'], scopes: [], role: 'user' },
  boss: { secret: 'boss-secret', tenants: ['t1'], scopes: ['read-only', 'workspace.write'], role: 'human' },
  worker: { secret: 'worker-secret', tenants: ['t1'], scopes: [], role: 'worker' },
  other: { secret: 'other-secret', tenants: ['t2'], scopes: ['read-only'], role: 'user' },
}
let db
let server
let base
let store
let api
const embedder = mockEmbedder()
const as = (id, tenant = 't1') => apiClient({ baseUrl: base, principal: id, secret: principals[id].secret, tenant })

before(async () => {
  db = await freshDb()
  store = localObjectStore({ root: mkdtempSync(join(tmpdir(), 'mvp-objects-')), secret: 'store-secret' })
  api = createApi({ pool: db.pool, embedder, principals, objectStore: store })
  server = await api.listen(0)
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => { server.close(); await db.pool.end().catch(() => {}); await db.drop() })

const task = (key, job = { kind: 'readonly.summarize', payload: { text: 'one two three\nfour' } }) => ({ project_id: 'p', idempotency_key: key, scope: 'read-only', job })
const count = async (sql, args = []) => (await db.admin.query(sql, args)).rows[0].n

test('a signed remote request is admitted, runs read-only in a sandbox, and its evidence outlives the sandbox', async () => {
  const sent = []
  const res = await as('alice')('POST', '/v1/tasks', task('k-1'))
  assert.equal(res.status, 202)
  const lease = await acquireWriterLease(db.pool, 'ctl-1')
  assert.equal(lease.held, true)
  await dispatchPending(db.pool, { tenants: ['t1'], lease, send: async t => sent.push(t) })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].route, 'daytona')
  const provider = mockDaytona()
  const out = await runJob({ provider, objectStore: store, api: as('worker'), task: sent[0], traceId: 'trace-demo' })
  assert.equal(provider.live.size, 0, 'the sandbox is gone')
  assert.equal(existsSync(join(out.sandbox)), false)
  const timeline = await as('alice')('GET', `/v1/runs/${res.body.run_id}?project_id=p`)
  assert.equal(timeline.status, 200)
  assert.deepEqual(timeline.body.events.map(e => e.kind), ['worker.started', 'task.result'])
  assert.ok(timeline.body.events.every(e => e.trace_id === 'trace-demo'), 'one trace ID end to end')
  assert.ok(timeline.body.events.every(e => e.verified_outcome === 'UNKNOWN'), 'claimed is not verified')
  assert.equal(timeline.body.events[1].claimed_outcome, 'completed')
  assert.equal(timeline.body.authorizations[0].verdict, 'allow')
  const [artifact] = timeline.body.artifacts
  assert.equal(store.head({ bucket: artifact.bucket, key: artifact.object_key }).sha256, artifact.sha256, 'the stored object still matches its recorded digest')
  assert.equal(JSON.parse(store.get({ bucket: artifact.bucket, key: artifact.object_key })).words, 4)
  await lease.release()
})

test('bad, stale and replayed requests are refused before anything is admitted or dispatched', async () => {
  const before = await count('select count(*)::int n from tasks_admitted')
  const raw = (over, who = 'alice', body = task('k-bad')) => {
    const { raw: payload, headers } = sign({ principal: who, secret: principals[who]?.secret ?? 'unknown', tenant: 't1', method: 'POST', path: '/v1/tasks', body, ...over })
    return fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: payload })
  }
  assert.equal((await raw({ secret: 'wrong' })).status, 401)
  assert.equal((await raw({ ts: Date.now() - 3_600_000 })).status, 401)
  assert.equal((await raw({}, 'nobody')).status, 401)
  const ok = await raw({ nonce: 'fixed-nonce' }, 'alice', task('k-replay'))
  assert.equal(ok.status, 202)
  assert.equal((await raw({ nonce: 'fixed-nonce' }, 'alice', task('k-replay-2'))).status, 409, 'a replayed nonce is refused')
  assert.equal(await count('select count(*)::int n from tasks_admitted'), before + 1, 'only the one valid request was admitted')
  assert.equal(await count("select count(*)::int n from tasks_admitted where idempotency_key = 'k-replay-2'"), 0)
})

test('a client retry with the same idempotency key returns the same run and dispatches once', async () => {
  const first = await as('alice')('POST', '/v1/tasks', task('k-idem'))
  const second = await as('alice')('POST', '/v1/tasks', task('k-idem'))
  assert.equal(second.body.run_id, first.body.run_id)
  assert.equal(second.body.duplicate, true)
  const sent = []
  const lease = await acquireWriterLease(db.pool, 'ctl-idem')
  await dispatchPending(db.pool, { tenants: ['t1'], lease, send: async t => sent.push(t) })
  await dispatchPending(db.pool, { tenants: ['t1'], lease, send: async t => sent.push(t) })
  assert.equal(sent.filter(t => t.run_id === first.body.run_id).length, 1)
  await lease.release()
})

test('scope, tenant and role are enforced from the authenticated principal, not the payload', async () => {
  assert.equal((await as('limited')('POST', '/v1/tasks', task('k-s'))).status, 403)
  assert.equal((await as('boss')('POST', '/v1/tasks', { ...task('k-w'), scope: 'workspace.write' })).status, 403, 'writes are not enabled in the MVP, even for a permitted scope')
  assert.equal((await as('other', 't1')('POST', '/v1/tasks', task('k-x'))).status, 403, 'not a member of the tenant')
  assert.equal((await as('alice')('POST', '/v1/events', {})).status, 403, 'a user cannot ingest events')
  const forged = { schema_version: 1, tenant_id: 't2', project_id: 'p', event_id: 'forged', run_id: 'r', kind: 'task.result', occurred_at: '2026-11-18T12:00:00Z', source_system: 'x', source_id: 'x', source_seq: 1, source_sha256: 'a'.repeat(64) }
  assert.equal((await as('worker')('POST', '/v1/events', forged)).status, 403, 'a worker cannot write into another tenant')
  const verified = { ...forged, tenant_id: 't1', verified_outcome: 'PASS' }
  assert.equal((await as('worker')('POST', '/v1/events', verified)).status, 422, 'a worker cannot mark its own work verified')
  const prompt = { ...forged, tenant_id: 't1', body: { 'llm.prompt': 'x' } }
  assert.equal((await as('worker')('POST', '/v1/events', prompt)).status, 422)
  const run = await as('other', 't2')('GET', '/v1/runs/run-none?project_id=p')
  assert.equal(run.status, 404)
})

test('exactly one controller is the writer, and a Mac that is offline does not stop cloud work', async () => {
  await as('alice')('POST', '/v1/tasks', task('k-cloud'))
  await as('alice')('POST', '/v1/tasks', task('k-mac', { kind: 'cad.render', needs: 'mac', payload: {} }))
  const first = await acquireWriterLease(db.pool, 'ctl-a')
  const second = await acquireWriterLease(db.pool, 'ctl-b')
  assert.equal(first.held, true)
  assert.equal(second.held, false, 'a second controller cannot become the writer')
  const sent = []
  assert.deepEqual(await dispatchPending(db.pool, { tenants: ['t1'], lease: second, send: async t => sent.push(t) }), { dispatched: 0, skipped: 'not the writer' })
  assert.equal(sent.length, 0)
  const out = await dispatchPending(db.pool, { tenants: ['t1'], lease: first, send: async t => sent.push(t), macSeenAt: 0 })
  assert.equal(out.dispatched, 1)
  assert.deepEqual(sent.map(t => t.route), ['daytona'], 'the cloud job ran')
  assert.equal(await count("select count(*)::int n from tasks_admitted where idempotency_key = 'k-mac' and dispatched = false and route = 'deferred'"), 1, 'the Mac job waits, visibly')
  await first.release()
  const third = await acquireWriterLease(db.pool, 'ctl-c')
  assert.equal(third.held, true, 'the lease is free once the writer is gone')
  await third.release()
})

test('after a controller restart the timeline, ids and undispatched work are all still there', async () => {
  const res = await as('alice')('POST', '/v1/tasks', task('k-restart'))
  const before = await as('alice')('GET', `/v1/runs/${res.body.run_id}?project_id=p`)
  server.close()
  await db.pool.end()
  db.pool = makePool(appUrl(db.name))
  api = createApi({ pool: db.pool, embedder, principals, objectStore: store })
  server = await api.listen(0)
  base = `http://127.0.0.1:${server.address().port}`
  const after = await as('alice')('GET', `/v1/runs/${res.body.run_id}?project_id=p`)
  assert.deepEqual(after.body.run, before.body.run)
  assert.deepEqual(after.body.authorizations.map(a => a.auth_id), before.body.authorizations.map(a => a.auth_id))
  const sent = []
  const lease = await acquireWriterLease(db.pool, 'ctl-restart')
  await dispatchPending(db.pool, { tenants: ['t1'], lease, send: async t => sent.push(t) })
  assert.ok(sent.some(t => t.run_id === res.body.run_id), 'work admitted before the restart is dispatched after it')
  await lease.release()
})

test('agent prose cannot authorize a push; only a human approval row for that exact action and run can', async () => {
  const run = (await as('alice')('POST', '/v1/tasks', task('k-push'))).body.run_id
  const gate = (runId, actor = 'capy') => withScope(db.pool, { tenant: 't1' }, c => authorizeAction(c, { tenant: 't1', project: 'p', run: runId, actor, action: 'git.push', scope: 'repo:demo' }))
  assert.deepEqual(await gate(run), { allow: false, reason: 'approval-required' })
  // Neither a user, a worker nor "approved in chat" can create an approval.
  assert.equal((await as('alice')('POST', '/v1/approvals', { project_id: 'p', run_id: run, action: 'git.push', scope: 'repo:demo' })).status, 403)
  assert.equal((await as('worker')('POST', '/v1/approvals', { project_id: 'p', run_id: run, action: 'git.push', scope: 'repo:demo' })).status, 403)
  await withScope(db.pool, { tenant: 't1' }, c => c.query(`insert into authorizations (tenant_id, project_id, auth_id, run_id, actor, action, scope, verdict, reason)
    values ('t1','p','fake','${run}','capy','git.push','repo:demo','allow','Chief said it is fine')`))
  assert.deepEqual(await gate(run), { allow: false, reason: 'approval-required' }, 'an allow row without a human approval does not count')
  const approved = await as('boss')('POST', '/v1/approvals', { project_id: 'p', run_id: run, action: 'git.push', scope: 'repo:demo' })
  assert.equal(approved.status, 201)
  assert.equal((await gate(run)).allow, true)
  assert.equal((await gate('another-run')).allow, false, 'an approval covers one run only')
  const timeline = await as('alice')('GET', `/v1/runs/${run}?project_id=p`)
  const verdicts = timeline.body.authorizations.filter(a => a.action === 'git.push').map(a => a.verdict)
  assert.ok(verdicts.includes('deny') && verdicts.includes('allow'), 'allowed and denied decisions are both on record')
  assert.ok(timeline.body.authorizations.some(a => a.approval_ref === approved.body.approval_ref))
})

test('an artifact that does not match its declared digest is refused, and stored objects are immutable', async () => {
  const key = 't1/p/run-x/file.bin'
  const token = store.presign({ bucket: 'artifacts', key })
  const stored = store.put({ bucket: 'artifacts', key, token, bytes: Buffer.from('hello') })
  const body = { project_id: 'p', artifact_id: 'a1', bucket: 'artifacts', key, sha256: stored.sha256, bytes: stored.bytes }
  assert.equal((await as('worker')('POST', '/v1/artifacts/register', { ...body, sha256: 'f'.repeat(64) })).status, 422)
  assert.equal((await as('worker')('POST', '/v1/artifacts/register', body)).status, 200)
  assert.throws(() => store.put({ bucket: 'artifacts', key, token, bytes: Buffer.from('different') }), /immutable/)
  assert.throws(() => store.put({ bucket: 'artifacts', key: 't1/p/other', token, bytes: Buffer.from('x') }), /token/)
  assert.throws(() => store.put({ bucket: 'artifacts', key: '../escape', token: store.presign({ bucket: 'artifacts', key: '../escape' }), bytes: Buffer.from('x') }), /escapes/)
})

test('a task run is retrievable by keyword and by paraphrase, with the source cited', async () => {
  const run = (await as('alice')('POST', '/v1/tasks', task('k-search'))).body.run_id
  const sent = []
  const lease = await acquireWriterLease(db.pool, 'ctl-search')
  await dispatchPending(db.pool, { tenants: ['t1'], lease, send: async t => sent.push(t) })
  await runJob({ provider: mockDaytona(), objectStore: store, api: as('worker'), task: sent.find(t => t.run_id === run) })
  await lease.release()
  await runIndexer(db.pool, 't1', embedder)
  const found = await as('alice')('POST', '/v1/search', { project_id: 'p', query: 'read-only job finished 4 words', mode: 'hybrid' })
  assert.equal(found.status, 200)
  assert.ok(found.body.results.some(r => /^daytona-worker:/.test(r.source_ref)), 'the answer cites its source')
  assert.equal((await as('other', 't2')('POST', '/v1/search', { project_id: 'p', query: 'read-only job finished' })).body.results.length, 0, 'another tenant gets nothing')
  assert.equal((await fetch(`${base}/health`)).status, 200)
  assert.equal((await fetch(`${base}/ready`)).status, 200)
})
