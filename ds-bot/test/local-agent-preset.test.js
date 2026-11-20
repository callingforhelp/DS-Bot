import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { install } from '../src/host/local-agents/index.js'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { refreshSearchDirs } from '../src/host/local-agents/discover.js'
import { fakeContext } from './fake-ctx.js'

// The preset a local agent runs under follows what DSH enforces on its Session when the
// Bot and its group set none: a Bot left on DSH's full-access default (approval policy
// `never`) must not get a CLI that asks, since every ask would be rejected.
async function presetHost(t, { current, bot = {}, room } = {}) {
  await refreshSearchDirs()
  const owner = new Context()
  const llm = new LlmRuntime(owner)
  const adapters = []
  const register = llm.registerAdapter.bind(llm)
  llm.registerAdapter = (ids, adapter) => { if (adapter instanceof LocalAgentAdapter) adapters.push(adapter); return register(ids, adapter) }
  const services = { llm }
  if (current !== undefined) services.permissionPresets = { current: () => { if (current instanceof Error) throw current; return current }, catalog: () => ({ options: [], defaultPreset: current }) }
  const ctx = fakeContext({ services })
  const warnings = []
  const rt = {
    ctx, state: { bots: {}, localAgents: { custom: [], sessions: {} } }, warn: (...args) => warnings.push(args), save: async () => {},
    selfOf: () => 'b1', botOf: id => (id === 'b1' ? { id: 'b1', name: 'Devin Manager', ...bot } : undefined),
    groupOwners: new Map(room ? [['s1', { roomId: 'r1' }]] : []), roomOf: id => (id === 'r1' ? room : undefined),
    resolveAgent: async () => ({ session: { header: { id: 's1' } } }),
  }
  t.after(async () => { await ctx.dispose(); await owner.fiber.dispose() })
  install(rt)
  // Registration follows CLI discovery, which is asynchronous on a cold start.
  for (let i = 0; i < 500 && adapters.length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(adapters.length > 0, 'the local agents adapter registered')
  return { presetFor: id => adapters[0].deps.presetFor(id), warnings }
}

test("a Bot with no preset of its own follows DSH's preset for the Session", async (t) => {
  const { presetFor } = await presetHost(t, { current: 'danger-full-access' })
  assert.equal(await presetFor('s1'), 'danger-full-access')
})

test("the Bot's and the group's own presets still win over DSH's", async (t) => {
  assert.equal(await (await presetHost(t, { current: 'danger-full-access', bot: { permission: 'read-only' } })).presetFor('s1'), 'read-only')
  assert.equal(await (await presetHost(t, { current: 'danger-full-access', bot: { permission: 'read-only' }, room: { id: 'r1', permission: 'workspace-write' } })).presetFor('s1'), 'workspace-write')
})

test('workspace-write stays the fallback without DSH presets, for a custom setting, or when the Session cannot be read', async (t) => {
  assert.equal(await (await presetHost(t, {})).presetFor('s1'), 'workspace-write')
  assert.equal(await (await presetHost(t, { current: 'custom' })).presetFor('s1'), 'workspace-write')
  const broken = await presetHost(t, { current: new Error('no session') })
  assert.equal(await broken.presetFor('s1'), 'workspace-write')
  assert.ok(broken.warnings.some(args => String(args[0]).includes('permission preset')))
})
