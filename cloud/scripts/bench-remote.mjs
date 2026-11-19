// Benchmark on the remote database, with the mock embedder and then with OpenAI's
// text-embedding-3-small, on the same synthetic corpus and queries. Only the fixture in
// benchlib.mjs is ever sent to OpenAI. Real transcripts need your explicit yes in .env.
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './pg.mjs'
import { runBench } from './benchlib.mjs'
import { mockEmbedder, openaiEmbedder } from '../src/embed.mjs'
import { appPool, loadEnv } from '../src/remote.mjs'

const env = loadEnv(join(ROOT, '.env'))
const pool = appPool(env)
const suffix = randomBytes(3).toString('hex')
try {
  const mock = await runBench({
    pool, embedder: mockEmbedder(), tenant: `bench-mock-${suffix}`, title: 'Remote benchmark A: mock embedder (RDS, pgvector)',
    notes: 'Hashed word/trigram mock: it cannot match words it has never seen, so it is the baseline, not a semantic model.',
  })
  const real = await runBench({
    pool, embedder: openaiEmbedder({ apiKey: env.OPENAI_API_KEY, consentExternalTransfer: true }), tenant: `bench-oai-${suffix}`,
    title: 'Remote benchmark B: text-embedding-3-small (RDS, pgvector)',
    notes: 'Same corpus and queries as A. 11 queries on 25 documents: differences of a few hundredths are noise. Only synthetic text was sent to OpenAI.',
  })
  const md = `${mock}\n\n${real}\n`
  writeFileSync(new URL('../docs/benchmark-report-remote.md', import.meta.url), md)
  console.log(md)
} finally { await pool.end() }
