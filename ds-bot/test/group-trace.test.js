import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { createRuntime } from '../index.js'
import { buildGroupTrace, collectPairRecords, pairBookName, saveGroupTrace, summarizeRouting } from '../src/host/group-trace.js'
import { fakeContext } from './fake-ctx.js'

const SessionPersistence = typeof Jsonl.apply === 'function' ? Jsonl : Jsonl.default

async function dshRegistry(t, root, live, plugin) {
  const host = new Context()
  t.after(() => host.fiber.dispose())
  await host.plugin(Storage)
  await host.plugin(StorageJson, { root: join(root, 'storage') })
  await host.plugin(StorageDomain, { backend: 'json' })
  await host.plugin(SessionPersistence, { root: join(root, 'sessions') })
  await host.plugin({ name: 'live-sessions', apply: inner => inner.provide('sessions', { list: () => [], get: id => (live.includes(id) ? {} : undefined) }) })
  await host.plugin({
    name: 'plugin-hooks',
    apply: (inner) => {
      const hooks = name => plugin.listeners.get(name) ?? []
      inner.on('workspace/session-stop', payload => Promise.all(hooks('workspace/session-stop').map(listener => listener(payload))))
      inner.on('workspace/session-activity', (payload, next) => hooks('workspace/session-activity').reduceRight((rest, listener) => () => listener(payload, rest), next)())
    },
  })
  await host.plugin(WorkspaceRegistry)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the Workspace registry did not start')), 5000)
    host.inject(['workspaceRegistry'], (inner) => {
      clearTimeout(timer)
      resolve(inner.workspaceRegistry)
    })
  })
}

test('collectPairRecords gathers inter-bot exchanges and summarizeRouting counts loops', () => {
  const books = {
    [pairBookName('bot_coder', 'bot_planner')]: [
      { seq: 1, at: 100, fromName: 'Planner', toName: 'Coder', kind: 'request', text: 'Implement /decisions' },
      { seq: 2, at: 300, fromName: 'Coder', toName: 'Planner', kind: 'reply', text: 'Done: 12/12 pass' },
    ],
    [pairBookName('bot_coder', 'bot_reviewer')]: [
      { seq: 1, at: 200, fromName: 'Coder', toName: 'Reviewer', kind: 'review', text: 'Check diff' },
      { seq: 2, at: 250, fromName: 'Reviewer', toName: 'Coder', kind: 'review', text: 'Fix edge case' },
      { seq: 3, at: 280, fromName: 'Coder', toName: 'Reviewer', kind: 'review', text: 'Fixed, recheck' },
      { seq: 4, at: 290, fromName: 'Reviewer', toName: 'Coder', kind: 'review', text: 'LGTM sk-ant-api03-1234567890abcdef1234567890abcdef' },
    ],
  }
  const records = collectPairRecords({
    members: ['bot_planner', 'bot_coder', 'bot_reviewer'],
    readBook: name => books[name] ?? [],
    sinceAt: 50,
    untilAt: 500,
  })
  assert.equal(records.length, 6)
  assert.equal(records[0].from, 'Planner')
  assert.equal(records[4].text, '[redacted-secret]')

  const routing = summarizeRouting(
    [
      { seq: 1, at: 50, from: 'user', text: 'Ship feature' },
      { seq: 2, at: 350, from: 'Planner', text: 'All checks pass' },
    ],
    records,
  )
  assert.equal(routing.interBotCount, 6)
  assert.equal(routing.loopCount, 2)
  assert.deepEqual(routing.uniqueBots, ['Coder', 'Planner', 'Reviewer'])
  assert.deepEqual(routing.handoffSequence, ['user', 'Planner', 'Coder', 'Reviewer', 'Coder', 'Reviewer', 'Coder', 'Planner'])
})

