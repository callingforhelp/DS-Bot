// Retrieval benchmark on a SYNTHETIC corpus: lexical vs vector vs hybrid. Works against any
// pool (local Postgres or the remote database). It only ever indexes and sends the fixture below,
// never real transcripts, so using a paid embedding provider on it exposes no private text.
import { withScope } from '../src/db.mjs'
import { ingestEvent, sha256 } from '../src/ingest.mjs'
import { runIndexer } from '../src/indexer.mjs'
import { search } from '../src/search.mjs'

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

export const QUERIES = [
  { id: 'a1', q: '4f2a9c1e', relevant: ['c1'], project: 'p1', split: 'test' },
  { id: 'a2', q: 'which commit added retry limits 7be03d55', relevant: ['c2', 'v3'], project: 'p1', split: 'train' },
  { id: 'b1', q: 'why was the message to Writer blocked recipient-off', relevant: ['b1'], project: 'p1', split: 'test' },
  { id: 'b2', q: 'finding-attempt-limit refusal', relevant: ['b2'], project: 'p1', split: 'train' },
  { id: 'c1', q: 'earlier review about a missing null check in the router', relevant: ['v1', 'v2', 'c1', 'r1'], project: 'p1', split: 'test' },
  { id: 'c2', q: 'guard against missing values before routing', relevant: ['r1', 'v1', 'v2'], project: 'p1', split: 'train' },
  { id: 'd1', q: 'Capy review verdict', relevant: ['v1', 'v2', 'v3'], project: 'p1', split: 'test', botId: 'capy' },
  { id: 'e1', q: 'was the git push approved or denied', relevant: ['b3'], project: 'p1', split: 'test' },
  // Paraphrases that share almost no words with their answers: these separate a semantic model
  // from a hashed-word mock.
  { id: 'p1', q: 'who stopped an unauthorized deployment attempt', relevant: ['b3'], project: 'p1', split: 'test' },
  { id: 'p2', q: 'reviewer sign-off on the scheduling parser for blank lines', relevant: ['v4'], project: 'p2', split: 'test' },
  { id: 'p3', q: 'a missing-input bug the reviewer flagged then confirmed fixed', relevant: ['v1', 'v2'], project: 'p1', split: 'train' },
]

const dcg = rels => rels.reduce((s, g, i) => s + g / Math.log2(i + 2), 0)
const mean = a => a.reduce((x, y) => x + y, 0) / a.length
const fmt = x => x.toFixed(3)

// Runs the whole benchmark under a unique tenant and removes its own rows afterwards.
export async function runBench({ pool, embedder, tenant, title, notes }) {
  const other = `${tenant}-other`
  const modes = ['lexical', 'vector', 'hybrid']
  const mk = (e, tn, over = {}) => ({
    schema_version: 1, tenant_id: tn, project_id: e.project, event_id: `ev-${tn}-${e.id}`, run_id: `run-${e.project}`, agent_id: e.agent, kind: e.kind,
    occurred_at: '2026-11-18T12:00:00Z', source_system: 'bench', source_id: 'fixture', source_seq: e.n, source_sha256: sha256(`${tn}${e.id}`),
    body: { summary: e.summary, ...(e.commit ? { commit: e.commit } : {}) }, ...over,
  })
  const report = Object.fromEntries(modes.map(m => [m, { recall5: [], mrr10: [], ndcg10: [], ms: [], leaks: 0 }]))
  const t0 = Date.now()
  let indexLagMs
  try {
    for (const e of events) await withScope(pool, { tenant, role: 'ingest' }, c => ingestEvent(c, mk(e, tenant)))
    const probe = { id: 'other', project: 'p1', agent: 'capy', kind: 'review.verdict', summary: 'Capy review verdict commit 4f2a9c1e null check router', n: 500 }
    await withScope(pool, { tenant: other, role: 'ingest' }, c => ingestEvent(c, mk(probe, other)))
    await withScope(pool, { tenant, role: 'ingest' }, c => ingestEvent(c, mk({ ...probe, id: 'private', n: 501 }, tenant, { agent_id: 'secret-bot', private_agent_id: 'secret-bot', event_id: `ev-${tenant}-private` })))
    await runIndexer(pool, tenant, embedder, { limit: 500 })
    await runIndexer(pool, other, embedder)
    indexLagMs = Date.now() - t0
    const chunkEvent = new Map((await withScope(pool, { tenant, role: 'ingest' }, c => c.query('select chunk_id, source_event_id from retrieval_chunks where tenant_id = $1', [tenant]))).rows.map(r => [r.chunk_id, r.source_event_id]))
    const idOf = chunk => chunkEvent.get(chunk)?.replace(`ev-${tenant}-`, '')
    let engine = ''
    for (const q of QUERIES) {
      const want = new Set(q.relevant)
      for (const mode of modes) {
        const t = Date.now()
        const res = await search(pool, { tenant, project: q.project, principal: 'bench', query: q.q, mode, limit: 10, botId: q.botId }, embedder)
        const ms = Date.now() - t
        engine = res.vectorEngine
        const rels = res.results.map(r => (want.has(idOf(r.chunk_id)) ? 1 : 0))
        const r = report[mode]
        r.recall5.push(rels.slice(0, 5).reduce((a, b) => a + b, 0) / want.size)
        const first = rels.indexOf(1)
        r.mrr10.push(first === -1 ? 0 : 1 / (first + 1))
        r.ndcg10.push(dcg(rels.slice(0, 10)) / dcg(Array.from({ length: Math.min(want.size, 10) }, () => 1)))
        r.ms.push(ms)
        r.leaks += res.results.filter(x => chunkEvent.get(x.chunk_id)?.endsWith('private') || !chunkEvent.has(x.chunk_id)).length
      }
    }
    const rows = modes.map(m => `| ${m} | ${fmt(mean(report[m].recall5))} | ${fmt(mean(report[m].mrr10))} | ${fmt(mean(report[m].ndcg10))} | ${mean(report[m].ms).toFixed(1)} | ${report[m].leaks} |`)
    const paraphrase = QUERIES.map((q, i) => [q, i]).filter(([q]) => q.id.startsWith('p'))
    const prows = modes.map(m => `| ${m} | ${fmt(mean(paraphrase.map(([, i]) => report[m].recall5[i])))} | ${fmt(mean(paraphrase.map(([, i]) => report[m].mrr10[i])))} |`)
    return `# ${title}

Corpus: ${events.length} synthetic events + 2 isolation probes (another tenant, a private agent). Queries: ${QUERIES.length} (${QUERIES.filter(q => q.split === 'test').length} held-out test, ${QUERIES.filter(q => q.split === 'train').length} train). Vector engine: ${engine}. Embedding model: ${embedder.model} (${embedder.dim}-d). Index time for the whole corpus: ${indexLagMs} ms.

| mode | Recall@5 | MRR@10 | nDCG@10 | mean latency ms | isolation leaks |
|---|---|---|---|---|---|
${rows.join('\n')}

Paraphrase-only queries (little word overlap with their answers: ${paraphrase.map(([q]) => q.id).join(', ')}):

| mode | Recall@5 | MRR@10 |
|---|---|---|
${prows.join('\n')}

${notes}
`
  } finally {
    for (const t of [tenant, other]) {
      await withScope(pool, { tenant: t, role: 'ingest' }, async (c) => {
        for (const table of ['relevance_labels', 'retrieval_queries', 'retrieval_chunks', 'ingestion_outbox', 'events', 'runs']) await c.query(`delete from ${table} where tenant_id = $1`, [t])
      }).catch(() => {})
    }
  }
}
