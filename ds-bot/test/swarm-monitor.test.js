import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install as installLedger } from '../src/host/ledger.js'
import { install as installSwarm } from '../src/host/swarm.js'
import { install as installSwarmMonitor } from '../src/host/swarm-monitor.js'

const host = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-swarm-mon-'))
  const rt = {
    home,
    readOnly: () => undefined,
    warn: () => {},
    state: {},
    live: new Map(),
    createSession: async () => 'sess-1',
    swarmDeliver: async () => {},
    ctx: {},
  }

  installLedger(rt)
  installSwarm(rt)
  const monitor = installSwarmMonitor(rt)
  // Stop background timer so tests control tick execution
  monitor.stop()

  t.after(() => {
    monitor.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { rt, monitor }
}

test('monitor marks dormant on coordinator unaddressed [done]', () => {
  const { rt, monitor } = host(test)
  const swarm = rt.swarm.createSwarm({
    coordinatorSessionId: 'coord-1',
    title: 'Monitor Test Swarm',
  })

  const board = rt.swarm.boardOf(swarm.id)
  board.post({ agent: 'coordinator', text: '[done] all tasks completed', members: [] })

  const res = monitor.tick()
  assert.equal(res.length, 1)
  assert.equal(res[0].action, 'dormant')
  assert.equal(swarm.dormant, true)
})

test('monitor emits [stall] when members are working but absent from live', () => {
  const { rt, monitor } = host(test)
  const swarm = rt.swarm.createSwarm({
    coordinatorSessionId: 'coord-1',
    title: 'Stall Test Swarm',
  })
  swarm.members.worker = {
    name: 'worker',
    sessionId: 'worker-sess-1',
    role: 'worker',
    status: 'working',
  }

  // First tick detects no live activity and working member not in rt.live
  const res = monitor.tick()
  assert.equal(res.length, 1)
  assert.equal(res[0].action, 'stall')
  assert.equal(swarm.stalls, 1)

  // Verify deterministic stall message was posted to the board
  const board = rt.swarm.boardOf(swarm.id)
  const lastPost = rt.ledger.record(board.book, board.lastSeq())
  assert.equal(lastPost.agent, 'monitor')
  assert.ok(lastPost.text.includes('[stall]'))
})

test('monitor marks dormant after idle ticks threshold', () => {
  const { rt, monitor } = host(test)
  const swarm = rt.swarm.createSwarm({
    coordinatorSessionId: 'coord-1',
    title: 'Idle Test Swarm',
  })
  swarm.members.coordinator.status = 'waiting'

  for (let i = 0; i < 5; i++) {
    monitor.tick()
  }

  assert.equal(swarm.dormant, true)
})
