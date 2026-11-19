import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { openArchive } from '../src/lineage/archive.mjs'
import { buildOwners } from '../src/lineage/owners.mjs'
import { runPass } from '../src/lineage/pass.mjs'
import * as classify from '../src/lineage/refusals.mjs'
import { advanceHome, makeHome } from './fixtures/dsbot-home.mjs'
import { readers as realReaders } from '../src/lineage/readers.mjs'

const T = 1_763_500_000_000
const tmp = p => mkdtempSync(join(tmpdir(), p))
const state = {
  bots: { a: { id: 'bot-a', name: 'Ana', sessionId: 'chat-a', segments: [{ sessionId: 'seg-a' }] }, b: { id: 'bot-b', name: 'Bo', sessionId: 'chat-b' }, c: { id: 'bot-c', name: 'Cy', sessionId: 'chat-c' } },
  rooms: { r: { id: 'room-r', name: 'Desk', members: ['bot-a', 'bot-b'], sessions: { 'bot-b': 'grp-b' } } },
}
const call = (seq, t, id, name, args) => ({ type: 'tool/call', time: T + t, seq, data: { callId: id, name, arguments: JSON.stringify(args) } })
const res = (seq, t, id, text, isError) => ({ type: 'tool/result', time: T + t, seq, data: { message: { toolCallId: id, isError, content: [{ type: 'text', text }] } } })
const refusal = (to, from, reason) => `Error: Not sent: ${to} does not take automatic messages from ${from} (${reason}). No turn was started.`

function fakeReaders({ sessions = {}, diagnostics = [], ledger = { records: [], deliveries: [], groupNotices: [] }, throwIn } = {}) {
  return {
    readState: () => ({
      bots: Object.values(state.bots).map(b => ({ id: b.id, name: b.name, private: false, model: null, sessionId: b.sessionId })),
      rooms: Object.values(state.rooms).map(r => ({ id: r.id, name: r.name, members: r.members })),
      owners: buildOwners(state),
    }),
    listSessionLogs: () => Object.keys(sessions).map(id => ({ sessionId: id, file: id })),
    readSessionEvents: async file => { if (throwIn === 'sessions') throw new Error('disk gone'); return { events: sessions[file], torn: false, badLines: 0 } },
    readLedger: () => ledger,
    readDiagnostics: () => ({ lines: diagnostics, cursor: {}, rotated: false, cleared: false }),
  }
}
const pass = (archive, readers, now = () => T + 10_000) => runPass({ home: '/nowhere', archive, readers, classify, now })
const auths = a => a.db.prepare('SELECT * FROM authorizations ORDER BY at, id').all()

test('two message_bot calls in one turn give two rows with their own result seq', async () => {
  const a = openArchive(join(tmp('pass-'), 'l.sqlite'))
  await pass(a, fakeReaders({ sessions: { 'chat-a': [
    { type: 'turn/start', time: T, seq: 1, data: { turn: 1 } },
    call(2, 1, 'k1', 'message_bot', { to: 'Bo' }), call(3, 2, 'k2', 'message_bot', { to: 'Cy' }),
    res(4, 3, 'k1', 'Sent.', false), res(5, 4, 'k2', refusal('Cy', 'Ana', 'recipient-off'), true),
    { type: 'turn/end', time: T + 5, seq: 6, data: { reason: { kind: 'completed' } } },
  ] } }))
  const rows = auths(a)
  assert.equal(rows.length, 2)
  assert.notEqual(rows[0].id, rows[1].id)
  assert.deepEqual(rows.map(r => [r.seq, r.outcome, r.reason, r.target]), [[4, 'allowed', null, 'bot-b'], [5, 'denied', 'recipient-off', 'bot-c']])
})

test('group and segment Sessions are attributed to their Bot (and room)', async () => {
  const a = openArchive(join(tmp('pass-'), 'l.sqlite'))
  await pass(a, fakeReaders({ sessions: {
    'grp-b': [call(1, 0, 'g1', 'message_bot', { to: 'Ana' }), res(2, 1, 'g1', refusal('Ana', 'Bo', 'group-off'), true)],
    'seg-a': [call(1, 0, 's1', 'message_bot', { to: 'Bo' }), res(2, 1, 's1', 'Sent.', false)],
  } }))
  const rows = auths(a)
  const g = rows.find(r => r.session_id === 'grp-b')
  assert.deepEqual([g.actor, g.room_id, g.reason], ['bot-b', 'room-r', 'group-off'])
  assert.equal(rows.find(r => r.session_id === 'seg-a').actor, 'bot-a')
})

