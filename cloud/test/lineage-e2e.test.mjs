import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { createApi } from '../src/api.mjs'
import { apiClient } from '../src/client.mjs'
import { mockEmbedder } from '../src/embed.mjs'
import { runIndexer } from '../src/indexer.mjs'
import { freshDb } from './helpers.mjs'
import { advanceHome, IDS, makeHome } from './fixtures/dsbot-home.mjs'

// Synthetic DS Bot home -> bridge -> sidecar -> signed API -> events + authorizations -> index -> search.
const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const principals = {
  alice: { secret: 'a'.repeat(40), tenants: ['t1'], scopes: ['read-only'], role: 'user' },
  shipper: { secret: 's'.repeat(40), tenants: ['t1'], scopes: [], role: 'ingest', sources: ['ds-bot-lineage'], projects: ['p'] },
}
let db, server, base, dir, home, sidecarEnv
const embedder = mockEmbedder()
const as = id => apiClient({ baseUrl: base, principal: id, secret: principals[id].secret, tenant: 't1' })

before(async () => {
  db = await freshDb()
  server = await createApi({ pool: db.pool, embedder, principals }).listen(0)
  base = `http://127.0.0.1:${server.address().port}`
  dir = mkdtempSync(join(tmpdir(), 'lineage-e2e-'))
  home = makeHome(join(dir, 'home')).home
  writeFileSync(join(dir, 'principal.json'), JSON.stringify({ id: 'shipper', secret: principals.shipper.secret }))
  sidecarEnv = {
    PATH: process.env.PATH, LINEAGE_HOME: home, LINEAGE_DB: join(dir, 'lineage.sqlite'), SHIP_STATE: join(dir, 'shipped.sqlite'), STATUS_FILE: join(dir, 'status.json'),
    INSTALL_ID: 'test', TENANT: 't1', PROJECT: 'p', LINEAGE_PRINCIPAL_FILE: join(dir, 'principal.json'), CONTROLLER_URL: base, ONCE: '1',
  }
})
after(async () => { server.close(); await db.drop() })

// The sidecar runs as a child process; the API it calls runs in this one, so it must not block.
const sidecar = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(SRC, 'lineage-sidecar.mjs')], { env: sidecarEnv })
  let out = ''
  let err = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { err += d })
  child.on('error', reject)
  child.on('close', code => resolve({ code, ship: code === 0 || out ? JSON.parse(out.trim().split('\n').at(-1) || '{}').ship : undefined, err }))
})
const denials = async () => (await db.admin.query("select actor, action, reason, target, room_id from authorizations where tenant_id = 't1' and verdict = 'deny' order by decided_at, auth_id")).rows
const dsbot = id => `dsbot:${id}`

