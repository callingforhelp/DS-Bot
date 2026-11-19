import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { stepRouteDecision } from '../src/host/models.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Lead', model: 'liftgate/gemini-pro-orchestrator-g1-pro', appliedModel: 'liftgate/gemini-pro-orchestrator-g1-pro', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Builder', role: 'Code', model: 'deepseek/v4', appliedModel: 'deepseek/v4', executorModel: 'deepseek/v4-lite', instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function start(team = TEAM, { providers } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-1plus1-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const catalogMap = providers ?? {
    liftgate: [
      { id: 'gemini-pro-orchestrator-g1-pro', name: 'Orchestrator (Argon)' },
      { id: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen (High)' },
    ],
    deepseek: [
      { id: 'v4', name: 'DeepSeek V4' },
      { id: 'v4-lite', name: 'DeepSeek V4 Lite' },
    ],
  }
  const calls = []
  const workspaces = new Map()
  let sessions = 0
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: {
      listProviders: () => Object.keys(catalogMap).map(id => ({ id, name: id })),
      listModels: async provider => catalogMap[provider] ?? [],
      resolveModelInfo: async () => ({}),
      stream(options) {
        const chain = ctx.listeners.get('llm/stream') ?? []
        const run = index => (index < chain.length ? chain[index](options, () => run(index + 1)) : (async function* () {
          calls.push({ provider: options.provider, model: options.model })
          yield { type: 'finish', reason: { kind: 'stop' } }
        })())
        return run(0)
      },
    },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async path => [...workspaces.values()].find(workspace => workspace.path === path),
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId, seq: 1 }, ctx: { tools: { register: () => () => {} } }, followup: () => {} } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, calls, tool, state, stop }
}

async function drain(stream) {
  for await (const chunk of stream) assert.ok(chunk)
}

test('stepRouteDecision handles Step 1 planning, executor continuation, 2-error review, and cadence review', () => {
  const user = { role: 'user', content: [{ type: 'text', text: 'Implement feature' }] }
  const okTool = { role: 'tool', isError: false, content: [{ type: 'text', text: 'ok' }] }
  const errTool = { role: 'tool', isError: true, content: [{ type: 'text', text: 'fail' }] }
  const assistant = { role: 'assistant', content: [] }

  assert.deepEqual(stepRouteDecision([user]), { role: 'planner', reason: 'initial-plan', step: 0, consecutiveErrors: 0 })
  assert.deepEqual(stepRouteDecision([user, assistant, okTool]), { role: 'executor', reason: 'continuation', step: 1, consecutiveErrors: 0 })
  assert.deepEqual(stepRouteDecision([user, assistant, okTool, okTool]), { role: 'executor', reason: 'continuation', step: 1, consecutiveErrors: 0 })
  assert.deepEqual(stepRouteDecision([user, assistant, errTool]), { role: 'executor', reason: 'continuation', step: 1, consecutiveErrors: 1 })
  assert.deepEqual(stepRouteDecision([user, assistant, errTool, assistant, errTool]), { role: 'planner', reason: 'error-review', step: 2, consecutiveErrors: 2 })
  assert.deepEqual(stepRouteDecision([user, assistant, errTool, assistant, errTool, assistant, okTool]), { role: 'executor', reason: 'continuation', step: 3, consecutiveErrors: 0 })
  assert.deepEqual(stepRouteDecision([user, assistant, errTool, assistant, errTool, assistant, errTool]), { role: 'executor', reason: 'continuation', step: 3, consecutiveErrors: 1 })

  assert.deepEqual(stepRouteDecision([user, assistant, okTool, assistant, okTool], { reviewCadence: 3 }), { role: 'executor', reason: 'continuation', step: 2, consecutiveErrors: 0 })
  assert.deepEqual(stepRouteDecision([user, assistant, okTool, assistant, okTool, assistant, okTool], { reviewCadence: 3 }), { role: 'planner', reason: 'cadence-review', step: 3, consecutiveErrors: 0 })
  assert.deepEqual(stepRouteDecision([user, assistant, okTool, assistant, okTool, assistant, okTool, assistant, okTool], { reviewCadence: 3 }), { role: 'executor', reason: 'continuation', step: 4, consecutiveErrors: 0 })
})

