import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createApi } from '../src/api.mjs'
import { apiClient } from '../src/client.mjs'
import { startController } from '../src/controller-service.mjs'
import { createDaytonaMachineManager, mockDaytonaClient } from '../src/daytona-machine.mjs'
import { mockEmbedder } from '../src/embed.mjs'
import { localObjectStore } from '../src/objectstore.mjs'
import { mockDaytona } from '../src/worker.mjs'
import { freshDb } from './helpers.mjs'

const principals = {
  alice: { secret: 'alice-secret-at-least-32-chars-long!', tenants: ['t1'], scopes: ['read-only'], role: 'user' },
  bob: { secret: 'bob-secret-at-least-32-chars-long-!!', tenants: ['t2'], scopes: ['read-only'], role: 'user' },
  worker: { secret: 'worker-secret-at-least-32-chars-long', tenants: ['t1', 't2'], scopes: [], role: 'worker' },
}

let db
const started = []
before(async () => { db = await freshDb() })
after(async () => { for (const c of started) await c.stop(); await db.drop() })

test('controller exposes /v1/machines lifecycle, messaging, exec, sleep, cached reads, resize, policy, and delete', async () => {
  const client = mockDaytonaClient()
  const machines = createDaytonaMachineManager({ client, defaultIdleMinutes: 10 })
  const delivered = []
  const ctl = await startController({
    pool: db.pool,
    principals,
    embedder: mockEmbedder(),
    instance: 'ctl-machines-api',
    intervalMs: 60_000,
    provider: mockDaytona(),
    machines,
    approvedSnapshots: ['daytona-small'],
    machineMessageHandler: async (machine, _sandbox, message) => {
      delivered.push({ machineId: machine.id, ...message })
      return { reply: `bot(${message.botId}): ${message.text}` }
    },
    bucket: 'artifacts',
    objectStore: localObjectStore({ root: mkdtempSync(join(tmpdir(), 'ctl-machines-api-')), secret: 's' }),
  })
  started.push(ctl)

  const alice = apiClient({ baseUrl: ctl.base, principal: 'alice', secret: principals.alice.secret, tenant: 't1' })

  const created = await alice('POST', '/v1/machines', { name: 'coder-box', size: 'medium' })
  assert.equal(created.status, 201)
  const id = created.body.machine.id
  assert.equal(created.body.machine.name, 'coder-box')
  assert.equal(created.body.machine.labels.tenant_id, 't1')

  const listed = await alice('GET', '/v1/machines')
  assert.equal(listed.status, 200)
  assert.equal(listed.body.machines.length, 1)
  assert.equal(listed.body.machines[0].id, id)

  const fetched = await alice('GET', `/v1/machines/${id}`)
  assert.equal(fetched.status, 200)
  assert.equal(fetched.body.machine.id, id)

  const msg = await alice('POST', `/v1/machines/${id}/message`, { threadId: 'th-1', botId: 'coder', text: 'Please summarize this repository' })
  assert.equal(msg.status, 200)
  assert.equal(msg.body.result.seq, 2)
  assert.equal(msg.body.result.result.reply, 'bot(coder): Please summarize this repository')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].text, 'Please summarize this repository')

  const execRes = await alice('POST', `/v1/machines/${id}/exec`, { script: 'pwd' })
  assert.equal(execRes.status, 200)
  assert.equal(execRes.body.result.exitCode, 0)

  await machines.captureState(id, { roster: { coder: 'neon' } })
  const slept = await alice('POST', `/v1/machines/${id}/sleep`, { saveSnapshot: true, snapshotName: 'nightly' })
  assert.equal(slept.status, 200)
  assert.equal(slept.body.result.slept, true)
  assert.equal(slept.body.result.snapshotName, 'ds-bot-tenant-t1-nightly')

  const roster = await alice('GET', `/v1/machines/${id}/roster`)
  assert.equal(roster.status, 200)
  assert.equal(roster.body.roster.fromCache, true)
  assert.equal(roster.body.roster.woke, false)
  assert.deepEqual(roster.body.roster.value, { coder: 'neon' })

  const thread = await alice('GET', `/v1/machines/${id}/threads/th-1`)
  assert.equal(thread.status, 200)
  assert.equal(thread.body.thread.fromCache, true)
  assert.equal(thread.body.thread.value.messages[0].text, 'Please summarize this repository')

  const policy = await alice('POST', `/v1/machines/${id}/policy`, { keepAwake: true, idleMinutes: 15 })
  assert.equal(policy.status, 200)
  assert.equal(policy.body.machine.keepAwake, true)
  assert.equal(policy.body.machine.idleMinutes, 15)

  const resized = await alice('POST', `/v1/machines/${id}/resize`, { resources: { disk: 40 } })
  assert.equal(resized.status, 200)
  assert.equal(resized.body.result.applied, true)

  const deleted = await alice('DELETE', `/v1/machines/${id}`)
  assert.equal(deleted.status, 200)
  assert.equal(deleted.body.deleted, true)
  assert.equal((await alice('GET', '/v1/machines')).body.machines.length, 0)
})

