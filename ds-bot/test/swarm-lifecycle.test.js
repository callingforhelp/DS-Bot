import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install as installLedger } from '../src/host/ledger.js'
import { install as installSwarm } from '../src/host/swarm.js'
import { install as installSwarmTools } from '../src/host/swarm-tools.js'
import { isQuotaWorker, swarmCounts, swarmsForSession, workersOf } from '../src/client/swarm-model.js'

const host = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-swarm-lc-'))
  const deliveries = []
  const sessions = new Map()
  let nextSessionId = 1

  const rt = {
    home,
    readOnly: () => undefined,
    warn: () => {},
    state: {},
    teamTools: [],
    cachedCatalog: () => [
      { provider: 'deepseek', model: 'deepseek-chat', name: 'DeepSeek Chat' },
      { provider: 'deepseek', model: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ],
    createSession: async (title) => {
      const id = `session-${nextSessionId++}`
      sessions.set(id, { title })
      return id
    },
    selectSessionModel: async (sessionId, model) => {
      const s = sessions.get(sessionId)
      if (s) s.model = model
      return { selected: model }
    },
    swarmDeliver: async (sessionId, text) => {
      deliveries.push({ sessionId, text })
    },
    ctx: {
      sessionController: {
        fork: async ({ sessionId }) => {
          const id = `session-fork-${nextSessionId++}`
          sessions.set(id, { title: `Fork of ${sessionId}` })
          return { sessionId: id }
        },
      },
      systemPrompt: {
        section: () => {},
      },
    },
  }

  installLedger(rt)
  installSwarm(rt)
  installSwarmTools(rt)

  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  return { rt, deliveries, sessions }
}

test('swarm lifecycle: create, add workers, post, and ring doorbells', async () => {
  const { rt, deliveries } = host(test)

  // 1. Create Swarm
  const swarm = rt.swarm.createSwarm({
    coordinatorSessionId: 'coord-session-1',
    title: 'Feature Swarm',
  })
  assert.equal(swarm.title, 'Feature Swarm')
  assert.equal(swarm.members.coordinator.sessionId, 'coord-session-1')

  // 2. Add workers with task slicing
  const added = await rt.swarm.addMembers(swarm.id, 'coordinator', {
    name: 'worker',
    brief: 'Implement slices',
    tasks: ['slice A', 'slice B'],
  })
  assert.equal(added.length, 2)
  assert.equal(added[0].name, 'worker-1')
  assert.equal(added[1].name, 'worker-2')

  // Verify doorbells were delivered on worker spawn
  assert.ok(deliveries.length >= 2)
  assert.ok(deliveries[0].text.includes('slice A'))
  assert.ok(deliveries[1].text.includes('slice B'))

  // 3. Status view
  const status = rt.swarm.statusView(swarm.id)
  assert.equal(status.members.length, 3)

  // 4. Tools integration for session
  const coordTools = rt.swarmToolsForSession('coord-session-1')
  assert.equal(coordTools.length, 4)
  const nonSwarmTools = rt.swarmToolsForSession('unknown-session')
  assert.equal(nonSwarmTools.length, 0)

  // 5. Turn hooks: start, end, quota failure
  rt.swarmHooks.turnStart(added[0].sessionId)
  assert.equal(swarm.members['worker-1'].status, 'working')

  rt.swarmHooks.turnEnd(added[0].sessionId)
  assert.equal(swarm.members['worker-1'].status, 'waiting')

  // Quota failure marks quota and stops member
  rt.swarmHooks.turnFailure(added[0].sessionId, { code: '429', message: 'Rate limit' })
  assert.equal(swarm.members['worker-1'].status, 'stopped')
  assert.equal(swarm.members['worker-1'].quota?.code, '429')

  // 6. Model switching
  await rt.swarm.switchMemberModel(swarm.id, 'coordinator', 'worker-1', {
    provider: 'deepseek',
    model: 'deepseek-reasoner',
  })
  assert.equal(swarm.members['worker-1'].model.model, 'deepseek-reasoner')
  assert.equal(swarm.members['worker-1'].status, 'waiting')

  // 7. Kill worker
  const killRes = await rt.swarm.killMember(swarm.id, 'coordinator', 'worker-2')
  assert.equal(killRes.member.status, 'killed')
  assert.equal(swarm.members['worker-2'].status, 'killed')

  // 8. Close swarm with decisions distillation
  const board = rt.swarm.boardOf(swarm.id)
  board.post({ agent: 'worker-1', text: '@coordinator [done] finished feat commit 0123456789abcdef', members: [] })

  let ingested = 0
  rt.ingestObservation = async () => { ingested += 1 }
  rt.recordProvenance = async () => {}

  const closeRes = await rt.swarm.closeSwarm(swarm.id, 'coordinator')
  assert.equal(closeRes.decisions, 1)
  assert.equal(closeRes.shas, 1)
  assert.equal(swarm.closed, true)
})

