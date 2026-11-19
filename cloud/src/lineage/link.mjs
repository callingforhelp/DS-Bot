// Task, run and event linking, carried over from the bridge PoC. It is a heuristic over time
// windows: a wrong link moves an event between runs, but never changes a refusal row.
import { createHash } from 'node:crypto'

export const rowId = (...parts) => createHash('sha256').update(parts.map(p => String(p ?? '')).join('\0')).digest('hex').slice(0, 40)
const ref = (sessionId, seq) => `session:${sessionId}#seq:${seq}`

// Turns from turn/start..turn/end; an unfinished turn stays open.
export function buildTurns(events) {
  const turns = []
  let open = null
  for (const e of events) {
    if (e.type === 'turn/start') { open = { turn: e.data?.turn ?? turns.length + 1, startSeq: e.seq, startTime: e.time, routing: [] }; continue }
    if (!open) continue
    if (e.type === 'user/message' && e.data?.source?.routing) open.routing.push({ routing: e.data.source.routing, at: e.time, seq: e.seq })
    if (e.type === 'turn/end') { turns.push({ ...open, endSeq: e.seq, endTime: e.time, outcome: e.data?.reason?.kind ?? 'unknown' }); open = null }
  }
  if (open) turns.push({ ...open, endSeq: null, endTime: events.at(-1)?.time ?? open.startTime, outcome: 'open' })
  return turns
}

