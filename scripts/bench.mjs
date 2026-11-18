// Retrieval benchmark on a SYNTHETIC corpus, comparing lexical, vector and hybrid search.
// The vectors come from the offline mock embedder (hashed words and trigrams), so the vector
// and hybrid numbers describe this pipeline's fusion, NOT text-embedding-3-small. Re-run with
// the real provider (consent + key) before drawing any conclusion about semantic quality.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { freshDb } from '../test/helpers.mjs'
import { withScope } from '../src/db.mjs'
import { mockEmbedder } from '../src/embed.mjs'
import { ingestEvent, sha256 } from '../src/ingest.mjs'
import { runIndexer } from '../src/indexer.mjs'
import { search } from '../src/search.mjs'

const T = 'bench-tenant'
const events = []
let n = 0
const add = (id, project, agent, kind, summary, extra = {}) => events.push({ id, project, agent, kind, summary, ...extra, n: n++ })

add('c1', 'p1', 'devin', 'git.commit', 'Devin pushed commit 4f2a9c1e to feature/router after fixing the null check', { commit: '4f2a9c1e' })
add('c2', 'p1', 'devin', 'git.commit', 'Devin pushed commit 7be03d55 adding retry limits to the dispatcher', { commit: '7be03d55' })
add('c3', 'p2', 'devin', 'git.commit', 'Devin pushed commit a91c44f0 updating the paint schedule parser', { commit: 'a91c44f0' })
add('b1', 'p1', 'system', 'authorization.denied', 'message_bot from Capy to Writer was denied: recipient-off, so no turn was started')
add('b2', 'p1', 'system', 'authorization.denied', 'message_bot from Grok to Chief was denied: finding-attempt-limit after two fix attempts')
add('b3', 'p1', 'system', 'authorization.denied', 'git.push by Devin was denied: approval-required, no human approval on record')
add('v1', 'p1', 'capy', 'review.verdict', 'Capy review verdict: changes requested, the router drops the null check on empty input')
add('v2', 'p1', 'capy', 'review.verdict', 'Capy review verdict: approved after the null check was restored in the router')
add('v3', 'p1', 'capy', 'review.verdict', 'Capy review verdict: approved, retry limits are bounded and tested')
add('v4', 'p2', 'capy', 'review.verdict', 'Capy review verdict: approved, the paint schedule parser handles empty rows')
add('r1', 'p1', 'chief', 'task.result', 'Reviewer asked the coder to guard against missing values before routing requests')
for (let i = 0; i < 14; i += 1) add(`x${i}`, 'p1', ['chief', 'writer', 'grok'][i % 3], 'task.result', `weekly planning note ${i} about calendar, budget and meeting agenda number ${i}`)

const queries = [
  { id: 'a1', q: '4f2a9c1e', relevant: ['c1'], project: 'p1', split: 'test' },
  { id: 'a2', q: 'which commit added retry limits 7be03d55', relevant: ['c2', 'v3'], project: 'p1', split: 'train' },
  { id: 'b1', q: 'why was the message to Writer blocked recipient-off', relevant: ['b1'], project: 'p1', split: 'test' },
  { id: 'b2', q: 'finding-attempt-limit refusal', relevant: ['b2'], project: 'p1', split: 'train' },
  { id: 'c1', q: 'earlier review about a missing null check in the router', relevant: ['v1', 'v2', 'c1', 'r1'], project: 'p1', split: 'test' },
  { id: 'c2', q: 'guard against missing values before routing', relevant: ['r1', 'v1', 'v2'], project: 'p1', split: 'train' },
  { id: 'd1', q: 'Capy review verdict', relevant: ['v1', 'v2', 'v3'], project: 'p1', split: 'test', botId: 'capy' },
  { id: 'e1', q: 'was the git push approved or denied', relevant: ['b3'], project: 'p1', split: 'test' },
]

