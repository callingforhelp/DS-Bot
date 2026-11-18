import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'

const sha = s => createHash('sha256').update(String(s)).digest('hex')

// Reads the lineage archive the DS Bot bridge PoC writes (bridge.mjs -> lineage.sqlite) and
// turns its rows into event envelopes. The PoC parses the DSH sessions and ledger; this
// does not parse them again. It opens the file read-only and keeps only what the archive
// itself keeps: hashes and references, never chat text.
//
// Verified against the PoC's table layout only (events, authorizations). Whether the PoC
// emits the same rows for a live team has not been checked here.
export function* envelopesFromLineage(path, { tenant, project }) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const events = db.prepare('select * from events order by at, id').all()
    for (const [i, e] of events.entries()) {
      yield {
        schema_version: 1, tenant_id: tenant, project_id: project, event_id: `lineage-${e.id}`,
        run_id: e.run_id ?? e.task_id ?? 'run-unknown', task_id: e.task_id ?? undefined, agent_id: e.actor ?? undefined,
        session_id: e.session_id ?? undefined, trace_id: e.task_id ? `trace-${e.task_id}` : undefined,
        kind: String(e.kind ?? 'event').toLowerCase().replace(/[^a-z0-9_.-]/g, '.').slice(0, 63) || 'event',
        occurred_at: new Date(Number(e.at)).toISOString(), claimed_outcome: undefined,
        source_system: 'ds-bot-lineage', source_id: e.session_id ?? 'lineage', source_seq: Number.isSafeInteger(e.seq) ? e.seq : i,
        source_sha256: sha(`${e.id}|${e.ref ?? ''}|${e.kind}`),
        body: { summary: `${e.actor ?? 'someone'} ${e.kind}${e.target ? ` ${e.target}` : ''}`, ref: e.ref ?? null },
      }
    }
    const auths = db.prepare('select * from authorizations order by at, id').all()
    for (const [i, a] of auths.entries()) {
      yield {
        schema_version: 1, tenant_id: tenant, project_id: project, event_id: `lineage-auth-${a.id}`,
        run_id: a.run_id ?? a.task_id ?? 'run-unknown', task_id: a.task_id ?? undefined, agent_id: a.actor ?? undefined,
        session_id: a.session_id ?? undefined, kind: `authorization.${String(a.outcome ?? 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '')}`,
        occurred_at: new Date(Number(a.at)).toISOString(),
        source_system: 'ds-bot-lineage', source_id: `auth:${a.session_id ?? 'lineage'}`, source_seq: Number.isSafeInteger(a.seq) ? a.seq : i,
        source_sha256: sha(`${a.id}|${a.ref ?? ''}|${a.outcome}`),
        body: { summary: `${a.action} by ${a.actor ?? 'someone'} to ${a.target ?? 'someone'} was ${a.outcome}`, reason: a.reason ?? undefined },
      }
    }
  } finally { db.close() }
}
