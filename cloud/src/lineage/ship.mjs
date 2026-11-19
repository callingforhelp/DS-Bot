// Ships lineage envelopes to the controller in order, at most 100 per batch, and remembers
// what the controller has. A conflict, an error or an unexpected status stops the pass without
// marking anything after the last success, so the next pass resumes from the same point.
// Logs carry counts and HTTP statuses only: never bodies, names or references.
import { DatabaseSync } from 'node:sqlite'

export function openShipState(path) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS shipped (event_id TEXT PRIMARY KEY, sha TEXT NOT NULL, at INTEGER)')
  return db
}

export async function shipOnce({ envelopes, statePath, state, post, batchSize = 100, log = () => {}, now = Date.now }) {
  const db = state ?? openShipState(statePath)
  const counts = { sent: 0, inserted: 0, alreadyPresent: 0, conflicts: 0, errors: 0, skippedUnknown: 0 }
  const seen = db.prepare('SELECT 1 FROM shipped WHERE event_id = ?')
  const mark = db.prepare('INSERT OR IGNORE INTO shipped (event_id, sha, at) VALUES (?, ?, ?)')
  let batchRoute = true
  const record = (env, r) => {
    if (r.inserted === true) counts.inserted += 1
    else counts.alreadyPresent += 1
    mark.run(env.event_id, env.source_sha256, now())
  }
  // Returns false when the pass must stop.
  async function send(batch) {
    counts.sent += batch.length
    if (batchRoute) {
      const res = await post('POST', '/v1/events/batch', { events: batch })
      if (res.status === 404) { batchRoute = false; log('batch route missing (404); sending one by one'); counts.sent -= batch.length; return send(batch) }
      if (res.status !== 200 || !Array.isArray(res.body?.results)) { counts.errors += 1; log(`batch refused: HTTP ${res.status}`); return false }
      for (const [i, r] of res.body.results.entries()) {
        if (r.conflict) { counts.conflicts += 1; log('conflict: stopping this pass'); return false }
        if (r.error || r.skipped) { counts.errors += 1; log('batch item refused: stopping this pass'); return false }
        record(batch[i], r)
      }
      return true
    }
    for (const env of batch) {
      const res = await post('POST', '/v1/events', env)
      if (res.status === 409) { counts.conflicts += 1; log('conflict (HTTP 409): stopping this pass'); return false }
      if (res.status !== 200) { counts.errors += 1; log(`event refused: HTTP ${res.status}`); return false }
      record(env, res.body ?? {})
    }
    return true
  }
  try {
    let batch = []
    for (const env of envelopes) {
      if (!env?.event_id || !env?.source_sha256) { counts.skippedUnknown += 1; continue }
      if (seen.get(env.event_id)) continue
      batch.push(env)
      if (batch.length >= batchSize) { if (!(await send(batch))) return counts; batch = [] }
    }
    if (batch.length > 0) await send(batch)
    return counts
  } finally { if (!state) db.close() }
}