test('buildGroupTrace + saveGroupTrace persist project context, interactions, inter-bot trace, and index.jsonl', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-group-trace-'))
  try {
    const room = {
      id: 'room-1plus1',
      name: '1+1 Routing',
      goal: 'Ship closed-loop decisions',
      members: ['b1', 'b2'],
      tasks: {
        t1: { id: 't1', botId: 'b1', goal: 'Implement broker API', status: 'done', progress: '', result: '19/19 passed', startedAt: 100, updatedAt: 200 },
        t2: { id: 't2', botId: 'b2', goal: 'Deploy to EC2', status: 'active', progress: 'queued', startedAt: 210, updatedAt: 220 },
      },
    }
    const trace = buildGroupTrace({
      room,
      bot: { id: 'b1', name: 'Coder' },
      agentId: 'sess-b1',
      reason: 'daily-sweep',
      tokens: 18400,
      note: 'Implemented /decisions',
      kevDecision: { action: 'switch', pSwitch: 0.84, confident: true, factors: { pAction: 0.9, pSkip: 0.05, pWait: 0.02, pNext: 0.01 } },
      workDir: '/Users/chief/ds-bot-dev/src',
      groupRows: [{ seq: 1, at: 110, botId: 'b1', from: 'Coder', text: 'Updated broker.py' }],
      pairRecords: [{ pair: 'pair-b1-b2', seq: 1, at: 150, from: 'Coder', to: 'Reviewer', kind: 'request', text: 'Review commit' }],
      startedAt: 90,
      endedAt: 300,
      botNameOf: id => (id === 'b1' ? 'Coder' : 'Reviewer'),
    })
    assert.equal(trace.schema, 'ds-bot/group-trace/v1')
    assert.equal(trace.project.completedTasks.length, 1)
    assert.equal(trace.project.openTasks.length, 1)
    assert.deepEqual(trace.kevDecision.factors, { pAction: 0.9, pSkip: 0.05, pWait: 0.02, pNext: 0.01 })

    const saved = await saveGroupTrace({ home, trace })
    const dir = join(home, 'memory', 'groups', 'room-1plus1', 'traces')
    const files = readdirSync(dir)
    assert.ok(files.some(name => name.endsWith(`${trace.traceId}.json`)))
    const indexRows = readFileSync(saved.indexFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(indexRows.length, 1)
    assert.equal(indexRows[0].roomName, '1+1 Routing')
    assert.equal(indexRows[0].interBotCount, 1)
    assert.equal(indexRows[0].completedTaskCount, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('createRuntime isRoomBusy blocks rotation while busy and sweepIdleParts writes durable group trace on switch', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-parts-trace-'))
  const team = {
    version: 1,
    mainBotIds: ['b_plan'],
    revision: 1,
    bots: {
      b_plan: { id: 'b_plan', sessionId: 'b_plan', name: 'Planner', role: 'Planning', instructions: '', createdAt: 1 },
      b_code: { id: 'b_code', sessionId: 'b_code', name: 'Coder', role: '', instructions: '', createdAt: 1 },
    },
    rooms: {
      room_1p1: {
        id: 'room_1p1',
        name: '1+1 Routing',
        named: true,
        members: ['b_plan', 'b_code'],
        admin: 'b_plan',
        mode: 'admin',
        notice: '',
        createdAt: 100,
        sessionId: 'room_1p1',
        sessions: { b_plan: 's_plan_room', b_code: 's_code_room' },
        tasks: {
          t1: { id: 't1', botId: 'b_code', goal: 'Fix bug', status: 'active', startedAt: 110, updatedAt: 120, progress: 'editing' },
        },
      },
    },
    exchanges: [],
    exchangeTurns: {},
    questions: {},
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const dshEvents = [
    { type: 'user/message', seq: 1, time: 120, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Planner, ask Coder to fix the bug.' }] } },
    { type: 'assistant/message', seq: 2, time: 130, data: { message: { content: [{ type: 'text', text: 'Done: fixed bug and 32/32 tests pass.' }] } } },
    { type: 'turn/end', seq: 3, time: 140 },
  ]
  const makeSession = (id) => ({
    id,
    seq: dshEvents.length,
    header: { cwd: home },
    snapshotEvents: () => dshEvents,
    eventAt: i => dshEvents[i],
    estimateTokens: () => 5000,
    deriveMessages: () => [
      { role: 'user', content: [{ type: 'text', text: 'Fix bug' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Fixed bug, 32/32 pass.' }] },
    ],
    requestHeader: () => ({ config: { provider: 'mock', model: 'mock-model' } }),
    toolHistory: () => [],
  })
  const makeAgent = (id) => ({
    id,
    session: makeSession(id),
    inbox: { nextStep: [], nextTurn: [] },
    whenIdle: async () => {},
    runMaintenance: async fn => fn(new AbortController().signal),
    followup: () => {},
  })
  const agentsMap = new Map([
    ['s_plan_room', makeAgent('s_plan_room')],
    ['s_code_room', makeAgent('s_code_room')],
  ])
  const sessionsSvc = {
    get: id => agentsMap.get(id)?.session,
    flush: async () => {},
    query: async () => ({ records: dshEvents.map(event => ({ event })), hasMore: false }),
  }
  const ctx = fakeContext({
    services: {
      agents: agentsMap,
      sessions: sessionsSvc,
      llm: { resolveModelInfo: async () => undefined },
    },
  })
  ctx.sessions = sessionsSvc
  ctx.llm.resolveModelInfo = async () => undefined
  ctx.sessionController = {
    page: async () => ({ records: dshEvents.map(event => ({ event })), hasMore: false }),
  }
  const registry = await dshRegistry(t, join(home, 'dsh'), ['b_plan', 'b_code', 'room_1p1', 's_plan_room', 's_code_room'], ctx)
  ctx.workspaceRegistry = registry
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  await rt.load()

  rt.resolveAgent = async id => agentsMap.get(id) ?? makeAgent(id)
  rt.createSession = async () => `s_fresh_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`
  rt.selectSessionModel = async () => {}
  rt.ensureCapabilities = async () => {}
  rt.applyPermission = async () => {}
  const fullNote = [
    '## Goals\nFix bug in group room',
    '## Constraints and preferences\nNone',
    '## Progress\nDone: Fixed bug; In progress: None; Blocked: None',
    '## Decisions\nDone',
    '## Facts to keep\n32/32 tests passed',
    '## Open threads\n(none)',
    '## Next step\n(none)',
    '## Where to look\n(none)',
  ].join('\n\n')
  rt.assembleLlm = async () => ({
    finish: { kind: 'stop' },
    blocks: () => [{ type: 'text', text: fullNote }],
  })
  rt.ledger.append(pairBookName('b_code', 'b_plan'), {
    at: 125,
    fromName: 'Planner',
    toName: 'Coder',
    kind: 'request',
    text: 'Fix bug',
  })
  rt.kevSteward = async () => ({
    action: 'switch',
    pSwitch: 0.88,
    confident: true,
    factors: { pAction: 0.92, pSkip: 0.02, pWait: 0.01, pNext: 0.01 },
  })

  const room = rt.roomOf('room_1p1')
  assert.equal(rt.isRoomBusy(room), true, 'active room task marks room busy')

  // Clear open task, set active roomProgress -> still busy
  room.tasks.t1.status = 'done'
  room.tasks.t1.result = 'Fixed and verified'
  rt.roomProgress.set('round-1', { roomId: room.id, slots: [] })
  assert.equal(rt.isRoomBusy(room), true, 'active roomProgress marks room busy')

  // Busy sweep skips room
  const busySweep = await rt.sweepIdleParts({ minMessages: 1, minTokens: 0, idleMs: 0, now: 10_000 })
  assert.deepEqual(busySweep, [])

  // Idle sweep rotates room member parts and writes durable trace + index.jsonl
  rt.roomProgress.clear()
  assert.equal(rt.isRoomBusy(room), false)
  const idleSweep = await rt.sweepIdleParts({ minMessages: 2, minTokens: 0, idleMs: 1_000, now: 100_000 })
  assert.ok(idleSweep.length >= 1, 'idle room rotated')
  for (let i = 0; i < 60 && [...rt.switchJobs()].length > 0; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  await new Promise(resolve => setTimeout(resolve, 50))

  const traceDir = join(home, 'memory', 'groups', room.id, 'traces')
  const traceFiles = readdirSync(traceDir).filter(f => f.endsWith('.json'))
  assert.ok(traceFiles.length >= 1, 'trace JSON written after group moveOn')
  const savedTrace = JSON.parse(readFileSync(join(traceDir, traceFiles[0]), 'utf8'))
  assert.equal(savedTrace.roomName, '1+1 Routing')
  assert.equal(savedTrace.reason, 'daily-sweep')
  assert.equal(savedTrace.interBotTrace.length, 1)
  assert.equal(savedTrace.project.completedTasks.length, 1)
  assert.equal(savedTrace.kevDecision.pSwitch, 0.88)
})
