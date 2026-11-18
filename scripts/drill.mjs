// Backup and restore drill, all local: dump the database, copy the object store with a
// SHA-256 manifest, restore into a brand-new database and directory, and prove the rows and
// every artifact digest match. It stands in for "restore on a clean EC2 replacement"; the real
// drill needs EBS snapshots, S3 and a managed Postgres, none of which exist yet.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PG_PORT } from './pg.mjs'
import { adminUrl, appUrl, makePool, withScope } from '../src/db.mjs'
import { mockEmbedder } from '../src/embed.mjs'
import { ingestEvent, sha256 } from '../src/ingest.mjs'
import { runIndexer } from '../src/indexer.mjs'
import { search } from '../src/search.mjs'
import { localObjectStore } from '../src/objectstore.mjs'
import { freshDb } from '../test/helpers.mjs'

const walk = (dir, base = dir) => readdirSync(dir).flatMap(f => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f), base) : [join(dir, f).slice(base.length + 1)]))
const manifest = dir => Object.fromEntries(walk(dir).sort().map(f => [f, createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')]))
const pg = (cmd, args) => execFileSync(cmd, ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', 'postgres', ...args], { encoding: 'utf8' })

const src = await freshDb()
const objects = mkdtempSync(join(tmpdir(), 'drill-objects-'))
const store = localObjectStore({ root: objects, secret: 's' })
const embedder = mockEmbedder()
await withScope(src.pool, { tenant: 'drill', role: 'ingest' }, c => ingestEvent(c, {
  schema_version: 1, tenant_id: 'drill', project_id: 'p', event_id: 'e1', run_id: 'r1', kind: 'review.verdict', occurred_at: '2026-11-18T12:00:00Z',
  source_system: 'drill', source_id: 's', source_seq: 1, source_sha256: sha256('x'), body: { summary: 'Capy approved commit 5d6e7f80' },
}))
await runIndexer(src.pool, 'drill', embedder)
const key = 'drill/p/r1/result.json'
const put = store.put({ bucket: 'artifacts', key, token: store.presign({ bucket: 'artifacts', key }), bytes: Buffer.from('{"ok":true}') })
await withScope(src.pool, { tenant: 'drill' }, c => c.query(`insert into artifacts (tenant_id, project_id, artifact_id, run_id, bucket, object_key, sha256, bytes, media_type) values ('drill','p','a1','r1','artifacts',$1,$2,$3,'application/json')`, [key, put.sha256, put.bytes]))

// Backup.
const dump = join(mkdtempSync(join(tmpdir(), 'drill-dump-')), 'backup.sql')
pg('pg_dump', ['-d', src.name, '-f', dump, '--no-owner'])
const backupObjects = mkdtempSync(join(tmpdir(), 'drill-objects-backup-'))
cpSync(objects, backupObjects, { recursive: true })
const before = manifest(objects)
await src.drop()

// Restore into a replacement that shares nothing with the original.
const name = `restored_${Date.now()}`
pg('createdb', [name])
pg('psql', ['-d', name, '-q', '-v', 'ON_ERROR_STOP=1', '-f', dump])
const restored = join(mkdtempSync(join(tmpdir(), 'drill-restored-')), 'objects')
cpSync(backupObjects, restored, { recursive: true })
const after = manifest(restored)
const pool = makePool(appUrl(name))
const rows = await withScope(pool, { tenant: 'drill' }, async (c) => ({
  events: (await c.query('select count(*)::int n from events')).rows[0].n,
  chunks: (await c.query('select count(*)::int n, count(embedding)::int e from retrieval_chunks')).rows[0],
  artifacts: (await c.query('select sha256 from artifacts')).rows,
}))
const found = await search(pool, { tenant: 'drill', project: 'p', principal: 'drill', query: '5d6e7f80' }, embedder)
const ok = JSON.stringify(before) === JSON.stringify(after) && rows.events === 1 && rows.chunks.n === 1 && rows.chunks.e === 1
  && rows.artifacts[0].sha256 === put.sha256 && found.results.length === 1
console.log(JSON.stringify({ ok, objects: after, rows: { events: rows.events, chunks: rows.chunks }, search_after_restore: found.results.length }, null, 2))
await pool.end()
const root = makePool(adminUrl(), 1)
await root.query(`drop database if exists ${name} with (force)`)
await root.end()
if (!ok) process.exit(1)
