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
  MOCK_WATCH: 'A_ONLY_CONTEXT_234', MOCK_LOG_CHARS: '160000', MOCK_LOG_TOOLS: '1',
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
async function customer(args) {
  const before = sent.length
  message('customer-A', command(args))
  await until(() => sent.length > before, 'customer tool reply')
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
  const foreground = (await state()).bots[chief.id].sessionId ?? chief.id
  await api('im-add', { platform: 'wecom_kf', botId: chief.id, fields: { corpId: 'stand-in-corp', secret: 'stand-in-secret', openKfId: 'kf-e2e' } })
  const mainBeforeCustomers = await api('chat', { botId: chief.id })
  message('customer-A', '客户A：请核对支架图纸并报价 A_ONLY_CONTEXT_234')
  message('customer-A', '', true)
  await until(async () => mediaReads > 0 && (await calls()).some(call => call.last?.includes('Test bracket')), 'STEP facts reach model')
  await settle()
  const a = (await state()).bots[chief.id].openParts.find(part => part.customer?.chatKey === 'customer-A')
  assert.ok(a)
  assert.equal((await state()).bots[chief.id].sessionId ?? chief.id, foreground)
  assert.ok((await calls()).some(call => call.session === a.sessionId && call.last?.includes('MILLI.')))
  passed('A has a background thread and real STEP media facts reach the mock model')
  message('customer-B', '客户B：订单现在到哪一步 B_ONLY_CONTEXT_875')
  const beforeB = sent.length
  try {
    await until(() => sent.some(value => value.touser === 'customer-B'), 'B reply', 20_000)
  } catch (error) {
    const current = (await state()).bots[chief.id]
    const sessionId = current.openParts.find(part => part.customer?.chatKey === 'customer-B')?.sessionId
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
  const b = (await state()).bots[chief.id].openParts.find(part => part.customer?.chatKey === 'customer-B')
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
  await customer({ action: 'vote', summary: 'AGREE_CASE：支架报价', routes: ['quote', 'order_status'] })
  assert.ok((await calls()).some(call => call.last?.includes('E2E_ROUTED_CASE') && call.session !== a.sessionId))
  passed('two agreeing mock judges route through the real message_bot delivery')
  const replies = await customer({ action: 'vote', summary: 'DISAGREE：客户需要确认责任归属', routes: ['quote', 'order_status'] })
  const handoff = (await state()).questions[foreground]
  assert.ok(handoff?.id.startsWith('triage-'))
  assert.equal((await state()).questions[a.sessionId], undefined)
  const handoffDetail = JSON.parse(handoff.detail)
  assert.equal(handoffDetail.source.customer_session_id, a.sessionId)
  assert.equal(handoffDetail.case.summary, 'DISAGREE：客户需要确认责任归属')
  assert.ok(handoffDetail.candidate_destinations.some(candidate => candidate.route === 'quote' && candidate.target === 'Quote'))
  assert.ok(replies.some(value => value.touser === 'customer-A' && /您好.*专人/.test(value.text?.content)))
  const quoteId = quote.id ?? Object.values((await state()).bots).find(bot => bot.name === 'Quote').id
  await staff(quoteId, { action: 'review' })
  assert.ok((await calls()).some(call => call.last?.includes('"status":"pending"') && call.last.includes('DISAGREE')))
  passed('disagreement creates a main-chat handoff, sends a Chinese holding reply and appears in review')
  for (const args of [
    { action: 'rules', rule_action: 'add', text: 'INJECTED_RULE' },
    { action: 'outcome', id: 'forbidden', result: 'resolved' },
    { action: 'types', type_action: 'edit', type: 'quote', target: 'INJECTED_TARGET' },
  ]) {
    const denied = await customer(args)
    assert.ok(denied.some(value => /outside customer conversations/.test(value.text?.content)))
  }
  passed('real customer turns cannot add rules, write outcomes or edit types')
  const before = await readFile(join(home, 'bot', 'state.json'), 'utf8')
  const page = await api('customer-page', { sessionId: a.sessionId })
  assert.ok(JSON.stringify(page).includes('A_ONLY_CONTEXT_234'))
  assert.equal(await readFile(join(home, 'bot', 'state.json'), 'utf8'), before)
  assert.equal((await state()).bots[chief.id].sessionId ?? chief.id, foreground)
  passed('staff read-only customer page returns A transcript without writes or foreground changes')
} finally {
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'triage-e2e-results.json'), JSON.stringify({ checks, sent, mediaReads }, null, 2))
  await bench('stop').catch(error => console.error(error.message))
  await new Promise(resolve => server.close(resolve))
}