test('diagnostics refusals: a repeat within 2 s is dropped; a different target or a 40 s gap is kept', async () => {
  const a = openArchive(join(tmp('pass-'), 'l.sqlite'))
  await pass(a, fakeReaders({
    sessions: { 'chat-a': [call(1, 0, 'k', 'message_bot', { to: 'Cy' }), res(2, 1000, 'k', refusal('Cy', 'Ana', 'recipient-off'), true)] },
    diagnostics: [
      { time: T + 1500, text: 'ds-bot: bot message from Ana to Cy did not start work (recipient-off)', file: 'diagnostics.jsonl' },
      { time: T + 1500, text: 'ds-bot: bot message from Ana to Bo did not start work (recipient-off)', file: 'diagnostics.jsonl' },
      { time: T + 41_000, text: 'ds-bot: bot message from Ana to Cy did not start work (recipient-off) in Desk', file: 'diagnostics.jsonl' },
    ],
  }))
  const diag = auths(a).filter(r => r.source === 'diagnostics')
  assert.deepEqual(diag.map(r => [r.target, r.at - T, r.room_id]), [['bot-b', 1500, null], ['bot-c', 41_000, 'room-r']])
})

test('an unknown target is stored as unresolved:<hash>, and raw names stay in bots and rooms only', async () => {
  const a = openArchive(join(tmp('pass-'), 'l.sqlite'))
  await pass(a, fakeReaders({ sessions: { 'chat-a': [call(1, 0, 'k', 'message_bot', { to: 'Ghost Writer' }), res(2, 1, 'k', 'Error: Not sent: no such Bot.', true)] } }))
  assert.match(auths(a)[0].target, /^unresolved:[0-9a-f]{12}$/)
  for (const table of ['tasks', 'runs', 'events', 'authorizations', 'artifacts', 'session_owners', 'sync', 'cursors']) {
    const dump = JSON.stringify(a.db.prepare(`SELECT * FROM ${table}`).all())
    for (const name of ['Ghost', 'Ana', 'Desk']) assert.ok(!dump.includes(name), `${name} in ${table}`)
  }
})

test('a reader that throws mid-pass leaves the archive unchanged', async () => {
  const a = openArchive(join(tmp('pass-'), 'l.sqlite'))
  await assert.rejects(pass(a, fakeReaders({ sessions: { 'chat-a': [] }, throwIn: 'sessions' })), /disk gone/)
  assert.equal(a.count('authorizations') + a.count('events') + a.db.prepare('SELECT COUNT(*) AS n FROM bots').get().n, 0)
})

// Rows as a pass leaves them, without revision bookkeeping.
const snapshot = a => Object.fromEntries(['tasks', 'runs', 'events', 'authorizations', 'artifacts'].map(t =>
  [t, a.db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all().map(({ rev, updated_at, ...r }) => ({ ...r }))]))

test('incremental passes converge on the same rows as one fresh pass, over a synthetic home', async () => {
  const dir = tmp('pass-home-')
  const { home, ids } = makeHome(join(dir, 'home'))
  const inc = openArchive(join(dir, 'inc.sqlite'))
  const opts = { home, readers: realReaders, classify, now: () => T + 10_000 }
  await runPass({ ...opts, archive: inc })
  const pendingBefore = auths(inc).filter(r => r.outcome === 'pending').length
  advanceHome(home)
  await runPass({ ...opts, archive: inc })
  await runPass({ ...opts, archive: inc })
  const fresh = openArchive(join(dir, 'fresh.sqlite'))
  await runPass({ ...opts, archive: fresh })
  assert.deepEqual(snapshot(inc), snapshot(fresh))
  assert.equal(pendingBefore, 1)
  assert.equal(auths(inc).filter(r => r.outcome === 'pending').length, 0)
  const revised = auths(inc).find(r => r.reason === 'tool-error')
  assert.equal(revised.rev, 2, 'the pending call became denied in place')
  const replies = inc.db.prepare("SELECT kind FROM events WHERE ref LIKE 'ledger:%#x-2' AND kind IN ('review.verdict','message.replied')").all()
  assert.deepEqual(replies.map(r => r.kind), ['review.verdict'], 'one reply row, labelled by its task category')
  assert.equal(inc.db.prepare("SELECT task_id FROM events WHERE kind = 'message.requested'").get().task_id, ids.task)
  // No stored string holds a path: '/' appears only inside the known ref prefixes.
  for (const t of ['tasks', 'runs', 'events', 'authorizations', 'artifacts', 'session_owners', 'bots', 'rooms', 'sync', 'cursors', 'meta']) {
    for (const row of inc.db.prepare(`SELECT * FROM ${t}`).all()) for (const v of Object.values(row)) if (typeof v === 'string') assert.ok(!v.includes('/') || /^(session|ledger|group|diagnostics):/.test(v) || t === 'bots', `${t}: ${v}`)
  }
})

test('the CLI refuses an archive inside the DS Bot home', () => {
  const dir = tmp('pass-cli-')
  const cli = fileURLToPath(new URL('../src/lineage/cli.mjs', import.meta.url))
  const r = spawnSync(process.execPath, [cli, '--home', dir, '--db', join(dir, 'bot', 'x.sqlite')], { encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /outside --home/)
})
