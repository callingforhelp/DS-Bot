import { t } from './i18n.js'

// Pure model helpers for the native swarm UI (usable in Node unit tests without DOM/DSH primitives).
export const WORKER_STATES = new Set(['working', 'waiting', 'stopped', 'killed'])
export const BOARD_POLL_MS = 2500

// A worker waiting on a model quota counts under `quota`, not under its state.
export const isQuotaWorker = worker => worker?.quota === true || worker?.state === 'quota'
export const workersOf = swarm => (swarm?.workers ?? swarm?.members ?? []).filter(worker => worker && worker.state !== 'killed')

export function swarmCounts(swarm) {
  const counts = { working: 0, waiting: 0, quota: 0 }
  for (const worker of workersOf(swarm)) {
    if (isQuotaWorker(worker)) counts.quota += 1
    else if (worker.state === 'working') counts.working += 1
    else if (worker.state === 'waiting') counts.waiting += 1
  }
  return counts
}

export const isLiveSwarm = swarm => swarm !== undefined && swarm !== null && swarm.status !== 'closed'

export function swarmsForSession(swarms, sessionId) {
  return Object.values(swarms ?? {})
    .filter(swarm => isLiveSwarm(swarm) && (sessionId === undefined || swarm.ownerSessionId === sessionId || swarm.sessionId === sessionId || swarm.ownerBotId === sessionId))
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
}

export function swarmPodLabel(counts) {
  return t('{working} working · {waiting} waiting · {quota} quota', counts)
}

// Splits a post into text, `@mention` and `#seq` pieces; `@#channel` stays one mention.
export function postParts(text) {
  const parts = []
  let last = 0
  for (const match of String(text ?? '').matchAll(/@#?[\w-]+|#\d+/g)) {
    if (match.index > last) parts.push({ type: 'text', value: text.slice(last, match.index) })
    parts.push({ type: match[0].startsWith('@') ? 'mention' : 'seq', value: match[0] })
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) })
  return parts
}

// The status tag a post leads with, after its `@mention`s: `[done]`, `[stall]`, `[quota]`.
export function postBadge(text) {
  const match = /^(?:\s*@#?[\w-]+)*\s*\[(done|stall|quota)\]/i.exec(String(text ?? ''))
  return match ? match[1].toLowerCase() : null
}

export function channelsOf(swarm, messages) {
  const names = new Set(['main', ...(swarm?.channels ?? []).map(channel => (typeof channel === 'string' ? channel : channel?.name)).filter(Boolean)])
  for (const message of messages) if (message.channel) names.add(message.channel)
  return [...names]
}

export const inChannel = (messages, channel) => (channel === 'all' ? messages : messages.filter(message => (message.channel ?? 'main') === channel))

// Posts arrive in `seq` order; a poll's page merges by `seq` so a repeat never doubles a row.
export function mergePosts(known, page) {
  const bySeq = new Map(known.map(message => [message.seq, message]))
  for (const message of page) bySeq.set(message.seq, message)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}
