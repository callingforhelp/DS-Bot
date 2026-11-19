import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { envelopesFromLineage, LineageError } from '../src/bridge-adapter.mjs'
import { withScope } from '../src/db.mjs'
import { mockEmbedder } from '../src/embed.mjs'
import { ingestEvent } from '../src/ingest.mjs'
import { runIndexer } from '../src/indexer.mjs'
import { search } from '../src/search.mjs'
import { freshDb } from './helpers.mjs'

// Synthetic archives in the lineage schema v1 layout, built here so this test does not depend
// on the bridge's own code. No real DS Bot data is read by any test.
const T = 1_763_500_000_000
const SCHEMA = `
  CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT, private INTEGER NOT NULL DEFAULT 0, updated_at INTEGER);
  CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT, updated_at INTEGER);
  CREATE TABLE events (id TEXT PRIMARY KEY, rev INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL, task_id TEXT, run_id TEXT, actor TEXT, target TEXT, room_id TEXT, at INTEGER NOT NULL, session_id TEXT, seq INTEGER, ref TEXT, meta TEXT, updated_at INTEGER);
  CREATE TABLE authorizations (id TEXT PRIMARY KEY, rev INTEGER NOT NULL DEFAULT 1, at INTEGER NOT NULL, actor TEXT, target TEXT, room_id TEXT, action TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT, source TEXT NOT NULL, task_id TEXT, run_id TEXT, session_id TEXT, seq INTEGER, ref TEXT, updated_at INTEGER);
  PRAGMA user_version = 1;`
function archive(build) {
  const file = join(mkdtempSync(join(tmpdir(), 'lineage-')), 'lineage.sqlite')
  const sql = new DatabaseSync(file)
  sql.exec(SCHEMA)
  sql.prepare("INSERT INTO bots VALUES ('bot-chief','Chief',0,0), ('bot-writer','Writer',0,0), ('bot-vault','Vault',1,0)").run()
  sql.prepare("INSERT INTO rooms VALUES ('room-desk','Desk',0)").run()
  build?.(sql)
  sql.close()
  return file
}
const auth = (sql, id, over = {}) => {
  const r = { id, rev: 1, at: T, actor: 'bot-chief', target: 'bot-writer', room_id: null, action: 'message_bot', outcome: 'denied', reason: 'recipient-off', source: 'tool', task_id: null, run_id: null, session_id: 'session-c1', seq: 5, ref: 'session:session-c1#seq:5', updated_at: 0, ...over }
  sql.prepare(`INSERT OR REPLACE INTO authorizations (${Object.keys(r).join(',')}) VALUES (${Object.keys(r).map(() => '?').join(',')})`).run(...Object.values(r))
}

let db
before(async () => { db = await freshDb() })
after(async () => { await db.drop() })
const ingestAll = async (file, tenant = 'tb') => {
  let inserted = 0
  for (const env of envelopesFromLineage(file, { tenant, project: 'p', installId: 'test' })) {
    inserted += (await withScope(db.pool, { tenant, role: 'ingest' }, c => ingestEvent(c, env, { allowAuthorization: true }))).inserted ? 1 : 0
  }
  return inserted
}

test('two decisions in one turn (same Session and seq) both ingest; a replay adds nothing; the denial is searchable', async () => {
  const file = archive(sql => {
    auth(sql, 'a-allowed', { outcome: 'allowed', reason: null, target: 'bot-chief' })
    auth(sql, 'a-denied')
    sql.prepare("INSERT INTO events (id, rev, kind, actor, target, at, session_id, seq, ref, meta) VALUES ('e1', 1, 'task.assigned', 'bot-chief', 'bot-writer', ?, 'session-c1', 2, 'session:session-c1#seq:2', '{\"category\":\"review\",\"text\":\"never shipped\"}')").run(T - 10)
    sql.prepare("INSERT INTO events (id, rev, kind, at) VALUES ('e2', 1, 'something.else', ?)").run(T)
  })
  assert.equal(await ingestAll(file), 3)
  assert.equal(await ingestAll(file), 0, 'a fresh replay produces no new rows')
  const embedder = mockEmbedder()
  await runIndexer(db.pool, 'tb', embedder)
  const found = await search(db.pool, { tenant: 'tb', project: 'p', principal: 'u', query: 'Writer recipient-off' }, embedder)
  assert.match(found.results[0].snippet, /authorization denied message_bot by Chief to Writer: recipient-off/)
  assert.ok(found.results[0].source_ref.startsWith('ds-bot-lineage:dsbot:test:auth:'))
  const ev = (await db.admin.query("select body from events where tenant_id = 'tb' and kind = 'task.assigned'")).rows[0].body
  assert.deepEqual(ev.meta, { category: 'review' }, 'meta is whitelisted')
})

