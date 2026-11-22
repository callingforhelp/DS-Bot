import assert from 'node:assert/strict'
import { test } from 'node:test'
import adapter, { chunks } from '../src/host/im/platforms/wecom-kf.js'

const fields = { corpId: 'test-corp', secret: 'test-secret' }
const json = value => Response.json(value)
function fake(replies = {}) {
  let runtime = {}
  const calls = []
  return {
    calls, runtime: { get: () => runtime, set: patch => { runtime = { ...runtime, ...patch } } },
    async fetch(url, options) {
      const path = new URL(url).pathname.split('/').pop()
      const body = options?.body ? JSON.parse(options.body) : undefined
      calls.push({ path, body })
      if (replies[path]?.length) return json(replies[path].shift())
      if (path === 'gettoken') return json({ access_token: 'test-token', expires_in: 7200 })
      if (path === 'list') return json({ account_list: [{ open_kfid: 'kf-test', name: 'Test' }] })
      if (path === 'sync_msg') return json({ msg_list: [], next_cursor: 'idle' })
      return json({ errcode: 0, msgid: 'sent' })
    },
  }
}
test('kf check selects first account and reports bad credentials', async () => {
  assert.deepEqual(await adapter.check(fields, fake()), { account: { id: 'kf-test', name: 'Test' } })
  const refreshed = fake({ list: [{ errcode: 40014 }] })
  await adapter.check(fields, refreshed)
  assert.equal(refreshed.calls.filter(call => call.path === 'gettoken').length, 2)
  await assert.rejects(adapter.check(fields, fake({ gettoken: [{ errcode: 40001, errmsg: 'invalid credential' }] })), /invalid credential/)
  await assert.rejects(adapter.check(fields, fake({ list: [{ account_list: [] }] })), /account not found/)
})
test('kf token cache, refresh, byte chunks and permanent failures', async () => {
  const env = fake({ send_msg: [{ errcode: 42001 }, { msgid: 'ok' }] })
  const connection = adapter.connect(fields, env, { onStatus() {}, async onMessage() {} })
  try {
    const text = '中😀'.repeat(1000)
    await connection.send({ key: 'customer' }, { text })
    assert.equal(env.calls.filter(call => call.path === 'gettoken').length, 2)
    assert.equal(chunks(text).join(''), text)
    assert.ok(chunks(text).every(part => Buffer.byteLength(part) <= 2048))
    assert.deepEqual(chunks(''), [])
    await connection.send({ key: 'customer' }, { text: 'again' })
    assert.equal(env.calls.filter(call => call.path === 'gettoken').length, 2)
  } finally { connection.stop() }
  for (const errcode of [95018, 95007]) {
    const conn = adapter.connect(fields, fake({ send_msg: [{ errcode }] }), { onStatus() {}, onMessage() {} })
    try { await assert.rejects(conn.send({ key: 'c' }, { text: 'x' }), error => error.permanent && /48 hours/.test(error.message)) }
    finally { conn.stop() }
  }
})
test('kf pages sync, filters origins and old backlog, persists cursor', async () => {
  const now = Math.floor(Date.now() / 1000)
  const msg = (msgid, origin = 3, send_time = now) => ({ msgid, origin, send_time, external_userid: 'customer', msgtype: 'text', text: { content: '你好' } })
  const env = fake({ sync_msg: [
    { msg_list: [msg('old', 3, 1), msg('agent', 5), msg('one')], next_cursor: 'page2', has_more: 1 },
    { msg_list: [msg('two')], next_cursor: 'done', has_more: 0 },
  ] })
  const received = []
  let finish
  const done = new Promise(resolve => { finish = resolve })
  const timeout = setTimeout(() => finish(), 3000)
  const conn = adapter.connect(fields, env, {
    onStatus(status) { if (status.state === 'ready' && env.runtime.get().cursor === 'done') finish() },
    async onMessage(msg) { received.push(msg) },
  })
  try {
    await done
    assert.deepEqual(received.map(msg => msg.messageId), ['one', 'two'])
    assert.equal(env.calls.filter(call => call.path === 'sync_msg')[1].body.cursor, 'page2')
    assert.equal(env.runtime.get().cursor, 'done')
  } finally { clearTimeout(timeout); conn.stop() }
})

test('kf downloads customer media as images and original file bytes', async () => {
  const env = fake()
  env.runtime.set({ cursor: 'previous' })
  const originalFetch = env.fetch
  const types = ['image', 'file', 'voice', 'video']
  env.fetch = async (url, options) => {
    if (url.includes('/media/get')) return new Response(Buffer.from('original-bytes'), { headers: { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="part.STEP"' } })
    if (url.includes('/kf/sync_msg')) return json({ next_cursor: 'media-done', msg_list: types.map(msgtype => ({ origin: 3, send_time: 1, msgtype, msgid: msgtype, external_userid: 'c', [msgtype]: { media_id: msgtype } })) })
    return originalFetch(url, options)
  }
  const received = []
  let finish
  const done = new Promise(resolve => { finish = resolve })
  const conn = adapter.connect(fields, env, { onStatus(status) { if (status.state === 'ready') finish() }, async onMessage(msg) { received.push(msg) } })
  try {
    await done
    assert.equal(received.length, 4)
    assert.equal(received[0].images[0].mediaType, 'image/png')
    assert.equal(received[0].images[0].data, Buffer.from('original-bytes').toString('base64'))
    for (const msg of received.slice(1)) {
      assert.equal(msg.files[0].name, 'part.STEP')
      assert.deepEqual(msg.files[0].data, Buffer.from('original-bytes'))
    }
  } finally { conn.stop() }
})
