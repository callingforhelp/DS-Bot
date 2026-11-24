import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install as installLedger } from '../src/host/ledger.js'
import { install as installSwarm } from '../src/host/swarm.js'
import { install as installSwarmTools } from '../src/host/swarm-tools.js'

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
