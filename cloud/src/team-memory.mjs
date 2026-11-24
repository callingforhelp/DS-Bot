import { randomUUID } from 'node:crypto'
import { withScope, vectorLiteral } from './db.mjs'
import { authorizeAction, recordHumanApproval, requireOrgRole } from './authz.mjs'
import { redact } from './redact.mjs'

// Team memory: device sync, hybrid search, code provenance, takeover, forget/restore, the shared
// skill/artifact library and a Streamable HTTP MCP router. Original DS Bot code (Apache-2.0).

export const RRF_K = 60
export const MCP_PROTOCOL_VERSION = '2025-06-18'
const MAX_OPS = 200
const FUTURE_SKEW_MS = 5 * 60_000

export class TeamMemoryError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
const bad = message => new TeamMemoryError(400, message)

// Entities a device may push. `text` columns are redacted server-side; `cols` is the whitelist.
const ENTITIES = {
  memory: { table: 'memories', id: 'memory_id', cols: ['project_id', 'bot_id', 'scope', 'title', 'body', 'tags'], text: ['title', 'body'], clock: 'updated_at_ms' },
  observation: { table: 'observations', id: 'observation_id', cols: ['project_id', 'session_id', 'bot_id', 'kind', 'text', 'occurred_at_ms'], text: ['text'], clock: 'occurred_at_ms' },
  turn: { table: 'transcript_turns', id: 'turn_id', cols: ['project_id', 'session_id', 'bot_id', 'seq', 'role', 'text', 'occurred_at_ms'], text: ['text'], clock: 'occurred_at_ms' },
  provenance: { table: 'code_provenance', id: 'provenance_id', cols: ['project_id', 'session_id', 'turn_id', 'bot_id', 'repo', 'commit_sha', 'pr_url', 'path', 'summary', 'occurred_at_ms'], text: ['summary', 'repo', 'pr_url', 'path'], clock: 'occurred_at_ms' },
}
const NOT_NULL_DEFAULTS = { title: '', kind: 'note', summary: '', scope: 'project', tags: [] }

const str = (v, name, { max = 200_000, optional = false } = {}) => {
  if (v === undefined || v === null) { if (optional) return null; throw bad(`missing ${name}`) }
  if (typeof v !== 'string' || (v === '' && !optional)) throw bad(`invalid ${name}`)
  if (v.length > max) throw bad(`${name} too long`)
  return v
}
const clampLimit = (v, def = 10) => Math.min(Math.max(Number.isInteger(v) ? v : def, 1), 50)
const ids = p => [...new Set([...(Array.isArray(p.bot_ids) ? p.bot_ids : []), ...(p.agent ? [p.agent] : [])])]

// Every request runs in one tenant-scoped transaction. app.bot_ids widens private-row visibility
// to exactly the bots this principal owns; it dies with the transaction.
function run(pool, p, fn, extra = {}) {
  return withScope(pool, { tenant: p.tenant, agent: p.agent ?? '', ...extra }, async c => {
    await c.query("select set_config('app.bot_ids', $1, true)", [ids(p).join(',')])
    return fn(c)
  })
}

// A protected action: the org role floor first, then the human-approval ledger. An authenticated
// human principal approves its own call; every other principal needs a prior human row.
async function gate(c, p, action, run_, scope) {
  requireOrgRole(p, action)
  if (p.role === 'human') await recordHumanApproval(c, { tenant: p.tenant, project: 'team-memory', run: run_, human: p.id, action, scope })
  const verdict = await authorizeAction(c, { tenant: p.tenant, project: 'team-memory', run: run_, actor: p.id, action, scope })
  return verdict.allow
}

async function logOp(c, p, { device, opId, entity, entityId, op, payload, privateAgent }) {
  const { rows } = await c.query(
    `insert into memory_sync_log (tenant_id, origin_device_id, origin_op_id, entity, entity_id, op, payload, private_agent_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (tenant_id, origin_device_id, origin_op_id) do nothing returning server_seq`,
    [p.tenant, device, opId, entity, entityId, op, JSON.stringify(payload), privateAgent ?? null])
  return rows[0]?.server_seq
}

// ---- sync ----------------------------------------------------------------------------------