test('a revised row and an earlier-timed new row replay cleanly: exactly two inserts, no errors', async () => {
  const file = archive(sql => { auth(sql, 'r1', { outcome: 'pending', reason: null }); auth(sql, 'r2', { at: T + 100 }) })
  const tenant = 'tb-replay'
  assert.equal(await ingestAll(file, tenant), 1, 'a pending decision yields nothing')
  const sql = new DatabaseSync(file)
  auth(sql, 'r1', { rev: 2, outcome: 'denied', reason: 'group-off' })
  auth(sql, 'r0', { at: T - 1000, reason: 'self-reply' })
  sql.close()
  assert.equal(await ingestAll(file, tenant), 2)
  assert.equal(await ingestAll(file, tenant), 0)
  const rows = (await db.admin.query('select event_id, source_seq from events where tenant_id = $1 order by event_id', [tenant])).rows
  assert.deepEqual(rows.map(r => r.event_id), ['dsbot:test:auth:r0:r1', 'dsbot:test:auth:r1:r2', 'dsbot:test:auth:r2:r1'])
  assert.ok(rows.every(r => r.event_id !== 'run-unknown'))
})

test('wrong schema version, missing columns and bad times are refused before anything is yielded', () => {
  const v2 = archive(sql => sql.exec('PRAGMA user_version = 2'))
  assert.throws(() => [...envelopesFromLineage(v2, { tenant: 't', project: 'p', installId: 'test' })], LineageError)
  const noAt = join(mkdtempSync(join(tmpdir(), 'lineage-')), 'x.sqlite')
  const sql = new DatabaseSync(noAt)
  sql.exec(SCHEMA.replace('at INTEGER NOT NULL, session_id TEXT, seq INTEGER, ref TEXT, meta', 'session_id TEXT, seq INTEGER, ref TEXT, meta'))
  sql.close()
  assert.throws(() => [...envelopesFromLineage(noAt, { tenant: 't', project: 'p', installId: 'test' })], /lacks at/)
  const seconds = archive(sql => auth(sql, 'old', { at: 1_700_000_000 }))
  assert.throws(() => [...envelopesFromLineage(seconds, { tenant: 't', project: 'p', installId: 'test' })], /authorizations row old/)
  assert.throws(() => [...envelopesFromLineage(seconds, { tenant: 't', project: 'p', installId: 'Bad Id' })], /installId/)
})

test('policy rows become events without an authorization object; private Bots are marked', () => {
  const file = archive(sql => {
    auth(sql, 'pol', { outcome: 'policy', action: 'permission.preset', reason: 'default', source: 'session-policy', target: null })
    auth(sql, 'priv', { actor: 'bot-vault' })
  })
  const envs = [...envelopesFromLineage(file, { tenant: 't', project: 'p', installId: 'test' })]
  const pol = envs.find(e => e.source_id.endsWith(':pol'))
  assert.equal(pol.kind, 'authorization.policy')
  assert.equal(pol.authorization, undefined)
  const priv = envs.find(e => e.source_id.endsWith(':priv'))
  assert.equal(priv.private_agent_id, 'dsbot:bot-vault')
  assert.deepEqual(priv.authorization, { auth_id: 'dsbot:test:auth:priv', actor: 'dsbot:bot-vault', action: 'message_bot', scope: 'dsbot.bot-response', target: 'dsbot:bot-writer', room_id: null, verdict: 'deny', reason: 'recipient-off' })
  assert.equal(priv.run_id, 'dsbot-session:session-c1')
})
