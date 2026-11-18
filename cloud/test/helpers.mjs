import { randomBytes } from 'node:crypto'
import { pgStart } from '../scripts/pg.mjs'
import { adminUrl, appUrl, makePool } from '../src/db.mjs'
import { migrate } from '../src/migrate.mjs'
import { sha256 } from '../src/ingest.mjs'

// A fresh database per test file, on the throwaway local Postgres, owned by `postgres`
// and used through the restricted application role, exactly as the services will be.
export async function freshDb() {
  pgStart()
  const name = `t_${randomBytes(5).toString('hex')}`
  await migrate(name)
  const pool = makePool(appUrl(name))
  const admin = makePool(adminUrl(name), 2)
  const drop = async () => {
    await pool.end().catch(() => {})
    await admin.end().catch(() => {})
    const root = makePool(adminUrl(), 1)
    await root.query(`drop database if exists ${name} with (force)`)
    await root.end()
  }
  return { name, pool, admin, drop }
}

let seq = 0
export function envelope(over = {}) {
  seq += 1
  return {
    schema_version: 1, tenant_id: 'tenant-a', project_id: 'proj', event_id: `evt-${seq}`, run_id: 'run-1', task_id: 'task-1',
    agent_id: 'capy', session_id: 'session-1', trace_id: 'trace-1', kind: 'review.verdict', occurred_at: '2026-11-18T12:00:00Z',
    claimed_outcome: 'completed', source_system: 'dsh-session', source_id: 'session-1', source_seq: seq,
    source_sha256: sha256(`src-${seq}`), body: { summary: 'review finished' }, ...over,
  }
}
