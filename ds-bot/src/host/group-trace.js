// Durable project + inter-bot trace capture for group rooms (`1+1 Routing`, `Project Team`).
// Written when a group part rotates so project outcomes and inter-bot routing hops stay
// structured for next-time trace optimization and Kev-4B dataset curation.
import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { looksSecret } from './memory-entries.js'
import { openTasksOf, pastTasksOf } from './tasks.js'

const MAX_TRACE_ENTRIES = 200
const MAX_HOPS = 60

export const pairBookName = (a, b) => `pair-${[String(a), String(b)].sort().join('-')}`

/**
 * Normalize whitespace/length on trace strings and redact anything matching DS Bot's secret heuristic.
 */
export function sanitizeTraceText(text, maxLen = 2000) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLen)
  if (clean === '') return ''
  return looksSecret(clean) ? '[redacted-secret]' : clean
}

const recordTime = entry => {
  const value = Number(entry?.at ?? entry?.time ?? entry?.createdAt ?? 0)
  return Number.isFinite(value) ? value : 0
}

/**
 * Collect inter-bot pair ledger records (`pair-<botA>-<botB>`) for all members of a room.
 */
export function collectPairRecords({ members, readBook, sinceAt = 0, untilAt = Infinity } = {}) {
  if (typeof readBook !== 'function' || !Array.isArray(members) || members.length < 2) return []
  const uniqueMembers = [...new Set(members.map(String).filter(Boolean))]
  const collected = []
  for (let i = 0; i < uniqueMembers.length; i += 1) {
    for (let j = i + 1; j < uniqueMembers.length; j += 1) {
      const pair = pairBookName(uniqueMembers[i], uniqueMembers[j])
      let records = []
      try {
        records = readBook(pair) ?? []
      } catch {
        records = []
      }
      if (!Array.isArray(records)) continue
      for (const record of records) {
        if (!record || typeof record !== 'object') continue
        const at = recordTime(record)
        if (sinceAt > 0 && at > 0 && at < sinceAt) continue
        if (Number.isFinite(untilAt) && at > 0 && at > untilAt) continue
        collected.push({
          pair,
          seq: Number.isInteger(record.seq) ? record.seq : 0,
          at,
          from: String(record.fromName ?? record.from ?? record.sender ?? ''),
          to: String(record.toName ?? record.to ?? record.target ?? ''),
          kind: String(record.kind ?? record.type ?? 'message'),
          text: sanitizeTraceText(record.text ?? record.body ?? record.note ?? ''),
        })
      }
    }
  }
  collected.sort((a, b) => (a.at - b.at) || (a.seq - b.seq))
  return collected.slice(-MAX_TRACE_ENTRIES)
}

/**
 * Summarize chronological actor hops, repeated routing edges (`loopCount`), and participant bots.
 */
export function summarizeRouting(interactions = [], interBotTrace = []) {
  const timeline = [
    ...interactions.map(item => ({ at: recordTime(item), seq: item.seq ?? 0, order: 0, from: String(item.from ?? '').trim() })),
    ...interBotTrace.map(item => ({ at: recordTime(item), seq: item.seq ?? 0, order: 1, from: String(item.from ?? '').trim() })),
  ]
    .filter(item => item.from !== '')
    .sort((a, b) => (a.at - b.at) || (a.order - b.order) || (a.seq - b.seq))

  const handoffSequence = []
  for (const item of timeline) {
    if (handoffSequence.at(-1) !== item.from) handoffSequence.push(item.from)
    if (handoffSequence.length >= MAX_HOPS) break
  }

  const seenEdges = new Set()
  let loopCount = 0
  for (let i = 1; i < handoffSequence.length; i += 1) {
    const edge = `${handoffSequence[i - 1]}->${handoffSequence[i]}`
    if (seenEdges.has(edge)) loopCount += 1
    else seenEdges.add(edge)
  }

  const bots = new Set()
  for (const actor of handoffSequence) {
    if (actor.toLowerCase() !== 'user') bots.add(actor)
  }
  for (const item of interBotTrace) {
    const to = String(item?.to ?? '').trim()
    if (to !== '' && to.toLowerCase() !== 'user') bots.add(to)
  }

  return {
    handoffSequence,
    interBotCount: interBotTrace.length,
    loopCount,
    uniqueBots: [...bots].sort(),
  }
}

const serializeTask = (task, botNameOf) => ({
  id: String(task.id ?? ''),
  botId: task.botId ?? null,
  botName: task.botId ? botNameOf(task.botId) : null,
  goal: sanitizeTraceText(task.goal, 400),
  status: String(task.status ?? ''),
  progress: sanitizeTraceText(task.progress, 500),
  result: sanitizeTraceText(task.result ?? task.reason ?? '', 2000),
  startedAt: Number.isFinite(task.startedAt) ? task.startedAt : 0,
  updatedAt: Number.isFinite(task.updatedAt) ? task.updatedAt : 0,
})

