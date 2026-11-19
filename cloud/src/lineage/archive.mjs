// The lineage archive writer: one SQLite file, written only by the bridge. Upserts keep a
// revision number so the cloud can ship each change once and never lose an earlier one.
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_SQL, SCHEMA_VERSION, TRACKED } from './schema.mjs'

export class ArchiveError extends Error {}

const COLUMNS = {
  bots: ['id', 'name', 'private', 'updated_at'],
  rooms: ['id', 'name', 'updated_at'],
  session_owners: ['session_id', 'bot_id', 'room_id', 'kind'],
  tasks: ['id', 'category', 'assigned_by', 'assigned_to', 'exchange_id', 'created_at', 'status', 'completed_at', 'ref', 'updated_at'],
  runs: ['id', 'task_id', 'bot_id', 'session_id', 'turn', 'role', 'started_at', 'ended_at', 'outcome', 'ref'],
  events: ['id', 'rev', 'kind', 'task_id', 'run_id', 'actor', 'target', 'room_id', 'at', 'session_id', 'seq', 'ref', 'meta', 'updated_at'],
  authorizations: ['id', 'rev', 'at', 'actor', 'target', 'room_id', 'action', 'outcome', 'reason', 'source', 'task_id', 'run_id', 'session_id', 'seq', 'ref', 'updated_at'],
  artifacts: ['id', 'task_id', 'kind', 'ref', 'sha256', 'bytes', 'at'],
  cursors: ['source', 'value'],
  sync: ['id', 'at', 'counts'],
}
const KEY = { session_owners: 'session_id', cursors: 'source' }
const STATUS_RANK = { assigned: 1, working: 2, replied: 3, reviewed: 3, completed: 4 }
const DECIDED = new Set(['allowed', 'denied', 'policy'])

export function openArchive(path, { readOnly = false } = {}) {
  const db = new DatabaseSync(path, readOnly ? { readOnly: true } : {})
  const version = db.prepare('PRAGMA user_version').get().user_version
  if (version !== 0 && version !== SCHEMA_VERSION) { db.close(); throw new ArchiveError(`lineage archive has schema version ${version}; this bridge writes version ${SCHEMA_VERSION}`) }
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL')
    if (version === 0) {
      db.exec(SCHEMA_SQL)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('format', 'dsbot-lineage'), ('schema', ?)").run(String(SCHEMA_VERSION))
    }
  } else if (version !== SCHEMA_VERSION) { db.close(); throw new ArchiveError('lineage archive is empty or not initialised') }

  const stmts = new Map()
  const prep = sql => { if (!stmts.has(sql)) stmts.set(sql, db.prepare(sql)); return stmts.get(sql) }
  const changed = { events: 0, authorizations: 0 }

  function put(table, row) {
    const cols = COLUMNS[table]
    if (!cols) throw new ArchiveError(`unknown table ${table}`)
    const key = KEY[table] ?? 'id'
    const values = cols.map(c => row[c] ?? null)
    const set = cols.filter(c => c !== key).map(c => `${c} = excluded.${c}`).join(', ')
    prep(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT(${key}) DO UPDATE SET ${set}`).run(...values)
  }

  // events and authorizations: rev grows by one on a change to a tracked field; a decided
  // outcome never goes back to pending; a known task or run link is never erased.
  function upsert(table, row, now = Date.now()) {
    if (table !== 'events' && table !== 'authorizations') {
      if (table === 'tasks') {
        const old = prep('SELECT status, completed_at FROM tasks WHERE id = ?').get(row.id)
        if (old && (STATUS_RANK[old.status] ?? 0) >= (STATUS_RANK[row.status] ?? 0)) row = { ...row, status: old.status, completed_at: old.completed_at ?? row.completed_at }
      }
      return put(table, row)
    }
    const old = prep(`SELECT * FROM ${table} WHERE id = ?`).get(row.id)
    if (!old) { put(table, { ...row, rev: 1, updated_at: now }); changed[table] += 1; return 'inserted' }
    const next = { ...row }
    if (table === 'authorizations' && DECIDED.has(old.outcome) && next.outcome === 'pending') { next.outcome = old.outcome; next.reason = old.reason; next.at = old.at; next.seq = old.seq }
    for (const f of ['task_id', 'run_id']) if (next[f] == null && old[f] != null) next[f] = old[f]
    const differs = TRACKED.some(f => f in old && (next[f] ?? null) !== (old[f] ?? null))
    const otherDiffers = COLUMNS[table].some(c => !['rev', 'updated_at'].includes(c) && (next[c] ?? null) !== (old[c] ?? null))
    if (!differs && !otherDiffers) return 'unchanged'
    put(table, { ...next, rev: differs ? old.rev + 1 : old.rev, updated_at: now })
    if (differs) changed[table] += 1
    return differs ? 'revised' : 'updated'
  }

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE')
    try { const out = fn(); db.exec('COMMIT'); return out } catch (error) { db.exec('ROLLBACK'); throw error }
  }

  const count = table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
  const cursor = source => { const r = prep('SELECT value FROM cursors WHERE source = ?').get(source); return r ? JSON.parse(r.value) : undefined }
  return { db, upsert, put, tx, count, cursor, changed, close: () => db.close() }
}
