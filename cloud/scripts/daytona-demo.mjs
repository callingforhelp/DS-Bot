// End-to-end on real services: a signed API request is admitted and recorded on RDS, dispatched by
// the lease holder, run read-only inside a REAL Daytona sandbox (no network, ephemeral, 10-minute
// TTL), and its result and artifact come back as signed API calls. The sandbox is then deleted and
// the evidence is shown to survive. Uses one sandbox. Cleans up its own rows afterwards.
// The object store is still the local stand-in (no S3/R2 exists yet).
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApi } from '../src/api.mjs'
import { apiClient } from '../src/client.mjs'
import { acquireWriterLease, dispatchPending } from '../src/controller.mjs'
import { withScope } from '../src/db.mjs'
import { daytonaProvider } from '../src/daytona.mjs'
import { mockEmbedder } from '../src/embed.mjs'
import { localObjectStore } from '../src/objectstore.mjs'
import { appPool, loadEnv } from '../src/remote.mjs'
import { mockDaytona, runJob } from '../src/worker.mjs'
import { ROOT } from './pg.mjs'

const env = loadEnv(join(ROOT, '.env'))
const pool = appPool(env)
const tenant = `daytona-demo-${randomBytes(3).toString('hex')}`
const principals = {
  alice: { secret: randomBytes(16).toString('hex'), tenants: [tenant], scopes: ['read-only'], role: 'user' },
  worker: { secret: randomBytes(16).toString('hex'), tenants: [tenant], scopes: [], role: 'worker' },
}
const store = localObjectStore({ root: mkdtempSync(join(tmpdir(), 'demo-objects-')), secret: randomBytes(16).toString('hex') })
const api = createApi({ pool, embedder: mockEmbedder(), principals, objectStore: store })
const server = await api.listen(0)
const base = `http://127.0.0.1:${server.address().port}`
const as = who => apiClient({ baseUrl: base, principal: who, secret: principals[who].secret, tenant })
const provider = daytonaProvider({ apiKey: env.DAYTONA_API_KEY, ttlMinutes: 10 })
const out = []
const check = (name, ok, extra = '') => { out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!ok) process.exitCode = 1 }
const text = 'one two three\nfour five\nsix'
let sandboxId
try {
  const sub = await as('alice')('POST', '/v1/tasks', { project_id: 'p', idempotency_key: 'demo-1', scope: 'read-only', job: { kind: 'readonly.summarize', payload: { text } } })
  check('signed request admitted and recorded on RDS', sub.status === 202, `run ${sub.body.run_id?.slice(0, 12)}`)
  const lease = await acquireWriterLease(pool, 'demo-controller')
  const second = await acquireWriterLease(pool, 'demo-second')
  check('exactly one writer lease on RDS', lease.held && !second.held)
  const sent = []
  await dispatchPending(pool, { tenants: [tenant], lease, send: async t => sent.push(t) })
  check('task dispatched once to the cloud route', sent.length === 1 && sent[0].route === 'daytona')
  const spy = { ...provider, async create(o) { const s = await provider.create(o); sandboxId = s.id; return s } }
  const t0 = Date.now()
  const done = await runJob({ provider: spy, objectStore: store, api: as('worker'), task: sent[0], traceId: 'trace-daytona-demo' })
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  const expected = await (async () => { const m = mockDaytona(); const sb = await m.create({ volumeSubpath: 'x' }); const r = await m.run(sb, sent[0].job); await m.destroy(sb); return r })()
  check('the real sandbox computed the same result as the local reference', JSON.stringify(done.result) === JSON.stringify(expected), `${JSON.stringify(done.result)} in ${secs}s`)
  // Deletion completes asynchronously on Daytona's side: allow it up to 30 s.
  let gone = false
  for (let i = 0; i < 30 && !gone; i += 1) { gone = (await provider.exists(sandboxId)) === false; if (!gone) await new Promise(r => setTimeout(r, 1000)) }
  check('the sandbox is deleted', gone, sandboxId)
  const timeline = await as('alice')('GET', `/v1/runs/${sub.body.run_id}?project_id=p`)
  check('timeline kept on RDS after the sandbox is gone', timeline.status === 200 && timeline.body.events.map(e => e.kind).join() === 'worker.started,task.result' && timeline.body.events.every(e => e.trace_id === 'trace-daytona-demo'))
  const [artifact] = timeline.body.artifacts
  check('artifact digest matches the stored object', artifact && store.head({ bucket: artifact.bucket, key: artifact.object_key }).sha256 === artifact.sha256)
  check('claimed is not verified', timeline.body.events.every(e => e.verified_outcome === 'UNKNOWN'))
  await lease.release()
  await second.release?.()
} catch (error) {
  check('demo completed without error', false, String(error.message).slice(0, 160))
} finally {
  server.close()
  if (sandboxId && (await provider.exists(sandboxId))) { await provider.destroy({ remote: await new (await import('@daytonaio/sdk')).Daytona({ apiKey: env.DAYTONA_API_KEY }).get(sandboxId) }).catch(() => {}); out.push('NOTE  a leftover sandbox was deleted in cleanup') }
  await withScope(pool, { tenant, role: 'ingest' }, async (c) => {
    for (const t of ['artifacts', 'authorizations', 'tasks_admitted', 'retrieval_chunks', 'ingestion_outbox', 'events', 'runs']) await c.query(`delete from ${t} where tenant_id = $1`, [tenant])
  }).catch(() => {})
  await pool.query("delete from request_nonces where nonce like 'alice:%' or nonce like 'worker:%'").catch(() => {})
  await pool.end()
  console.log(out.join('\n'))
}
