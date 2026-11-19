import { hasPgvector, vectorLiteral, withScope } from './db.mjs'
import { chunk, redact } from './redact.mjs'
import { sha256 } from './ingest.mjs'

// The text an event contributes to search: its kind, ids and the redacted summary it
// carries. Prompts and reasoning never reach an event, so they never reach this.
const textOf = e => [
  `${e.kind}`,
  e.agent_id ? `agent ${e.agent_id}` : '',
  e.body?.summary ?? '',
  e.body?.reason ? `reason: ${e.body.reason}` : '',
  e.body?.commit ? `commit ${e.body.commit}` : '',
].filter(Boolean).join('\n')

const backoff = attempts => `${Math.min(3600, 2 ** attempts * 5)} seconds`

// One pass over the tenant's pending events. Lexical search works the moment a chunk
// exists; an embedding failure leaves the chunk searchable and the outbox row on retry.
export async function runIndexer(pool, tenant, embedder, { limit = 50 } = {}) {
  const stats = { indexed: 0, embedded: 0, embedFailed: 0 }
  const native = await hasPgvector(pool)
  await withScope(pool, { tenant, role: 'ingest' }, async (c) => {
    const { rows } = await c.query(
      `select o.attempts, e.* from ingestion_outbox o join events e using (tenant_id, event_id)
       where o.tenant_id = $1 and o.status in ('pending','retry') and o.next_retry_at <= now()
       order by o.next_retry_at limit $2 for update of o skip locked`, [tenant, limit])
    for (const e of rows) {
      const parts = chunk(redact(textOf(e)))
      const ids = []
      for (const [i, text] of parts.entries()) {
        const id = sha256(`${e.event_id}#${i}`).slice(0, 32)
        ids.push([id, text])
        await c.query(
          `insert into retrieval_chunks (tenant_id, project_id, chunk_id, source_event_id, source_ref, content_hash, private_agent_id, text)
           values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (tenant_id, chunk_id) do nothing`,
          [tenant, e.project_id, id, e.event_id, `${e.source_system}:${e.source_id}#${e.source_seq}`, sha256(text), e.private_agent_id, text])
      }
      let status = 'done'
      let lastError = null
      try {
        const vectors = await embedder.embed(ids.map(([, text]) => text))
        for (const [i, [id]] of ids.entries()) {
          await c.query(`update retrieval_chunks set embedding = $3, embedding_model = $4, embedding_dim = $5${native ? ', embedding_v = $6::vector' : ''} where tenant_id = $1 and chunk_id = $2`,
            [tenant, id, vectors[i], embedder.model, embedder.dim, ...(native ? [vectorLiteral(vectors[i])] : [])])
        }
        stats.embedded += ids.length
      } catch (error) {
        status = 'retry'
        lastError = String(error.message).slice(0, 200)
        stats.embedFailed += 1
      }
      await c.query(
        `update ingestion_outbox set status = $3, attempts = attempts + 1, last_error = $4, next_retry_at = now() + $5::interval where tenant_id = $1 and event_id = $2`,
        [tenant, e.event_id, status, lastError, status === 'retry' ? backoff(e.attempts) : '0 seconds'])
      stats.indexed += 1
    }
  })
  return stats
}