test('llm/stream auto-pairs orchestrator models with Hydrogen, injects bridge rule, and hands back on 2 errors', async (t) => {
  const { ctx, calls, tool, stop } = start()
  t.after(stop)
  await tool('list_bots', {}, 'm1')

  const promptText = ctx.sections.get('bot-identity').text({ agent: { id: 'm1' } })
  assert.match(promptText, /Antigravity Orchestrator Bridge Rule/)
  assert.match(promptText, /exit_plan_mode/)
  assert.doesNotMatch(ctx.sections.get('bot-identity').text({ agent: { id: 'b2' } }), /Antigravity Orchestrator Bridge Rule/)

  const user = { role: 'user', content: [{ type: 'text', text: 'Plan and run' }] }
  const assistant = { role: 'assistant', content: [] }
  const okTool = { role: 'tool', isError: false, content: [{ type: 'text', text: 'ok' }] }
  const errTool = { role: 'tool', isError: true, content: [{ type: 'text', text: 'err' }] }

  await drain(ctx.llm.stream({ sessionId: 'm1', provider: 'liftgate', model: 'gemini-pro-orchestrator-g1-pro', messages: [user] }))
  await drain(ctx.llm.stream({ sessionId: 'm1', provider: 'liftgate', model: 'gemini-pro-orchestrator-g1-pro', messages: [user, assistant, okTool] }))
  await drain(ctx.llm.stream({ sessionId: 'm1', provider: 'liftgate', model: 'gemini-pro-orchestrator-g1-pro', messages: [user, assistant, errTool, assistant, errTool] }))
  await drain(ctx.llm.stream({ sessionId: 'b2', provider: 'deepseek', model: 'v4', messages: [user, assistant, okTool] }))

  assert.deepEqual(calls, [
    { provider: 'liftgate', model: 'gemini-pro-orchestrator-g1-pro' },
    { provider: 'liftgate', model: 'gemini-4-hydrogen-high' },
    { provider: 'liftgate', model: 'gemini-pro-orchestrator-g1-pro' },
    { provider: 'deepseek', model: 'v4-lite' },
  ])
})

test('create_bot and update_bot set, list, and clear executor_model', async (t) => {
  const { tool, state, stop } = start()
  t.after(stop)

  const created = await tool('create_bot', {
    name: 'Planner',
    role: 'Plan',
    instructions: 'Plan first.',
    model: 'deepseek/v4',
    executor_model: 'deepseek/v4-lite',
  }, 'm1')
  assert.match(created, /^Created Planner/)
  const planner = Object.values(state().bots).find(bot => bot.name === 'Planner')
  assert.equal(planner.model, 'deepseek/v4')
  assert.equal(planner.executorModel, 'deepseek/v4-lite')

  const list = await tool('list_bots', { bot: 'Planner' }, 'm1')
  assert.match(list, /executor deepseek\/v4-lite/)

  assert.equal(await tool('update_bot', { bot: 'Planner', executor_model: 'liftgate/gemini-4-hydrogen-high' }, 'm1'), 'Updated Planner.')
  assert.equal(state().bots[planner.id].executorModel, 'liftgate/gemini-4-hydrogen-high')

  assert.equal(await tool('update_bot', { bot: 'Planner', executor_model: '' }, 'm1'), 'Updated Planner.')
  assert.equal('executorModel' in state().bots[planner.id], false)
})

