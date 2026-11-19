import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, renameSync, truncateSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { readers } from '../src/lineage/readers.mjs'
import { advanceHome, IDS, makeHome, TEXTS } from './fixtures/dsbot-home.mjs'

const fresh = (opts) => makeHome(mkdtempSync(join(tmpdir(), 'dsbot-home-')), opts)

test('the owners map covers chat, segment, part, group and room Sessions', () => {
  const { home } = fresh()
  const { bots, rooms, owners } = readers.readState(home)
  assert.equal(bots.length, 4)
  assert.equal(bots.find(b => b.id === IDS.vault).private, true)
  assert.deepEqual(rooms[0].members, [IDS.writer, IDS.editor])
  const expect = {
    [IDS.chiefChat]: [IDS.chief, null, 'chat'], [IDS.chiefSegment]: [IDS.chief, null, 'segment'],
    [IDS.chiefPart]: [IDS.chief, null, 'part'], [IDS.chiefPartSegment]: [IDS.chief, null, 'part'],
    [IDS.writerGroup]: [IDS.writer, IDS.desk, 'group'], [IDS.writerGroupSegment]: [IDS.writer, IDS.desk, 'group'],
    [IDS.deskRoom]: [null, IDS.desk, 'room'], [IDS.deskPart]: [null, IDS.desk, 'room'],
    [IDS.vault]: [IDS.vault, null, 'chat'],
  }
  for (const [sid, [botId, roomId, kind]] of Object.entries(expect)) assert.deepEqual(owners.get(sid), { botId, roomId, kind }, sid)
})

test('a missing or broken state.json gives empty results and a flag, never a throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-empty-'))
  assert.equal(readers.readState(dir).stateError, true)
  mkdirSync(join(dir, 'bot'))
  writeFileSync(join(dir, 'bot', 'state.json'), '{"bots": {')
  assert.equal(readers.readState(dir).stateError, true)
})

test('listSessionLogs picks the newest generation, accepts plain .jsonl, decodes ~ escapes, and hides the project folder', () => {
  const { home } = fresh()
  const dir = join(home, 'sessions', '--synthetic-workspace--', 'session~003Aodd')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from('')))
  writeFileSync(join(dir, 'session.v5.jsonl.zstd'), zstdCompressSync(Buffer.from('')))
  const plain = join(home, 'sessions', '--synthetic-workspace--', 'session-plain')
  mkdirSync(plain)
  writeFileSync(join(plain, 'session.v4.jsonl'), '')
  const logs = readers.listSessionLogs(home)
  const odd = logs.find(l => l.sessionId === 'session:odd')
  assert.ok(odd.file.endsWith('session.v5.jsonl.zstd'))
  assert.ok(logs.find(l => l.sessionId === 'session-plain').file.endsWith('session.v4.jsonl'))
  for (const l of logs) assert.deepEqual(Object.keys(l).sort(), ['file', 'sessionId'])
  assert.ok(logs.every(l => !l.sessionId.includes('synthetic-workspace')))
})

test('a torn log keeps every complete event, and reads in full after the next frame lands', async () => {
  const { home } = fresh({ torn: true })
  const log = readers.listSessionLogs(home).find(l => l.sessionId === IDS.writerGroup)
  const first = await readers.readSessionEvents(log.file)
  assert.equal(first.torn, true)
  assert.equal(first.events.length, 0, 'the cut frame is dropped, the header frame is not an event')
  const chief = readers.listSessionLogs(home).find(l => l.sessionId === IDS.chiefChat)
  const ok = await readers.readSessionEvents(chief.file)
  assert.equal(ok.torn, false)
  assert.equal(ok.events.length, 9)
  assert.deepEqual(ok.events[0], { type: 'turn/start', time: ok.events[0].time, seq: 1, data: { turn: 1 } })
  advanceHome(home)
  const after = await readers.readSessionEvents(chief.file)
  assert.equal(after.events.length, 14)
})

test('a bad JSON line is counted and skipped, not fatal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-bad-'))
  const file = join(dir, 'session.v4.jsonl')
  writeFileSync(file, '{"type":"turn/start","time":1,"seq":1}\nnot json\n{"type":"turn/end","time":2,"seq":2}\n{"type":"half')
  const r = await readers.readSessionEvents(file)
  assert.equal(r.events.length, 2)
  assert.equal(r.badLines, 1)
  assert.equal(r.torn, true)
})

test('the ledger reader keeps hashes and counts, never message text', () => {
  const { home } = fresh()
  const plain = readers.readLedger(home)
  assert.equal(plain.records.length, 3)
  assert.equal(plain.deliveries.filter(d => d.passive).length, 1)
  assert.deepEqual(plain.groupNotices.map(n => [n.roomId, n.about, n.refused, n.from]), [[IDS.desk, IDS.editor, 'task-category-required', 'Chief']])
  const json = JSON.stringify(plain)
  for (const text of Object.values(TEXTS)) assert.ok(!json.includes(text))
  assert.ok(!json.includes('take this'))
  const keyed = readers.readLedger(home, { textKey: Buffer.from('synthetic-key') })
  assert.notEqual(keyed.records[0].textSha256, plain.records[0].textSha256)
  assert.equal(keyed.records[0].bytes, Buffer.byteLength(TEXTS.request))
})

test('diagnostics: .1 is read first, and rotation and clearing are reported', () => {
  const { home } = fresh()
  const first = readers.readDiagnostics(home)
  assert.deepEqual(first.lines.map(l => l.file), ['diagnostics.jsonl.1', 'diagnostics.jsonl', 'diagnostics.jsonl'])
  assert.equal(first.rotated || first.cleared, false)
  const logs = join(home, 'bot', 'logs')
  renameSync(join(logs, 'diagnostics.jsonl'), join(logs, 'diagnostics.jsonl.1'))
  writeFileSync(join(logs, 'diagnostics.jsonl'), '')
  const rotated = readers.readDiagnostics(home, first.cursor)
  assert.equal(rotated.rotated, true)
  appendFileSync(join(logs, 'diagnostics.jsonl'), '{"time":1,"level":"warn","text":"x"}\n')
  const grown = readers.readDiagnostics(home, rotated.cursor)
  truncateSync(join(logs, 'diagnostics.jsonl'), 0)
  const cleared = readers.readDiagnostics(home, grown.cursor)
  assert.equal(cleared.cleared, true)
  assert.equal(cleared.rotated, false)
})