async function checkDevice(c, p, input) {
  if (p.device_id && input.device_id && p.device_id !== input.device_id) throw new TeamMemoryError(403, 'device_id does not match the authenticated device')
  const device = p.device_id ?? str(input.device_id, 'device_id', { max: 100 })
  const { rows } = await c.query('select revoked_at from sync_devices where tenant_id = $1 and device_id = $2', [p.tenant, device])
  if (rows[0]?.revoked_at) throw new TeamMemoryError(403, 'device is revoked')
  await c.query(
    `insert into sync_devices (tenant_id, device_id, principal, last_seen_at) values ($1,$2,$3, now())
     on conflict (tenant_id, device_id) do update set last_seen_at = now()`, [p.tenant, device, p.id])
  return device
}

function cleanData(spec, raw) {
  const data = {}
  for (const col of spec.cols) {
    let v = raw?.[col]
    if (v === undefined || v === null) { if (col in NOT_NULL_DEFAULTS) v = NOT_NULL_DEFAULTS[col]; else continue }
    if (spec.text.includes(col) && typeof v === 'string') v = redact(v)
    if (col === 'tags') v = Array.isArray(v) ? v.filter(t => typeof t === 'string').slice(0, 32).map(t => redact(t).slice(0, 64)) : []
    data[col] = v
  }
  return data
}

async function applyOp(c, p, device, op, now) {
  const spec = ENTITIES[op?.entity]
  const opId = str(op?.op_id, 'op_id', { max: 200 })
  if (!spec) return { op_id: opId, status: 'rejected', reason: 'unknown entity' }
  if (op.op !== 'upsert' && op.op !== 'delete') return { op_id: opId, status: 'rejected', reason: 'unknown op' }
  const entityId = str(op.id, 'id', { max: 200 })
  const privateAgent = op.data?.private_agent_id ?? op.private_agent_id ?? null
  if (privateAgent !== null && (typeof privateAgent !== 'string' || !ids(p).includes(privateAgent))) return { op_id: opId, status: 'rejected', reason: 'private_agent_id is not owned by this principal' }
  const data = cleanData(spec, op.data)
  if (op.op === 'upsert') {
    if (spec.table === 'memories' && (typeof data.body !== 'string' || data.body === '')) return { op_id: opId, status: 'rejected', reason: 'missing body' }
    if (spec.table === 'memories' && Array.isArray(p.memory_scopes) && !p.memory_scopes.includes(data.scope)) return { op_id: opId, status: 'rejected', reason: 'scope not permitted' }
    if (spec.table !== 'memories' && spec.cols.includes('text') && typeof data.text !== 'string') return { op_id: opId, status: 'rejected', reason: 'missing text' }
    if (spec.table === 'transcript_turns' && (!data.session_id || !Number.isInteger(data.seq) || !data.role)) return { op_id: opId, status: 'rejected', reason: 'turn needs session_id, seq and role' }
  }
  const clock = Math.min(Number.isInteger(op.updated_at_ms) ? op.updated_at_ms : now, now + FUTURE_SKEW_MS)
  if (spec.clock === 'occurred_at_ms' && data.occurred_at_ms === undefined) data.occurred_at_ms = clock
  const seq = await logOp(c, p, { device, opId, entity: op.entity, entityId, op: op.op, payload: { id: entityId, updated_at_ms: clock, data }, privateAgent })
  if (seq === undefined) return { op_id: opId, status: 'duplicate' }

  if (spec.table === 'memories') return applyMemory(c, p, { device, opId, entityId, op: op.op, data, clock, privateAgent, seq })
  if (op.op === 'delete') {
    await c.query(`update ${spec.table} set deleted_at = now() where tenant_id = $1 and ${spec.id} = $2`, [p.tenant, entityId])
    return { op_id: opId, status: 'applied', server_seq: Number(seq) }
  }
  const cols = Object.keys(data)
  const { rowCount } = await c.query(
    `insert into ${spec.table} (tenant_id, ${spec.id}, ${cols.join(', ')}, private_agent_id, origin_device_id)
     values ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}, $${cols.length + 3}, $${cols.length + 4}) on conflict do nothing`,
    [p.tenant, entityId, ...cols.map(k => data[k]), privateAgent, device])
  if (rowCount > 0) await c.query('insert into memory_outbox (tenant_id, entity, entity_id) values ($1,$2,$3)', [p.tenant, op.entity, entityId])
  return { op_id: opId, status: rowCount > 0 ? 'applied' : 'superseded', server_seq: Number(seq) }
}

