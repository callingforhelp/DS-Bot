import { createHash } from 'node:crypto'

const KINDS = /^[a-z][a-z0-9_.-]{1,63}$/
const FORBIDDEN_BODY = ['llm.prompt', 'llm.completion', 'llm.reasoning', 'prompt', 'completion', 'reasoning']
export const sha256 = (value) => createHash('sha256').update(value).digest('hex')

export class IngestError extends Error {}

export function validateEnvelope(env) {
  const need = ['tenant_id', 'project_id', 'event_id', 'run_id', 'kind', 'occurred_at', 'source_system', 'source_id', 'source_seq', 'source_sha256']
  for (const key of need) if (env?.[key] === undefined || env[key] === null || env[key] === '') throw new IngestError(`missing ${key}`)
  if (env.schema_version !== 1) throw new IngestError('unsupported schema_version')
  if (!KINDS.test(env.kind)) throw new IngestError('bad kind')
  if (!/^[0-9a-f]{64}$/.test(env.source_sha256)) throw new IngestError('bad source_sha256')
  if (!Number.isSafeInteger(env.source_seq) || env.source_seq < 0) throw new IngestError('bad source_seq')
  if (Number.isNaN(Date.parse(env.occurred_at))) throw new IngestError('bad occurred_at')
  // Metadata only by default: a prompt, completion or reasoning trace is refused, not stripped.
  for (const key of Object.keys(env.body ?? {})) if (FORBIDDEN_BODY.includes(key)) throw new IngestError(`body.${key} is not accepted: metadata-only tracing`)
  // Claimed and verified are different facts. Only a verifier may set verified_outcome.
  return env
}

// One transaction: the event, and the outbox row that lets the indexer find it. A replay
// or a worker retry hits the unique source key and changes nothing.
export async function ingestEvent(client, env, { fromVerifier = false } = {}) {
  validateEnvelope(env)
  if (env.verified_outcome !== undefined && env.verified_outcome !== 'UNKNOWN' && !fromVerifier) throw new IngestError('verified_outcome can only be set by a verifier')
  await client.query(
    `insert into runs (tenant_id, project_id, run_id, task_id, owner) values ($1,$2,$3,$4,$5) on conflict do nothing`,
    [env.tenant_id, env.project_id, env.run_id, env.task_id ?? null, env.agent_id ?? 'system'])
  const res = await client.query(
    `insert into events (tenant_id, project_id, event_id, run_id, task_id, agent_id, session_id, trace_id, parent_event_id, kind, occurred_at,
       claimed_outcome, verified_outcome, source_system, source_id, source_seq, source_sha256, private_agent_id, body)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     on conflict (tenant_id, source_system, source_id, source_seq) do nothing returning event_id`,
    [env.tenant_id, env.project_id, env.event_id, env.run_id, env.task_id ?? null, env.agent_id ?? null, env.session_id ?? null, env.trace_id ?? null,
      env.parent_event_id ?? null, env.kind, env.occurred_at, env.claimed_outcome ?? null, env.verified_outcome ?? 'UNKNOWN',
      env.source_system, env.source_id, env.source_seq, env.source_sha256, env.private_agent_id ?? null, env.body ?? {}])
  if (res.rowCount === 0) return { inserted: false }
  await client.query('insert into ingestion_outbox (tenant_id, event_id) values ($1,$2) on conflict do nothing', [env.tenant_id, env.event_id])
  return { inserted: true }
}
