import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createApi, validatePrincipals } from '../src/api.mjs'
import { orgRoleAllows, requireOrgRole, recordHumanApproval } from '../src/authz.mjs'
import { apiClient } from '../src/client.mjs'
import { withScope } from '../src/db.mjs'
import { mockEmbedder } from '../src/embed.mjs'
import { localObjectStore } from '../src/objectstore.mjs'
import {
  syncPush, syncPull, searchTeamMemory, codeSearch, sessionTakeover,
  forgetMemory, restoreMemory, listSkills, publishSkill,
  listSharedArtifacts, registerSharedArtifact, handleMcpRpc, revokeDevice,
  RRF_K, MCP_PROTOCOL_VERSION
} from '../src/team-memory.mjs'
import { freshDb } from './helpers.mjs'

const SECRET_32 = '0123456789abcdef0123456789abcdef'
const principals = {
  admin: { secret: SECRET_32 + '-admin', tenants: ['t1'], scopes: ['read-only'], role: 'human', org_id: 'org-1', org_role: 'admin' },
  member: { secret: SECRET_32 + '-member', tenants: ['t1'], scopes: ['read-only'], role: 'user', org_id: 'org-1', org_role: 'member', bot_ids: ['bot-a'] },
  bot: { secret: SECRET_32 + '-bot', tenants: ['t1'], scopes: ['read-only'], role: 'bot', agent: 'bot-a' },
  dev1: { secret: SECRET_32 + '-dev1', tenants: ['t1'], scopes: ['read-only'], role: 'device', device_id: 'dev-1' },
  dev2: { secret: SECRET_32 + '-dev2', tenants: ['t1'], scopes: ['read-only'], role: 'device', device_id: 'dev-2' },
  other: { secret: SECRET_32 + '-other', tenants: ['t2'], scopes: ['read-only'], role: 'user', org_id: 'org-2' },
}

let db
let server
let base
let store
let api
const embedder = mockEmbedder()
const as = (id, tenant = 't1') => apiClient({ baseUrl: base, principal: id, secret: principals[id].secret, tenant })

before(async () => {
  db = await freshDb({ optional: ['002_pgvector.optional.sql', '006_team_memory_pgvector.optional.sql'] })
  store = localObjectStore({ root: mkdtempSync(join(tmpdir(), 'team-mem-objects-')), secret: 'store-secret' })
  api = createApi({ pool: db.pool, embedder, principals, objectStore: store })
  server = await api.listen(0)
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  server.close()
  await db.pool.end().catch(() => {})
  await db.drop()
})

test('validatePrincipals accepts device & bot roles and validates org/memory fields', () => {
  const valid = {
    d1: { secret: SECRET_32 + '01', tenants: ['t1'], role: 'device', device_id: 'dev-1' },
    b1: { secret: SECRET_32 + '02', tenants: ['t1'], role: 'bot', agent: 'bot-1', bot_ids: ['bot-1'] },
    u1: { secret: SECRET_32 + '03', tenants: ['t1'], role: 'user', org_id: 'org-1', org_role: 'admin', memory_scopes: ['project'] },
  }
  assert.deepEqual(validatePrincipals(valid), [])

  const invalid = {
    x1: { secret: SECRET_32 + '04', tenants: ['t1'], role: 'unknown' },
    x2: { secret: SECRET_32 + '05', tenants: ['t1'], role: 'user', org_role: 'super' },
    x3: { secret: SECRET_32 + '06', tenants: ['t1'], role: 'user', bot_ids: 'not-an-array' },
    x4: { secret: SECRET_32 + '07', tenants: ['t1'], role: 'user', memory_scopes: [123] },
  }
  const errors = validatePrincipals(invalid)
  assert.ok(errors.some(e => e.startsWith('x1: role')))
  assert.ok(errors.some(e => e.startsWith('x2: org_role')))
  assert.ok(errors.some(e => e.startsWith('x3: bot_ids')))
  assert.ok(errors.some(e => e.startsWith('x4: memory_scopes')))
})

test('authz orgRoleAllows and requireOrgRole enforce RBAC floors', () => {
  assert.equal(orgRoleAllows('member', 'memory.purge_hard'), false)
  assert.equal(orgRoleAllows('admin', 'memory.purge_hard'), true)
  assert.equal(orgRoleAllows('owner', 'memory.purge_hard'), true)
  assert.equal(orgRoleAllows('admin', 'transcript.export_external'), false)
  assert.equal(orgRoleAllows('owner', 'transcript.export_external'), true)

  assert.throws(() => requireOrgRole({ org_role: 'member' }, 'memory.purge_hard'), /org role member cannot memory.purge_hard/)
  assert.doesNotThrow(() => requireOrgRole({ org_role: 'admin' }, 'memory.purge_hard'))
})