// sessions: [{sessionId, owner, events, calls:[{callId,name,args,at,seq}]}]; ledger from readLedger.
export function link({ sessions, ledger, botName }) {
  const routingRows = []
  const turnsBySession = new Map()
  for (const s of sessions) {
    const turns = buildTurns(s.events)
    turnsBySession.set(s.sessionId, turns)
    for (const t of turns) for (const r of t.routing) routingRows.push({ ...r, sessionId: s.sessionId, turn: t })
  }
  const nearest = (senderId, recipientId, at, max = 15_000) => {
    let best = null
    for (const row of routingRows) {
      if (row.routing.sender !== senderId || row.routing.recipient !== recipientId || !row.routing.task) continue
      const d = Math.abs(row.at - at)
      if (d <= max && (!best || d < best.d)) best = { row, d }
    }
    return best?.row
  }
  const requests = ledger.records.filter(r => r.role === 'request')
  const replies = ledger.records.filter(r => r.role === 'reply' || r.role === 'report')
  const taskOfRequest = new Map()
  for (const r of requests) { const m = nearest(r.from, r.to, r.time); if (m) taskOfRequest.set(r.id, m.routing.task) }
  const taskOfReply = new Map()
  for (const r of replies) {
    const t = taskOfRequest.get(r.replyTo) ?? nearest(r.from, r.to, r.time)?.routing.task
    if (t) taskOfReply.set(r.id, t)
  }

  const runs = new Map()
  const assignments = [] // {sessionId, at, taskId, runId}
  const requestRun = new Map()
  const completion = new Map()
  const addRun = run => { runs.set(run.id, run); return run.id }
  // Assignment: each linked request is matched to the nearest message_bot call its sender
  // made to that recipient (the request lands between 5 s before and 180 s after the call).
  const turnOf = (sessionId, at) => turnsBySession.get(sessionId)?.find(t => at >= t.startTime && at <= t.endTime)
  for (const r of requests) {
    const taskId = taskOfRequest.get(r.id)
    if (!taskId) continue
    let best = null
    for (const s of sessions) {
      if (s.owner?.botId !== r.from) continue
      for (const call of s.calls) {
        if (call.name !== 'message_bot' || String(call.args?.to ?? '').replace(/^@/, '') !== botName(r.to)) continue
        const d = r.time - call.at
        if (d < -5000 || d > 180_000) continue
        if (!best || Math.abs(d) < best.d) best = { s, call, d: Math.abs(d) }
      }
    }
    const turn = best && turnOf(best.s.sessionId, best.call.at)
    if (!turn) continue
    const sessionId = best.s.sessionId
    const runId = addRun({ id: rowId('run', taskId, sessionId, turn.turn, 'assignment'), task_id: taskId, bot_id: r.from, session_id: sessionId, turn: turn.turn, role: 'assignment', started_at: turn.startTime, ended_at: turn.endTime, outcome: turn.outcome, ref: ref(sessionId, turn.startSeq) })
    requestRun.set(r.id, runId)
    assignments.push({ sessionId, at: best.call.at, taskId, runId })
  }
  for (const s of sessions) {
    const botId = s.owner?.botId
    if (!botId) continue
    const turns = turnsBySession.get(s.sessionId)
    for (const turn of turns) {
      for (const item of turn.routing) {
        const taskId = item.routing.task
        if (!taskId) continue
        const role = item.routing.result ? 'completion' : 'work'
        const id = addRun({ id: rowId('run', taskId, s.sessionId, turn.turn, role), task_id: taskId, bot_id: botId, session_id: s.sessionId, turn: turn.turn, role, started_at: turn.startTime, ended_at: turn.endTime, outcome: turn.outcome, ref: ref(s.sessionId, turn.startSeq) })
        if (role === 'completion') completion.set(taskId, { id, botId, sessionId: s.sessionId, turn })
      }
    }
  }

  const tasks = new Map()
  const byTask = new Map()
  for (const row of routingRows) if (row.routing.task) (byTask.get(row.routing.task) ?? byTask.set(row.routing.task, []).get(row.routing.task)).push(row)
  for (const [taskId, rows] of byTask) {
    rows.sort((a, b) => a.at - b.at)
    const first = rows.find(r => !r.routing.result) ?? rows[0]
    const request = requests.find(r => taskOfRequest.get(r.id) === taskId)
    const reply = replies.find(r => taskOfReply.get(r.id) === taskId)
    const category = first.routing.category ?? 'general'
    let status = reply ? (category === 'review' ? 'reviewed' : 'replied') : request ? 'working' : 'assigned'
    const done = completion.get(taskId)
    if (done?.turn.outcome === 'completed') status = 'completed'
    tasks.set(taskId, {
      id: taskId, category, assigned_by: first.routing.sender ?? null, assigned_to: first.routing.recipient ?? null,
      exchange_id: request?.id ?? reply?.replyTo ?? null, created_at: Math.min(...rows.map(r => r.at), request?.time ?? Infinity),
      status, completed_at: status === 'completed' ? done.turn.endTime : null, ref: ref(first.sessionId, first.seq),
    })
  }

  const events = []
  for (const [taskId, rows] of byTask) {
    const first = rows.find(r => !r.routing.result)
    if (first) events.push({ id: rowId('event', 'task.assigned', taskId), kind: 'task.assigned', task_id: taskId, run_id: null, actor: first.routing.sender ?? null, target: first.routing.recipient ?? null, room_id: null, at: first.at, session_id: first.sessionId, seq: first.seq, ref: ref(first.sessionId, first.seq), meta: JSON.stringify({ category: first.routing.category ?? 'general', hops: first.routing.hops ?? null }) })
  }
  for (const r of requests) {
    events.push({ id: rowId('event', 'request', r.book, r.id), kind: 'message.requested', task_id: taskOfRequest.get(r.id) ?? null, run_id: requestRun.get(r.id) ?? null, actor: r.from, target: r.to, room_id: r.roomId, at: r.time, session_id: null, seq: null, ref: `ledger:${r.book}#${r.id}`, meta: JSON.stringify({ exchangeId: r.id }) })
  }
  for (const r of replies) {
    const taskId = taskOfReply.get(r.id) ?? null
    const kind = taskId && tasks.get(taskId)?.category === 'review' ? 'review.verdict' : 'message.replied'
    // The id does not depend on the kind: a relabelled reply is revised, not duplicated.
    events.push({ id: rowId('event', 'reply', r.book, r.id), kind, task_id: taskId, run_id: null, actor: r.from, target: r.to, room_id: r.roomId, at: r.time, session_id: null, seq: null, ref: `ledger:${r.book}#${r.id}`, meta: JSON.stringify({ replyTo: r.replyTo }) })
  }
  const ownerOf = new Map(sessions.map(s => [s.sessionId, s.owner]))
  for (const d of ledger.deliveries) {
    const r = ledger.records.find(x => x.book === d.book && x.id === d.id)
    events.push({ id: rowId('event', 'delivered', d.book, d.id, d.sessionId), kind: 'message.delivered', task_id: (r && (taskOfRequest.get(r.id) ?? taskOfReply.get(r.id))) ?? null, run_id: null, actor: r?.from ?? null, target: ownerOf.get(d.sessionId)?.botId ?? r?.to ?? null, room_id: r?.roomId ?? null, at: d.time, session_id: d.sessionId, seq: null, ref: `ledger:${d.book}#${d.id}`, meta: null })
  }
  for (const [taskId, done] of completion) {
    if (done.turn.outcome !== 'completed') continue
    events.push({ id: rowId('event', 'task.completed', taskId), kind: 'task.completed', task_id: taskId, run_id: done.id, actor: done.botId, target: null, room_id: null, at: done.turn.endTime, session_id: done.sessionId, seq: done.turn.endSeq, ref: ref(done.sessionId, done.turn.endSeq), meta: null })
  }
  const artifacts = [...requests, ...replies].map(r => ({ id: rowId('artifact', r.role, r.book, r.id), task_id: taskOfRequest.get(r.id) ?? taskOfReply.get(r.id) ?? null, kind: `message.${r.role}`, ref: `ledger:${r.book}#${r.id}`, sha256: r.textSha256, bytes: r.bytes, at: r.time }))

  // The task and run for one call: the nearest assignment in the same Session, within 180 s.
  const linkCall = (sessionId, at) => {
    let best = null
    for (const a of assignments) {
      if (a.sessionId !== sessionId) continue
      const d = Math.abs(a.at - at)
      if (d <= 180_000 && (!best || d < best.d)) best = { a, d }
    }
    return best ? { task_id: best.a.taskId, run_id: best.a.runId } : { task_id: null, run_id: null }
  }
  return { tasks: [...tasks.values()], runs: [...runs.values()], events, artifacts, linkCall }
}