/**
 * Assemble a `ds-bot/group-trace/v1` snapshot capturing project context, chat interactions, and inter-bot trace.
 */
export function buildGroupTrace({
  room,
  bot,
  agentId,
  reason,
  tokens,
  note,
  kevDecision,
  workDir,
  groupRows = [],
  pairRecords = [],
  startedAt = 0,
  endedAt = Date.now(),
  botNameOf = id => String(id ?? ''),
}) {
  const completedTasks = pastTasksOf(room).map(task => serializeTask(task, botNameOf))
  const openTasks = openTasksOf(room).map(task => serializeTask(task, botNameOf))

  const interactions = []
  for (const row of Array.isArray(groupRows) ? groupRows : []) {
    if (!row || typeof row !== 'object') continue
    const at = recordTime(row)
    if (startedAt > 0 && at > 0 && at < startedAt) continue
    if (at > 0 && at > endedAt) continue
    interactions.push({
      seq: Number.isInteger(row.seq) ? row.seq : 0,
      at,
      botId: row.botId ?? null,
      from: String(row.from ?? row.name ?? (row.botId ? botNameOf(row.botId) : (row.kind === 'user' ? 'user' : ''))),
      text: sanitizeTraceText(row.text ?? ''),
    })
  }
  interactions.sort((a, b) => (a.at - b.at) || (a.seq - b.seq))
  const boundedInteractions = interactions.slice(-MAX_TRACE_ENTRIES)

  const interBotTrace = (Array.isArray(pairRecords) ? pairRecords : [])
    .slice(-MAX_TRACE_ENTRIES)
    .map(record => ({
      pair: String(record.pair ?? ''),
      seq: Number.isInteger(record.seq) ? record.seq : 0,
      at: recordTime(record),
      from: String(record.from ?? ''),
      to: String(record.to ?? ''),
      kind: String(record.kind ?? 'message'),
      text: sanitizeTraceText(record.text ?? ''),
    }))

  const goalRaw = typeof room?.goal === 'string' ? room.goal : room?.goal?.text
  return {
    schema: 'ds-bot/group-trace/v1',
    traceId: `tr_${randomBytes(6).toString('hex')}`,
    roomId: room.id,
    roomName: String(room.name ?? ''),
    memberBotId: bot?.id ?? null,
    memberBotName: bot?.name ?? null,
    sessionId: agentId,
    reason: String(reason ?? 'steward'),
    workDir: workDir ?? null,
    goal: goalRaw ? sanitizeTraceText(goalRaw, 500) : null,
    startedAt: Number.isFinite(startedAt) ? startedAt : 0,
    endedAt,
    tokens: Number.isFinite(tokens) ? tokens : null,
    kevDecision: kevDecision
      ? {
          action: kevDecision.action ?? null,
          pSwitch: Number.isFinite(kevDecision.pSwitch) ? kevDecision.pSwitch : null,
          confident: Boolean(kevDecision.confident),
          factors: kevDecision.factors ?? null,
        }
      : null,
    project: {
      handoffNote: note ? sanitizeTraceText(note, 8000) : null,
      completedTasks,
      openTasks,
    },
    routing: summarizeRouting(boundedInteractions, interBotTrace),
    interactions: boundedInteractions,
    interBotTrace,
  }
}

/**
 * Persist a group trace JSON file and append a summary row to `index.jsonl` under `<home>/memory/groups/<roomId>/traces`.
 */
export async function saveGroupTrace({ home, trace }) {
  if (!home || !trace?.roomId) return undefined
  const dir = join(home, 'memory', 'groups', String(trace.roomId), 'traces')
  await mkdir(dir, { recursive: true })
  const filename = `${trace.endedAt}-${trace.traceId}.json`
  const file = join(dir, filename)
  const indexFile = join(dir, 'index.jsonl')
  await writeFile(file, `${JSON.stringify(trace, null, 2)}\n`, 'utf8')
  const indexRow = {
    traceId: trace.traceId,
    roomId: trace.roomId,
    roomName: trace.roomName,
    memberBotName: trace.memberBotName,
    reason: trace.reason,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    tokens: trace.tokens,
    kevDecision: trace.kevDecision,
    workDir: trace.workDir,
    completedTaskCount: trace.project.completedTasks.length,
    openTaskCount: trace.project.openTasks.length,
    interactionCount: trace.interactions.length,
    interBotCount: trace.routing.interBotCount,
    loopCount: trace.routing.loopCount,
    handoffSequence: trace.routing.handoffSequence,
    file: filename,
  }
  await appendFile(indexFile, `${JSON.stringify(indexRow)}\n`, 'utf8')
  return { file, indexFile }
}
