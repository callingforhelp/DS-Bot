import { withScope } from './db.mjs'

function maxLeaseUntil(leases) {
  if (!leases || typeof leases !== 'object') return null
  let max = null
  for (const v of Object.values(leases)) {
    const n = Number(v)
    if (Number.isFinite(n) && (max === null || n > max)) max = n
  }
  return max
}

function pruneLeases(leases, at) {
  const next = {}
  if (!leases || typeof leases !== 'object') return next
  for (const [k, v] of Object.entries(leases)) {
    const n = Number(v)
    if (Number.isFinite(n) && n > at) next[k] = n
  }
  return next
}

function rowToRecord(r) {
  return {
    tenantId: r.tenant_id,
    id: r.machine_id,
    name: r.name,
    size: r.size,
    state: r.state,
    idleMinutes: r.idle_minutes,
    keepAwake: r.keep_awake,
    nextScheduledAt: r.next_scheduled_at === null ? null : Number(r.next_scheduled_at),
    labels: r.labels ?? {},
    pendingResize: r.pending_resize ?? null,
    cache: r.cache ?? {},
    epoch: r.epoch,
    seq: r.seq,
    version: Number(r.version ?? 1),
    busyUntil: maxLeaseUntil(r.job_leases),
    lastActivityAt: Number(r.last_activity_at),
  }
}

