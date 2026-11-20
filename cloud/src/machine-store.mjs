import { withScope } from './db.mjs'

// Postgres-backed persistence for Daytona machine records. Every read and write runs inside
// withScope(pool, { tenant }) so row-level security isolates tenants on every query.
export function pgMachineStore({ pool, tenants = [] }) {
  return {
    async loadAll() {
      const rows = []
      for (const tenant of tenants) {
        await withScope(pool, { tenant }, async (c) => {
          const res = await c.query(
            `select tenant_id, machine_id, name, size, state, idle_minutes, keep_awake,
                    next_scheduled_at, labels, pending_resize, cache, epoch, seq, last_activity_at
               from machines
              where tenant_id = $1
              order by created_at asc`,
            [tenant],
          )
          for (const r of res.rows) {
            rows.push({
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
              lastActivityAt: Number(r.last_activity_at),
            })
          }
        })
      }
      return rows
    },

    async save(record) {
      const tenant = record.tenantId ?? record.labels?.tenant_id ?? 'default'
      await withScope(pool, { tenant }, async (c) => {
        await c.query(
          `insert into machines (
             tenant_id, machine_id, name, size, state, idle_minutes, keep_awake,
             next_scheduled_at, labels, pending_resize, cache, epoch, seq, last_activity_at, updated_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
           on conflict (machine_id) do update set
             name = excluded.name,
             size = excluded.size,
             state = excluded.state,
             idle_minutes = excluded.idle_minutes,
             keep_awake = excluded.keep_awake,
             next_scheduled_at = excluded.next_scheduled_at,
             labels = excluded.labels,
             pending_resize = excluded.pending_resize,
             cache = excluded.cache,
             epoch = excluded.epoch,
             seq = excluded.seq,
             last_activity_at = excluded.last_activity_at,
             updated_at = now()`,
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
