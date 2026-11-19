import { createHash, randomUUID } from 'node:crypto'
import { hasPgvector, vectorLiteral, withScope } from './db.mjs'
import { redact } from './redact.mjs'

export const RETRIEVAL_VERSION = 1
const RRF_K = 60

// Letters and digits in any script, at most 24 terms of 64 characters, each quoted so that
// tsquery operators in the query are just text.
const words = q => [...new Set((redact(q).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(w => w.slice(0, 64)))].slice(0, 24)
const tsTerms = terms => terms.map(t => `'${t.replace(/['\\]/g, '')}'`).join(' | ')

// Weighted reciprocal-rank fusion: lexical (exact IDs, errors) outweighs vector.
export function fuse(lists, weights, limit) {
  const score = new Map()
  for (const [name, list] of Object.entries(lists)) {
    list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + (weights[name] ?? 1) / (RRF_K + rank + 1)))
  }
  return [...score].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, limit).map(([id, s]) => ({ id, score: s }))
}

// Tenant, project, time and agent filters are applied in SQL for both branches, and RLS
// is the second wall behind them. Time filters use when the event happened, not when it was
// indexed. The answer carries source references and snippets only. DS Bot lineage Bots are
// addressed as botId 'dsbot:<id>'.
export async function search(pool, { tenant, project, agent = '', principal, query, mode = 'hybrid', limit = 10, from, to, botId }, embedder) {
  const started = Date.now()
  const terms = words(query)
  const filter = `c.tenant_id = $1 and c.project_id = $2
    and ($3::timestamptz is null and $4::timestamptz is null or exists (select 1 from events e2 where e2.tenant_id = c.tenant_id and e2.event_id = c.source_event_id
      and ($3::timestamptz is null or e2.occurred_at >= $3) and ($4::timestamptz is null or e2.occurred_at <= $4)))
    and (c.private_agent_id is null or c.private_agent_id = $5)`
  const bot = botId
    ? ' and exists (select 1 from events e where e.tenant_id = c.tenant_id and e.event_id = c.source_event_id and e.agent_id = $6)'
    : ''
  const base = [tenant, project, from ?? null, to ?? null, agent, ...(botId ? [botId] : [])]
  const n = base.length
  const pool_n = Math.max(limit * 5, 30)
  const native = await hasPgvector(pool)
  return withScope(pool, { tenant, agent }, async (c) => {
    const rank = { lexical: [], vector: [] }
    if (mode !== 'vector' && terms.length > 0) {
      const { rows } = await c.query(
        `select c.chunk_id from retrieval_chunks c where ${filter}${bot} and c.tsv @@ to_tsquery('simple', $${n + 1})
         order by ts_rank_cd(c.tsv, to_tsquery('simple', $${n + 1})) desc, c.chunk_id limit ${pool_n}`, [...base, tsTerms(terms)])
      rank.lexical = rows.map(r => r.chunk_id)
    }
    let vectorUsed = false
    if (mode !== 'lexical') {
      try {
        const [qv] = await embedder.embed([redact(query)])
        const { rows } = native
          ? await c.query(
            `select c.chunk_id from retrieval_chunks c where ${filter}${bot} and c.embedding_v is not null and c.embedding_model = $${n + 1}
             order by c.embedding_v <=> $${n + 2}::vector, c.chunk_id limit ${pool_n}`, [...base, embedder.model, vectorLiteral(qv)])
          : await c.query(
            `select c.chunk_id from retrieval_chunks c where ${filter}${bot} and c.embedding is not null and c.embedding_model = $${n + 1}
             order by cosine_sim(c.embedding, $${n + 2}::real[]) desc nulls last, c.chunk_id limit ${pool_n}`, [...base, embedder.model, qv])
        rank.vector = rows.map(r => r.chunk_id)
        vectorUsed = true
      } catch { /* the lexical branch still answers: an embedding outage never fails a search */ }
    }
    const fused = fuse(rank, { lexical: 1.5, vector: 1 }, limit)
    const ids = fused.map(f => f.id)
    const { rows: docs } = ids.length === 0
      ? { rows: [] }
      : await c.query(
        `select c.chunk_id, c.source_ref, c.source_event_id, c.content_hash, left(c.text, 240) as snippet, e.occurred_at, e.kind
           from retrieval_chunks c left join events e on e.tenant_id = c.tenant_id and e.event_id = c.source_event_id
          where c.tenant_id = $1 and c.chunk_id = any($2) and (c.private_agent_id is null or c.private_agent_id = $3)`, [tenant, ids, agent])
    const byId = new Map(docs.map(d => [d.chunk_id, d]))
    const results = fused.filter(f => byId.has(f.id)).map((f, i) => ({ rank: i + 1, score: f.score, ...byId.get(f.id) }))
    const queryId = randomUUID()
    await c.query(
      `insert into retrieval_queries (tenant_id, query_id, project_id, principal, query_fp, filters, mode, candidates, retrieval_version, latency_ms)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [tenant, queryId, project, principal ?? 'unknown', createHash('sha256').update(redact(query)).digest('hex'), { from, to, botId: botId ?? null }, mode,
        JSON.stringify(results.map(r => ({ id: r.chunk_id, rank: r.rank }))), RETRIEVAL_VERSION, Date.now() - started])
    return { queryId, mode, vectorUsed, vectorEngine: native ? 'pgvector' : 'array', results }
  })
}
