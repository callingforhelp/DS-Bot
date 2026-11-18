import { withScope } from './db.mjs'

const LEASE_KEY = 'ds-bot-cloud-writer'

// One writable controller. The lease is a Postgres advisory lock held on a connection that
// stays open for the controller's life: a second controller (or a stale one after a
// partition) cannot take it while the first is alive, and it frees itself when the first dies.
export async function acquireWriterLease(pool, instance) {
  const client = await pool.connect()
  const { rows } = await client.query('select pg_try_advisory_lock(hashtext($1)) as ok', [LEASE_KEY])
  if (!rows[0].ok) { client.release(); return { held: false, instance } }
  return {
    held: true,
    instance,
    release: async () => { await client.query('select pg_advisory_unlock(hashtext($1))', [LEASE_KEY]).catch(() => {}); client.release() },
  }
}

// Where a job runs. Cloud work never waits for the Mac: a job that needs the Mac while it is
// offline is deferred and reported, while everything else goes to a Daytona sandbox.
export function route(job, { macSeenAt, now = Date.now, macTtlMs = 30_000 } = {}) {
  if (job?.needs === 'mac') return now() - (macSeenAt ?? 0) <= macTtlMs ? 'mac' : 'deferred'
  return 'daytona'
}

// Dispatches admitted tasks that were never sent. Run on start and on a timer, so a restart
// between admission and dispatch loses nothing; only the lease holder dispatches, and the
// row lock plus the dispatched flag keep one task from being sent twice.
export async function dispatchPending(pool, { tenants, lease, send, macSeenAt, now }) {
  if (!lease?.held) return { dispatched: 0, skipped: 'not the writer' }
  let dispatched = 0
  for (const tenant of tenants) {
    await withScope(pool, { tenant }, async (c) => {
      const { rows } = await c.query('select * from tasks_admitted where tenant_id = $1 and dispatched = false order by created_at for update skip locked limit 20', [tenant])
      for (const task of rows) {
        const where = route(task.job, { macSeenAt, now })
        if (where !== 'deferred') await send({ tenant, project: task.project_id, run_id: task.run_id, job: task.job, route: where })
        await c.query('update tasks_admitted set dispatched = $3, route = $4 where tenant_id = $1 and idempotency_key = $2', [tenant, task.idempotency_key, where !== 'deferred', where])
        if (where !== 'deferred') dispatched += 1
      }
    })
  }
  return { dispatched }
}