test('syncPush: idempotent on (origin_device_id, origin_op_id), redacts content, applies LWW with revisions', async () => {
  const client = as('dev1')
  const op1 = {
    op_id: 'op-m1-v1',
    entity: 'memory',
    id: 'mem-1',
    op: 'upsert',
    updated_at_ms: 1000,
    data: {
      title: 'Auth config',
      body: 'Token is ghp_111122223333444455556666777788889999 and contact alice@example.com',
      scope: 'project',
      tags: ['auth', 'secret'],
    },
  }

  const res1 = await client('POST', '/v1/memory/sync/push', { ops: [op1] })
  assert.equal(res1.status, 200)
  assert.equal(res1.body.results[0].status, 'applied')
  const seq1 = res1.body.results[0].server_seq
  assert.ok(Number.isInteger(seq1))

  // Replaying the exact same op returns 'duplicate'
  const resReplay = await client('POST', '/v1/memory/sync/push', { ops: [op1] })
  assert.equal(resReplay.status, 200)
  assert.equal(resReplay.body.results[0].status, 'duplicate')

  // Verify server-side redaction was applied
  const row = (await db.admin.query("select body, title from memories where memory_id = 'mem-1'")).rows[0]
  assert.ok(row.body.includes('[redacted:token]'))
  assert.ok(row.body.includes('[redacted:email]'))
  assert.ok(!row.body.includes('ghp_'))
  assert.ok(!row.body.includes('alice@example.com'))

  // LWW newer write succeeds (clock 2000 > 1000)
  const op2 = {
    op_id: 'op-m1-v2',
    entity: 'memory',
    id: 'mem-1',
    op: 'upsert',
    updated_at_ms: 2000,
    data: { title: 'Auth config v2', body: 'Updated instructions for oauth login', scope: 'project' },
  }
  const res2 = await client('POST', '/v1/memory/sync/push', { ops: [op2] })
  assert.equal(res2.body.results[0].status, 'applied')

  // LWW older write is superseded (clock 1500 < 2000)
  const opStale = {
    op_id: 'op-m1-stale',
    entity: 'memory',
    id: 'mem-1',
    op: 'upsert',
    updated_at_ms: 1500,
    data: { title: 'Stale title', body: 'Stale body', scope: 'project' },
  }
  const resStale = await client('POST', '/v1/memory/sync/push', { ops: [opStale] })
  assert.equal(resStale.body.results[0].status, 'superseded')

  // Memory revisions preserve every update attempt
  const revs = (await db.admin.query("select revision, title, applied from memory_revisions where memory_id = 'mem-1' order by revision")).rows
  assert.equal(revs.length, 3)
  assert.equal(revs[0].applied, true)
  assert.equal(revs[1].applied, true)
  assert.equal(revs[2].applied, false)
})

test('syncPush: turns, observations, and code_provenance', async () => {
  const client = as('dev1')
  const ops = [
    {
      op_id: 'op-turn-1',
      entity: 'turn',
      id: 'turn-1',
      op: 'upsert',
      updated_at_ms: 3000,
      data: { session_id: 'sess-1', seq: 1, role: 'user', text: 'Please refactor authentication router' },
    },
    {
      op_id: 'op-obs-1',
      entity: 'observation',
      id: 'obs-1',
      op: 'upsert',
      updated_at_ms: 3010,
      data: { session_id: 'sess-1', kind: 'decision', text: 'Selected Fastify router with token auth' },
    },
    {
      op_id: 'op-prov-1',
      entity: 'provenance',
      id: 'prov-1',
      op: 'upsert',
      updated_at_ms: 3020,
      data: {
        session_id: 'sess-1',
        turn_id: 'turn-1',
        commit_sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        repo: 'ds-bot',
        path: 'cloud/src/api.mjs',
        summary: 'Added team-memory sync endpoints',
      },
    },
  ]

  const res = await client('POST', '/v1/memory/sync/push', { ops })
  assert.equal(res.status, 200)
  assert.equal(res.body.results.length, 3)
  assert.ok(res.body.results.every(r => r.status === 'applied'))
})