// Last-writer-wins on (updated_at_ms, origin_device_id). Every op leaves a revision, winner or not.
async function applyMemory(c, p, { device, opId, entityId, op, data, clock, privateAgent, seq }) {
  await c.query('select pg_advisory_xact_lock(hashtext($1))', [`${p.tenant}:memory:${entityId}`])
  let applied
  if (op === 'delete') {
    const r = await c.query(
      `update memories set deleted_at = now(), updated_at_ms = $3, origin_device_id = $4, version = version + 1
       where tenant_id = $1 and memory_id = $2 and (updated_at_ms, origin_device_id) < ($3, $4)`, [p.tenant, entityId, clock, device])
    applied = r.rowCount > 0
  } else {
    const r = await c.query(
      `insert into memories (tenant_id, memory_id, project_id, bot_id, scope, title, body, tags, updated_at_ms, origin_device_id, private_agent_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (tenant_id, memory_id) do update set project_id = excluded.project_id, bot_id = excluded.bot_id, scope = excluded.scope,
         title = excluded.title, body = excluded.body, tags = excluded.tags, updated_at_ms = excluded.updated_at_ms,
         origin_device_id = excluded.origin_device_id, version = memories.version + 1, deleted_at = null
       where (excluded.updated_at_ms, excluded.origin_device_id) > (memories.updated_at_ms, memories.origin_device_id)
       returning version`,
      [p.tenant, entityId, data.project_id ?? null, data.bot_id ?? null, data.scope ?? 'project', data.title ?? '', data.body, JSON.stringify(data.tags ?? []), clock, device, privateAgent])
    applied = r.rowCount > 0
    if (applied) await c.query('insert into memory_outbox (tenant_id, entity, entity_id) values ($1,$2,$3)', [p.tenant, 'memory', entityId])
  }
  const cur = (await c.query('select title, body from memories where tenant_id = $1 and memory_id = $2', [p.tenant, entityId])).rows[0]
  await c.query(
    `insert into memory_revisions (tenant_id, memory_id, revision, title, body, updated_at_ms, origin_device_id, origin_op_id, applied, private_agent_id)
     values ($1,$2,(select coalesce(max(revision), 0) + 1 from memory_revisions where tenant_id = $1 and memory_id = $2),$3,$4,$5,$6,$7,$8,$9)`,
    [p.tenant, entityId, op === 'delete' ? cur?.title ?? '' : data.title ?? '', op === 'delete' ? cur?.body ?? '' : data.body, clock, device, opId, applied, privateAgent])
  return { op_id: opId, status: applied ? 'applied' : 'superseded', server_seq: Number(seq) }
}

export async function syncPush(pool, p, input, { now = Date.now } = {}) {
  if (!Array.isArray(input?.ops)) throw bad('ops must be an array')
  if (input.ops.length > MAX_OPS) throw bad(`at most ${MAX_OPS} ops per push`)
  return run(pool, p, async c => {
    const device = await checkDevice(c, p, input)
    const results = []
    for (const op of input.ops) results.push(await applyOp(c, p, device, op, now()))
    return { device_id: device, results }
  })
}

export async function syncPull(pool, p, input) {
  const cursor = Number.isInteger(input?.cursor) && input.cursor >= 0 ? input.cursor : 0
  const limit = Math.min(Math.max(Number.isInteger(input?.limit) ? input.limit : 100, 1), 500)
  return run(pool, p, async c => {
    const device = await checkDevice(c, p, input ?? {})
    const own = input?.include_own === true
    const { rows } = await c.query(
      `select server_seq, origin_device_id, origin_op_id, entity, entity_id, op, payload from memory_sync_log
       where tenant_id = $1 and server_seq > $2 and ($3::boolean or origin_device_id <> $4) order by server_seq limit $5`,
      [p.tenant, cursor, own, device, limit + 1])
    const page = rows.slice(0, limit).map(r => ({ ...r, server_seq: Number(r.server_seq) }))
    const next = page.length ? page[page.length - 1].server_seq : cursor
    return { ops: page, cursor: next, has_more: rows.length > limit }
  })
}

