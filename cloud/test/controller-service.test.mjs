import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { apiClient } from '../src/client.mjs'
import { startController } from '../src/controller-service.mjs'
import { mockEmbedder } from '../src/embed.mjs'
import { localObjectStore } from '../src/objectstore.mjs'
import { mockDaytona } from '../src/worker.mjs'
import { freshDb } from './helpers.mjs'

const principals = {
  alice: { secret: 'a', tenants: ['t1'], scopes: ['read-only'], role: 'user' },
  worker: { secret: 'w', tenants: ['t1'], scopes: [], role: 'worker' },
}
let db
const started = []
before(async () => { db = await freshDb() })
after(async () => { for (const c of started) await c.stop(); await db.drop() })

const boot = (instance, provider = mockDaytona()) => startController({
  pool: db.pool, principals, embedder: mockEmbedder(), instance, intervalMs: 100, provider, bucket: 'artifacts',
  objectStore: localObjectStore({ root: mkdtempSync(join(tmpdir(), 'ctl-objects-')), secret: 's' }),
}).then(c => { started.push(c); return c })
const waitFor = async (check, ms = 8000) => { for (let t = 0; t < ms; t += 50) { const v = await check(); if (v) return v; await new Promise(r => setTimeout(r, 50)) } return undefined }

test('the controller dispatches an admitted task by itself and records the whole run', async () => {
  const ctl = await boot('ctl-1')
  const as = apiClient({ baseUrl: ctl.base, principal: 'alice', secret: 'a', tenant: 't1' })
  const res = await as('POST', '/v1/tasks', { project_id: 'p', idempotency_key: 'svc-1', scope: 'read-only', job: { kind: 'readonly.summarize', payload: { text: 'x y z' } } })
  assert.equal(res.status, 202)
  const timeline = await waitFor(async () => {
    const t = await as('GET', `/v1/runs/${res.body.run_id}?project_id=p`)
    return t.body.events?.some(e => e.kind === 'task.result') ? t : undefined
  })
  assert.ok(timeline, 'the task ran without anyone calling dispatch')
  assert.equal(timeline.body.artifacts.length, 1)
  assert.equal(ctl.state.writer, true)
  assert.equal((await fetch(`${ctl.base}/ready`)).status, 200)
})

test('a second controller stays on standby, and takes over only when the first stops', async () => {
  const first = started[0]
  const second = await boot('ctl-2')
  await second.tick()
  assert.equal(second.state.writer, false, 'the standby does not dispatch')
  const as = apiClient({ baseUrl: second.base, principal: 'alice', secret: 'a', tenant: 't1' })
  const res = await as('POST', '/v1/tasks', { project_id: 'p', idempotency_key: 'svc-2', scope: 'read-only', job: { kind: 'readonly.summarize', payload: { text: 'q' } } })
  // The first (writer) runs it; the standby must not have.
  const done = await waitFor(async () => (await as('GET', `/v1/runs/${res.body.run_id}?project_id=p`)).body.events?.some(e => e.kind === 'task.result'))
  assert.ok(done)
  assert.equal(second.state.dispatched, 0)
  const before = first.state.dispatched
  assert.ok(before >= 2)
  await first.stop()
  const res2 = await as('POST', '/v1/tasks', { project_id: 'p', idempotency_key: 'svc-3', scope: 'read-only', job: { kind: 'readonly.summarize', payload: { text: 'r' } } })
  const taken = await waitFor(async () => (await as('GET', `/v1/runs/${res2.body.run_id}?project_id=p`)).body.events?.some(e => e.kind === 'task.result'))
  assert.ok(taken, 'the standby took over after the writer stopped')
  assert.equal(second.state.writer, true)
})
