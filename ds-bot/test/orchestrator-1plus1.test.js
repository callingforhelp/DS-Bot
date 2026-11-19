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

function start(team = TEAM, { providers, failureFor } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-1plus1-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const catalogMap = providers ?? {
    liftgate: [
      { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
      { id: 'gemini-pro-orchestrator-g1-pro', name: 'Orchestrator (Argon)' },
      { id: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen (High)' },
    ],
    deepseek: [
      { id: 'v4', name: 'DeepSeek V4' },
      { id: 'v4-lite', name: 'DeepSeek V4 Lite' },
    ],
  }
  const calls = []
  const requests = []
  const deliveries = []
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
          requests.push(options)
          const failure = failureFor?.(options)
          yield { type: 'finish', reason: failure === undefined ? { kind: 'stop' } : { kind: 'error', failure } }
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
      resolveAgent: async sessionId => {
        const enqueue = message => deliveries.push({ sessionId, message })
        return { agent: { id: sessionId, session: { id: sessionId, seq: 1 }, ctx: { tools: { register: () => () => {} } }, followup: enqueue, steer: enqueue } }
      },
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
  return { ctx, rt, calls, requests, deliveries, tool, state, stop }
}

async function drain(stream) {
  for await (const chunk of stream) assert.ok(chunk)
}

const toolCall = (id, name) => ({ role: 'assistant', content: [{ type: 'tool-call', id, name, arguments: '{}' }] })
const toolResult = (toolCallId, isError = false) => ({ role: 'tool', toolCallId, isError, content: [{ type: 'text', text: 'result' }] })

test('stepRouteDecision handles Step 1 planning, executor continuation, 2-error review, and cadence review', () => {
  const user = { role: 'user', content: [{ type: 'text', text: 'Implement feature' }] }
  const okTool = toolResult('edit')
  const errTool = toolResult('edit', true)
  const assistant = toolCall('edit', 'edit')

  assert.deepEqual(stepRouteDecision([user]), { role: 'planner', reason: 'initial-plan', step: 0, consecutiveErrors: 0 })
  assert.deepEqual(stepRouteDecision([user, assistant, okTool]), { role: 'executor', reason: 'continuation', step: 1, consecutiveErrors: 0 })
  assert.deepEqual(stepRouteDecision([user, assistant, okTool, okTool]), { role: 'executor', reason: 'continuation', step: 1, consecutiveErrors: 0 })
  assert.deepEqual(stepRouteDecision([user, assistant, errTool]), { role: 'executor', reason: 'continuation', step: 1, consecutiveErrors: 1 })
  assert.deepEqual(stepRouteDecision([user, assistant, errTool, assistant, errTool]), { role: 'planner', reason: 'error-review', step: 2, consecutiveErrors: 2 })
  const clock = { role: 'user', source: { kind: 'ds-bot-time-context' } }
  assert.deepEqual(stepRouteDecision([user, assistant, errTool, clock, assistant, errTool]), { role: 'planner', reason: 'error-review', step: 2, consecutiveErrors: 2 })
  assert.deepEqual(stepRouteDecision([user, assistant, errTool, assistant, errTool, assistant, okTool]), { role: 'executor', reason: 'continuation', step: 3, consecutiveErrors: 0 })
  assert.deepEqual(stepRouteDecision([user, assistant, errTool, assistant, errTool, assistant, errTool]), { role: 'executor', reason: 'continuation', step: 3, consecutiveErrors: 1 })

  assert.deepEqual(stepRouteDecision([user, assistant, okTool, assistant, okTool], { reviewCadence: 3 }), { role: 'executor', reason: 'continuation', step: 2, consecutiveErrors: 0 })
  assert.deepEqual(stepRouteDecision([user, assistant, okTool, assistant, okTool, assistant, okTool], { reviewCadence: 3 }), { role: 'planner', reason: 'cadence-review', step: 3, consecutiveErrors: 0 })
  assert.deepEqual(stepRouteDecision([user, assistant, okTool, assistant, okTool, assistant, okTool, assistant, okTool], { reviewCadence: 3 }), { role: 'executor', reason: 'continuation', step: 4, consecutiveErrors: 0 })
})

test('stepRouteDecision keeps routing history across context injected mid-turn', () => {
  const user = { role: 'user', content: [{ type: 'text', text: 'Implement feature' }] }
  const assistant = toolCall('edit', 'edit')
  const okTool = toolResult('edit')
  const errTool = toolResult('edit', true)
  const memory = { role: 'user', source: { kind: 'ds-bot-memory-update', form: 'snapshot', sections: [] } }
  const jobs = { role: 'user', source: { kind: 'tool-jobs', form: 'notice', summary: 'bash done' } }
  const settled = { role: 'user', source: { kind: 'subagent-settled', form: 'notice', summary: 'done' } }
  const reminder = { role: 'user', source: { kind: 'repeat-tool-reminder', form: 'notice', summary: 'repeat' } }

  for (const context of [memory, jobs, settled, reminder]) {
    assert.deepEqual(stepRouteDecision([user, assistant, okTool, context]), { role: 'executor', reason: 'continuation', step: 1, consecutiveErrors: 0 }, context.source.kind)
    assert.deepEqual(stepRouteDecision([user, assistant, errTool, context, assistant, errTool]), { role: 'planner', reason: 'error-review', step: 2, consecutiveErrors: 2 }, context.source.kind)
  }
  assert.deepEqual(stepRouteDecision([user, assistant, okTool, assistant, okTool, jobs, assistant, okTool], { reviewCadence: 3 }), { role: 'planner', reason: 'cadence-review', step: 3, consecutiveErrors: 0 })
  const developer = { role: 'developer', content: [{ type: 'text', text: 'note' }] }
  const clock = { role: 'user', source: { kind: 'ds-bot-time-context', form: 'snapshot', sections: [] } }
  assert.deepEqual(stepRouteDecision([user, assistant, okTool, developer, clock]), { role: 'executor', reason: 'continuation', step: 1, consecutiveErrors: 0 })
  assert.deepEqual(stepRouteDecision([user, assistant, okTool, developer, memory]), { role: 'executor', reason: 'continuation', step: 1, consecutiveErrors: 0 })

  // A notice that opens a turn after the model's answer, and a user steer, start a new task.
  const answer = { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }
  assert.deepEqual(stepRouteDecision([user, assistant, okTool, answer, jobs]), { role: 'planner', reason: 'initial-plan', step: 0, consecutiveErrors: 0 })
  assert.deepEqual(stepRouteDecision([user, assistant, okTool, { role: 'user', source: { kind: 'user' } }]), { role: 'planner', reason: 'initial-plan', step: 0, consecutiveErrors: 0 })
})

test('stepRouteDecision treats terminal input and editor changes as execution, and editor views as reads', () => {
  const user = { role: 'user', content: [{ type: 'text', text: 'Implement feature' }] }
  const editor = (id, command) => ({ role: 'assistant', content: [{ type: 'tool-call', id, name: 'str_replace_editor', arguments: JSON.stringify({ command, path: 'a.txt' }) }] })
  assert.equal(stepRouteDecision([user, toolCall('t', 'terminal_send'), toolResult('t')]).role, 'executor')
  assert.equal(stepRouteDecision([user, editor('e', 'str_replace'), toolResult('e')]).role, 'executor')
  assert.deepEqual(stepRouteDecision([user, editor('v', 'view'), toolResult('v')]), { role: 'planner', reason: 'inspection', step: 1, consecutiveErrors: 0 })
})

test('llm/stream keeps reads on Argon, sends execution continuations to Neon, and hands back on 2 errors', async (t) => {
  const { ctx, calls, tool, stop } = start()
  t.after(stop)
  await tool('list_bots', {}, 'm1')

  const promptText = ctx.sections.get('bot-identity').text({ agent: { id: 'm1' } })
  assert.match(promptText, /Antigravity Orchestrator Bridge Rule/)
  assert.match(promptText, /exit_plan_mode/)
  assert.doesNotMatch(ctx.sections.get('bot-identity').text({ agent: { id: 'b2' } }), /Antigravity Orchestrator Bridge Rule/)

  const user = { role: 'user', content: [{ type: 'text', text: 'Plan and run' }] }
  const assistant = toolCall('edit', 'edit')
  const okTool = toolResult('edit')
  const errTool = toolResult('edit', true)

  await drain(ctx.llm.stream({ sessionId: 'm1', provider: 'liftgate', model: 'gemini-pro-orchestrator-g1-pro', messages: [user] }))
  const inspected = [user, toolCall('read', 'read'), toolResult('read')]
  await drain(ctx.llm.stream({ sessionId: 'm1', provider: 'liftgate', model: 'gemini-pro-orchestrator-g1-pro', messages: inspected }))
  await drain(ctx.llm.stream({ sessionId: 'm1', provider: 'liftgate', model: 'gemini-pro-orchestrator-g1-pro', messages: [...inspected, assistant, okTool] }))
  await drain(ctx.llm.stream({ sessionId: 'm1', provider: 'liftgate', model: 'gemini-pro-orchestrator-g1-pro', messages: [user, assistant, errTool, assistant, errTool] }))
  await drain(ctx.llm.stream({ sessionId: 'b2', provider: 'deepseek', model: 'v4', messages: [user, assistant, okTool] }))

  assert.deepEqual(calls, [
    { provider: 'liftgate', model: 'gemini-pro-orchestrator-g1-pro' },
    { provider: 'liftgate', model: 'gemini-pro-orchestrator-g1-pro' },
    { provider: 'liftgate', model: 'gemini-pro-orchestrator-neon' },
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
  assert.equal(state().bots[planner.id].executorModel, null)
})

test('explicit executor opt-out survives updates and copies', async (t) => {
  const { rt, tool, state, stop } = start()
  t.after(stop)
  await tool('list_bots', {}, 'm1')
  await rt.updateBot('m1', { executorModel: null })
  assert.equal(state().bots.m1.executorModel, null)
  assert.equal(await rt.desiredExecutorModel(state().bots.m1), undefined)
  const copy = await rt.duplicateBot('m1')
  assert.equal(state().bots[copy.id].executorModel, null)
  const created = await rt.createBot({ name: 'Opt out', model: 'liftgate/gemini-pro-orchestrator-g1-pro', executorModel: null })
  assert.equal(state().bots[created.id].executorModel, null)
  await rt.updateBot('m1', { executorModel: 'auto' })
  assert.equal('executorModel' in state().bots.m1, false)
  assert.equal(await rt.desiredExecutorModel(state().bots.m1), 'liftgate/gemini-pro-orchestrator-neon')
  const auto = await rt.createBot({ name: 'Auto', model: 'liftgate/gemini-pro-orchestrator-g1-pro', executorModel: 'auto' })
  assert.equal('executorModel' in state().bots[auto.id], false)
})

test('a Bot on a local agent drops an executor it kept, so it can still be copied', async (t) => {
  const { rt, tool, state, stop } = start({
    ...TEAM,
    bots: {
      ...TEAM.bots,
      l1: { id: 'l1', sessionId: 'l1', name: 'Local', model: 'local-codex-cli/gpt-5.1-codex', appliedModel: 'local-codex-cli/gpt-5.1-codex', executorModel: 'deepseek/v4-lite', createdAt: 3 },
    },
  }, {
    providers: {
      liftgate: [{ id: 'gemini-pro-orchestrator-g1-pro' }, { id: 'gemini-pro-orchestrator-neon' }],
      deepseek: [{ id: 'v4' }, { id: 'v4-lite' }],
      'local-codex-cli': [{ id: 'gpt-5.1-codex' }],
    },
  })
  t.after(stop)
  // The fake context has no local agent adapter to register the CLI's route.
  rt.isLocalAgentAvailable = () => true
  await tool('list_bots', {}, 'm1')
  const copy = await rt.duplicateBot('l1')
  assert.equal(state().bots[copy.id].model, 'local-codex-cli/gpt-5.1-codex')
  assert.equal('executorModel' in state().bots[copy.id], false)

  await rt.updateBot('b2', { model: 'local-codex-cli/gpt-5.1-codex', changeEngine: true })
  assert.equal('executorModel' in state().bots.b2, false)
})

test('a Planner coding handoff and a Coder review handoff reach separate Sessions', async (t) => {
  const { ctx, calls, deliveries, tool, stop } = start({
    ...TEAM,
    bots: {
      ...TEAM.bots,
      p1: { id: 'p1', sessionId: 'p1', name: 'Planner', model: 'liftgate/gemini-pro-orchestrator-g1-pro', executorModel: null, createdAt: 3 },
      c1: { id: 'c1', sessionId: 'c1', name: 'Coder', model: 'liftgate/gemini-pro-orchestrator-neon', createdAt: 4, botResponse: { mode: 'selected', allow: ['p1'] }, responsibility: { preset: 'coding', categories: ['coding'] } },
      r1: { id: 'r1', sessionId: 'r1', name: 'Reviewer', model: 'review/gpt-6.2-sol', createdAt: 5, botResponse: { mode: 'selected', allow: ['c1'] }, responsibility: { preset: 'reviewer', categories: ['review'] } },
    },
  }, {
    providers: {
      liftgate: [{ id: 'gemini-pro-orchestrator-g1-pro' }, { id: 'gemini-pro-orchestrator-neon' }],
      review: [{ id: 'gpt-6.2-sol' }],
      deepseek: [{ id: 'v4' }, { id: 'v4-lite' }],
    },
  })
  t.after(stop)
  await tool('list_bots', {}, 'p1')

  const read = [{ role: 'user' }, toolCall('read', 'read'), toolResult('read')]
  await drain(ctx.llm.stream({ sessionId: 'p1', provider: 'liftgate', model: 'gemini-pro-orchestrator-g1-pro', messages: read }))
  assert.equal(deliveries.length, 0)
  const task = { to: 'Coder', message: 'Change the exact line reviewed in input.txt.', task_category: 'coding', request_id: 'change-input' }
  await assert.rejects(tool('message_bot', task, 'm1'), /recipient-not-selected/)
  assert.match(await tool('message_bot', task, 'p1'), /Delivered to Coder/)
  assert.equal(deliveries[0].message.source.routing.category, 'coding')
  await drain(ctx.llm.stream({ sessionId: deliveries[0].sessionId, provider: 'liftgate', model: 'gemini-pro-orchestrator-neon', messages: [deliveries[0].message] }))

  assert.match(await tool('message_bot', { to: 'Reviewer', message: 'Review the input.txt diff and check the recorded result.', task_category: 'review' }, 'c1'), /Delivered to Reviewer/)
  assert.equal(deliveries[1].message.source.routing.category, 'review')
  await drain(ctx.llm.stream({ sessionId: deliveries[1].sessionId, provider: 'review', model: 'gpt-6.2-sol', messages: [deliveries[1].message] }))
  assert.deepEqual(deliveries.map(({ sessionId }) => sessionId), ['c1', 'r1'])
  assert.deepEqual(calls, [
    { provider: 'liftgate', model: 'gemini-pro-orchestrator-g1-pro' },
    { provider: 'liftgate', model: 'gemini-pro-orchestrator-neon' },
    { provider: 'review', model: 'gpt-6.2-sol' },
  ])
})

test('executor does not inherit an unsupported planner reasoning effort', async (t) => {
  const { ctx, requests, tool, stop } = start()
  t.after(stop)
  await tool('list_bots', {}, 'm1')
  const messages = [{ role: 'user' }, toolCall('edit', 'edit'), toolResult('edit')]
  await drain(ctx.llm.stream({ sessionId: 'm1', provider: 'liftgate', model: 'gemini-pro-orchestrator-g1-pro', reasoningEffort: 'high', messages }))
  assert.equal(requests.at(-1).model, 'gemini-pro-orchestrator-neon')
  assert.equal(requests.at(-1).reasoningEffort, undefined)
})

test('an executor or fallback refusal leaves the planner available', async (t) => {
  for (const scenario of ['executor', 'fallback']) await t.test(scenario, async (t) => {
    const planner = 'gemini-pro-orchestrator-g1-pro'
    const neon = 'gemini-pro-orchestrator-neon'
    const refusal = { code: 'HOSTED_ENGINE_ROUTE', message: 'Not a model endpoint' }
    let failPlanner = scenario === 'fallback'
    const { ctx, rt, tool, calls, stop } = start(TEAM, {
      failureFor: ({ model }) => model === neon ? refusal : failPlanner ? { code: 'QUOTA', message: 'Argon quota exhausted' } : undefined,
    })
    t.after(stop)
    await tool('list_bots', {}, 'm1')
    const refused = t.mock.method(rt, 'routeRefused')
    const config = { provider: 'liftgate', model: planner }
    const session = { id: 'm1', requestHeader: () => ({ config }) }
    const emit = (type, data) => {
      for (const listener of ctx.listeners.get('session/event') ?? []) listener(session, { type, data })
    }
    const user = { role: 'user' }
    const messages = [user, toolCall('edit', 'edit'), toolResult('edit')]

    emit('turn/start', { turn: 1 })
    const input = scenario === 'executor' ? messages : [user]
    await drain(ctx.llm.stream({ ...config, sessionId: session.id, messages: input }))
    assert.equal(calls.at(-1).model, neon)
    emit('turn/end', { turn: 1, reason: { kind: 'error', error: refusal } })
    assert.equal(refused.mock.calls[0]?.arguments[0], `liftgate/${neon}`)
    await refused.mock.calls[0].result

    assert.equal(rt.botOf('m1').model, `liftgate/${planner}`)
    assert.equal(rt.botOf('m1').appliedModel, `liftgate/${planner}`)
    assert.equal(await rt.desiredExecutorModel(rt.botOf('m1')), undefined)
    assert.equal((await rt.catalog()).some(entry => entry.ref === `liftgate/${neon}`), false)
    failPlanner = false
    await drain(ctx.llm.stream({ ...config, sessionId: session.id, messages }))
    assert.equal(calls.at(-1).model, planner)
  })
})

test('Argon models fall back to Orchestrator (Neon) when absent from catalog and never auto-pair with Hydrogen', async (t) => {
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
  assert.equal(await rt.desiredModel({ model: 'liftgate/gemini-pro-orchestrator-argon' }), 'liftgate/gemini-pro-orchestrator-neon')
  assert.equal(await rt.desiredExecutorModel({ model: 'liftgate/gemini-4-argon-high' }), 'liftgate/gemini-pro-orchestrator-neon')
  assert.equal(await rt.desiredExecutorModel({ model: 'liftgate/gemini-4-argon-high', appliedModel: 'liftgate/gemini-pro-orchestrator-neon' }), undefined)
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
  const fallbackEfforts = []
  ctx.llm.stream = (options) => {
    const chain = ctx.listeners.get('llm/stream') ?? []
    const run = index => (index < chain.length ? chain[index](options, () => run(index + 1)) : (async function* () {
      calls.push({ provider: options.provider, model: options.model })
      if (options.model === 'gemini-pro-orchestrator-neon') fallbackEfforts.push(options.reasoningEffort)
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

  const finishFallback = await collect(ctx.llm.stream({ sessionId: 'm1', provider: 'liftgate', model: 'gemini-pro-orchestrator-g1-pro', reasoningEffort: 'unsupported', messages: [user] }))
  assert.deepEqual(finishFallback.map(chunk => chunk.type), ['text-delta', 'finish'])
  assert.equal(finishFallback[0].text, 'ok:gemini-pro-orchestrator-neon')
  assert.equal(fallbackEfforts[0], undefined)

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
