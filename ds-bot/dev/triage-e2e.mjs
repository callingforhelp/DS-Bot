// Real-host WeCom Customer Service composition test. Owns its loopback stand-in and bench.
// node dev/triage-e2e.mjs [bench-name] [web-port] [mock-port]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { modelsFor } from '../src/client/agent-routes.js'

const [name = 'triage-e2e', webPort = '3097', mockPort = '8797'] = process.argv.slice(2)
if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid bench name')
const plugin = fileURLToPath(new URL('../', import.meta.url))
const home = join(plugin, '..', `.dsh-test-${name}`)
const base = `http://127.0.0.1:${webPort}`
const fixture = await readFile(new URL('../test/fixtures/triage-part.step', import.meta.url))
const inbound = []
const sent = []
const checks = []
let mediaReads = 0
let cookie
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const state = () => json(join(home, 'bot', 'state.json'))
const calls = async () => (await readFile(join(home, 'mock.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = raw ? JSON.parse(raw) : {}
  let value
  if (url.pathname.endsWith('/gettoken')) value = { access_token: 'stand-in-token', expires_in: 7200 }
  else if (url.pathname.endsWith('/kf/account/list')) value = { account_list: [{ open_kfid: 'kf-e2e', name: 'Local customer service' }] }
  else if (url.pathname.endsWith('/kf/sync_msg')) {
    assert.equal(body.limit, 1000)
    const offset = Number(body.cursor || 0)
    const page = inbound.slice(offset, offset + body.limit)
    value = { msg_list: page, next_cursor: String(offset + page.length), has_more: 0 }
  } else if (url.pathname.endsWith('/media/get')) {
    mediaReads++
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="triage-part.step"' })
    res.end(fixture)
    return
  } else if (url.pathname.endsWith('/kf/send_msg')) {
    assert.equal(body.open_kfid, 'kf-e2e')
    assert.ok(['customer-A', 'customer-B'].includes(body.touser))
    sent.push(body)
    value = { msgid: `sent-${sent.length}` }
  } else { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ errcode: 0, ...value }))
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const env = {
  ...process.env, DSBOT_TEST_WECOM_KF_BASE_URL: `http://127.0.0.1:${server.address().port}/cgi-bin/`,
  DSBOT_ENV_FILE: join(home, 'no-startup-seed.env'), MOCK_TRIAGE_E2E: '1',
  MOCK_WATCH: 'A_ONLY_CONTEXT_234,STAFF_CONTEXT_SENTINEL_73C9,mock/', MOCK_LOG_CHARS: '160000', MOCK_LOG_TOOLS: '1',
  CONTEXT_WINDOW: '100000', CHECK_RATIO: '0.45',
}
async function bench(action) {
  const child = spawn('dev/bench.sh', [name, webPort, mockPort, action], { cwd: plugin, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const [code] = await once(child, 'exit')
  if (code !== 0) throw new Error(`bench ${action} failed (${code}); see ${home}/web.log`)
  return output
}
async function api(endpoint, payload = {}) {
  const response = await fetch(`${base}/api/bot`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ endpoint, payload }) })
  const value = await response.json()
  if (!value.ok) throw new Error(`${endpoint}: ${value.error?.message ?? JSON.stringify(value)}`)
  return value.value
}
async function until(predicate, label, timeout = 90_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await predicate()) return; await delay(200) }
  throw new Error(`Timed out: ${label}`)
}
async function settle() {
  let count = (await calls()).length
  let since = Date.now()
  await until(async () => {
    const view = await api('state')
    const now = (await calls()).length
    if (now !== count || Object.keys(view.activity ?? {}).length) { count = now; since = Date.now() }
    return Date.now() - since > 2500
  }, 'team quiet')
}
function message(customer, text, file = false) {
  inbound.push({ msgid: `message-${inbound.length}`, origin: 3, send_time: Math.floor(Date.now() / 1000), external_userid: customer,
    msgtype: file ? 'file' : 'text', ...(file ? { file: { media_id: 'step-fixture', filename: 'triage-part.step' } } : { text: { content: text } }) })
}
const command = args => `分诊测试 ${JSON.stringify(args)}`
async function staff(sessionId, args) { await api('send', { sessionId, text: command(args) }); await settle() }
async function customer(customerId, args) {
  const before = sent.length
  message(customerId, command(args))
  await until(() => sent.slice(before).some(value => value.touser === customerId), `customer ${customerId} tool reply`)
  await settle()
  return sent.slice(before)
}
function passed(label) { checks.push(label); console.log(`PASS ${label}`) }
try {
  await bench('reset')
  const log = await readFile(join(home, 'web.log'), 'utf8')
  const login = log.match(new RegExp(`http://127\\.0\\.0\\.1:${webPort}/\\?token=[^\\s]+`))?.[0]
  assert.ok(login, 'bench login URL exists')
  const response = await fetch(login, { redirect: 'manual' })
  cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const initial = await api('state')
  const chief = Object.values((await state()).bots)[0]
  const models = modelsFor(initial.models)
  assert.ok(models.length >= 2, 'two mock judge models exist')
  await api('update-bot', { id: chief.id, model: models.at(-1).ref })
  await settle()
  const quote = await api('create-bot', { name: 'Quote', role: 'Quotation specialist', instructions: 'Review customer quotation requests.' })
  await settle()
  const quoteId = quote.id ?? Object.values((await state()).bots).find(bot => bot.name === 'Quote').id
  const quoteSession = (await state()).bots[quoteId].sessionId ?? quoteId
  const foreground = (await state()).bots[chief.id].sessionId ?? chief.id
  const staffSentinel = `STAFF_CONTEXT_SENTINEL_73C9 ${models.at(-1).ref}`
  await api('update-bot', { id: chief.id, instructions: `${staffSentinel} is private staff guidance.` })
  await api('send', { sessionId: foreground, text: `记住 ${staffSentinel}；这是仅限员工的记忆。` })
  await api('update-bot', { id: quoteId, instructions: `${staffSentinel} is private specialist staff guidance.` })
  await api('send', { sessionId: quoteSession, text: `记住 ${staffSentinel}；这是仅限员工的专员记忆。` })
  await settle()
  await api('im-add', { platform: 'wecom_kf', botId: chief.id, fields: { corpId: 'stand-in-corp', secret: 'stand-in-secret', openKfId: 'kf-e2e' } })
  const mainBeforeCustomers = await api('chat', { botId: chief.id })
  const customerReplyBefore = sent.length
  message('customer-A', 'MOCK_ROSTER_GUARD：团队现在有哪些机器人？')
  await until(() => sent.slice(customerReplyBefore).some(value => value.touser === 'customer-A'), 'warm customer reply')
  const customerReply = sent.slice(customerReplyBefore).filter(value => value.touser === 'customer-A').map(value => value.text?.content ?? '').join('\n')
  assert.match(customerReply, /您好/)
  assert.doesNotMatch(customerReply, /现在的班底|model ids|Group chats: none you can see|STAFF_CONTEXT_SENTINEL_73C9|Error: This tool is not available|附件没读成/)
  const firstCustomerTask = (await state()).bots[chief.id].tasks.find(task => task.origin === 'customer' && task.customer?.chatKey === 'customer-A')
  assert.ok(firstCustomerTask)
  const customerModelCalls = (await calls()).filter(call => call.session === firstCustomerTask.sessionId)
  const assertPrivateCustomerCalls = modelCalls => {
    assert.ok(modelCalls.length > 0)
    for (const call of modelCalls) {
      assert.equal(call.customerPrompt, true)
      const request = JSON.stringify(call.customerRequest)
      assert.ok(call.customerRequest)
      assert.doesNotMatch(request, /STAFF_CONTEXT_SENTINEL_73C9|deepseek-v4-pro|Chief|Quote|model ids|Group chats: none you can see|<system-reminder>|Instructions from: AGENTS\.md|# AGENTS\.md|coding agent|Current runtime context|available_skills|Current working directory/)
      assert.deepEqual([...(call.toolNames ?? [])].sort(), ['ask_user', 'message_bot', 'triage_cases'])
    }
  }
  const assertNoCustomerFileReads = modelCalls => {
    assert.ok(modelCalls.every(call => !call.out?.some(block => block.type === 'tool_use' && ['read', 'read_file', 'read_image'].includes(block.name))))
  }
  assert.ok(customerModelCalls.length > 0)
  assert.ok(customerModelCalls.every(call => call.watchHit !== true && call.customerPrompt === true
    && call.staffIdentity !== true && call.teamRules !== true && call.memorySection !== true
    && !call.toolNames?.includes('list_bots')))
  assertPrivateCustomerCalls(customerModelCalls)
  assert.ok(customerModelCalls.some(call => call.out?.some(block => block.type === 'tool_use' && block.name === 'list_bots')))
  assert.ok(customerModelCalls.some(call => JSON.stringify(call.customerRequest).includes('Error: This tool is not available in customer conversations.')))
  assertNoCustomerFileReads(customerModelCalls)
  const rosterTranscript = await api('customer-page', { sessionId: firstCustomerTask.sessionId })
  assert.ok(JSON.stringify(rosterTranscript).includes(customerReply))
  console.log('PASS customer WeCom reply contains no roster or staff-context sentinel')
  await settle()
  const stepReplyBefore = sent.length
  message('customer-A', '客户A：请核对支架图纸并报价 A_ONLY_CONTEXT_234')
  message('customer-A', '', true)
  await until(async () => mediaReads > 0 && (await calls()).some(call => call.last?.includes('Test bracket'))
    && sent.slice(stepReplyBefore).some(value => value.touser === 'customer-A' && value.text?.content?.includes('CARTESIAN_POINT bounding box')), 'STEP facts acknowledged')
  await settle()
  let a = (await state()).bots[chief.id].tasks.find(task => task.origin === 'customer' && task.customer?.chatKey === 'customer-A')
  assert.ok(a)
  assert.equal((await state()).bots[chief.id].sessionId ?? chief.id, foreground)
  const stepCalls = (await calls()).filter(call => call.session === a.sessionId && call.last?.includes('Test bracket'))
  assertPrivateCustomerCalls(stepCalls)
  assertNoCustomerFileReads(stepCalls)
  const stepRequest = JSON.stringify(stepCalls.map(call => call.customerRequest))
  assert.ok(stepRequest.includes('Products: Test bracket'))
  assert.ok(stepRequest.includes('Length unit: SI_UNIT(.MILLI.,.METRE.)'))
  assert.ok(stepRequest.includes('CARTESIAN_POINT bounding box in file units: [-1, 2, 3] to [10, 20, 30]'))
  const stepAcknowledgement = sent.slice(stepReplyBefore).filter(value => value.touser === 'customer-A').map(value => value.text?.content ?? '').join('\n')
  assert.ok(stepAcknowledgement.includes('Products: Test bracket'))
  assert.ok(stepAcknowledgement.includes('Length unit: SI_UNIT(.MILLI.,.METRE.)'))
  assert.ok(stepAcknowledgement.includes('CARTESIAN_POINT bounding box in file units: [-1, 2, 3] to [10, 20, 30]'))
  assert.doesNotMatch(stepAcknowledgement, /Error: This tool is not available|附件没读成/)
  passed('A has a background thread and real STEP media facts reach the mock model')
  const oldCustomerSession = a.sessionId
  message('customer-A', '撑爆')
  await until(async () => {
    const task = (await state()).bots[chief.id].tasks.find(item => item.origin === 'customer' && item.customer?.chatKey === 'customer-A')
    return task !== undefined && task.sessionId !== oldCustomerSession
  }, 'customer A true context rollover')
  await settle()
  a = (await state()).bots[chief.id].tasks.find(task => task.origin === 'customer' && task.customer?.chatKey === 'customer-A')
  assert.equal(a.segments.filter(segment => segment.sessionId === oldCustomerSession).length, 1)
  assert.equal(a.segments.length, 1)
  assert.notEqual(a.sessionId, oldCustomerSession)
  passed('A rollover keeps exactly one historical segment for the prior customer session')
  message('customer-B', '客户B：订单现在到哪一步 B_ONLY_CONTEXT_875')
  const beforeB = sent.length
  try {
    await until(() => sent.some(value => value.touser === 'customer-B'), 'B reply', 20_000)
  } catch (error) {
    const current = (await state()).bots[chief.id]
    const sessionId = current.tasks.find(task => task.origin === 'customer' && task.customer?.chatKey === 'customer-B')?.sessionId
    const customerPage = await api('customer-page', { sessionId })
    const mainPage = await api('chat', { botId: chief.id })
    const currentView = await api('state')
    console.log('E2E diagnostic', JSON.stringify({
      customerB: customerPage.items.map(item => ({ kind: item.kind, text: item.text?.slice(0, 160) })),
      mainChat: mainPage.items.map(item => ({ kind: item.kind, text: item.text?.slice(0, 160) })),
      imVia: currentView.imVia?.[sessionId] ?? null,
      calls: (await calls()).filter(call => call.session === sessionId).map(call => ({ last: call.last?.slice(-160), output: call.output })),
    }))
    throw error
  }
  await settle()
  const b = (await state()).bots[chief.id].tasks.find(task => task.origin === 'customer' && task.customer?.chatKey === 'customer-B')
  assert.ok(b && b.sessionId !== a.sessionId)
  assert.ok(sent.slice(beforeB).length > 0 && sent.slice(beforeB).every(value => value.touser === 'customer-B'))
  assert.ok((await calls()).some(call => call.session === b.sessionId && call.last?.includes('B_ONLY_CONTEXT_875')))
  assert.ok((await calls()).filter(call => call.session === b.sessionId).every(call => !call.watchHit))
  assert.ok(sent.some(value => value.touser === 'customer-A'))
  assert.equal((await state()).bots[chief.id].sessionId ?? chief.id, foreground)
  assert.deepEqual(await api('chat', { botId: chief.id }), mainBeforeCustomers)
  passed('B is isolated, replies address the correct external user and foreground stays unchanged')
  await staff(foreground, { action: 'judges', models: models.slice(0, 2).map(model => model.ref) })
  await staff(foreground, { action: 'types', type_action: 'edit', type: 'quote', target: 'Quote' })
  const routeAStart = sent.length
  await customer('customer-A', { action: 'vote', summary: 'AGREE_CASE：支架报价 A_ONLY_CONTEXT_234', routes: ['quote', 'order_status'] })
  await until(() => sent.slice(routeAStart).some(value => value.touser === 'customer-A' && value.text?.content?.includes('报价专员已核对您的需求')), 'A specialist reply sent to WeCom')
  await settle()
  const specialistA = (await state()).bots[quoteId].tasks.find(task => task.origin === 'customer' && task.customer?.chatKey === 'customer-A')
  assert.ok(specialistA)
  assert.notEqual(specialistA.sessionId, quoteSession)
  const specialistCallsA = (await calls()).filter(call => call.session === specialistA.sessionId)
  assert.ok(specialistCallsA.length > 0)
  assert.ok(specialistCallsA.every(call => call.watchHit !== true && call.customerPrompt === true
    && call.staffIdentity !== true && call.teamRules !== true && call.memorySection !== true))
  assertPrivateCustomerCalls(specialistCallsA)
  assert.ok(sent.slice(routeAStart).every(value => value.touser === 'customer-A'))
  assert.match(sent.slice(routeAStart).map(value => value.text?.content ?? '').join('\n'), /报价专员已核对您的需求/)
  const customerAAfterRoute = (await calls()).filter(call => call.session === a.sessionId && call.customerPrompt === true)
  assertPrivateCustomerCalls(customerAAfterRoute)
  assertNoCustomerFileReads(customerAAfterRoute)
  assert.ok(customerAAfterRoute.some(call => JSON.stringify(call.customerRequest).includes('[Reply from Customer support]')))
  const routeBStart = sent.length
  await customer('customer-B', { action: 'vote', summary: 'AGREE_CASE：订单查询 B_ONLY_CONTEXT_875', routes: ['quote', 'order_status'] })
  await until(() => sent.slice(routeBStart).some(value => value.touser === 'customer-B' && value.text?.content?.includes('报价专员已核对您的需求')), 'B specialist reply sent to WeCom')
  await settle()
  const specialistB = (await state()).bots[quoteId].tasks.find(task => task.origin === 'customer' && task.customer?.chatKey === 'customer-B')
  assert.ok(specialistB && specialistB.sessionId !== specialistA.sessionId)
  const specialistCallsB = (await calls()).filter(call => call.session === specialistB.sessionId)
  assert.ok(specialistCallsB.length > 0)
  assert.ok(specialistCallsB.every(call => call.watchHit !== true && call.customerPrompt === true
    && call.staffIdentity !== true && call.teamRules !== true && call.memorySection !== true))
  assertPrivateCustomerCalls(specialistCallsB)
  assert.ok(sent.slice(routeBStart).every(value => value.touser === 'customer-B'))
  assert.match(sent.slice(routeBStart).map(value => value.text?.content ?? '').join('\n'), /报价专员已核对您的需求/)
  const customerBAfterRoute = (await calls()).filter(call => call.session === b.sessionId && call.customerPrompt === true)
  assertPrivateCustomerCalls(customerBAfterRoute)
  assertNoCustomerFileReads(customerBAfterRoute)
  assert.ok(customerBAfterRoute.some(call => JSON.stringify(call.customerRequest).includes('[Reply from Customer support]')))
  const allCustomerCalls = (await calls()).filter(call => call.customerPrompt === true)
  assertPrivateCustomerCalls(allCustomerCalls)
  assertNoCustomerFileReads(allCustomerCalls)
  passed('A and B route to separate specialist customer tasks and each reply reaches only its original WeCom user')
  message('customer-A', 'E2E_ASK_CARD_A')
  await until(async () => (await state()).questions[a.sessionId]?.options?.length === 3
    && sent.some(value => value.touser === 'customer-A' && value.text?.content?.includes('E2E_A_OPTION_ONE')), 'A customer question card')
  const questionA = (await state()).questions[a.sessionId]
  message('customer-B', 'E2E_ASK_CARD_B')
  await until(async () => (await state()).questions[b.sessionId]?.options?.length === 3
    && sent.some(value => value.touser === 'customer-B' && value.text?.content?.includes('E2E_B_OPTION_ONE')), 'B customer question card')
  const questionB = (await state()).questions[b.sessionId]
  const bCallsBeforeFreeText = (await calls()).filter(call => call.session === b.sessionId).length
  const freeTextStart = sent.length
  message('customer-B', '99')
  await until(async () => (await state()).questions[b.sessionId] === undefined
    && (await calls()).filter(call => call.session === b.sessionId).length > bCallsBeforeFreeText
    && sent.slice(freeTextStart).some(value => value.touser === 'customer-B' && value.text?.content === 'E2E_FREE_TEXT_99_ACK'), 'out-of-range number handled as free text')
  await settle()
  assert.equal((await state()).questions[a.sessionId]?.id, questionA.id)
  assert.equal((await state()).questions[b.sessionId], undefined)
  assert.ok((await calls()).some(call => call.session === b.sessionId && call.customerRequest !== undefined
    && JSON.stringify(call.customerRequest).includes('99')))
  assert.ok(sent.slice(freeTextStart).every(value => value.touser === 'customer-B'))
  passed('out-of-range numeric text follows free-text cancellation for B without affecting A')
  const pickStart = sent.length
  message('customer-B', 'E2E_ASK_CARD_B')
  await until(async () => (await state()).questions[b.sessionId]?.id !== undefined
    && (await state()).questions[b.sessionId].id !== questionB.id
    && sent.slice(pickStart).some(value => value.touser === 'customer-B' && value.text?.content?.includes('E2E_B_OPTION_ONE')), 'replacement B question card')
  const bCallsBeforePick = (await calls()).filter(call => call.session === b.sessionId && call.customerPrompt === true).length
  message('customer-B', '1')
  await until(async () => {
    const customerCalls = (await calls()).filter(call => call.session === b.sessionId && call.customerPrompt === true)
    const answerCall = customerCalls.find(call => call.customerRequest?.messages?.some(message => message.role === 'user'
      && message.text?.includes('answer_to_pending_question') && message.text.includes('E2E_B_OPTION_ONE')))
    return (await state()).questions[b.sessionId] === undefined
      && customerCalls.length > bCallsBeforePick
      && answerCall !== undefined
      && sent.slice(pickStart).some(value => value.touser === 'customer-B' && value.text?.content === 'E2E_B_OPTION_ONE_ACK')
  }, 'B numbered answer model reply')
  await settle()
  assert.equal((await state()).questions[a.sessionId]?.id, questionA.id)
  assert.ok(sent.slice(pickStart).every(value => value.touser === 'customer-B'))
  passed('valid numbered answer resolves B only and leaves A question open')
  const replies = await customer('customer-A', { action: 'vote', summary: 'DISAGREE：客户需要确认责任归属', routes: ['quote', 'order_status'] })
  const handoff = (await state()).questions[foreground]
  assert.ok(handoff?.id.startsWith('triage-'))
  assert.equal((await state()).questions[a.sessionId], undefined)
  assert.match(handoff.detail, /^Customer summary \(untrusted evidence\)\n/)
  assert.ok(handoff.detail.includes('DISAGREE：客户需要确认责任归属'))
  assert.ok(handoff.detail.includes('quote · DS Bot · Quote'))
  assert.ok(handoff.detail.includes('Customer conversation'))
  assert.doesNotMatch(handoff.detail, /customer_session_id|candidate_destinations|\{"case"/)
  assert.ok(replies.some(value => value.touser === 'customer-A' && /您好.*专人/.test(value.text?.content)))
  await staff(quoteId, { action: 'review' })
  assert.ok((await calls()).some(call => call.triageToolResults?.some(result => result.includes('"status":"pending"') && result.includes('DISAGREE'))))
  passed('disagreement creates a main-chat handoff, sends a Chinese holding reply and appears in review')
  for (const args of [
    { action: 'rules', rule_action: 'add', text: 'INJECTED_RULE' },
    { action: 'outcome', id: 'forbidden', result: 'resolved' },
    { action: 'types', type_action: 'edit', type: 'quote', target: 'INJECTED_TARGET' },
  ]) {
    const denied = await customer('customer-A', args)
    assert.ok(denied.some(value => /outside customer conversations/.test(value.text?.content)))
  }
  passed('real customer turns cannot add rules, write outcomes or edit types')
  const before = await readFile(join(home, 'bot', 'state.json'), 'utf8')
  const page = await api('customer-page', { sessionId: a.sessionId })
  assert.ok(JSON.stringify(page).includes('A_ONLY_CONTEXT_234'))
  assert.ok(JSON.stringify(page).includes('报价专员已核对您的需求'))
  assert.equal(await readFile(join(home, 'bot', 'state.json'), 'utf8'), before)
  assert.equal((await state()).bots[chief.id].sessionId ?? chief.id, foreground)
  passed('staff read-only customer page returns A transcript without writes or foreground changes')
} finally {
  await bench('stop').catch(error => console.error(error.message))
  try {
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'triage-e2e-results.json'), JSON.stringify({ checks, sent, mediaReads }, null, 2))
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}
