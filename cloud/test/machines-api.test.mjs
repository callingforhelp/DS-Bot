import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createApi } from '../src/api.mjs'
import { apiClient } from '../src/client.mjs'
import { startController } from '../src/controller-service.mjs'
import { createDaytonaMachineManager, mockDaytonaClient } from '../src/daytona-machine.mjs'
import { mockEmbedder } from '../src/embed.mjs'
import { pgMachineStore } from '../src/machine-store.mjs'
import { localObjectStore } from '../src/objectstore.mjs'
import { mockDaytona } from '../src/worker.mjs'
import { freshDb } from './helpers.mjs'

const principals = {
  alice: { secret: 'alice-secret-at-least-32-chars-long!', tenants: ['t1'], scopes: ['read-only'], role: 'user' },
  bob: { secret: 'bob-secret-at-least-32-chars-long-!!', tenants: ['t2'], scopes: ['read-only'], role: 'user' },
  acme: { secret: 'acme-secret-at-least-32-chars-long!', tenants: ['acme', 'acme-prod'], scopes: ['read-only'], role: 'user' },
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
  assert.equal(delivered[0].threadId, 'th-1')
  assert.equal(delivered[0].text, 'Please summarize this repository')

  const execRes = await alice('POST', `/v1/machines/${id}/exec`, { script: 'pwd' })
  assert.equal(execRes.status, 200)
  assert.equal(execRes.body.result.exitCode, 0)

  await machines.captureState(id, { roster: { coder: 'neon' } })
  const slept = await alice('POST', `/v1/machines/${id}/sleep`, { saveSnapshot: true, snapshotName: 'nightly' })
  assert.equal(slept.status, 200)
  assert.equal(slept.body.result.slept, true)
  const t1Snap = slept.body.result.snapshotName
  assert.ok(t1Snap.endsWith('-nightly'))

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
  const t1HexSnap = `ds-bot-t-${Buffer.from('t1', 'utf8').toString('hex')}-nightly`
  assert.equal((await alice('POST', '/v1/machines', { name: 'from-approved', snapshot: 'daytona-small' })).status, 201)
  assert.equal((await alice('POST', '/v1/machines', { name: 'from-own-snap', snapshot: t1HexSnap })).status, 201)
  assert.equal((await bob('POST', '/v1/machines', { name: 'steal-t1', snapshot: t1HexSnap })).status, 403)
  assert.equal((await bob('POST', '/v1/machines', { name: 'unapproved', snapshot: 'nightly' })).status, 403)

  // Hyphen-prefix collision check: acme cannot access acme-prod's saved snapshot.
  const acmeProd = apiClient({ baseUrl: ctl.base, principal: 'acme', secret: principals.acme.secret, tenant: 'acme-prod' })
  const acme = apiClient({ baseUrl: ctl.base, principal: 'acme', secret: principals.acme.secret, tenant: 'acme' })
  const apBox = await acmeProd('POST', '/v1/machines', { name: 'ap-box' })
  assert.equal(apBox.status, 201)
  const apSlept = await acmeProd('POST', `/v1/machines/${apBox.body.machine.id}/sleep`, { saveSnapshot: true, snapshotName: 'nightly' })
  assert.equal(apSlept.status, 200)
  assert.equal((await acme('POST', '/v1/machines', { name: 'steal-ap', snapshot: apSlept.body.result.snapshotName })).status, 403)

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

test('machine registry persists in Postgres across controller restarts, prevents stale overwrites, retries unresolved sandboxes, and persists wake invalidation', async () => {
  const client = mockDaytonaClient()
  const store = pgMachineStore({ pool: db.pool, tenants: ['t1', 't2'] })
  const msgHandler = async (_m, _sbx, msg) => ({ reply: `echo:${msg.text}` })
  const mgr1 = createDaytonaMachineManager({ client, store, defaultIdleMinutes: 10 })
  const ctl1 = await startController({
    pool: db.pool,
    principals,
    embedder: mockEmbedder(),
    instance: 'ctl-persist-1',
    intervalMs: 60_000,
    provider: mockDaytona(),
    machines: mgr1,
    machineMessageHandler: msgHandler,
    bucket: 'artifacts',
    objectStore: localObjectStore({ root: mkdtempSync(join(tmpdir(), 'ctl-persist-1-')), secret: 's' }),
  })
  started.push(ctl1)

  const alice1 = apiClient({ baseUrl: ctl1.base, principal: 'alice', secret: principals.alice.secret, tenant: 't1' })
  const created = await alice1('POST', '/v1/machines', { name: 'persist-box', size: 'medium' })
  assert.equal(created.status, 201)
  const id = created.body.machine.id

  // Second controller rehydrates at seq 0 before controller 1 records a message (seq 2).
  const mgr2 = createDaytonaMachineManager({ client, store, defaultIdleMinutes: 10 })
  const ctl2 = await startController({
    pool: db.pool,
    principals,
    embedder: mockEmbedder(),
    instance: 'ctl-persist-2',
    intervalMs: 60_000,
    provider: mockDaytona(),
    machines: mgr2,
    machineMessageHandler: msgHandler,
    bucket: 'artifacts',
    objectStore: localObjectStore({ root: mkdtempSync(join(tmpdir(), 'ctl-persist-2-')), secret: 's' }),
  })
  started.push(ctl2)

  const msg = await alice1('POST', `/v1/machines/${id}/message`, { threadId: 'th-persist', botId: 'coder', text: 'hello' })
  assert.equal(msg.status, 200)
  assert.equal(msg.body.result.seq, 2)

  // Updating policy through standby ctl2 must sync from store and never clobber seq 2 / thread cache.
  const alice2 = apiClient({ baseUrl: ctl2.base, principal: 'alice', secret: principals.alice.secret, tenant: 't1' })
  const pol = await alice2('POST', `/v1/machines/${id}/policy`, { keepAwake: true })
  assert.equal(pol.status, 200)
  assert.equal(mgr2.getMachine(id).seq, 2)

  // Direct stale version write is rejected with MACHINE_VERSION_CONFLICT.
  await assert.rejects(
    store.save({ tenantId: 't1', id, name: 'persist-box', size: 'medium', state: 'started', idleMinutes: 10, keepAwake: false, nextScheduledAt: null, labels: { tenant_id: 't1' }, pendingResize: null, cache: {}, epoch: 1, seq: 0, version: 1, lastActivityAt: Date.now() }),
    err => err.code === 'MACHINE_VERSION_CONFLICT',
  )

  // Sleep with roster A, wake via uncaptured readThread, update sandbox roster to B, stop directly, and rehydrate.
  await mgr1.setIdlePolicy(id, { keepAwake: false })
  await mgr1.captureState(id, { roster: { coder: 'roster-A' } })
  assert.equal((await alice1('POST', `/v1/machines/${id}/sleep`, {})).status, 200)
  await mgr1.readThread(id, 'uncaptured-thread', { fetcher: async () => ({ threadId: 'uncaptured-thread', messages: [] }) })
  await mgr1.getMachine(id).sandbox.fs.uploadFile(Buffer.from(JSON.stringify({ bots: { coder: 'roster-B' } })), '/data/bot/state.json')
  await mgr1.getMachine(id).sandbox.stop()

  // Simulate transient Daytona outage during rehydrate, then recovery on retry.
  const origGet = client.get.bind(client)
  let failOnce = true
  client.get = async (sid) => {
    if (failOnce) { failOnce = false; throw new Error('daytona temporary outage') }
    return origGet(sid)
  }
  const mgr3 = createDaytonaMachineManager({ client, store, defaultIdleMinutes: 10 })
  await mgr3.rehydrate()
  assert.equal(mgr3.getMachine(id).sandbox, null, 'failed lookup leaves sandbox null instead of broken placeholder')

  // Next operation retries client.get() and wakes to read fresh roster-B (cache invalidation was persisted on wake).
  const roster = await mgr3.readRoster(id)
  assert.equal(roster.fromCache, false)
  assert.deepEqual(roster.value, { coder: 'roster-B' })

  const downSql = readFileSync(new URL('../migrations/004_machines.down.sql', import.meta.url), 'utf8')
  assert.match(downSql, /delete from schema_migrations where id = '004_machines\.sql'/)
  assert.equal((await alice2('DELETE', `/v1/machines/${id}`)).status, 200)
})

test('concurrent store refresh never overwrites in-flight machine mutations', async () => {
  const client = mockDaytonaClient()
  const store = pgMachineStore({ pool: db.pool, tenants: ['t1'] })
  const mgrA = createDaytonaMachineManager({ client, store, defaultIdleMinutes: 10 })
  const mgrB = createDaytonaMachineManager({ client, store, defaultIdleMinutes: 10 })

  const box = await mgrA.createMachine({ name: 'race-box', labels: { tenant_id: 't1' } })
  await mgrB.rehydrate()

  let releaseHandler
  const handlerGate = new Promise(r => { releaseHandler = r })
  const pendingSend = mgrA.sendMessage(box.id, {
    threadId: 'th-race',
    botId: 'coder',
    text: 'in-flight message',
    handler: async () => {
      await handlerGate
      return { reply: 'done' }
    },
  })

  // Wait until sendMessage is inside the active mutation.
  for (let i = 0; i < 100 && mgrA.getMachine(box.id).activeMutations === 0; i++) {
    await new Promise(r => setTimeout(r, 10))
  }
  assert.equal(mgrA.getMachine(box.id).activeMutations, 1)

  // Controller B updates policy (advancing DB version), then Controller A runs a thread read.
  await mgrB.setIdlePolicy(box.id, { keepAwake: true })
  const midRead = await mgrA.readThread(box.id, 'th-race')
  assert.equal(midRead.value.messages[0].text, 'in-flight message', 'refresh must not clobber in-flight thread cache')
  assert.equal(mgrA.getMachine(box.id).seq, 1, 'refresh must not regress in-flight seq')

  releaseHandler()
  await assert.rejects(pendingSend, err => err.code === 'MACHINE_VERSION_CONFLICT')

  // DB still holds Controller B's valid version without any corrupted/regressed state from A.
  const stored = await store.loadOne(box.id, 't1')
  assert.equal(stored.keepAwake, true)
  assert.equal(stored.seq, 0)
  await mgrB.deleteMachine(box.id)
})

test('controllers discover newly created machines, scheduler syncs standby policy changes, and concurrent same-controller saves serialize cleanly', async () => {
  let now = 3_000_000
  const clock = () => now
  const client = mockDaytonaClient({ now: clock })
  const store = pgMachineStore({ pool: db.pool, tenants: ['t1'] })

  const mgr1 = createDaytonaMachineManager({ client, store, now: clock, defaultIdleMinutes: 5, preWakeLeadMs: 2 * 60_000 })
  const mgr2 = createDaytonaMachineManager({ client, store, now: clock, defaultIdleMinutes: 5, preWakeLeadMs: 2 * 60_000 })
  const ctl1 = await startController({
    pool: db.pool, principals, embedder: mockEmbedder(), instance: 'ctl-sync-1', intervalMs: 60_000,
    provider: mockDaytona(), machines: mgr1, bucket: 'artifacts',
    objectStore: localObjectStore({ root: mkdtempSync(join(tmpdir(), 'ctl-sync-1-')), secret: 's' }),
  })
  const ctl2 = await startController({
    pool: db.pool, principals, embedder: mockEmbedder(), instance: 'ctl-sync-2', intervalMs: 60_000,
    provider: mockDaytona(), machines: mgr2, bucket: 'artifacts',
    objectStore: localObjectStore({ root: mkdtempSync(join(tmpdir(), 'ctl-sync-2-')), secret: 's' }),
  })
  started.push(ctl1, ctl2)

  // Machine created on ctl1 AFTER ctl2 started is immediately discoverable on ctl2.
  const alice1 = apiClient({ baseUrl: ctl1.base, principal: 'alice', secret: principals.alice.secret, tenant: 't1' })
  const alice2 = apiClient({ baseUrl: ctl2.base, principal: 'alice', secret: principals.alice.secret, tenant: 't1' })
  const created = await alice1('POST', '/v1/machines', { name: 'cross-ctl-box' })
  assert.equal(created.status, 201)
  const id = created.body.machine.id

  assert.equal((await alice2('GET', '/v1/machines')).body.machines.some(m => m.id === id), true)
  assert.equal((await alice2('GET', `/v1/machines/${id}`)).status, 200)

  // Concurrent exec calls on ctl1 serialize their Postgres saves instead of colliding with 409.
  const [execA, execB] = await Promise.all([
    alice1('POST', `/v1/machines/${id}/exec`, { script: 'echo a' }),
    alice1('POST', `/v1/machines/${id}/exec`, { script: 'echo b' }),
  ])
  assert.equal(execA.status, 200)
  assert.equal(execB.status, 200)

  // Put machine to sleep, update nextScheduledAt via ctl2, and verify ctl1's checkIdleAndSchedule pre-wakes it.
  assert.equal((await alice1('POST', `/v1/machines/${id}/sleep`, {})).status, 200)
  assert.equal((await alice2('POST', `/v1/machines/${id}/policy`, { nextScheduledAt: now + 60_000 })).status, 200)
  const sched = await mgr1.checkIdleAndSchedule(id)
  assert.equal(sched.action, 'pre-woke')

  // Standby active job prevents writer from auto-sleeping even after idle threshold passes.
  assert.equal((await alice2('POST', `/v1/machines/${id}/policy`, { idleMinutes: 1, nextScheduledAt: null })).status, 200)
  let releaseStandbyJob
  const standbyGate = new Promise(r => { releaseStandbyJob = r })
  const standbyJob = mgr2.sendMessage(id, {
    threadId: 'th-busy',
    botId: 'coder',
    text: 'working',
    handler: async () => { await standbyGate; return { reply: 'ok' } },
  })
  for (let i = 0; i < 100 && mgr2.getMachine(id).activeJobs === 0; i++) {
    await new Promise(r => setTimeout(r, 10))
  }
  now += 2 * 60_000
  const idleDuringJob = await mgr1.checkIdleAndSchedule(id)
  assert.equal(idleDuringJob.action, 'none')
  assert.equal(idleDuringJob.reason, 'active-jobs')
  releaseStandbyJob()
  await standbyJob

  // Concurrent ensureAwake calls after unresolved sandbox still issue only one start().
  assert.equal((await alice1('POST', `/v1/machines/${id}/sleep`, {})).status, 200)
  const sbx = mgr1.getMachine(id).sandbox
  let startCount = 0
  const origStart = sbx.start.bind(sbx)
  sbx.start = async () => {
    startCount += 1
    await new Promise(r => setTimeout(r, 20))
    return origStart()
  }
  mgr1.getMachine(id).sandbox = null
  await Promise.all([mgr1.ensureAwake(id, 'a'), mgr1.ensureAwake(id, 'b')])
  assert.equal(startCount, 1)

  // Deleting on ctl2 prunes the machine from ctl1 on rehydrate/tick.
  assert.equal((await alice2('DELETE', `/v1/machines/${id}`)).status, 200)
  await mgr1.rehydrate()
  assert.equal(mgr1.listMachines().some(m => m.id === id), false)
  assert.equal((await alice1('GET', `/v1/machines/${id}`)).status, 404)
})

test('expired job lease allows auto-sleep, sleep resolves unresolved sandbox, and failed initial save cleans up sandbox', async () => {
  let now = 4_000_000
  const clock = () => now
  const client = mockDaytonaClient({ now: clock })
  const store = pgMachineStore({ pool: db.pool, tenants: ['t1'] })
  const mgr = createDaytonaMachineManager({ client, store, now: clock, defaultIdleMinutes: 5 })

  const box = await mgr.createMachine({ name: 'lease-box', labels: { tenant_id: 't1' } })

  // Simulate a crashed controller that called beginJob without endJob (60s lease).
  await store.beginJob(box.id, 't1', 'crashed-job', now, 60_000)
  now += 30_000
  assert.deepEqual(await mgr.checkIdleAndSchedule(box.id), { action: 'none', reason: 'active-jobs' })

  // Once the 60s job lease AND 5m idle interval expire, auto-sleep proceeds cleanly.
  now += 6 * 60_000
  const slept = await mgr.checkIdleAndSchedule(box.id)
  assert.equal(slept.action, 'slept')

  // Wake, clear sandbox reference, and verify sleep() resolves it instead of throwing.
  await mgr.ensureAwake(box.id)
  mgr.getMachine(box.id).sandbox = null
  const explicitSleep = await mgr.sleep(box.id)
  assert.equal(explicitSleep.slept, true)

  // Overlapping jobs: finishing a quick read must not clear a concurrent long job's lease.
  await mgr.ensureAwake(box.id)
  await mgr.setIdlePolicy(box.id, { idleMinutes: 1 })
  let releaseLong
  const longGate = new Promise(r => { releaseLong = r })
  const longJob = mgr.sendMessage(box.id, {
    threadId: 'th-overlap',
    botId: 'coder',
    text: 'long',
    handler: async () => { await longGate; return { reply: 'done' } },
  })
  for (let i = 0; i < 100 && mgr.getMachine(box.id).activeJobs === 0; i++) {
    await new Promise(r => setTimeout(r, 10))
  }
  await mgr.readThread(box.id, 'th-overlap')
  now += 2 * 60_000
  const writerMgr = createDaytonaMachineManager({ client, store, now: clock, defaultIdleMinutes: 1 })
  await writerMgr.rehydrate()
  assert.deepEqual(await writerMgr.checkIdleAndSchedule(box.id), { action: 'none', reason: 'active-jobs' })
  releaseLong()
  await longJob

  // Retryable delete after store.remove() fails once Daytona already deleted the sandbox.
  let failRemove = true
  const flakyStore = {
    ...store,
    async remove(mid, tid) {
      if (failRemove) { failRemove = false; throw new Error('db blip') }
      return store.remove(mid, tid)
    },
  }
  const flakyMgr = createDaytonaMachineManager({ client, store: flakyStore, now: clock })
  await flakyMgr.rehydrate()
  await assert.rejects(flakyMgr.deleteMachine(box.id), /db blip/)
  const retryMgr = createDaytonaMachineManager({ client, store: flakyStore, now: clock })
  await retryMgr.rehydrate()
  await retryMgr.deleteMachine(box.id)
  assert.equal(await store.loadOne(box.id, 't1'), null)

  // Long-running job renews its lease while active.
  const renewClient = mockDaytonaClient()
  const renewMgr = createDaytonaMachineManager({ client: renewClient, store, jobLeaseMs: 120, defaultIdleMinutes: 1 })
  const renewBox = await renewMgr.createMachine({ name: 'renew-box', labels: { tenant_id: 't1' } })
  const beforeRenew = Date.now()
  await renewMgr.execCommand(renewBox.id, 'sleep 1')
  let sawRenewed = false
  await renewMgr.sendMessage(renewBox.id, {
    threadId: 'th-renew',
    botId: 'coder',
    text: 'hold',
    handler: async () => {
      await new Promise(r => setTimeout(r, 200))
      const row = await store.loadOne(renewBox.id, 't1')
      sawRenewed = row.busyUntil > beforeRenew + 150
      return { reply: 'ok' }
    },
  })
  assert.equal(sawRenewed, true)
  await renewMgr.deleteMachine(renewBox.id)

  // Failed initial store.save() must clean up the allocated Daytona sandbox.
  const beforeCount = client.sandboxes.size
  const failingStore = { ...store, save: async () => { throw new Error('db down') } }
  const failMgr = createDaytonaMachineManager({ client, store: failingStore, now: clock })
  await assert.rejects(failMgr.createMachine({ name: 'orphan-check', labels: { tenant_id: 't1' } }), /db down/)
  assert.equal(client.sandboxes.size, beforeCount)
  assert.equal(failMgr.listMachines().length, 0)
})
