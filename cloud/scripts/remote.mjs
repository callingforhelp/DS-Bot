// Remote database tasks against the existing RDS instance, through the SSM tunnel.
//   node scripts/remote.mjs migrate   apply the schema (+ pgvector column) to ds_bot, as the owner
//   node scripts/remote.mjs smoke     end-to-end check as the restricted app login, then clean up
// Requires: the tunnel on 127.0.0.1:55432, an AWS SSO session, and the DS_BOT_DB_* values in .env.
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { ROOT } from './pg.mjs'
import { withScope } from '../src/db.mjs'
import { mockEmbedder } from '../src/embed.mjs'
import { ingestEvent, sha256 } from '../src/ingest.mjs'
import { runIndexer } from '../src/indexer.mjs'
import { migrate } from '../src/migrate.mjs'
import { adminPool, appPool, loadEnv } from '../src/remote.mjs'
import { search } from '../src/search.mjs'

const env = loadEnv(join(ROOT, '.env'))
for (const key of ['DS_BOT_DB_HOST', 'DS_BOT_DB_HOSTADDR', 'DS_BOT_DB_PORT', 'DS_BOT_DB_NAME', 'DS_BOT_DB_USER', 'DS_BOT_DB_PASSWORD', 'DS_BOT_DB_SSLROOTCERT']) {
  if (!env[key]) { console.error(`missing ${key} in .env`); process.exit(2) }
}
const [command] = process.argv.slice(2)

if (command === 'migrate') {
  if (env.DS_BOT_DB_NAME !== 'ds_bot') throw new Error('refusing to migrate any database other than ds_bot')
  const pool = adminPool(env, { secretId: 'rds!db-d64eceae-3dff-46c0-a131-c8c8682ba94e' })
  try {
    const who = (await pool.query('select current_database() db, current_user u, version() v')).rows[0]
    console.log(`connected: db=${who.db} user=${who.u} ${who.v.split(' on ')[0]}`)
    const applied = await migrate(env.DS_BOT_DB_NAME, { adminPool: pool, appRole: env.DS_BOT_DB_USER, optional: ['002_pgvector.optional.sql'] })
    console.log('applied:', applied.length ? applied.join(', ') : '(already up to date)')
    const tables = (await pool.query("select count(*)::int n from information_schema.tables where table_schema = 'public'")).rows[0].n
    console.log('tables in ds_bot.public:', tables)
  } finally { await pool.end() }
} else if (command === 'smoke') {
  const pool = appPool(env)
  const tenant = `remote-smoke-${randomBytes(4).toString('hex')}`
  const other = `${tenant}-other`
  const embedder = mockEmbedder()
  const report = []
  const check = (name, ok, extra = '') => { report.push([ok, name, extra]); if (!ok) process.exitCode = 1 }
  try {
    const me = (await pool.query('select current_user u, (select ssl from pg_stat_ssl where pid = pg_backend_pid()) ssl')).rows[0]
    check('connected as the restricted login over verified TLS', me.u === env.DS_BOT_DB_USER && me.ssl === true, `${me.u}, ssl=${me.ssl}`)
    const env1 = (n, summary, over = {}) => ({
      schema_version: 1, tenant_id: tenant, project_id: 'p', event_id: `${tenant}-${n}`, run_id: `${tenant}-run`, agent_id: 'capy', kind: 'review.verdict',
      occurred_at: new Date().toISOString(), source_system: 'remote-smoke', source_id: tenant, source_seq: n, source_sha256: sha256(`${tenant}${n}`), body: { summary }, ...over,
    })
    const docs = ['router drops the null check on empty input', 'blocked message_bot call recipient-off for Writer', 'Devin pushed commit 9f8e7d6c to the feature branch']
    let inserted = 0
    for (const [i, summary] of docs.entries()) inserted += (await withScope(pool, { tenant, role: 'ingest' }, c => ingestEvent(c, env1(i, summary)))).inserted ? 1 : 0
    const replay = await withScope(pool, { tenant, role: 'ingest' }, c => ingestEvent(c, { ...env1(0, docs[0]), event_id: 'retry' }))
    check('events ingested once, a replay is a no-op', inserted === 3 && replay.inserted === false)
    await withScope(pool, { tenant: other, role: 'ingest' }, c => ingestEvent(c, { ...env1(9, 'other tenant secret roadmap 9f8e7d6c'), tenant_id: other, event_id: `${other}-1`, source_id: other }))
    const stats = await runIndexer(pool, tenant, embedder)
    await runIndexer(pool, other, embedder)
    check('indexer chunked and embedded all events', stats.indexed === 3 && stats.embedded === 3, JSON.stringify(stats))
    const exact = await search(pool, { tenant, project: 'p', principal: 'smoke', query: '9f8e7d6c' }, embedder)
    check('exact commit lookup cites its source', /9f8e7d6c/.test(exact.results[0]?.snippet ?? '') && /^remote-smoke:/.test(exact.results[0]?.source_ref ?? ''), exact.results[0]?.source_ref)
    const vec = await search(pool, { tenant, project: 'p', principal: 'smoke', query: 'null check router empty input', mode: 'vector' }, embedder)
    check('vector search runs on pgvector and finds the paraphrase', vec.vectorEngine === 'pgvector' && /null check/.test(vec.results[0]?.snippet ?? ''), vec.vectorEngine)
    const leak = await search(pool, { tenant, project: 'p', principal: 'smoke', query: 'secret roadmap' }, embedder)
    check('another tenant\'s rows are never returned', leak.results.every(r => !/roadmap/.test(r.snippet)))
    let denied = false
    try { await withScope(pool, { tenant, role: 'ingest' }, c => ingestEvent(c, { ...env1(50, 'forged'), tenant_id: other, event_id: 'forged' })) } catch (e) { denied = /row-level security/.test(e.message) }
    check('a write for another tenant is refused by the database', denied)
    let ddl = false
    try { await pool.query('create table smoke_probe(a int)') } catch { ddl = true }
    check('the restricted login cannot create objects', ddl)
  } finally {
    // The smoke test's own rows only, removed with the same restricted login.
    for (const t of [tenant, other]) {
      await withScope(pool, { tenant: t, role: 'ingest' }, async (c) => {
        for (const table of ['retrieval_queries', 'retrieval_chunks', 'ingestion_outbox', 'events', 'runs']) await c.query(`delete from ${table} where tenant_id = $1`, [t])
      }).catch(() => {})
    }
    const left = (await pool.query("select count(*)::int n from events where tenant_id like 'remote-smoke-%'")).rows[0]
    await pool.end()
    for (const [ok, name, extra] of report) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
    console.log(`cleanup: smoke rows left in events visible to this login = ${left.n}`)
  }
} else {
  console.log('usage: node scripts/remote.mjs migrate | smoke')
}