test('swarm bot bootstrap, channel/MCP endpoints, and client model contract work end-to-end', async t => {
  const { rt, deliveries } = host(t)
  rt.chatOwners = new Map([['bot-s1', 'b1']])
  rt.selfOf = id => (id === 'bot-s1' ? 'b1' : undefined)

  // Normal Bot session gets `swarm` from rt.teamTools and unlocks all 4 swarm tools on bootstrap.
  assert.equal(rt.swarmToolsForSession('bot-s1').length, 0)
  const swarmDef = rt.teamTools.find(d => d.name === 'swarm')
  assert.ok(swarmDef)
  const addOut = await swarmDef.execute(
    { action: 'add', name: 'helper', title: 'Alpha Swarm', brief: 'Inspect module' },
    { agent: { session: { id: 'bot-s1' } } },
  )
  assert.equal(addOut, 'Added helper')
  assert.equal(rt.swarmToolsForSession('bot-s1').length, 4)

  // Map-keyed swarmsView + statusView compatibility with client swarm-model helpers.
  const viewMap = rt.swarmsView()
  const swIds = Object.keys(viewMap)
  assert.equal(swIds.length, 1)
  const swId = swIds[0]
  const forSession = swarmsForSession(viewMap, 'bot-s1')
  assert.equal(forSession.length, 1)
  assert.equal(forSession[0].ownerBotId, 'b1')
  // Initial intro doorbell transitions helper to working alongside coordinator.
  assert.equal(swarmCounts(forSession[0]).working, 2)
  assert.equal(swarmCounts(forSession[0]).waiting, 0)

  // Turn hooks mark working -> waiting -> stopped/quota and expose quota cleanly to client helpers.
  const helperSession = rt.swarm.memberOf(rt.swarm.swarmOf(swId), 'helper').sessionId
  rt.swarmHooks.turnStart(helperSession)
  rt.swarmHooks.turnEnd(helperSession)
  assert.equal(swarmCounts(rt.swarmsView()[swId]).waiting, 1)
  assert.equal(swarmCounts(rt.swarmsView()[swId]).working, 1)
  rt.swarmHooks.turnFailure(helperSession, { code: '429', message: 'Quota' })
  assert.equal(isQuotaWorker(workersOf(rt.swarmsView()[swId]).find(w => w.name === 'helper')), true)
  assert.equal(swarmCounts(rt.swarmsView()[swId]).quota, 1)

  // swarmEndpoint supports all channel/MCP endpoint names, external mcp poster, and "provider/model" string switch.
  const epCreate = await rt.swarmEndpoint('swarm-create', { sessionId: 'bot-s2', ownerBotId: 'b2', title: 'Second' })
  assert.ok(epCreate.swarm?.id)
  const postRes = await rt.swarmEndpoint('swarm-post', { swarmId: swId, from: 'mcp:agy', text: '@helper check status' })
  assert.ok(postRes.post?.seq >= 1)
  const readRes = await rt.swarmEndpoint('swarm-read', { swarmId: swId, since: 0 })
  assert.ok(readRes.messages.some(m => m.agent === 'mcp:agy'))
  const modelsRes = await rt.swarmEndpoint('swarm-models', { swarmId: swId })
  assert.equal(modelsRes.models[0].id, 'deepseek/deepseek-chat')
  const switchRes = await rt.swarmEndpoint('swarm-switch-model', { swarmId: swId, name: 'helper', model: 'deepseek/deepseek-reasoner' })
  assert.equal(switchRes.member.model.model, 'deepseek-reasoner')
  assert.ok(deliveries.length >= 1)
  const closeRes = await rt.swarmEndpoint('swarm-close', { swarmId: swId })
  assert.equal(rt.swarmsView()[swId].status, 'closed')
  assert.equal(rt.swarmsView()[swId].closed, true)
  assert.equal(closeRes.closed, undefined)
})