test('syncPull: cursor pagination and device exclusion', async () => {
  const dev1Client = as('dev1')
  const dev2Client = as('dev2')

  // dev1 pulling with include_own=false will not see its own ops
  const pullDev1 = await dev1Client('POST', '/v1/memory/sync/pull', { cursor: 0, include_own: false })
  assert.equal(pullDev1.status, 200)
  assert.equal(pullDev1.body.ops.length, 0)

  // dev2 pulling will see dev1 ops
  const pullDev2 = await dev2Client('POST', '/v1/memory/sync/pull', { cursor: 0 })
  assert.equal(pullDev2.status, 200)
  assert.ok(pullDev2.body.ops.length > 0)
  assert.ok(pullDev2.body.cursor > 0)

  // GET /v1/memory/sync/pull works with query params
  const getPull = await dev2Client('GET', `/v1/memory/sync/pull?cursor=0&limit=2`)
  assert.equal(getPull.status, 200)
  assert.equal(getPull.body.ops.length, 2)
})

test('searchTeamMemory and codeSearch', async () => {
  const client = as('member')

  // Hybrid search over team memory
  const searchRes = await client('POST', '/v1/memory/search', { query: 'Fastify authentication router', limit: 5 })
  assert.equal(searchRes.status, 200)
  assert.ok(searchRes.body.results.length > 0)
  assert.ok(searchRes.body.results.some(r => r.kind === 'turn' || r.kind === 'observation' || r.kind === 'memory'))

  // Code search by commit prefix
  const codeRes = await client('POST', '/v1/memory/code-search', { commit: 'a1b2c3d' })
  assert.equal(codeRes.status, 200)
  assert.equal(codeRes.body.results.length, 1)
  assert.equal(codeRes.body.results[0].repo, 'ds-bot')
  assert.ok(codeRes.body.results[0].turn_excerpt.includes('refactor authentication'))

  // Code search by query
  const codeQueryRes = await client('POST', '/v1/memory/code-search', { query: 'team-memory sync endpoints' })
  assert.equal(codeQueryRes.status, 200)
  assert.equal(codeQueryRes.body.results.length, 1)
})

test('sessionTakeover: restores full transcript, observations, and provenance', async () => {
  const client = as('member')
  const res = await client('GET', '/v1/memory/sessions/sess-1/takeover')
  assert.equal(res.status, 200)
  assert.equal(res.body.session_id, 'sess-1')
  assert.equal(res.body.turns.length, 1)
  assert.equal(res.body.turns[0].text, 'Please refactor authentication router')
  assert.equal(res.body.observations.length, 1)
  assert.equal(res.body.provenance.length, 1)

  // 404 for unknown session
  const res404 = await client('GET', '/v1/memory/sessions/unknown-session/takeover')
  assert.equal(res404.status, 404)
})

test('forgetMemory and restoreMemory (soft delete and hard purge)', async () => {
  const client = as('admin')

  // Soft delete memory
  const forgetRes = await client('POST', '/v1/memory/forget', { ids: ['mem-1'] })
  assert.equal(forgetRes.status, 200)
  assert.equal(forgetRes.body.forgotten, 1)

  // Memory is hidden from normal search
  const searchAfterForget = await client('POST', '/v1/memory/search', { query: 'oauth login', kinds: ['memory'] })
  assert.equal(searchAfterForget.status, 200)
  assert.equal(searchAfterForget.body.results.length, 0)

  // Restore memory
  const restoreRes = await client('POST', '/v1/memory/restore', { ids: ['mem-1'] })
  assert.equal(restoreRes.status, 200)
  assert.equal(restoreRes.body.restored, 1)

  // Memory is visible again
  const searchAfterRestore = await client('POST', '/v1/memory/search', { query: 'oauth login', kinds: ['memory'] })
  assert.equal(searchAfterRestore.status, 200)
  assert.equal(searchAfterRestore.body.results.length, 1)

  // Hard purge without human approval fails for non-human or without approval row
  const memberClient = as('member')
  const purgeFail = await memberClient('POST', '/v1/memory/forget', { ids: ['mem-1'], hard: true })
  assert.equal(purgeFail.status, 403)

  // Hard purge with admin (human) principal succeeds and deletes rows permanently
  const purgeOk = await client('POST', '/v1/memory/forget', { ids: ['mem-1'], hard: true })
  assert.equal(purgeOk.status, 200)
  assert.equal(purgeOk.body.purged, 1)
  const remaining = (await db.admin.query("select 1 from memories where memory_id = 'mem-1'")).rows
  assert.equal(remaining.length, 0)
})

