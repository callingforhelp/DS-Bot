import assert from 'node:assert/strict'
import { request } from 'node:http'
import { after, before, test } from 'node:test'
import { createApi, validatePrincipals } from '../src/api.mjs'
import { apiClient, sign } from '../src/client.mjs'
import { sha256 } from '../src/ingest.mjs'
import { freshDb } from './helpers.mjs'

const principals = {
  alice: { secret: 'alice-secret', tenants: ['td'], scopes: ['read-only'], role: 'user' },
  worker: { secret: 'worker-secret', tenants: ['td'], scopes: [], role: 'worker' },
  shipper: { secret: 'shipper-secret', tenants: ['td'], scopes: [], role: 'ingest', sources: ['ds-bot-lineage'], projects: ['dsbot-staging'] },
}
let db, server, base, readyCalls = 0
const as = id => apiClient({ baseUrl: base, principal: id, secret: principals[id].secret, tenant: 'td' })
before(async () => {
  db = await freshDb()
  server = await createApi({ pool: db.pool, embedder: { model: 'none', embed: async () => [] }, principals, ready: async () => { readyCalls += 1; return true } }).listen(0)
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => { server.close(); await db.drop() })

const denial = (id, over = {}) => {
  const source_id = `dsbot:test:auth:${id}`
  return {
    schema_version: 1, tenant_id: 'td', project_id: 'dsbot-staging', event_id: `${source_id}:r1`, run_id: 'dsbot-session:session-c1', agent_id: 'dsbot:bot-chief',
    kind: 'authorization.denied', occurred_at: '2026-11-19T10:00:00.000Z', source_system: 'ds-bot-lineage', source_id, source_seq: 1, source_sha256: sha256(id),
    body: { summary: `authorization denied message_bot by Chief to Writer in Desk: recipient-off (${id})`, reason: 'recipient-off' },
    authorization: { auth_id: source_id, actor: 'dsbot:bot-chief', action: 'message_bot', scope: 'dsbot.bot-response', target: 'dsbot:bot-writer', room_id: 'room-desk', verdict: 'deny', reason: 'recipient-off' },
    ...over,
  }
}

test('only the ingest principal may send lineage events, for its listed sources and projects', async () => {
  assert.equal((await as('shipper')('POST', '/v1/events', denial('a1'))).status, 200)
  assert.equal((await as('worker')('POST', '/v1/events', denial('a2'))).status, 403)
  const { authorization, ...plain } = denial('a3')
  assert.equal((await as('worker')('POST', '/v1/events', { ...plain, source_system: 'dsh-session' })).status, 403, 'a dsbot: event id is reserved')
  assert.equal((await as('shipper')('POST', '/v1/events', { ...denial('a4'), source_system: 'dsh-session' })).status, 403)
  assert.equal((await as('shipper')('POST', '/v1/events', { ...denial('a5'), project_id: 'elsewhere' })).status, 403)
  assert.equal((await as('shipper')('POST', '/v1/events', denial('a1', { source_sha256: sha256('changed') }))).status, 409)
})

test('batches: in order, idempotent, stop at a conflict, bounded, ingest-only', async () => {
  const batch = ['b1', 'b2', 'b3'].map(id => denial(id))
  const first = await as('shipper')('POST', '/v1/events/batch', { events: batch })
  assert.deepEqual(first.body.results.map(r => r.inserted), [true, true, true])
  const again = await as('shipper')('POST', '/v1/events/batch', { events: batch })
  assert.deepEqual(again.body.results.map(r => r.inserted), [false, false, false])
  const bad = await as('shipper')('POST', '/v1/events/batch', { events: [denial('b4'), { ...batch[2], source_sha256: sha256('x') }, denial('b5')] })
  assert.deepEqual(bad.body.results.map(r => [r.inserted, r.conflict ?? false, r.skipped ?? false]), [[true, false, false], [false, true, false], [false, false, true]])
  assert.equal((await as('shipper')('POST', '/v1/events/batch', { events: Array.from({ length: 101 }, (_, i) => denial(`m${i}`)) })).status, 400)
  assert.equal((await as('worker')('POST', '/v1/events/batch', { events: [denial('b6')] })).status, 403)
})

test('refusals can be listed by people, not by workers or the shipper; run timelines include bodies', async () => {
  const list = await as('alice')('GET', '/v1/authorizations?project_id=dsbot-staging&verdict=deny&reason=recipient-off')
  assert.equal(list.status, 200)
  const row = list.body.authorizations.find(a => a.auth_id === 'dsbot:test:auth:a1')
  assert.deepEqual([row.reason, row.target, row.room_id, row.source_event_id], ['recipient-off', 'dsbot:bot-writer', 'room-desk', 'dsbot:test:auth:a1:r1'])
  assert.equal((await as('worker')('GET', '/v1/authorizations?project_id=dsbot-staging')).status, 403)
  assert.equal((await as('shipper')('GET', '/v1/authorizations?project_id=dsbot-staging')).status, 403)
  assert.equal((await as('alice')('GET', '/v1/authorizations?project_id=dsbot-staging&limit=500')).status, 400)
  const run = await as('alice')('GET', '/v1/runs/dsbot-session%3Asession-c1?project_id=dsbot-staging')
  assert.equal(run.status, 200)
  assert.ok(run.body.events.some(e => /recipient-off/.test(e.body.summary)))
  assert.equal(run.body.authorizations[0].target, 'dsbot:bot-writer')
  assert.equal((await as('worker')('POST', '/v1/search', { project_id: 'dsbot-staging', query: 'Writer' })).status, 403)
})

test('bad input is a 400, never a 500', async () => {
  const s = body => as('alice')('POST', '/v1/search', { project_id: 'dsbot-staging', query: 'x', ...body })
  for (const body of [{ limit: 'abc' }, { from: 'nope' }, { query: 'q'.repeat(2001) }, { mode: 'psychic' }]) assert.equal((await s(body)).status, 400, JSON.stringify(body).slice(0, 40))
  assert.equal((await as('alice')('GET', '/v1/runs/%E0%A4%A?project_id=dsbot-staging')).status, 400)
})

test('authentication failures look the same, and odd headers are a 401', async () => {
  const unknown = await apiClient({ baseUrl: base, principal: 'nobody', secret: 'x', tenant: 'td' })('GET', '/v1/authorizations?project_id=dsbot-staging')
  const badSig = await apiClient({ baseUrl: base, principal: 'alice', secret: 'wrong', tenant: 'td' })('GET', '/v1/authorizations?project_id=dsbot-staging')
  assert.deepEqual([unknown.status, unknown.body], [401, { error: 'unauthenticated' }])
  assert.deepEqual([badSig.status, badSig.body], [401, { error: 'unauthenticated' }])
  const { headers } = sign({ principal: 'alice', secret: 'alice-secret', tenant: 'td', method: 'GET', path: '/v1/authorizations?project_id=dsbot-staging' })
  const status = await new Promise((resolve, reject) => {
    const req = request(`${base}/v1/authorizations?project_id=dsbot-staging`, { method: 'GET', headers: { ...headers, 'x-signature': 'é'.repeat(64) } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
    req.end()
  })
  assert.equal(status, 401)
})

test('/ready checks the database at most once a second', async () => {
  const before = readyCalls
  await fetch(`${base}/ready`)
  await fetch(`${base}/ready`)
  assert.equal(readyCalls - before, 1)
})

test('the principals file is validated without echoing secrets', () => {
  const long = c => c.repeat(40)
  assert.deepEqual(validatePrincipals({ worker: { secret: long('w'), tenants: ['t'], role: 'worker' } }), [])
  const errors = validatePrincipals({
    worker: { secret: 'short', tenants: ['t'], role: 'worker' },
    a: { secret: long('s'), tenants: 't', role: 'user' },
    b: { secret: long('s'), tenants: ['t'], role: 'admin' },
    ship: { secret: long('i'), tenants: ['t', 'u'], role: 'ingest' },
  })
  assert.ok(errors.some(e => e.startsWith('worker: secret')))
  assert.ok(errors.some(e => e.startsWith('a: tenants')))
  assert.ok(errors.some(e => e.startsWith('b: role')) && errors.some(e => e.startsWith('b: shares its secret with a')))
  assert.ok(errors.some(e => e.startsWith('ship: an ingest principal has exactly one tenant')) && errors.some(e => e.startsWith('ship: an ingest principal needs a sources')))
  assert.ok(errors.every(e => !e.includes(long('s')) && !e.includes('short')))
})