export async function revokeDevice(pool, p, input) {
  const device = str(input?.device_id, 'device_id', { max: 100 })
  const out = await run(pool, p, async c => {
    if (!await gate(c, p, 'device.revoke', `device:${device}`, device)) return { denied: true }
    const r = await c.query('update sync_devices set revoked_at = now() where tenant_id = $1 and device_id = $2', [p.tenant, device])
    return { revoked: r.rowCount > 0 }
  })
  if (out.denied) throw new TeamMemoryError(403, 'approval-required')
  if (!out.revoked) throw new TeamMemoryError(404, 'unknown device')
  return { revoked: true, device_id: device }
}

// ---- search --------------------------------------------------------------------------------

const SEARCH = {
  memory: { table: 'memories', id: 'memory_id', title: 'title', text: 'body', bot: true, scoped: true },
  observation: { table: 'observations', id: 'observation_id', title: 'kind', text: 'text', bot: true },
  turn: { table: 'transcript_turns', id: 'turn_id', title: 'role', text: 'text', bot: true },
  provenance: { table: 'code_provenance', id: 'provenance_id', title: "coalesce(path, commit_sha, pr_url, '')", text: 'summary', bot: true },
  skill: { table: 'shared_skills', id: 'skill_id', title: 'name', text: 'description', org: true },
  artifact: { table: 'shared_artifacts', id: 'artifact_id', title: 'name', text: 'description' },
}

const vectorSeen = new WeakMap()
async function hasVectors(pool) {
  if (!vectorSeen.has(pool)) {
    const { rowCount } = await pool.query("select 1 from information_schema.columns where table_name = 'memories' and column_name = 'embedding_v'")
    vectorSeen.set(pool, rowCount > 0)
  }
  return vectorSeen.get(pool)
}

function where(spec, p, input, params) {
  const parts = ['tenant_id = $1', 'deleted_at is null']
  if (spec.scoped && Array.isArray(p.memory_scopes)) { params.push(p.memory_scopes); parts.push(`scope = any($${params.length})`) }
  if (spec.bot && typeof input.bot_id === 'string') { params.push(input.bot_id); parts.push(`bot_id = $${params.length}`) }
  if (spec.org) { params.push(p.org_id ?? null); parts.push(`(visibility = 'tenant' or org_id = $${params.length})`) }
  return parts.join(' and ')
}
const select = spec => `'${spec.kind}' as kind, ${spec.id} as id, ${spec.title} as title, left(${spec.text}, 400) as snippet`
for (const [kind, spec] of Object.entries(SEARCH)) spec.kind = kind

