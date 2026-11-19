// One bridge pass: read the DS Bot home once, then write the whole result to the archive in
// one transaction. Readers and classifiers are injected (cli.mjs composes them), so tests can
// drive a pass from in-memory records. A pass recomputes everything it can see, so running
// it twice, or after more data arrives, converges on the same rows.
import { createHash } from 'node:crypto'
import { link, rowId } from './link.mjs'

const unresolved = name => `unresolved:${createHash('sha256').update(String(name)).digest('hex').slice(0, 12)}`
const parseArgs = raw => { if (raw && typeof raw === 'object') return raw; try { return JSON.parse(raw) } catch { return {} } }
export const DIAG_GRACE_MS = 120_000
const textOf = message => (Array.isArray(message?.content) ? message.content.map(c => c?.text ?? '').join(' ') : '')

export async function runPass({ home, archive, readers, classify, now = Date.now, textKey }) {
  if (!readers || !classify) throw new Error('runPass needs readers and classify')
  const startedAt = now()
  // --- read everything first: a reader that throws leaves the archive untouched ---
  const state = readers.readState(home)
  const owners = state.owners ?? new Map()
  const sessions = []
  let torn = 0
  let badLines = 0
  for (const { sessionId, file } of readers.listSessionLogs(home)) {
    const r = await readers.readSessionEvents(file)
    if (r.torn) torn += 1
    badLines += r.badLines ?? 0
    const results = new Map()
    const calls = []
    for (const e of r.events) {
      if (e.type === 'tool/call' && classify.MESSAGE_TOOLS.has(e.data?.name)) calls.push({ callId: e.data.callId, name: e.data.name, args: parseArgs(e.data.arguments), at: e.time, seq: e.seq })
      if (e.type === 'tool/result') {
        const m = e.data?.message
        const id = m?.toolCallId ?? e.data?.toolCallId
        if (id) results.set(id, { isError: m?.isError === true, text: textOf(m), at: e.time, seq: e.seq })
      }
    }
    sessions.push({ sessionId, owner: owners.get(sessionId) ?? null, events: r.events, calls, results })
  }
  const ledger = readers.readLedger(home, { textKey })
  const prevCursor = archive.cursor('diagnostics')
  const diag = readers.readDiagnostics(home, prevCursor)

  // --- resolve names to ids; raw names live only in bots.name and rooms.name ---
  // Current names first; Bots and rooms the archive has seen before still resolve after they
  // are deleted from state.json.
  const seenBots = archive.db.prepare('SELECT id, name FROM bots WHERE name IS NOT NULL').all()
  const seenRooms = archive.db.prepare('SELECT id, name FROM rooms WHERE name IS NOT NULL').all()
  const botByName = new Map([...seenBots.map(b => [b.name, b.id]), ...state.bots.filter(b => b.name).map(b => [b.name, b.id])])
  const roomByName = new Map([...seenRooms.map(r => [r.name, r.id]), ...state.rooms.filter(r => r.name).map(r => [r.name, r.id])])
  const botName = id => state.bots.find(b => b.id === id)?.name ?? seenBots.find(b => b.id === id)?.name ?? null
  // DS Bot falls back to the Bot's id when it has no name, so an id is accepted as a name.
  const knownIds = new Set([...seenBots.map(b => b.id), ...state.bots.map(b => b.id)])
  const botId = name => (name == null || name === '' ? null : botByName.get(String(name).replace(/^@/, '')) ?? (knownIds.has(String(name)) ? String(name) : unresolved(name)))
  const roomId = name => (name == null || name === '' ? null : roomByName.get(String(name)) ?? unresolved(name))

  const linked = link({ sessions, ledger, botName })

  // --- authorizations ---
  const auths = []
  for (const s of sessions) {
    const actor = s.owner?.botId ?? null
    for (const c of s.calls) {
      const res = s.results.get(c.callId)
      const k = classify.classifyToolResult({ name: c.name, args: c.args, isError: res?.isError, text: res?.text })
      const at = res?.at ?? c.at
      auths.push({
        id: rowId('auth', 'tool', s.sessionId, c.callId), at, actor, target: botId(k.targetName),
        room_id: s.owner?.kind === 'group' ? s.owner.roomId : roomId(k.roomName), action: c.name, outcome: k.outcome, reason: k.reason,
        source: 'tool', ...linked.linkCall(s.sessionId, c.at), session_id: s.sessionId, seq: res?.seq ?? c.seq, ref: `session:${s.sessionId}#seq:${res?.seq ?? c.seq}`,
      })
    }
    for (const e of s.events) {
      if (e.type !== 'permission/preset' && e.type !== 'approval/policy') continue
      const action = e.type === 'permission/preset' ? 'permission.preset' : 'approval.policy'
      const value = e.data?.preset ?? e.data?.policy
      auths.push({ id: rowId('auth', 'policy', s.sessionId, e.seq), at: e.time, actor, target: null, room_id: s.owner?.roomId ?? null, action, outcome: 'policy', reason: typeof value === 'string' ? value.slice(0, 80) : null, source: 'session-policy', task_id: null, run_id: null, session_id: s.sessionId, seq: e.seq, ref: `session:${s.sessionId}#seq:${e.seq}` })
    }
  }
  for (const d of ledger.deliveries) {
    const rec = ledger.records.find(r => r.book === d.book && r.id === d.id)
    const refusal = rec && classify.passiveDeliveryRefusal(rec, d)
    if (!refusal) continue
    auths.push({ id: rowId('auth', 'ledger', d.book, d.id), at: refusal.time, actor: refusal.fromId, target: refusal.toId, room_id: refusal.roomId, action: refusal.action, outcome: 'denied', reason: refusal.reason, source: 'ledger', task_id: null, run_id: null, session_id: d.sessionId, seq: null, ref: `ledger:${d.book}#${d.id}` })
  }
  for (const n of ledger.groupNotices) {
    const r = classify.groupNoticeRefusal(n)
    auths.push({ id: rowId('auth', 'notice', r.roomId, r.seq), at: r.time, actor: botId(r.fromName), target: r.toId, room_id: r.roomId, action: r.action, outcome: 'denied', reason: r.reason, source: 'group-notice', task_id: null, run_id: null, session_id: null, seq: r.seq, ref: `group:${r.roomId}#${r.seq}` })
  }
  // A diagnostics line repeats a structured denial when actor, target and reason match within
  // 2 s; anything else is a refusal the structured sources did not see, and is kept. Rows are
  // never deleted, so a line is held back until its tool result has surely landed: while any
  // Session log is torn (a frame still being written) and for DIAG_GRACE_MS after the line.
  const structured = auths.filter(a => a.outcome === 'denied')
  const diagCutoff = now() - DIAG_GRACE_MS
  let heldBack = 0
  const names = state.bots.map(b => b.name).filter(Boolean)
  const roomNames = state.rooms.map(r => r.name).filter(Boolean)
  for (const line of diag.lines) {
    const p = classify.parseDiagnosticRefusal(line.text, names, roomNames)
    if (!p || !Number.isFinite(line.time)) continue
    if (torn > 0 || line.time > diagCutoff) { heldBack += 1; continue }
    const actor = botId(p.fromName)
    const target = botId(p.toName)
    if (structured.some(a => a.actor === actor && a.target === target && a.reason === p.reason && Math.abs(a.at - line.time) <= 2000)) continue
    auths.push({ id: rowId('auth', 'diag', line.time, line.text), at: line.time, actor, target, room_id: roomId(p.roomName), action: 'bot.respond', outcome: 'denied', reason: p.reason, source: 'diagnostics', task_id: null, run_id: null, session_id: null, seq: null, ref: `diagnostics:${line.time}` })
  }

  // --- write, all or nothing ---
  const t = now()
  const counts = archive.tx(() => {
    for (const b of state.bots) archive.put('bots', { id: b.id, name: b.name, private: b.private ? 1 : 0, updated_at: t })
    for (const r of state.rooms) archive.put('rooms', { id: r.id, name: r.name, updated_at: t })
    for (const [session_id, o] of owners) archive.put('session_owners', { session_id, bot_id: o.botId, room_id: o.roomId, kind: o.kind })
    for (const task of linked.tasks) archive.upsert('tasks', { ...task, updated_at: t })
    for (const run of linked.runs) archive.put('runs', run)
    for (const a of linked.artifacts) archive.put('artifacts', a)
    const result = { events: { inserted: 0, revised: 0 }, authorizations: { inserted: 0, revised: 0 } }
    for (const e of linked.events) { if (!Number.isFinite(e.at)) continue; const r = archive.upsert('events', e, t); if (r in result.events) result.events[r] += 1 }
    for (const a of auths) { if (!Number.isFinite(a.at)) continue; const r = archive.upsert('authorizations', a, t); if (r in result.authorizations) result.authorizations[r] += 1 }
    archive.put('cursors', { source: 'diagnostics', value: JSON.stringify(diag.cursor) })
    const totals = Object.fromEntries(['tasks', 'runs', 'events', 'authorizations', 'artifacts'].map(n => [n, archive.count(n)]))
    const counts = { ...totals, changes: result, sessions: sessions.length, torn, badLines, diagnosticsHeldBack: heldBack, rotated: diag.rotated, cleared: diag.cleared, stateError: state.stateError === true, ms: now() - startedAt }
    archive.put('sync', { id: 1, at: t, counts: JSON.stringify(counts) })
    return counts
  })
  return { counts, torn, rotated: diag.rotated, cleared: diag.cleared }
}
