// A synthetic DS Bot home (DSH_HOME) with invented Bots, rooms and Sessions, in the shapes
// DS Bot and DSH write on disk. Tests use this instead of any real data.
import { appendFileSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

export const T0 = 1_763_500_000_000
export const IDS = {
  chief: 'bot-chief', writer: 'bot-writer', editor: 'bot-editor', vault: 'bot-vault', desk: 'room-desk',
  chiefChat: 'session-c1', chiefSegment: 'session-c0', chiefPart: 'session-cp1', chiefPartSegment: 'session-cp0',
  writerChat: 'session-w1', editorChat: 'session-e1', writerGroup: 'session-wg1', editorGroup: 'session-eg1', deskRoom: 'session-d1',
  deskPart: 'session-dp0', writerGroupSegment: 'session-wg0', task: 'task-0001',
}
const PROJECT = '--synthetic-workspace--'
export const TEXTS = { request: 'please draft the launch note', reply: 'draft attached, two open questions', passive: 'late result text' }

const line = o => `${JSON.stringify(o)}\n`
const header = id => line({ type: 'session', version: 4, id, createdAt: T0, cwd: '/synthetic/workspace', isSeeded: false, delegationDepth: 0, agentPreset: 'default' })
const call = (seq, t, callId, name, args) => ({ type: 'tool/call', time: T0 + t, seq, data: { callId, name, arguments: JSON.stringify(args) } })
const result = (seq, t, callId, text, isError) => ({ type: 'tool/result', time: T0 + t, seq, data: { message: { toolCallId: callId, isError, content: [{ type: 'text', text }] } } })
const turn = (seq, t, kind, n) => ({ type: kind === 'start' ? 'turn/start' : 'turn/end', time: T0 + t, seq, data: kind === 'start' ? { turn: n } : { turn: n, reason: { kind: 'completed' } } })

export const REFUSAL_RECIPIENT_OFF = 'Error: Not sent: Writer does not take automatic messages from Chief (recipient-off). No turn was started.'
export const REFUSAL_CATEGORY = 'Not sent: Editor in "Desk" does not take automatic messages from Chief (task-category-required). No turn was started.'
export const REFUSAL_GROUP_OFF = 'Error: Not sent: Editor in "Desk" does not take automatic messages from Writer (group-off). No turn was started.'

function sessionFile(home, id) {
  const dir = join(home, 'sessions', PROJECT, id)
  mkdirSync(dir, { recursive: true })
  return join(dir, 'session.v4.jsonl.zstd')
}
// One zstd frame per batch, appended, as DSH writes them.
const frame = (file, rows) => appendFileSync(file, zstdCompressSync(Buffer.from(rows.map(line).join(''))))

export function makeHome(dir, { phase = 1, torn = false } = {}) {
  const home = dir
  mkdirSync(join(home, 'bot', 'ledger'), { recursive: true })
  mkdirSync(join(home, 'bot', 'logs'), { recursive: true })
  const state = {
    version: 1,
    bots: {
      [IDS.chief]: { id: IDS.chief, name: 'Chief', model: 'synthetic/model', sessionId: IDS.chiefChat, segments: [{ sessionId: IDS.chiefSegment }], openParts: [{ sessionId: IDS.chiefPart, segments: [{ sessionId: IDS.chiefPartSegment }] }] },
      [IDS.writer]: { id: IDS.writer, name: 'Writer', model: 'synthetic/model', sessionId: IDS.writerChat, botResponse: { mode: 'off' } },
      [IDS.editor]: { id: IDS.editor, name: 'Editor', model: 'synthetic/model', sessionId: IDS.editorChat, botResponse: { mode: 'all' } },
      [IDS.vault]: { id: IDS.vault, name: 'Vault', model: 'synthetic/model', private: true },
    },
    rooms: {
      [IDS.desk]: { id: IDS.desk, name: 'Desk', members: [IDS.writer, IDS.editor], sessionId: IDS.deskRoom, botResponse: { mode: 'off' }, seq: 1,
        sessions: { [IDS.writer]: IDS.writerGroup, [IDS.editor]: IDS.editorGroup }, segments: { [IDS.writer]: [{ sessionId: IDS.writerGroupSegment }] }, parts: [{ sessionId: IDS.deskPart }] },
    },
  }
  writeFileSync(join(home, 'bot', 'state.json'), JSON.stringify(state))

  const chief = sessionFile(home, IDS.chiefChat)
  const writerGroup = sessionFile(home, IDS.writerGroup)
  const editorChat = sessionFile(home, IDS.editorChat)
  {
    writeFileSync(chief, zstdCompressSync(Buffer.from(header(IDS.chiefChat))))
    frame(chief, [
      turn(1, 0, 'start', 1),
      call(2, 100, 'call-1', 'message_bot', { to: 'Editor', message: TEXTS.request }),
      call(3, 110, 'call-2', 'message_bot', { to: 'Writer', message: 'ping' }),
      result(4, 200, 'call-1', 'Sent to Editor.', false),
      result(5, 210, 'call-2', REFUSAL_RECIPIENT_OFF, true),
      call(6, 300, 'call-3', 'post_to_group', { group: 'Desk', message: '@Editor take this' }),
      result(7, 310, 'call-3', REFUSAL_CATEGORY, false),
      call(8, 400, 'call-4', 'message_bot', { to: 'Ghost', message: 'anyone?' }),
      turn(9, 500, 'end', 1),
    ])
    writeFileSync(writerGroup, zstdCompressSync(Buffer.from(header(IDS.writerGroup))))
    frame(writerGroup, [
      turn(1, 1000, 'start', 1),
      call(2, 1100, 'call-w1', 'message_bot', { to: 'Editor', message: 'review please' }),
      result(3, 1110, 'call-w1', REFUSAL_GROUP_OFF, true),
      turn(4, 1200, 'end', 1),
    ])
    writeFileSync(editorChat, zstdCompressSync(Buffer.from(header(IDS.editorChat))))
    frame(editorChat, [
      turn(1, 2000, 'start', 1),
      { type: 'user/message', time: T0 + 2001, seq: 2, data: { content: [{ type: 'text', text: TEXTS.request }], source: { routing: { task: IDS.task, key: 'k1', sender: IDS.chief, recipient: IDS.editor, trail: [IDS.chief], hops: 1, category: 'review' } } } },
      turn(3, 2100, 'end', 1),
    ])
    const pair = join(home, 'bot', 'ledger', `pair-${IDS.chief}-${IDS.editor}.jsonl`)
    writeFileSync(pair, [
      { id: 'x-1', from: IDS.chief, to: IDS.editor, role: 'request', text: TEXTS.request, time: T0 + 150 },
      { event: 'delivered', id: 'x-1', sessionId: IDS.editorChat, time: T0 + 160 },
      { id: 'x-2', from: IDS.editor, to: IDS.chief, role: 'reply', text: TEXTS.reply, replyTo: 'x-1', time: T0 + 2100 },
      { event: 'delivered', id: 'x-2', sessionId: IDS.chiefChat, time: T0 + 2110 },
      { id: 'x-3', from: IDS.editor, to: IDS.chief, role: 'reply', text: TEXTS.passive, replyTo: 'x-1', time: T0 + 2200 },
      { event: 'delivered', id: 'x-3', sessionId: IDS.chiefChat, passive: true, time: T0 + 2210 },
    ].map(line).join(''))
    writeFileSync(join(home, 'bot', 'ledger', `group-${IDS.desk}.jsonl`), [
      { who: 'Chief', kind: 'message', text: '@Editor take this', seq: 1, time: T0 + 305 },
      { who: 'DS Bot', kind: 'notice', reason: 'category', names: ['Editor'], about: IDS.editor, from: 'Chief', refused: 'task-category-required', accepts: ['review'], seq: 2, time: T0 + 311 },
    ].map(line).join(''))
    writeFileSync(join(home, 'bot', 'logs', 'diagnostics.jsonl.1'), line({ time: T0 - 5000, level: 'info', source: 'host', text: 'started' }) + line({ time: T0 - 4000, level: 'warn', source: 'host', text: 'ds-bot: something unrelated' }))
    writeFileSync(join(home, 'bot', 'logs', 'diagnostics.jsonl'), [
      { time: T0 + 211, level: 'warn', source: 'host', text: 'ds-bot: bot message from Chief to Writer did not start work (recipient-off)' },
      { time: T0 + 1111, level: 'warn', source: 'host', text: 'ds-bot: bot message from Writer to Editor did not start work (group-off) in Desk' },
    ].map(line).join(''))
  }
  if (phase === 2) advanceHome(home)
  if (torn) {
    const size = readFileSync(writerGroup).length
    truncateSync(writerGroup, size - 7)
  }
  return {
    home, ids: IDS, texts: TEXTS,
    expected: {
      sessions: 3,
      toolDenials: phase === 2 ? { 'recipient-off': 2, 'task-category-required': 1, 'group-off': 1, 'tool-error': 1 } : { 'recipient-off': 1, 'task-category-required': 1, 'group-off': 1 },
      pending: phase === 2 ? 0 : 1,
      diagnosticsRefusals: phase === 2 ? 3 : 2,
      passive: 1, groupNotices: 1,
    },
  }
}

// Phase 2: later frames and lines appended to the same files (a pending call gets its
// result, a new refusal, a new diagnostics line).
export function advanceHome(home) {
  const chief = sessionFile(home, IDS.chiefChat)
  const editorChat = sessionFile(home, IDS.editorChat)
  {
    frame(chief, [
      turn(10, 3000, 'start', 2),
      result(11, 3010, 'call-4', 'Error: Not sent: Ghost is not on the team.', true),
      call(12, 3100, 'call-5', 'stop_bot', { bot: 'Editor' }),
      result(13, 3110, 'call-5', 'Stopped Editor.', false),
      turn(14, 3200, 'end', 2),
    ])
    frame(editorChat, [
      turn(4, 3300, 'start', 2),
      call(5, 3310, 'call-e1', 'message_bot', { to: 'Writer', message: 'done?' }),
      result(6, 3320, 'call-e1', 'Error: Not sent: Writer does not take automatic messages from Editor (recipient-off). No turn was started.', true),
      turn(7, 3400, 'end', 2),
    ])
    appendFileSync(join(home, 'bot', 'logs', 'diagnostics.jsonl'), line({ time: T0 + 3321, level: 'warn', source: 'host', text: 'ds-bot: bot message from Editor to Writer did not start work (recipient-off)' }))
  }
}
