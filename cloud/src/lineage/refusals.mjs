// Pure classifiers for DS Bot's Responding-to-Bots decisions, as they appear on disk:
// tool results in Session logs, the diagnostics warn line, passive deliveries in the
// ledger, and category notices in a group's book.

// Contract C2: every reason ds-bot src/host/bot-response-policy.js can give.
export const POLICY_REASONS = Object.freeze(new Set([
  'human', 'legacy', 'allowed-all', 'allowed-selected', 'unknown-recipient', 'self-reply', 'recipient-off',
  'recipient-not-selected', 'group-off', 'group-not-selected', 'no-designated-recipient', 'acknowledgment-or-status',
  'circular-chain', 'duplicate-event', 'finding-identity-required', 'task-category-required', 'task-category-not-permitted',
  'finding-attempt-limit', 'unchanged-finding', 'chain-hop-limit', 'task-turn-limit', 'unrecorded-admission', 'left-group',
]))

export const MESSAGE_TOOLS = Object.freeze(new Set([
  'message_bot', 'post_to_group', 'stop_bot', 'create_bot', 'update_bot', 'create_group', 'update_group', 'delete_group',
  'group_todo', 'group_relay', 'group_task', 'group_goal', 'save_capability', 'delete_capability',
]))
const GROUP_TOOLS = new Set(['create_group', 'update_group', 'delete_group', 'group_todo', 'group_relay', 'group_task', 'group_goal'])

// 'ds-bot: bot message from A to B did not start work (reason) in Room'
const DIAG = /^(?:ds-bot: )?bot message from (.+) to (.+) did not start work \(([a-z][a-z-]+)\)(?: in (.+))?$/
export function parseDiagnosticRefusal(text, knownBotNames = [], knownRoomNames = []) {
  const s = String(text ?? '')
  const m = DIAG.exec(s)
  if (!m) return null
  const [, , , reason, roomName] = m
  const pair = s.slice(0, s.indexOf(' did not start work')).replace(/^(?:ds-bot: )?bot message from /, '')
  // A name may itself contain ' to ': prefer the split where both sides are known Bots.
  const known = new Set(knownBotNames)
  const splits = []
  for (let i = pair.indexOf(' to '); i !== -1; i = pair.indexOf(' to ', i + 1)) splits.push([pair.slice(0, i), pair.slice(i + 4)])
  const [fromName, toName] = splits.find(([a, b]) => known.has(a) && known.has(b)) ?? splits[0]
  // The room is the text after ' in '; knownRoomNames lets a caller check it resolves.
  const room = roomName ?? null
  return { fromName, toName, reason, roomName: room, roomKnown: room === null || knownRoomNames.includes(room) }
}

const DENIED_TEXT = /^(Not sent|refused|denied|not allowed|cannot|can't|You cannot)/i
const REASON_FULL = /does not take automatic messages from .+ \(([a-z][a-z-]+)\)\. No turn was started\./
const REASON_TAIL = /\(([a-z][a-z-]+)\)\. No turn was started/

// One message tool call and its result. A thrown refusal arrives as 'Error: <message>' with
// isError; post_to_group RETURNS its category refusal as plain text with isError false.
export function classifyToolResult({ name, args = {}, isError, text } = {}) {
  const a = args && typeof args === 'object' ? args : {}
  if (text === undefined && isError === undefined) {
    return { outcome: 'pending', reason: null, targetName: targetOf(name, a, ''), roomName: a.group ?? null, policy: false }
  }
  const body = String(text ?? '').replace(/^Error: /, '').trim()
  const denied = isError === true || DENIED_TEXT.test(body)
  const code = REASON_FULL.exec(body)?.[1] ?? REASON_TAIL.exec(body)?.[1]
  const reason = denied ? (code ?? 'tool-error') : null
  const roomName = /\bin "([^"]+)"/.exec(body)?.[1] ?? a.group ?? null
  return { outcome: denied ? 'denied' : 'allowed', reason, targetName: targetOf(name, a, body), roomName, policy: POLICY_REASONS.has(reason) }
}

function targetOf(name, a, body) {
  if (name === 'message_bot') return a.to ?? null
  if (name === 'stop_bot') return a.bot ?? null
  if (name === 'post_to_group') return /^Not sent: (.+?) in "/.exec(body)?.[1] ?? null
  if (GROUP_TOOLS.has(name)) return a.group ?? a.name ?? null
  return a.name ?? null
}

// A result the ledger marks as delivered passively: it reached the recipient's Session, but
// no turn was started for it.
export function passiveDeliveryRefusal(record, delivery) {
  if (delivery?.passive !== true) return null
  return { action: `deliver.${record.role}`, outcome: 'denied', reason: 'result-suppressed', fromId: record.from, toId: record.to, roomId: record.roomId ?? null, time: delivery.time }
}

export function groupNoticeRefusal(notice) {
  return { action: 'group.call', outcome: 'denied', reason: notice.refused, fromName: notice.from, toId: notice.about, roomId: notice.roomId, seq: notice.seq, time: notice.time }
}