test('first pass: every refusal arrives once, attributed, searchable and listable', async () => {
  const cli = spawnSync(process.execPath, [join(SRC, 'lineage', 'cli.mjs'), '--home', home, '--db', join(dir, 'cli.sqlite'), '--once'], { encoding: 'utf8' })
  assert.equal(cli.status, 0, cli.stderr)
  const verify = spawnSync(process.execPath, [join(SRC, 'lineage', 'cli.mjs'), '--db', join(dir, 'cli.sqlite'), '--verify', '--json'], { encoding: 'utf8' })
  assert.equal(verify.status, 0, verify.stdout)

  const r = await sidecar()
  assert.equal(r.code, 0, r.err)
  assert.equal(r.ship.conflicts + r.ship.errors, 0)
  const rows = await denials()
  const has = (actor, action, reason, target, room = null) => rows.filter(x => x.actor === actor && x.action === action && x.reason === reason && x.target === target && x.room_id === room).length
  assert.equal(has(dsbot(IDS.chief), 'message_bot', 'recipient-off', dsbot(IDS.writer)), 1, 'tool refusal, once (its diagnostics copy is not a second row)')
  assert.equal(has(dsbot(IDS.chief), 'post_to_group', 'task-category-required', dsbot(IDS.editor), IDS.desk), 1, 'returned refusal')
  assert.equal(has(dsbot(IDS.writer), 'message_bot', 'group-off', dsbot(IDS.editor), IDS.desk), 1, 'group Session refusal, attributed to Writer in Desk')
  assert.equal(has(dsbot(IDS.editor), 'deliver.reply', 'result-suppressed', dsbot(IDS.chief)), 1, 'passive delivery')
  assert.equal(has(dsbot(IDS.chief), 'group.call', 'task-category-required', dsbot(IDS.editor), IDS.desk), 1, 'group notice')
  assert.equal(rows.filter(x => x.action === 'bot.respond').length, 0, 'no duplicate from diagnostics')
  const allowed = (await db.admin.query("select count(*)::int n from authorizations where tenant_id = 't1' and verdict = 'allow' and action = 'message_bot'")).rows[0].n
  assert.equal(allowed, 1, 'the allowed decision in the same turn is there too')

  await runIndexer(db.pool, 't1', embedder, { limit: 200 })
  const found = await as('alice')('POST', '/v1/search', { project_id: 'p', query: 'Writer recipient-off', mode: 'lexical' })
  assert.match(found.body.results[0].snippet, /authorization denied message_bot by Chief to Writer: recipient-off/)
  const windowed = await as('alice')('POST', '/v1/search', { project_id: 'p', query: 'Writer recipient-off', mode: 'lexical', from: '2025-11-18T00:00:00Z', to: '2025-11-20T00:00:00Z' })
  assert.ok(windowed.body.results.some(x => x.kind === 'authorization.denied'), 'found by when it happened (Nov 2025), though indexed today')
  const list = await as('alice')('GET', '/v1/authorizations?project_id=p&verdict=deny')
  assert.equal(list.body.authorizations.length, rows.length)
  assert.ok(list.body.authorizations.every(a => a.target?.startsWith('dsbot:')))
  const run = await as('alice')('GET', `/v1/runs/dsbot-task%3A${IDS.task}?project_id=p`)
  assert.equal(run.status, 200)
  assert.ok(run.body.events.some(e => e.kind === 'review.verdict' && e.body.summary))
  assert.equal((await as('shipper')('POST', '/v1/search', { project_id: 'p', query: 'Writer' })).status, 403)

  const again = await sidecar()
  assert.equal(again.code, 0)
  assert.equal(again.ship.sent, 0, 'a second pass ships nothing')
  const status = JSON.parse(readFileSync(sidecarEnv.STATUS_FILE, 'utf8'))
  assert.deepEqual(Object.keys(status).sort(), ['at', 'consecutiveFailures', 'lastOkAt', 'pass', 'ship'])
  assert.doesNotMatch(JSON.stringify(status), /Writer|Chief|session-|\/home/)
})

test('second phase with a torn tail: only new or revised rows, nothing lost', async () => {
  const before = (await db.admin.query("select count(*)::int n from events where tenant_id = 't1'")).rows[0].n
  advanceHome(home)
  // A frame still being written: cut off mid-way.
  const writerGroup = join(home, 'sessions', '--synthetic-workspace--', IDS.writerGroup, 'session.v4.jsonl.zstd')
  const tail = zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'turn/start', time: 1_763_500_009_000, seq: 5, data: { turn: 2 } })}\n`))
  appendFileSync(writerGroup, tail.subarray(0, tail.length - 4))
  const r = await sidecar()
  assert.equal(r.code, 0, r.err)
  assert.equal(r.ship.conflicts + r.ship.errors, 0)
  const after = (await db.admin.query("select count(*)::int n from events where tenant_id = 't1'")).rows[0].n
  assert.equal(after - before, r.ship.inserted)
  const rows = await denials()
  assert.equal(rows.filter(x => x.reason === 'tool-error' && x.target?.startsWith('dsbot:unresolved:')).length, 1, 'the pending call is now a denial')
  assert.equal(rows.filter(x => x.actor === dsbot(IDS.editor) && x.reason === 'recipient-off').length, 1, 'the new refusal')
  assert.equal(rows.filter(x => x.reason === 'group-off').length, 1, "the torn Session's earlier refusal is still there")
  const st = JSON.parse(readFileSync(sidecarEnv.STATUS_FILE, 'utf8'))
  assert.equal(st.pass.torn, 1)
  // The rest of the frame lands: the next pass reads it and ships nothing it already had.
  writeFileSync(writerGroup, Buffer.concat([readFileSync(writerGroup).subarray(0, readFileSync(writerGroup).length - (tail.length - 4)), tail]))
  const done = await sidecar()
  assert.equal(done.code, 0)
  assert.equal(JSON.parse(readFileSync(sidecarEnv.STATUS_FILE, 'utf8')).pass.torn, 0)
  assert.equal(done.ship.conflicts + done.ship.errors, 0)
})
