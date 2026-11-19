import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyToolResult, groupNoticeRefusal, parseDiagnosticRefusal, passiveDeliveryRefusal, POLICY_REASONS } from '../src/lineage/refusals.mjs'
import { REFUSAL_CATEGORY, REFUSAL_RECIPIENT_OFF } from './fixtures/dsbot-home.mjs'

test('tool results: thrown and returned refusals, plain errors, successes and pending calls', () => {
  assert.deepEqual(classifyToolResult({ name: 'message_bot', args: { to: 'Writer' }, isError: true, text: REFUSAL_RECIPIENT_OFF }),
    { outcome: 'denied', reason: 'recipient-off', targetName: 'Writer', roomName: null, policy: true })
  assert.deepEqual(classifyToolResult({ name: 'post_to_group', args: { group: 'Desk' }, isError: false, text: REFUSAL_CATEGORY }),
    { outcome: 'denied', reason: 'task-category-required', targetName: 'Editor', roomName: 'Desk', policy: true })
  const self = classifyToolResult({ name: 'message_bot', args: { to: 'Chief' }, isError: true, text: 'Error: You cannot message yourself.' })
  assert.equal(self.outcome, 'denied')
  assert.equal(self.reason, 'tool-error')
  assert.equal(self.policy, false)
  assert.equal(classifyToolResult({ name: 'message_bot', args: { to: 'Editor' }, isError: false, text: 'Sent to Editor.' }).outcome, 'allowed')
  assert.equal(classifyToolResult({ name: 'message_bot', args: { to: 'Editor' } }).outcome, 'pending')
  assert.equal(classifyToolResult({ name: 'stop_bot', args: { bot: 'Editor' }, isError: false, text: 'Stopped.' }).targetName, 'Editor')
  assert.equal(classifyToolResult({ name: 'group_task', args: { group: 'Desk' }, isError: false, text: 'ok' }).targetName, 'Desk')
})

test('a parenthesised word in a group name is not taken as the reason', () => {
  const r = classifyToolResult({ name: 'post_to_group', args: {}, isError: false, text: 'Not sent: Editor in "Desk (night)" does not take automatic messages from Chief (group-off). No turn was started.' })
  assert.equal(r.reason, 'group-off')
  assert.equal(r.roomName, 'Desk (night)')
  const plain = classifyToolResult({ name: 'message_bot', args: { to: 'X' }, isError: true, text: 'Error: cannot reach (offline) right now' })
  assert.equal(plain.reason, 'tool-error')
})

test('diagnostics lines: room captured, names with " to " resolved by known Bots, other lines ignored', () => {
  assert.deepEqual(parseDiagnosticRefusal('ds-bot: bot message from Writer to Editor did not start work (group-off) in Desk', ['Writer', 'Editor'], ['Desk']),
    { fromName: 'Writer', toName: 'Editor', reason: 'group-off', roomName: 'Desk', roomKnown: true })
  const tricky = parseDiagnosticRefusal('bot message from Ana to Bo to Cy did not start work (recipient-off)', ['Ana to Bo', 'Cy'])
  assert.equal(tricky.fromName, 'Ana to Bo')
  assert.equal(tricky.toName, 'Cy')
  assert.equal(tricky.roomName, null)
  assert.equal(parseDiagnosticRefusal('ds-bot: something else entirely'), null)
})

test('passive deliveries and category notices become refusals', () => {
  const rec = { role: 'reply', from: 'bot-editor', to: 'bot-chief', roomId: null }
  assert.deepEqual(passiveDeliveryRefusal(rec, { passive: true, time: 5 }),
    { action: 'deliver.reply', outcome: 'denied', reason: 'result-suppressed', fromId: 'bot-editor', toId: 'bot-chief', roomId: null, time: 5 })
  assert.equal(passiveDeliveryRefusal(rec, { passive: false, time: 5 }), null)
  const n = groupNoticeRefusal({ roomId: 'room-desk', seq: 2, time: 9, from: 'Chief', about: 'bot-editor', refused: 'task-category-required' })
  assert.equal(n.action, 'group.call')
  assert.equal(n.reason, 'task-category-required')
  assert.ok(Object.isFrozen(POLICY_REASONS) && POLICY_REASONS.has('left-group') && POLICY_REASONS.size === 23)
})