// Postgres-backed persistence for Daytona machine records. Every read and write runs inside
// withScope(pool, { tenant }) so row-level security isolates tenants on every query, and
// optimistic version checks prevent stale controllers from overwriting newer state.
export function pgMachineStore({ pool, tenants = [] }) {
  return {
    async loadAll() {
      const rows = []
      for (const tenant of tenants) {
        await withScope(pool, { tenant }, async (c) => {
          const res = await c.query(
            `select tenant_id, machine_id, name, size, state, idle_minutes, keep_awake,
                    next_scheduled_at, labels, pending_resize, cache, epoch, seq, version, job_leases, last_activity_at
               from machines
              where tenant_id = $1
              order by created_at asc`,
            [tenant],
          )
          for (const r of res.rows) rows.push(rowToRecord(r))
        })
      }
      return rows
    },

    async loadOne(machineId, tenantId) {
      const tenant = tenantId ?? 'default'
      return withScope(pool, { tenant }, async (c) => {
        const res = await c.query(
          `select tenant_id, machine_id, name, size, state, idle_minutes, keep_awake,
                  next_scheduled_at, labels, pending_resize, cache, epoch, seq, version, job_leases, last_activity_at
             from machines
            where tenant_id = $1 and machine_id = $2`,
          [tenant, machineId],
        )
        return res.rowCount > 0 ? rowToRecord(res.rows[0]) : null
      })
    },

    async save(record) {
      const tenant = record.tenantId ?? record.labels?.tenant_id ?? 'default'
      return withScope(pool, { tenant }, async (c) => {
        if (record.version === undefined || record.version === null) {
          const res = await c.query(
            `insert into machines (
               tenant_id, machine_id, name, size, state, idle_minutes, keep_awake,
               next_scheduled_at, labels, pending_resize, cache, epoch, seq, version, last_activity_at, updated_at
             ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,now())
             on conflict (machine_id) do nothing
             returning version`,
            [
              tenant,
              record.id,
              record.name,
              record.size,
              record.state,
              record.idleMinutes,
              Boolean(record.keepAwake),
              record.nextScheduledAt ?? null,
              JSON.stringify(record.labels ?? {}),
              record.pendingResize ? JSON.stringify(record.pendingResize) : null,
              JSON.stringify(record.cache ?? {}),
              record.epoch ?? 1,
              record.seq ?? 0,
              record.lastActivityAt,
            ],
          )
          if (res.rowCount === 0) {
            const err = new Error(`machine ${record.id} already exists`)
            err.code = 'MACHINE_VERSION_CONFLICT'
            throw err
          }
          return { version: Number(res.rows[0].version) }
        }

        const res = await c.query(
          `update machines set
             name = $3,
             size = $4,
             state = $5,
             idle_minutes = $6,
             keep_awake = $7,
             next_scheduled_at = $8,
             labels = $9,
             pending_resize = $10,
             cache = $11,
             epoch = $12,
             seq = $13,
             last_activity_at = $14,
             version = machines.version + 1,
             updated_at = now()
           where tenant_id = $1 and machine_id = $2 and version = $15
           returning version`,
          [
            tenant,
            record.id,
            record.name,
            record.size,
            record.state,
            record.idleMinutes,
            Boolean(record.keepAwake),
            record.nextScheduledAt ?? null,
            JSON.stringify(record.labels ?? {}),
            record.pendingResize ? JSON.stringify(record.pendingResize) : null,
            JSON.stringify(record.cache ?? {}),
            record.epoch ?? 1,
            record.seq ?? 0,
            record.lastActivityAt,
            record.version,
          ],
        )
        if (res.rowCount === 0) {
          const err = new Error(`stale machine version for ${record.id} (expected ${record.version})`)
          err.code = 'MACHINE_VERSION_CONFLICT'
          throw err
        }
        return { version: Number(res.rows[0].version) }
      })
    },

    async beginJob(machineId, tenantId, jobId, at, leaseMs = 5 * 60_000) {
      const tenant = tenantId ?? 'default'
      const nowAt = Number(at)
      const expiresAt = nowAt + Number(leaseMs)
      await withScope(pool, { tenant }, async (c) => {
        const cur = await c.query('select job_leases, sleep_lease from machines where tenant_id = $1 and machine_id = $2 for update', [tenant, machineId])
        if (cur.rowCount === 0) return
        const sl = cur.rows[0].sleep_lease
        if (sl && Number(sl.expiresAt) > nowAt && sl.phase === 'stopping') {
          const err = new Error(`machine ${machineId} is currently stopping`)
          err.code = 'MACHINE_SLEEPING'
          throw err
        }
        const leases = pruneLeases(cur.rows[0].job_leases, nowAt)
        leases[jobId] = expiresAt
        await c.query(
          `update machines
              set job_leases = $3::jsonb,
                  sleep_lease = null,
                  last_activity_at = greatest(last_activity_at, $4::bigint),
                  updated_at = now()
            where tenant_id = $1 and machine_id = $2`,
          [tenant, machineId, JSON.stringify(leases), nowAt],
        )
      })
    },

    async beginSleep(machineId, tenantId, token, at, ttlMs = 60_000) {
      const tenant = tenantId ?? 'default'
      const nowAt = Number(at)
      return withScope(pool, { tenant }, async (c) => {
        const cur = await c.query('select job_leases, sleep_lease from machines where tenant_id = $1 and machine_id = $2 for update', [tenant, machineId])
        if (cur.rowCount === 0) return { ok: false, reason: 'deleted' }
        const leases = pruneLeases(cur.rows[0].job_leases, nowAt)
        if (Object.keys(leases).length > 0) return { ok: false, reason: 'busy' }
        const sl = cur.rows[0].sleep_lease
        if (sl && Number(sl.expiresAt) > nowAt && sl.token !== token) return { ok: false, reason: 'busy' }
        await c.query(
          `update machines set sleep_lease = $3::jsonb, updated_at = now() where tenant_id = $1 and machine_id = $2`,
          [tenant, machineId, JSON.stringify({ token, phase: 'capturing', expiresAt: nowAt + Number(ttlMs) })],
        )
        return { ok: true }
      })
    },

    async commitSleep(machineId, tenantId, token, at, ttlMs = 60_000) {
      const tenant = tenantId ?? 'default'
      const nowAt = Number(at)
      return withScope(pool, { tenant }, async (c) => {
        const cur = await c.query('select job_leases, sleep_lease from machines where tenant_id = $1 and machine_id = $2 for update', [tenant, machineId])
        if (cur.rowCount === 0) return { ok: false, reason: 'deleted' }
        const leases = pruneLeases(cur.rows[0].job_leases, nowAt)
        const sl = cur.rows[0].sleep_lease
        if (Object.keys(leases).length > 0 || !sl || sl.token !== token || Number(sl.expiresAt) <= nowAt) {
          return { ok: false, reason: 'aborted' }
        }
        await c.query(
          `update machines set sleep_lease = $3::jsonb, updated_at = now() where tenant_id = $1 and machine_id = $2`,
          [tenant, machineId, JSON.stringify({ token, phase: 'stopping', expiresAt: nowAt + Number(ttlMs) })],
        )
        return { ok: true }
      })
    },

    async endSleep(machineId, tenantId, token) {
      const tenant = tenantId ?? 'default'
      await withScope(pool, { tenant }, async (c) => {
        await c.query(
          `update machines
              set sleep_lease = case when sleep_lease->>'token' = $3 then null else sleep_lease end,
                  updated_at = now()
            where tenant_id = $1 and machine_id = $2`,
          [tenant, machineId, token],
        )
      })
    },

    async renewJob(machineId, tenantId, jobId, at, leaseMs = 5 * 60_000) {
      const tenant = tenantId ?? 'default'
      const nowAt = Number(at)
      const expiresAt = nowAt + Number(leaseMs)
      await withScope(pool, { tenant }, async (c) => {
        const cur = await c.query('select job_leases from machines where tenant_id = $1 and machine_id = $2 for update', [tenant, machineId])
        if (cur.rowCount === 0) return
        const leases = pruneLeases(cur.rows[0].job_leases, nowAt)
        leases[jobId] = expiresAt
        await c.query(
          `update machines
              set job_leases = $3::jsonb,
                  last_activity_at = greatest(last_activity_at, $4::bigint),
                  updated_at = now()
            where tenant_id = $1 and machine_id = $2`,
          [tenant, machineId, JSON.stringify(leases), nowAt],
        )
      })
    },

    async endJob(machineId, tenantId, jobId, at) {
      const tenant = tenantId ?? 'default'
      const nowAt = Number(at)
      await withScope(pool, { tenant }, async (c) => {
        const cur = await c.query('select job_leases from machines where tenant_id = $1 and machine_id = $2 for update', [tenant, machineId])
        if (cur.rowCount === 0) return
        const leases = pruneLeases(cur.rows[0].job_leases, nowAt)
        delete leases[jobId]
        await c.query(
          `update machines
              set job_leases = $3::jsonb,
                  last_activity_at = greatest(last_activity_at, $4::bigint),
                  updated_at = now()
            where tenant_id = $1 and machine_id = $2`,
          [tenant, machineId, JSON.stringify(leases), nowAt],
        )
      })
    },

    async remove(machineId, tenantId) {
      const tenant = tenantId ?? 'default'
      await withScope(pool, { tenant }, async (c) => {
        await c.query('delete from machines where tenant_id = $1 and machine_id = $2', [tenant, machineId])
      })
    },
  }
}
