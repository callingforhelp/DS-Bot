import { createApi } from './api.mjs'
import { apiClient } from './client.mjs'
import { acquireWriterLease, dispatchPending } from './controller.mjs'
import { createDaytonaMachineManager, mockDaytonaClient } from './daytona-machine.mjs'
import { runIndexer } from './indexer.mjs'
import { runJob } from './worker.mjs'

// The always-on controller: the signed API, the single-writer lease, and the dispatch loop, in one
// process that can run on any host (this Mac, a VPS, a container). Only the lease holder
// dispatches; a standby keeps trying to take the lease, so a crashed controller is replaced without
// anyone sending a task twice (the dispatched flag and the row lock still guard the hand-off).
export async function startController({
  pool, principals, embedder, localEmbedder, localTenants = [], objectStore, provider,
  machines = createDaytonaMachineManager({ client: mockDaytonaClient() }),
  machineMessageHandler, approvedSnapshots,
  workerPrincipal = 'worker', instance = `ctl-${process.pid}`,
  host = '127.0.0.1', port = 0, intervalMs = 2000, bucket, log = () => {},
}) {
  // Tenants in localTenants never reach an external embedding provider: not their events, not their queries.
  await machines.rehydrate?.()
  const embedderFor = tenant => (localEmbedder && localTenants.includes(tenant) ? localEmbedder : embedder)
  const api = createApi({ pool, embedder, embedderFor, principals, objectStore, machines, messageHandler: machineMessageHandler, approvedSnapshots, ready: async () => { await pool.query('select 1'); return true } })
  const server = await api.listen(port, host)
  const base = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${server.address().port}`
  const tenants = [...new Set(Object.values(principals).flatMap(p => p.tenants))]
  let lease
  let stopped = false
  let ticking = false
  const state = { dispatched: 0, failed: 0, writer: false }

  async function tick() {
    if (stopped || ticking) return
    ticking = true
    try {
      if (!lease?.held) lease = await acquireWriterLease(pool, instance)
      state.writer = lease.held === true
      if (!state.writer) return
      const tasks = []
      await dispatchPending(pool, { tenants, lease, send: async t => { tasks.push(t) } })
      for (const task of tasks) {
        state.dispatched += 1
        const as = apiClient({ baseUrl: base, principal: workerPrincipal, secret: principals[workerPrincipal].secret, tenant: task.tenant })
        try {
          await runJob({ provider, objectStore, api: as, bucket, task })
          log('job-finished', task.run_id)
        } catch (error) {
          state.failed += 1
          log('job-failed', task.run_id, String(error.message).slice(0, 120))
        }
      }
      // Recorded events become searchable here. Only the writer indexes, so one event is never
      // embedded twice; an embedding outage leaves the event on retry and search stays lexical.
      for (const tenant of tenants) {
        const stats = await runIndexer(pool, tenant, embedderFor(tenant))
        if (stats.indexed > 0) { state.indexed = (state.indexed ?? 0) + stats.indexed; log('indexed', tenant, stats.indexed, stats.embedFailed ? `embed-failed=${stats.embedFailed}` : '') }
      }
      await machines.rehydrate?.()
      for (const machine of machines.listMachines()) {
        const idle = await machines.checkIdleAndSchedule(machine.id)
        if (idle.action === 'slept') {
          state.machinesSlept = (state.machinesSlept ?? 0) + 1
          log('machine-slept', machine.id)
        } else if (idle.action === 'pre-woke') {
          state.machinesPreWoke = (state.machinesPreWoke ?? 0) + 1
          log('machine-pre-woke', machine.id)
        }
      }
    } catch (error) {
      log('tick-error', String(error.message).slice(0, 120))
    } finally { ticking = false }
  }

  const timer = setInterval(() => { void tick() }, intervalMs)
  void tick()
  return {
    server, base, state, machines, tick,
    async stop() {
      stopped = true
      clearInterval(timer)
      server.close()
      await lease?.release?.()
    },
  }
}