const words = q => [...new Set((redact(q).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(w => w.slice(0, 64)))].slice(0, 24)
const toTsQuery = terms => terms.length ? terms.map(t => `'${t.replace(/['\\]/g, '')}'`).join(' | ') : ''

export const rrf = (lists, k = RRF_K) => {
  const score = new Map()
  for (const list of lists) list.forEach((row, i) => {
    const key = `${row.kind}:${row.id}`
    const cur = score.get(key) ?? { row, score: 0 }
    cur.score += 1 / (k + i + 1)
    score.set(key, cur)
  })
  return [...score.values()].sort((a, b) => b.score - a.score || (a.row.id < b.row.id ? -1 : 1)).map(({ row, score: s }) => ({ ...row, score: s }))
}

export async function searchTeamMemory(pool, p, input, { embedder } = {}) {
  const query = redact(str(input?.query, 'query', { max: 2000 })).trim()
  if (query === '') throw bad('query is empty after redaction')
  const terms = words(query)
  const tsQueryStr = toTsQuery(terms)
  const limit = clampLimit(input.limit)
  const kinds = Array.isArray(input.kinds) && input.kinds.length ? input.kinds.filter(k => SEARCH[k]) : Object.keys(SEARCH)
  const poolN = limit * 4
  let qv = null
  if (embedder && input.mode !== 'lexical' && await hasVectors(pool)) {
    try { [qv] = await embedder.embed([query]) } catch { /* lexical still answers: an embedding outage never fails a search */ }
  }
  return run(pool, p, async c => {
    const lexical = []
    const vector = []
    for (const kind of kinds) {
      const spec = SEARCH[kind]
      if (input.mode !== 'vector' && tsQueryStr) {
        const params = [p.tenant, tsQueryStr]
        const w = where(spec, p, input, params)
        const { rows } = await c.query(
          `select ${select(spec)}, ts_rank_cd(tsv, to_tsquery('simple', $2)) as rank from ${spec.table}
           where ${w} and tsv @@ to_tsquery('simple', $2) order by rank desc, ${spec.id} limit ${poolN}`, params)
        lexical.push(...rows)
      }
      if (qv) {
        const params = [p.tenant, embedder.model, vectorLiteral(qv)]
        const w = where(spec, p, input, params)
        const { rows } = await c.query(
          `select ${select(spec)}, embedding_v <=> $3::vector as dist from ${spec.table}
           where ${w} and embedding_v is not null and embedding_model = $2 order by dist, ${spec.id} limit ${poolN}`, params)
        vector.push(...rows)
      }
    }
    const byRank = (a, b) => b.rank - a.rank || (a.id < b.id ? -1 : 1)
    const byDist = (a, b) => a.dist - b.dist || (a.id < b.id ? -1 : 1)
    const strip = ({ kind, id, title, snippet }) => ({ kind, id, title, snippet })
    const fused = rrf([lexical.sort(byRank).map(strip), vector.sort(byDist).map(strip)])
    return { query, mode: qv ? 'hybrid' : 'lexical', results: fused.slice(0, limit) }
  })
}

export async function codeSearch(pool, p, input) {
  const params = [p.tenant]
  const conds = []
  if (input?.commit !== undefined) {
    if (!/^[0-9a-f]{7,64}$/i.test(String(input.commit))) throw bad('commit must be 7-64 hex characters')
    params.push(`${String(input.commit).toLowerCase()}%`); conds.push(`cp.commit_sha like $${params.length}`)
  }
  if (input?.pr !== undefined) { params.push(str(input.pr, 'pr', { max: 500 })); conds.push(`cp.pr_url = $${params.length}`) }
  if (input?.path !== undefined) { params.push(str(input.path, 'path', { max: 500 })); conds.push(`cp.path = $${params.length}`) }
  if (input?.query !== undefined) {
    const ts = toTsQuery(words(input.query))
    if (ts) {
      params.push(ts)
      conds.push(`cp.tsv @@ to_tsquery('simple', $${params.length})`)
    }
  }
  if (conds.length === 0) throw bad('give at least one of commit, pr, path or query')
  const limit = clampLimit(input.limit)
  return run(pool, p, async c => {
    const { rows } = await c.query(
      `select cp.provenance_id, cp.repo, cp.commit_sha, cp.pr_url, cp.path, cp.summary, cp.session_id, cp.turn_id, cp.occurred_at_ms,
              left(t.text, 400) as turn_excerpt
       from code_provenance cp left join transcript_turns t on t.tenant_id = cp.tenant_id and t.turn_id = cp.turn_id and t.deleted_at is null
       where cp.tenant_id = $1 and cp.deleted_at is null and ${conds.join(' and ')}
       order by cp.occurred_at_ms desc, cp.provenance_id limit ${limit}`, params)
    return { results: rows.map(r => ({ ...r, occurred_at_ms: Number(r.occurred_at_ms) })) }
  })
}

// ---- takeover, forget, restore ---------------------------------------------------------------

export async function sessionTakeover(pool, p, input) {
  const session = str(input?.session_id, 'session_id', { max: 200 })
  const maxTurns = Math.min(Math.max(Number.isInteger(input?.max_turns) ? input.max_turns : 500, 1), 2000)
  return run(pool, p, async c => {
    const turns = (await c.query(
      `select turn_id, seq, role, text, occurred_at_ms, bot_id from transcript_turns
       where tenant_id = $1 and session_id = $2 and deleted_at is null order by seq limit $3`, [p.tenant, session, maxTurns + 1])).rows
    const observations = (await c.query(
      `select observation_id, kind, text, occurred_at_ms from observations where tenant_id = $1 and session_id = $2 and deleted_at is null order by occurred_at_ms limit 500`, [p.tenant, session])).rows
    const provenance = (await c.query(
      `select provenance_id, repo, commit_sha, pr_url, path, summary, turn_id from code_provenance where tenant_id = $1 and session_id = $2 and deleted_at is null order by occurred_at_ms limit 500`, [p.tenant, session])).rows
    if (turns.length === 0 && observations.length === 0 && provenance.length === 0) throw new TeamMemoryError(404, 'session not found')
    const norm = rows => rows.map(r => ({ ...r, ...(r.occurred_at_ms !== undefined ? { occurred_at_ms: Number(r.occurred_at_ms) } : {}) }))
    return { session_id: session, truncated: turns.length > maxTurns, turns: norm(turns.slice(0, maxTurns)), observations: norm(observations), provenance }
  })
}

const SESSION_TABLES = ['observations', 'transcript_turns', 'code_provenance']

async function setDeleted(pool, p, input, deleted, { now = Date.now } = {}) {
  const memoryIds = Array.isArray(input?.ids) ? input.ids.map(i => str(i, 'id', { max: 200 })) : []
  const session = input?.session_id === undefined ? null : str(input.session_id, 'session_id', { max: 200 })
  if (memoryIds.length === 0 && session === null) throw bad('give ids or session_id')
  if (input.hard === true && deleted) return hardPurge(pool, p, memoryIds, session)
  const stamp = deleted ? 'now()' : 'null'
  return run(pool, p, async c => {
    let affected = 0
    if (memoryIds.length) {
      const r = await c.query(
        `update memories set deleted_at = ${stamp}, updated_at_ms = greatest(updated_at_ms, $3), version = version + 1
         where tenant_id = $1 and memory_id = any($2) and (deleted_at is not null) = $4 returning memory_id, private_agent_id`, [p.tenant, memoryIds, now(), !deleted])
      affected += r.rowCount
      for (const row of r.rows) await logOp(c, p, { device: 'server', opId: randomUUID(), entity: 'memory', entityId: row.memory_id, op: deleted ? 'delete' : 'restore', payload: { id: row.memory_id, updated_at_ms: now() }, privateAgent: row.private_agent_id })
    }
    if (session !== null) {
      for (const t of SESSION_TABLES) affected += (await c.query(`update ${t} set deleted_at = ${stamp} where tenant_id = $1 and session_id = $2 and (deleted_at is not null) = $3`, [p.tenant, session, !deleted])).rowCount
      await logOp(c, p, { device: 'server', opId: randomUUID(), entity: 'session', entityId: session, op: deleted ? 'delete' : 'restore', payload: { id: session } })
    }
    return { [deleted ? 'forgotten' : 'restored']: affected }
  })
}

async function hardPurge(pool, p, memoryIds, session) {
  const out = await run(pool, p, async c => {
    if (!await gate(c, p, 'memory.purge_hard', `memory:${session ?? memoryIds.join(',')}`.slice(0, 500), session ?? 'memories')) return { denied: true }
    let purged = 0
    if (memoryIds.length) {
      purged += (await c.query('delete from memories where tenant_id = $1 and memory_id = any($2)', [p.tenant, memoryIds])).rowCount
      await c.query('delete from memory_revisions where tenant_id = $1 and memory_id = any($2)', [p.tenant, memoryIds])
      for (const id of memoryIds) await logOp(c, p, { device: 'server', opId: randomUUID(), entity: 'memory', entityId: id, op: 'purge', payload: { id } })
    }
    if (session !== null) {
      for (const t of SESSION_TABLES) purged += (await c.query(`delete from ${t} where tenant_id = $1 and session_id = $2`, [p.tenant, session])).rowCount
      await logOp(c, p, { device: 'server', opId: randomUUID(), entity: 'session', entityId: session, op: 'purge', payload: { id: session } })
    }
    return { purged }
  })
  if (out.denied) throw new TeamMemoryError(403, 'approval-required')
  return out
}

export const forgetMemory = (pool, p, input, deps) => setDeleted(pool, p, input, true, deps)
export const restoreMemory = (pool, p, input, deps) => setDeleted(pool, p, input, false, deps)

// ---- shared skills and artifacts -------------------------------------------------------------

export async function listSkills(pool, p, input = {}) {
  const limit = clampLimit(input.limit, 50)
  return run(pool, p, async c => {
    const { rows } = await c.query(
      `select distinct on (name) skill_id, name, version, visibility, description, published_by, created_at from shared_skills
       where tenant_id = $1 and deleted_at is null and (visibility = 'tenant' or org_id = $2) order by name, version desc limit ${limit}`, [p.tenant, p.org_id ?? null])
    return { skills: rows }
  })
}

export async function publishSkill(pool, p, input) {
  const name = str(input?.name, 'name', { max: 64 })
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw bad('name must match ^[a-z0-9][a-z0-9._-]{0,63}$')
  const body = redact(str(input.body, 'body', { max: 64_000 }))
  const description = redact(str(input.description, 'description', { max: 2000, optional: true }) ?? '')
  const visibility = input.visibility === 'org' ? 'org' : 'tenant'
  if (visibility === 'org' && !p.org_id) throw bad('org visibility needs a principal with an org_id')
  const out = await run(pool, p, async c => {
    if (visibility === 'org' && !await gate(c, p, 'skill.publish_org', `skill:${name}`, name)) return { denied: true }
    await c.query('select pg_advisory_xact_lock(hashtext($1))', [`${p.tenant}:skill:${name}`])
    const version = (await c.query('select coalesce(max(version), 0) + 1 as v from shared_skills where tenant_id = $1 and name = $2', [p.tenant, name])).rows[0].v
    const skillId = `${name}@${version}`
    await c.query(
      `insert into shared_skills (tenant_id, skill_id, org_id, name, version, visibility, description, body, published_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [p.tenant, skillId, p.org_id ?? null, name, version, visibility, description, body, p.id])
    return { skill_id: skillId, name, version, visibility }
  })
  if (out.denied) throw new TeamMemoryError(403, 'approval-required')
  return out
}

export async function listSharedArtifacts(pool, p, input = {}) {
  const limit = clampLimit(input.limit, 50)
  return run(pool, p, async c => {
    const { rows } = await c.query(
      `select artifact_id, name, description, bucket, object_key, sha256, bytes, media_type, registered_by, created_at from shared_artifacts
       where tenant_id = $1 and deleted_at is null order by created_at desc, artifact_id limit ${limit}`, [p.tenant])
    return { artifacts: rows.map(r => ({ ...r, bytes: Number(r.bytes) })) }
  })
}

// The store is asked for the object's real digest; the client's claim alone is never recorded.
export async function registerSharedArtifact(pool, p, input, { objectStore } = {}) {
  if (!objectStore) throw new TeamMemoryError(503, 'object store is not configured')
  const name = redact(str(input?.name, 'name', { max: 200 }))
  const bucket = str(input.bucket, 'bucket', { max: 100 })
  const key = str(input.object_key, 'object_key', { max: 500 })
  const sha256 = str(input.sha256, 'sha256', { max: 64 }).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw bad('sha256 must be 64 lowercase hex characters')
  const head = await objectStore.head({ bucket, key })
  if (!head) throw new TeamMemoryError(404, 'object not found in the store')
  if (head.sha256 !== sha256) throw new TeamMemoryError(422, 'sha256 does not match the stored object')
  const description = redact(str(input.description, 'description', { max: 2000, optional: true }) ?? '')
  const mediaType = str(input.media_type, 'media_type', { max: 100, optional: true }) ?? 'application/octet-stream'
  return run(pool, p, async c => {
    const id = randomUUID()
    const { rows } = await c.query(
      `insert into shared_artifacts (tenant_id, artifact_id, name, description, bucket, object_key, sha256, bytes, media_type, registered_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (tenant_id, bucket, object_key) do nothing returning artifact_id`,
      [p.tenant, id, name, description, bucket, key, sha256, head.bytes, mediaType, p.id])
    if (rows.length) return { artifact_id: id, sha256, bytes: Number(head.bytes), created: true }
    const prior = (await c.query('select artifact_id, sha256, bytes from shared_artifacts where tenant_id = $1 and bucket = $2 and object_key = $3', [p.tenant, bucket, key])).rows[0]
    return { artifact_id: prior.artifact_id, sha256: prior.sha256, bytes: Number(prior.bytes), created: false }
  })
}

// ---- MCP (Streamable HTTP, JSON responses only) ------------------------------------------------

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const S = { type: 'string' }
export const MCP_TOOLS = [
  { name: 'memory_search', description: 'Hybrid lexical+semantic search over team memory.', inputSchema: obj({ query: S, limit: { type: 'integer' }, bot_id: S, kinds: { type: 'array', items: S } }, ['query']), run: (c, a) => searchTeamMemory(c.pool, c.p, a, c.deps) },
  { name: 'code_search', description: 'Find the sessions behind a commit, PR or path.', inputSchema: obj({ commit: S, pr: S, path: S, query: S, limit: { type: 'integer' } }), run: (c, a) => codeSearch(c.pool, c.p, a) },
  { name: 'session_takeover', description: 'Load a session transcript to continue it.', inputSchema: obj({ session_id: S, max_turns: { type: 'integer' } }, ['session_id']), run: (c, a) => sessionTakeover(c.pool, c.p, a) },
  { name: 'memory_forget', description: 'Soft-delete memories or a whole session.', inputSchema: obj({ ids: { type: 'array', items: S }, session_id: S, hard: { type: 'boolean' } }), run: (c, a) => forgetMemory(c.pool, c.p, a, c.deps) },
  { name: 'memory_restore', description: 'Undo a soft delete.', inputSchema: obj({ ids: { type: 'array', items: S }, session_id: S }), run: (c, a) => restoreMemory(c.pool, c.p, a, c.deps) },
  { name: 'skill_list', description: 'List the latest version of each shared skill.', inputSchema: obj({ limit: { type: 'integer' } }), run: (c, a) => listSkills(c.pool, c.p, a) },
  { name: 'skill_publish', description: 'Publish a new version of a shared skill.', inputSchema: obj({ name: S, body: S, description: S, visibility: { enum: ['tenant', 'org'] } }, ['name', 'body']), run: (c, a) => publishSkill(c.pool, c.p, a) },
  { name: 'artifact_list', description: 'List shared artifacts.', inputSchema: obj({ limit: { type: 'integer' } }), run: (c, a) => listSharedArtifacts(c.pool, c.p, a) },
  { name: 'artifact_register', description: 'Register an uploaded object as a shared artifact.', inputSchema: obj({ name: S, bucket: S, object_key: S, sha256: S, description: S, media_type: S }, ['name', 'bucket', 'object_key', 'sha256']), run: (c, a) => registerSharedArtifact(c.pool, c.p, a, c.deps) },
]

const rpcError = (id, code, message) => ({ status: 200, json: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } })

// One JSON-RPC message per POST (2025-06-18 dropped batching). Notifications get 202 and no body.
export async function handleMcpRpc(pool, p, message, deps = {}) {
  if (Array.isArray(message)) return rpcError(null, -32600, 'batching is not supported')
  if (message === null || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(message?.id, -32600, 'invalid request')
  const { id, method, params } = message
  if (id === undefined) return { status: 202 }
  const ok = result => ({ status: 200, json: { jsonrpc: '2.0', id, result } })
  if (method === 'initialize') {
    return ok({ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'dsbot-team-memory', version: '1.0.0' } })
  }
  if (method === 'ping') return ok({})
  if (method === 'tools/list') return ok({ tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
  if (method === 'tools/call') {
    const tool = MCP_TOOLS.find(t => t.name === params?.name)
    if (!tool) return rpcError(id, -32602, `unknown tool: ${params?.name}`)
    try {
      const result = await tool.run({ pool, p, deps }, params.arguments ?? {})
      return ok({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false })
    } catch (error) {
      if (!(error instanceof TeamMemoryError) && !Number.isInteger(error?.status)) throw error
      return ok({ content: [{ type: 'text', text: error.message }], isError: true })
    }
  }
  return rpcError(id, -32601, `method not found: ${method}`)
}
