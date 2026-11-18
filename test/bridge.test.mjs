import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { envelopesFromLineage } from '../src/bridge-adapter.mjs'
import { withScope } from '../src/db.mjs'
import { mockEmbedder } from '../src/embed.mjs'
import { ingestEvent } from '../src/ingest.mjs'
import { runIndexer } from '../src/indexer.mjs'
import { search } from '../src/search.mjs'
import { freshDb } from './helpers.mjs'

let db
let file
before(async () => {
  db = await freshDb()
  // A synthetic archive in the PoC's layout. No real DS Bot data is read by any test.
  file = join(mkdtempSync(join(tmpdir(), 'lineage-')), 'lineage.sqlite')
  const sql = new DatabaseSync(file)
  sql.exec(`create table events (id text primary key, task_id text, run_id text, kind text, actor text, target text, at integer, session_id text, seq integer, ref text, meta text);
    create table authorizations (id text primary key, task_id text, run_id text, at integer, actor text, target text, action text, outcome text, reason text, session_id text, seq integer, ref text);`)
  sql.prepare('insert into events values (?,?,?,?,?,?,?,?,?,?,?)').run('e1', 't1', 'r1', 'assignment', 'chief', 'capy', 1_700_000_000_000, 's1', 1, 'ref1', null)
  sql.prepare('insert into authorizations values (?,?,?,?,?,?,?,?,?,?,?,?)').run('a1', 't1', 'r1', 1_700_000_001_000, 'capy', 'writer', 'message_bot', 'denied', 'recipient-off', 's1', 2, 'ref2')
  sql.close()
})
after(async () => { await db.drop() })

test('the lineage bridge archive replays into the same logical rows, and a refusal is searchable', async () => {
  const ingestAll = async () => {
    let inserted = 0
    for (const env of envelopesFromLineage(file, { tenant: 'tb', project: 'p' })) {
      inserted += (await withScope(db.pool, { tenant: 'tb', role: 'ingest' }, c => ingestEvent(c, env))).inserted ? 1 : 0
    }
    return inserted
  }
  assert.equal(await ingestAll(), 2)
  assert.equal(await ingestAll(), 0, 'a fresh replay produces no new rows')
  const embedder = mockEmbedder()
  await runIndexer(db.pool, 'tb', embedder)
  const found = await search(db.pool, { tenant: 'tb', project: 'p', principal: 'u', query: 'blocked message_bot recipient-off denied' }, embedder)
  assert.match(found.results[0].snippet, /message_bot by capy to writer was denied/)
  assert.match(found.results[0].snippet, /recipient-off/)
  assert.equal(found.results[0].source_ref.startsWith('ds-bot-lineage:'), true)
})
