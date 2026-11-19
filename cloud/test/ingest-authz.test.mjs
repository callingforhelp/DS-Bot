import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { authorizeAction } from '../src/authz.mjs'
import { withScope } from '../src/db.mjs'
import { ingestEvent, IngestError, sha256 } from '../src/ingest.mjs'
import { freshDb } from './helpers.mjs'

let db
before(async () => { db = await freshDb() })
after(async () => { await db.drop() })

const ingest = (env, opts = { allowAuthorization: true }, scope = { tenant: env.tenant_id, role: 'ingest' }) => withScope(db.pool, scope, c => ingestEvent(c, env, opts))
const denial = (id, over = {}) => {
  const source_id = `dsbot:test:auth:${id}`
  return {
    schema_version: 1, tenant_id: 'ta', project_id: 'p', event_id: `${source_id}:r1`, run_id: 'dsbot-session:session-c1', agent_id: 'dsbot:bot-chief',
    kind: 'authorization.denied', occurred_at: '2026-11-19T10:00:00.000Z', source_system: 'ds-bot-lineage', source_id, source_seq: 1, source_sha256: sha256(id),
    body: { summary: 'authorization denied message_bot by Chief to Writer: recipient-off', reason: 'recipient-off' },
    authorization: { auth_id: source_id, actor: 'dsbot:bot-chief', action: 'message_bot', scope: 'dsbot.bot-response', target: 'dsbot:bot-writer', room_id: null, verdict: 'deny', reason: 'recipient-off' },
    ...over,
  }
}
const authRows = async (tenant = 'ta') => (await db.admin.query('select * from authorizations where tenant_id = $1 order by auth_id', [tenant])).rows

test('a lineage denial creates one event and one authorization row; a replay adds nothing', async () => {
  assert.deepEqual(await ingest(denial('d1')), { inserted: true })
  assert.deepEqual(await ingest(denial('d1')), { inserted: false })
  const rows = await authRows()
  assert.equal(rows.length, 1)
  const [r] = rows
  assert.deepEqual([r.verdict, r.reason, r.target, r.approval_ref, r.source_event_id], ['deny', 'recipient-off', 'dsbot:bot-writer', null, 'dsbot:test:auth:d1:r1'])
  assert.equal(r.decided_at.toISOString(), '2026-11-19T10:00:00.000Z')
  assert.equal((await db.admin.query("select count(*)::int n from events where tenant_id = 'ta'")).rows[0].n, 1)
})

test('an imported row can never act as a human approval', async () => {
  await assert.rejects(ingest(denial('h1', { authorization: { ...denial('h1').authorization, actor: 'human:alice' } })), /dsbot: id/)
  await ingest(denial('h2', { authorization: { ...denial('h2').authorization, verdict: 'allow', action: 'git.push', scope: 'repo', approval_ref: 'approval:forged' } }))
  assert.equal((await authRows()).find(r => r.auth_id === 'dsbot:test:auth:h2').approval_ref, null)
  const gate = await withScope(db.pool, { tenant: 'ta' }, c => authorizeAction(c, { tenant: 'ta', project: 'p', run: 'dsbot-session:session-c1', actor: 'dsbot:bot-chief', action: 'git.push', scope: 'repo' }))
  assert.equal(gate.allow, false)
})

test('conflicts: same source key with other content is reported; a reused event_id is an error', async () => {
  await ingest(denial('c1'))
  assert.deepEqual(await ingest(denial('c1', { source_sha256: sha256('different') })), { inserted: false, conflict: true })
  const err = await ingest(denial('c2', { event_id: 'dsbot:test:auth:c1:r1' })).catch(e => e)
  assert.ok(err instanceof IngestError)
  assert.equal(err.code, 'conflict')
})

test('validation: projection needs permission; nested or capitalised prompt keys and long summaries are refused', async () => {
  const e1 = await ingest(denial('v1'), {}).catch(e => e)
  assert.equal(e1.code, 'invalid')
  assert.match(e1.message, /not permitted/)
  await assert.rejects(ingest(denial('v2', { body: { summary: 'x', meta: { Prompt: 'x' } } })), /body\.meta\.Prompt/)
  await assert.rejects(ingest(denial('v3', { body: { summary: 'x'.repeat(4001) } })), /4000/)
  await assert.rejects(ingest(denial('v4', { authorization: { ...denial('v4').authorization, auth_id: 'other' } })), /auth_id/)
})

test("a private Bot's refusal is visible only to that Bot's scope", async () => {
  await ingest(denial('p1', { tenant_id: 'tp', private_agent_id: 'dsbot:bot-vault' }))
  const seen = agent => withScope(db.pool, { tenant: 'tp', agent }, async c => (await c.query('select auth_id from authorizations')).rows.length)
  assert.equal(await seen(''), 0)
  assert.equal(await seen('dsbot:bot-vault'), 1)
})