test('/v1/machines enforces role permissions, tenant isolation, snapshot authorization, and 501 when unconfigured', async () => {
  const ctl = started[0]
  const alice = apiClient({ baseUrl: ctl.base, principal: 'alice', secret: principals.alice.secret, tenant: 't1' })
  const bob = apiClient({ baseUrl: ctl.base, principal: 'bob', secret: principals.bob.secret, tenant: 't2' })
  const worker = apiClient({ baseUrl: ctl.base, principal: 'worker', secret: principals.worker.secret, tenant: 't1' })

  const created = await alice('POST', '/v1/machines', { name: 't1-private', labels: { tenant_id: 't2' } })
  assert.equal(created.status, 201)
  assert.equal(created.body.machine.labels.tenant_id, 't1', 'caller cannot spoof tenant_id')
  const id = created.body.machine.id

  assert.equal((await worker('GET', '/v1/machines')).status, 403)
  assert.equal((await worker('POST', '/v1/machines', { name: 'nope' })).status, 403)

  const bobList = await bob('GET', '/v1/machines')
  assert.equal(bobList.status, 200)
  assert.deepEqual(bobList.body.machines, [])
  assert.equal((await bob('GET', `/v1/machines/${id}`)).status, 404)
  assert.equal((await bob('POST', `/v1/machines/${id}/message`, { threadId: 't', text: 'hi' })).status, 404)
  assert.equal((await bob('DELETE', `/v1/machines/${id}`)).status, 404)

  // Snapshot authorization: t1 can use its own tenant-prefixed snapshot or approved base snapshot; t2 cannot.
  assert.equal((await alice('POST', '/v1/machines', { name: 'from-approved', snapshot: 'daytona-small' })).status, 201)
  assert.equal((await alice('POST', '/v1/machines', { name: 'from-own-snap', snapshot: 'ds-bot-tenant-t1-nightly' })).status, 201)
  assert.equal((await bob('POST', '/v1/machines', { name: 'steal-t1', snapshot: 'ds-bot-tenant-t1-nightly' })).status, 403)
  assert.equal((await bob('POST', '/v1/machines', { name: 'unapproved', snapshot: 'nightly' })).status, 403)

  const bareApi = createApi({ pool: db.pool, embedder: mockEmbedder(), principals })
  const bareSrv = await bareApi.listen()
  const bareUrl = `http://127.0.0.1:${bareSrv.address().port}`
  const bareAlice = apiClient({ baseUrl: bareUrl, principal: 'alice', secret: principals.alice.secret, tenant: 't1' })
  assert.equal((await bareAlice('GET', '/v1/machines')).status, 501)
  bareSrv.close()

  // Without messageHandler, POST /v1/machines/:id/message must return 501 instead of executing shell commands.
  const noHandlerMgr = createDaytonaMachineManager({ client: mockDaytonaClient() })
  const noHandlerApi = createApi({ pool: db.pool, embedder: mockEmbedder(), principals, machines: noHandlerMgr })
  const noHandlerSrv = await noHandlerApi.listen()
  const noHandlerUrl = `http://127.0.0.1:${noHandlerSrv.address().port}`
  const nhAlice = apiClient({ baseUrl: noHandlerUrl, principal: 'alice', secret: principals.alice.secret, tenant: 't1' })
  const nhMachine = await nhAlice('POST', '/v1/machines', { name: 'no-handler-box' })
  assert.equal(nhMachine.status, 201)
  assert.equal((await nhAlice('POST', `/v1/machines/${nhMachine.body.machine.id}/message`, { threadId: 't1', text: 'echo pwned' })).status, 501)
  noHandlerSrv.close()
})