test('Argon models fall back to Orchestrator (Neon) when absent from catalog and still pair with Hydrogen', async (t) => {
  const { ctx, rt, tool, stop } = start({
    ...TEAM,
    bots: {
      m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Lead', model: 'liftgate/gemini-pro-orchestrator-g1-pro', appliedModel: 'deepseek/v4', instructions: '', createdAt: 1 },
      b2: { id: 'b2', sessionId: 'b2', name: 'ArgonDirect', role: 'Plan', model: 'liftgate/gemini-4-argon-high', instructions: '', createdAt: 2 },
    },
  }, {
    providers: {
      liftgate: [
        { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
        { id: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen (High)' },
      ],
      deepseek: [
        { id: 'v4', name: 'DeepSeek V4' },
      ],
    },
  })
  t.after(stop)
  await tool('list_bots', {}, 'm1')

  assert.equal(await rt.desiredModel({ model: 'liftgate/gemini-pro-orchestrator-g1-pro', appliedModel: 'deepseek/v4' }), 'liftgate/gemini-pro-orchestrator-neon')
  assert.equal(await rt.desiredModel({ model: 'liftgate/gemini-4-argon-high' }), 'liftgate/gemini-pro-orchestrator-neon')
  assert.equal(await rt.desiredExecutorModel({ model: 'liftgate/gemini-4-argon-high' }), 'liftgate/gemini-4-hydrogen-high')
  assert.match(ctx.sections.get('bot-identity').text({ agent: { id: 'b2' } }), /Antigravity Orchestrator Bridge Rule/)
})

test('llm/stream transparently falls back from Argon to Orchestrator (Neon) on pre-output error or throw', async (t) => {
  const { ctx, calls, tool, stop } = start(TEAM, {
    providers: {
      liftgate: [
        { id: 'gemini-pro-orchestrator-g1-pro', name: 'Orchestrator (Argon)' },
        { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
        { id: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen (High)' },
      ],
    },
  })
  t.after(stop)
  await tool('list_bots', {}, 'm1')

  let mode = 'error-finish'
  ctx.llm.stream = (options) => {
    const chain = ctx.listeners.get('llm/stream') ?? []
    const run = index => (index < chain.length ? chain[index](options, () => run(index + 1)) : (async function* () {
      calls.push({ provider: options.provider, model: options.model })
      if (options.model === 'gemini-pro-orchestrator-g1-pro') {
        if (mode === 'error-finish') {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'Argon quota exhausted' } } }
          return
        }
        if (mode === 'throw') throw new Error('Argon quota exhausted')
        if (mode === 'mid-stream-error') {
          yield { type: 'text-delta', index: 0, text: 'partial' }
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'mid-stream drop' } } }
          return
        }
      }
      yield { type: 'text-delta', index: 0, text: `ok:${options.model}` }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })())
    return run(0)
  }

  const collect = async (stream) => {
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    return chunks
  }

  const user = { role: 'user', content: [{ type: 'text', text: 'Plan and run' }] }

  const finishFallback = await collect(ctx.llm.stream({ sessionId: 'm1', provider: 'liftgate', model: 'gemini-pro-orchestrator-g1-pro', messages: [user] }))
  assert.deepEqual(finishFallback.map(chunk => chunk.type), ['text-delta', 'finish'])
  assert.equal(finishFallback[0].text, 'ok:gemini-pro-orchestrator-neon')

  mode = 'throw'
  const throwFallback = await collect(ctx.llm.stream({ sessionId: 'm1', provider: 'liftgate', model: 'gemini-pro-orchestrator-g1-pro', messages: [user] }))
  assert.deepEqual(throwFallback.map(chunk => chunk.type), ['text-delta', 'finish'])
  assert.equal(throwFallback[0].text, 'ok:gemini-pro-orchestrator-neon')

  mode = 'mid-stream-error'
  const partialError = await collect(ctx.llm.stream({ sessionId: 'm1', provider: 'liftgate', model: 'gemini-pro-orchestrator-g1-pro', messages: [user] }))
  assert.deepEqual(partialError.map(chunk => chunk.type), ['text-delta', 'finish'])
  assert.equal(partialError[0].text, 'partial')
  assert.equal(partialError[1].reason.kind, 'error')

  assert.deepEqual(calls, [
    { provider: 'liftgate', model: 'gemini-pro-orchestrator-g1-pro' },
    { provider: 'liftgate', model: 'gemini-pro-orchestrator-neon' },
    { provider: 'liftgate', model: 'gemini-pro-orchestrator-g1-pro' },
    { provider: 'liftgate', model: 'gemini-pro-orchestrator-neon' },
    { provider: 'liftgate', model: 'gemini-pro-orchestrator-g1-pro' },
  ])
})