test('skills: publishing and listing with versioning', async () => {
  const client = as('member')

  const pub1 = await client('POST', '/v1/skills', {
    name: 'deploy-agent',
    description: 'Deploys an agent to Daytona',
    body: 'Run daytona create and connect',
    visibility: 'tenant',
  })
  assert.equal(pub1.status, 200)
  assert.equal(pub1.body.skill_id, 'deploy-agent@1')

  const pub2 = await client('POST', '/v1/skills', {
    name: 'deploy-agent',
    description: 'Deploys an agent to Daytona v2',
    body: 'Run daytona create with custom snapshot',
    visibility: 'tenant',
  })
  assert.equal(pub2.status, 200)
  assert.equal(pub2.body.skill_id, 'deploy-agent@2')

  // Listing skills returns latest version
  const list = await client('GET', '/v1/skills')
  assert.equal(list.status, 200)
  const skill = list.body.skills.find(s => s.name === 'deploy-agent')
  assert.ok(skill)
  assert.equal(skill.version, 2)
})

test('sharedArtifacts: register verifies object store hash, list returns metadata', async () => {
  const client = as('member')
  const content = Buffer.from('hello shared artifact payload')
  const token = store.presign({ bucket: 'shared', key: 'artifacts/test.txt' })
  const uploaded = store.put({ bucket: 'shared', key: 'artifacts/test.txt', token, bytes: content })

  // Register with wrong hash fails with 422
  const regBad = await client('POST', '/v1/shared-artifacts', {
    name: 'test-artifact',
    bucket: 'shared',
    object_key: 'artifacts/test.txt',
    sha256: '0000000000000000000000000000000000000000000000000000000000000000',
  })
  assert.equal(regBad.status, 422)

  // Register with correct hash succeeds
  const regOk = await client('POST', '/v1/shared-artifacts', {
    name: 'test-artifact',
    bucket: 'shared',
    object_key: 'artifacts/test.txt',
    sha256: uploaded.sha256,
    description: 'A test shared artifact',
  })
  assert.equal(regOk.status, 200)
  assert.ok(regOk.body.artifact_id)
  assert.equal(regOk.body.sha256, uploaded.sha256)

  // List returns the registered artifact
  const list = await client('GET', '/v1/shared-artifacts')
  assert.equal(list.status, 200)
  const found = list.body.artifacts.find(a => a.name === 'test-artifact')
  assert.ok(found)
  assert.equal(found.sha256, uploaded.sha256)
})

test('MCP: JSON-RPC 2025-06-18 router on /v1/mcp and /mcp alias', async () => {
  const client = as('member')

  // initialize
  const init = await client('POST', '/v1/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.equal(init.status, 200)
  assert.equal(init.body.result.protocolVersion, MCP_PROTOCOL_VERSION)
  assert.equal(init.body.result.serverInfo.name, 'dsbot-team-memory')

  // ping
  const ping = await client('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'ping' })
  assert.equal(ping.status, 200)
  assert.deepEqual(ping.body.result, {})

  // tools/list
  const toolsList = await client('POST', '/v1/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/list' })
  assert.equal(toolsList.status, 200)
  assert.equal(toolsList.body.result.tools.length, 9)
  const names = toolsList.body.result.tools.map(t => t.name)
  assert.ok(names.includes('memory_search'))
  assert.ok(names.includes('code_search'))
  assert.ok(names.includes('session_takeover'))
  assert.ok(names.includes('skill_list'))

  // tools/call -> skill_list
  const callSkill = await client('POST', '/v1/mcp', {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'skill_list', arguments: {} },
  })
  assert.equal(callSkill.status, 200)
  assert.equal(callSkill.body.result.isError, false)
  assert.ok(callSkill.body.result.structuredContent.skills.length > 0)

  // notification without id gets 202
  const notify = await client('POST', '/v1/mcp', { jsonrpc: '2.0', method: 'initialized' })
  assert.equal(notify.status, 202)
})

test('revokeDevice: revokes device and blocks subsequent sync operations', async () => {
  const adminClient = as('admin')
  const devClient = as('dev1')

  const revRes = await adminClient('POST', '/v1/memory/device/revoke', { device_id: 'dev-1' })
  assert.equal(revRes.status, 200)
  assert.equal(revRes.body.revoked, true)

  // Subsequent syncPush from revoked device fails with 403
  const pushAttempt = await devClient('POST', '/v1/memory/sync/push', {
    ops: [{ op_id: 'op-blocked', entity: 'observation', id: 'obs-block', op: 'upsert', data: { text: 'test' } }],
  })
  assert.equal(pushAttempt.status, 403)
  assert.equal(pushAttempt.body.error, 'device is revoked')
})