const db = await freshDb()
const embedder = mockEmbedder()
const eventIdOf = new Map()
const t0 = Date.now()
for (const e of events) {
  const env = {
    schema_version: 1, tenant_id: T, project_id: e.project, event_id: `ev-${e.id}`, run_id: `run-${e.project}`, agent_id: e.agent, kind: e.kind,
    occurred_at: '2026-11-18T12:00:00Z', source_system: 'bench', source_id: 'fixture', source_seq: e.n, source_sha256: sha256(`${e.id}`),
    body: { summary: e.summary, ...(e.commit ? { commit: e.commit } : {}) },
  }
  await withScope(db.pool, { tenant: T, role: 'ingest' }, c => ingestEvent(c, env))
  eventIdOf.set(env.event_id, e.id)
}
// Noise that must never be returned: another tenant, and a private agent's row.
await withScope(db.pool, { tenant: 'other-tenant', role: 'ingest' }, c => ingestEvent(c, { schema_version: 1, tenant_id: 'other-tenant', project_id: 'p1', event_id: 'ev-other', run_id: 'r', kind: 'review.verdict', occurred_at: '2026-11-18T12:00:00Z', source_system: 'bench', source_id: 'other', source_seq: 1, source_sha256: sha256('o'), body: { summary: 'Capy review verdict commit 4f2a9c1e null check router' } }))
await withScope(db.pool, { tenant: T, role: 'ingest' }, c => ingestEvent(c, { schema_version: 1, tenant_id: T, project_id: 'p1', event_id: 'ev-private', run_id: 'r', agent_id: 'secret-bot', private_agent_id: 'secret-bot', kind: 'review.verdict', occurred_at: '2026-11-18T12:00:00Z', source_system: 'bench', source_id: 'priv', source_seq: 1, source_sha256: sha256('p'), body: { summary: 'Capy review verdict commit 4f2a9c1e null check router private' } }))
await runIndexer(db.pool, T, embedder, { limit: 500 })
await runIndexer(db.pool, 'other-tenant', embedder)
const indexLagMs = Date.now() - t0
const chunkEvent = new Map((await db.admin.query('select chunk_id, source_event_id from retrieval_chunks where tenant_id = $1', [T])).rows.map(r => [r.chunk_id, r.source_event_id]))

const dcg = (rels) => rels.reduce((s, g, i) => s + g / Math.log2(i + 2), 0)
const modes = ['lexical', 'vector', 'hybrid']
const report = Object.fromEntries(modes.map(m => [m, { recall5: [], mrr10: [], ndcg10: [], ms: [], leaks: 0 }]))
for (const q of queries) {
  const want = new Set(q.relevant)
  for (const mode of modes) {
    const t = Date.now()
    const res = await search(db.pool, { tenant: T, project: q.project, principal: 'bench', query: q.q, mode, limit: 10, botId: q.botId }, embedder)
    const ms = Date.now() - t
    const ids = res.results.map(r => eventIdOf.get(chunkEvent.get(r.chunk_id)))
    const rels = ids.map(id => (want.has(id) ? 1 : 0))
    const r = report[mode]
    r.recall5.push(rels.slice(0, 5).reduce((a, b) => a + b, 0) / want.size)
    const first = rels.indexOf(1)
    r.mrr10.push(first === -1 ? 0 : 1 / (first + 1))
    const ideal = dcg(Array.from({ length: Math.min(want.size, 10) }, () => 1))
    r.ndcg10.push(dcg(rels.slice(0, 10)) / ideal)
    r.ms.push(ms)
    r.leaks += res.results.filter(x => ['ev-other', 'ev-private'].includes(chunkEvent.get(x.chunk_id))).length
  }
  // Label rows, with the split kept apart so a held-out set can be frozen before tuning.
  for (const id of q.relevant) {
    const chunk = [...chunkEvent].find(([, ev]) => ev === `ev-${id}`)?.[0]
    if (chunk) await withScope(db.pool, { tenant: T }, c => c.query('insert into relevance_labels (tenant_id, query_id, chunk_id, grade, annotator, split) values ($1,$2,$3,3,$4,$5) on conflict do nothing', [T, q.id, chunk, 'synthetic-fixture', q.split]))
  }
}
const mean = a => a.reduce((x, y) => x + y, 0) / a.length
const fmt = x => x.toFixed(3)
const rows = modes.map(m => `| ${m} | ${fmt(mean(report[m].recall5))} | ${fmt(mean(report[m].mrr10))} | ${fmt(mean(report[m].ndcg10))} | ${mean(report[m].ms).toFixed(1)} | ${report[m].leaks} |`)
const md = `# Retrieval benchmark (synthetic fixture, mock embedder)

Corpus: ${events.length} synthetic events + 2 isolation probes (another tenant, a private agent). Queries: ${queries.length} (${queries.filter(q => q.split === 'test').length} held-out test, ${queries.filter(q => q.split === 'train').length} train). Index lag for the whole corpus: ${indexLagMs} ms.

| mode | Recall@5 | MRR@10 | nDCG@10 | mean latency ms | isolation leaks |
|---|---|---|---|---|---|
${rows.join('\n')}

**What this does and does not show.** The vector branch uses a hashed word/trigram mock, not a semantic model, so vector and hybrid quality here are properties of the fusion code on a tiny corpus. Nothing here predicts text-embedding-3-small. The corpus is 25 documents and the query set is 8: differences of a few hundredths are noise. No reranker was trained. "Isolation leaks" counts results from the other tenant or the private agent and must be 0.
`
writeFileSync(new URL('../docs/benchmark-report.md', import.meta.url), md)
console.log(md)
await db.drop()
