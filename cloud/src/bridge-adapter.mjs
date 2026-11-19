import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { POLICY_REASONS } from './lineage/refusals.mjs'

// Turns a lineage archive (schema v1, written by src/lineage) into event envelopes (contract C3).
// Keys are stable per archive row and revision: source_id names the row, source_seq is its
// rev, so a replay inserts nothing and a revised row inserts exactly one new event. The file
// is opened read-only and holds no chat text.
export class LineageError extends Error {}

const sha = s => createHash('sha256').update(String(s)).digest('hex')
const canonical = v => (v === null || typeof v !== 'object') ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
    : `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
const EVENT_KINDS = new Set(['task.assigned', 'message.requested', 'message.delivered', 'message.replied', 'review.verdict', 'task.completed'])
const REQUIRED = {
  events: ['id', 'rev', 'kind', 'task_id', 'run_id', 'actor', 'target', 'room_id', 'at', 'session_id', 'seq', 'ref', 'meta'],
  authorizations: ['id', 'rev', 'at', 'actor', 'target', 'room_id', 'action', 'outcome', 'reason', 'source', 'task_id', 'session_id', 'seq', 'ref'],
  bots: ['id', 'name', 'private'],
  rooms: ['id', 'name'],
}
const META_KEYS = ['category', 'hops', 'exchangeId', 'replyTo']

export function* envelopesFromLineage(path, { tenant, project, installId, stats = {} }) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(installId ?? '')) throw new LineageError('installId must match ^[a-z0-9][a-z0-9-]{0,39}$')
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version
    if (version !== 1) throw new LineageError(`lineage archive schema version ${version}; expected 1`)
    for (const [table, cols] of Object.entries(REQUIRED)) {
      const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name))
      const missing = cols.filter(c => !have.has(c))
      if (missing.length) throw new LineageError(`lineage table ${table} lacks ${missing.join(', ')}`)
    }
    const bots = new Map(db.prepare('SELECT id, name, private FROM bots').all().map(b => [b.id, b]))
    const rooms = new Map(db.prepare('SELECT id, name FROM rooms').all().map(r => [r.id, r]))
    const nameOf = id => (id && !String(id).startsWith('unresolved:') ? bots.get(id)?.name ?? null : null) ?? 'unknown'
    const isPrivate = id => id != null && bots.get(id)?.private === 1
    const when = (table, row) => {
      if (!Number.isSafeInteger(row.at) || row.at <= 1e12) throw new LineageError(`lineage ${table} row ${row.id} has no millisecond time`)
      return new Date(row.at).toISOString()
    }
    const base = (row, sourceId, table) => {
      const env = {
        schema_version: 1, tenant_id: tenant, project_id: project,
        event_id: `${sourceId}:r${row.rev}`,
        run_id: row.task_id ? `dsbot-task:${row.task_id}` : row.session_id ? `dsbot-session:${row.session_id}` : `dsbot-unattributed:${installId}`,
        task_id: row.task_id ?? undefined, agent_id: row.actor ? `dsbot:${row.actor}` : undefined,
        session_id: row.session_id ?? undefined, trace_id: row.task_id ? `dsbot-trace:${row.task_id}` : undefined,
        occurred_at: when(table, row), source_system: 'ds-bot-lineage', source_id: sourceId, source_seq: row.rev,
        private_agent_id: isPrivate(row.actor) ? `dsbot:${row.actor}` : isPrivate(row.target) ? `dsbot:${row.target}` : undefined,
      }
      return env
    }
    const finish = env => {
      for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k]
      env.source_sha256 = sha(canonical(env))
      return env
    }
    const roomName = id => (id ? rooms.get(id)?.name ?? null : null)
    stats.skippedKinds = 0
    stats.pending = 0

    for (const row of db.prepare('SELECT * FROM events ORDER BY at, id').all()) {
      if (!EVENT_KINDS.has(row.kind)) { stats.skippedKinds += 1; continue }
      const env = base(row, `dsbot:${installId}:ev:${row.id}`, 'events')
      let meta
      try { meta = row.meta ? JSON.parse(row.meta) : undefined } catch { meta = undefined }
      const kept = meta && Object.fromEntries(META_KEYS.filter(k => meta[k] !== undefined && meta[k] !== null).map(k => [k, meta[k]]))
      env.kind = row.kind
      env.body = {
        summary: `${nameOf(row.actor)} ${row.kind.replace(/\./g, ' ')} ${row.target ? nameOf(row.target) : ''}`.trim(),
        ref: row.ref ?? null, lineage_rev: row.rev, lineage_version: 1,
        actor_name: row.actor ? nameOf(row.actor) : undefined, target: row.target ?? undefined, target_name: row.target ? nameOf(row.target) : undefined,
        room_id: row.room_id ?? undefined, room_name: roomName(row.room_id) ?? undefined, session_seq: row.seq ?? undefined,
        meta: kept && Object.keys(kept).length ? kept : undefined,
      }
      yield finish(env)
    }
    for (const row of db.prepare('SELECT * FROM authorizations ORDER BY at, id').all()) {
      if (row.outcome === 'pending') { stats.pending += 1; continue }
      const sourceId = `dsbot:${installId}:auth:${row.id}`
      const env = base(row, sourceId, 'authorizations')
      const word = row.outcome === 'denied' ? 'denied' : row.outcome === 'allowed' ? 'allowed' : 'policy'
      const room = roomName(row.room_id)
      env.kind = `authorization.${word}`
      env.body = {
        summary: `authorization ${word} ${row.action} by ${nameOf(row.actor)} to ${row.target ? nameOf(row.target) : 'unknown'}${room ? ` in ${room}` : ''}: ${row.reason ?? 'no reason recorded'}`,
        ref: row.ref ?? null, lineage_rev: row.rev, lineage_version: 1,
        action: row.action, outcome: row.outcome, reason: row.reason ?? undefined, source: row.source,
        actor_name: row.actor ? nameOf(row.actor) : undefined, target: row.target ?? undefined, target_name: row.target ? nameOf(row.target) : undefined,
        room_id: row.room_id ?? undefined, room_name: room ?? undefined, session_seq: row.seq ?? undefined,
      }
      if (word !== 'policy') {
        env.authorization = {
          auth_id: sourceId, actor: `dsbot:${row.actor ?? 'unknown'}`, action: row.action,
          scope: POLICY_REASONS.has(row.reason) ? 'dsbot.bot-response' : `dsbot.tool:${row.action}`,
          target: row.target ? `dsbot:${row.target}` : null, room_id: row.room_id ?? null,
          verdict: word === 'denied' ? 'deny' : 'allow', reason: row.reason ?? (word === 'denied' ? 'denied (no reason recorded)' : 'allowed'),
        }
      }
      yield finish(env)
    }
  } finally { db.close() }
}
