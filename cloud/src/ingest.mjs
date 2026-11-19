import { createHash } from 'node:crypto'

const KINDS = /^[a-z][a-z0-9_.-]{1,63}$/
const FORBIDDEN_BODY = new Set(['llm.prompt', 'llm.completion', 'llm.reasoning', 'prompt', 'completion', 'reasoning'])
export const sha256 = (value) => createHash('sha256').update(value).digest('hex')

// code: 'invalid' (the envelope is refused) or 'conflict' (it collides with a stored event).
export class IngestError extends Error {
  constructor(message, code = 'invalid') { super(message); this.code = code }
}

// Metadata only: a prompt, completion or reasoning trace is refused, not stripped, at any
// depth and in any letter case ({Prompt}, {meta: {prompt}}).
function forbiddenKey(value, path = 'body', depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return undefined
  for (const [key, inner] of Object.entries(value)) {
    if (FORBIDDEN_BODY.has(key.toLowerCase())) return `${path}.${key}`
    const found = forbiddenKey(inner, `${path}.${key}`, depth + 1)
    if (found) return found
  }
  return undefined
}
const shortText = (v, max) => typeof v === 'string' && v !== '' && v.length <= max

export function validateEnvelope(env) {
  const need = ['tenant_id', 'project_id', 'event_id', 'run_id', 'kind', 'occurred_at', 'source_system', 'source_id', 'source_seq', 'source_sha256']
  for (const key of need) if (env?.[key] === undefined || env[key] === null || env[key] === '') throw new IngestError(`missing ${key}`)
  if (env.schema_version !== 1) throw new IngestError('unsupported schema_version')
  if (!KINDS.test(env.kind)) throw new IngestError('bad kind')
  if (!/^[0-9a-f]{64}$/.test(env.source_sha256)) throw new IngestError('bad source_sha256')
  if (!Number.isSafeInteger(env.source_seq) || env.source_seq < 0) throw new IngestError('bad source_seq')
  if (Number.isNaN(Date.parse(env.occurred_at))) throw new IngestError('bad occurred_at')
  const bad = forbiddenKey(env.body)
  if (bad) throw new IngestError(`${bad} is not accepted: metadata-only tracing`)
  const body = env.body ?? {}
  if (body.summary !== undefined && !(typeof body.summary === 'string' && body.summary.length <= 4000)) throw new IngestError('body.summary must be a string of at most 4000 characters')
  if (body.reason !== undefined && body.reason !== null && !(typeof body.reason === 'string' && body.reason.length <= 300)) throw new IngestError('body.reason must be at most 300 characters')
  const a = env.authorization
  if (a !== undefined) {
    if (a === null || typeof a !== 'object') throw new IngestError('bad authorization')
    if (a.verdict !== 'allow' && a.verdict !== 'deny') throw new IngestError('authorization.verdict must be allow or deny')
    if (typeof a.actor !== 'string' || !/^dsbot:/.test(a.actor)) throw new IngestError('authorization.actor must be a dsbot: id')
    for (const key of ['action', 'scope', 'reason']) if (!shortText(a[key], 200)) throw new IngestError(`authorization.${key} must be a non-empty string of at most 200 characters`)
    if (a.auth_id !== env.source_id) throw new IngestError('authorization.auth_id must equal source_id')
  }
  // Claimed and verified are different facts. Only a verifier may set verified_outcome.
  return env
}

// One transaction: the event, the outbox row that lets the indexer find it, and for an
// imported decision its authorizations row. A replay hits the unique source key and changes
// nothing; the same source key with different content is reported as a conflict.
export async function ingestEvent(client, env, { fromVerifier = false, allowAuthorization = false } = {}) {
  validateEnvelope(env)
  if (env.verified_outcome !== undefined && env.verified_outcome !== 'UNKNOWN' && !fromVerifier) throw new IngestError('verified_outcome can only be set by a verifier')
  if (env.authorization !== undefined && !allowAuthorization) throw new IngestError('authorization projection not permitted')
  await client.query('savepoint ingest_event')
  let res
  try {
    await client.query(
      `insert into runs (tenant_id, project_id, run_id, task_id, owner) values ($1,$2,$3,$4,$5) on conflict do nothing`,
      [env.tenant_id, env.project_id, env.run_id, env.task_id ?? null, env.agent_id ?? 'system'])
    res = await client.query(
      `insert into events (tenant_id, project_id, event_id, run_id, task_id, agent_id, session_id, trace_id, parent_event_id, kind, occurred_at,
         claimed_outcome, verified_outcome, source_system, source_id, source_seq, source_sha256, private_agent_id, body)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       on conflict (tenant_id, source_system, source_id, source_seq) do nothing returning event_id`,
      [env.tenant_id, env.project_id, env.event_id, env.run_id, env.task_id ?? null, env.agent_id ?? null, env.session_id ?? null, env.trace_id ?? null,
        env.parent_event_id ?? null, env.kind, env.occurred_at, env.claimed_outcome ?? null, env.verified_outcome ?? 'UNKNOWN',
        env.source_system, env.source_id, env.source_seq, env.source_sha256, env.private_agent_id ?? null, env.body ?? {}])
  } catch (error) {
    await client.query('rollback to savepoint ingest_event')
    if (error.code === '23505') throw new IngestError('event_id already used by another source key', 'conflict')
    throw error
  }
  await client.query('release savepoint ingest_event')
  if (res.rowCount === 0) {
    const { rows } = await client.query(
      'select source_sha256 from events where tenant_id = $1 and source_system = $2 and source_id = $3 and source_seq = $4',
      [env.tenant_id, env.source_system, env.source_id, env.source_seq])
    // A retry may carry a fresh event_id; only different content under the same key is a conflict.
    return rows[0] && rows[0].source_sha256 !== env.source_sha256 ? { inserted: false, conflict: true } : { inserted: false }
  }
  await client.query('insert into ingestion_outbox (tenant_id, event_id) values ($1,$2) on conflict do nothing', [env.tenant_id, env.event_id])
  const a = env.authorization
  if (a) {
    // approval_ref is always null: an imported Bot decision can never satisfy the human gate.
    await client.query(
      `insert into authorizations (tenant_id, project_id, auth_id, run_id, actor, action, scope, verdict, reason, approval_ref, decided_at, target, room_id, source_event_id, private_agent_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,null,$10,$11,$12,$13,$14) on conflict (tenant_id, auth_id) do nothing`,
      [env.tenant_id, env.project_id, a.auth_id, env.run_id, a.actor, a.action, a.scope, a.verdict, a.reason, env.occurred_at,
        a.target ?? null, a.room_id ?? null, env.event_id, env.private_agent_id ?? null])
  }
  return { inserted: true }
}
