import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', workDir: '/tmp/ws-a', createdAt: 1 },
    b: { id: 'b', name: 'Planner', role: 'Plan', sessionId: 'b', workDir: '/tmp/ws-a', createdAt: 2 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

function verifyHmac(headers, method, path, rawBody, secret) {
  const hash = createHash('sha256').update(rawBody ?? '').digest('hex')
  const canon = [headers['x-timestamp'], headers['x-nonce'], method.toUpperCase(), path, hash].join('\n')
  const expected = createHmac('sha256', secret).update(canon).digest('hex')
  assert.equal(headers['x-signature'], expected)
  assert.equal(headers['x-principal'], 'operator')
  assert.equal(headers['x-tenant'], 'dsbot-cloud')
}

const uiBundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/runtime-pill.js', import.meta.url))],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false,
  external: ['react', 'react-dom'],
})
const uiMod = { exports: {} }
runInNewContext(uiBundle.outputFiles[0].text, {
  module: uiMod,
  exports: uiMod.exports,
  URL,
  URLSearchParams,
  setTimeout,
  clearTimeout,
  require: (name) => {
    const platform = {
      react: {
        createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
        useContext: ctx => ctx.value,
        useId: () => 'rt-id',
        useSyncExternalStore: (sub, get) => get(),
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [initial, () => {}],
        useEffect: () => {},
        useRef: current => ({ current }),
        useLayoutEffect: () => {},
        useMemo: make => make(),
        useCallback: fn => fn,
        Fragment: 'fragment',
      },
      'react-dom': { createPortal: node => node },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { RuntimeStatusPill, SidebarRuntimeSwitch, ComposerRuntimeChip, RuntimeBadge, CloudHandoffDock, runtimeOf } = uiMod.exports

async function setupHost(t, { gitRunner, ghRunner, macBrokerCall, execResponder, controllerState } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-cloud-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const cacheDir = join(home, 'cloud-cache')
  const operatorFile = join(home, 'operator.json')
  const cacheFile = join(cacheDir, 'latest.json')
  const secret = 'test-secret-123'
  writeFileSync(operatorFile, JSON.stringify({ id: 'operator', tenant: 'dsbot-cloud', secret }))

  const state = controllerState ?? {
    online: true,
    machines: [{ id: 'm-1', name: 'ds-worker-1', status: 'running', snapshot: 'ds-bot-dsh' }],
    created: [],
    messages: [],
    execs: [],
    auths: [],
  }

  const cloudFetch = async (url, init = {}) => {
    if (!state.online) throw new Error('ECONNREFUSED')
    const u = new URL(url)
    const path = `${u.pathname}${u.search}`
    const method = init.method ?? 'GET'
    const raw = init.body ?? ''
    verifyHmac(init.headers ?? {}, method, path, raw, secret)
    const json = raw ? JSON.parse(raw) : {}
    const respond = (status, body) => ({ status, json: async () => body })

    if (method === 'GET' && u.pathname === '/v1/machines') return respond(200, { machines: state.machines })
    if (method === 'POST' && u.pathname === '/v1/machines') {
      const m = { id: `m-${state.machines.length + 1}`, name: json.name, status: 'running', snapshot: json.snapshot }
      state.machines.push(m)
      state.created.push(json)
      return respond(201, { machine: m })
    }
    const msgMatch = u.pathname.match(/^\/v1\/machines\/([^/]+)\/message$/)
    if (method === 'POST' && msgMatch) {
      state.messages.push({ machineId: decodeURIComponent(msgMatch[1]), ...json })
      return respond(200, { result: { delivered: true } })
    }
    const execMatch = u.pathname.match(/^\/v1\/machines\/([^/]+)\/exec$/)
    if (method === 'POST' && execMatch) {
      state.execs ??= []
      const entry = { machineId: decodeURIComponent(execMatch[1]), ...json }
      state.execs.push(entry)
      const result = execResponder ? await execResponder(entry) : { woke: false, exitCode: 0, stdout: 'Linux daytona-box\n' }
      return respond(200, { result })
    }
    const threadMatch = u.pathname.match(/^\/v1\/machines\/([^/]+)\/threads\/([^/]+)$/)
    if (method === 'GET' && threadMatch) {
      return respond(200, { thread: { id: decodeURIComponent(threadMatch[2]), summary: 'Cloud thread summary' } })
    }
    if (method === 'GET' && u.pathname === '/v1/authorizations') {
      return respond(200, { items: state.auths })
    }
    return respond(404, { error: `unexpected ${method} ${path}` })
  }

  const ctx = fakeContext()
  const localPrompts = []
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, cancel() {}, followup() {}, steer() {} } }),
      selectModel: async () => {},
      prompt: async (request) => { localPrompts.push(request); return { accepted: true, routed: 'local' } },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }

  const rt = createRuntime(ctx, {
    home,
    cloudOperatorFile: operatorFile,
    cloudCacheFile: cacheFile,
    cloudFetch,
    cloudGitRunner: gitRunner,
    cloudGhRunner: ghRunner,
    macBrokerCall,
    macSyncWaitMs: 0,
    disableCloudPoll: true,
  })

  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  const call = async (endpoint, payload) => {
    const res = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return res.json()
  }
  return { home, cacheFile, ctx, rt, state, localPrompts, call }
}

test('cloud-status syncs online machines and falls back to offline cache', async (t) => {
  const { call, cacheFile, state } = await setupHost(t)
  const online = await call('cloud-status', {})
  assert.equal(online.ok, true)
  assert.equal(online.value.controllerOnline, true)
  assert.equal(online.value.configured, true)
  assert.equal(online.value.machines.length, 1)

  const cached = JSON.parse(readFileSync(cacheFile, 'utf8'))
  assert.equal(cached.machines[0].id, 'm-1')

  state.online = false
  const offline = await call('cloud-status', {})
  assert.equal(offline.ok, true)
  assert.equal(offline.value.controllerOnline, false)
  assert.equal(offline.value.machines[0].id, 'm-1')
})

test('cloud-handoff-to-cloud enforces dirty branch guard, supports summary and WIP push, and signs POST /v1/machines/:id/message', async (t) => {
  const gitCommands = []
  let dirty = 'M src/app.js\n'
  const gitRunner = async (args) => {
    gitCommands.push(args)
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { exitCode: 0, stdout: 'true\n', stderr: '' }
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { exitCode: 0, stdout: 'feat/demo\n', stderr: '' }
    if (args[0] === 'status') return { exitCode: 0, stdout: dirty, stderr: '' }
    if (args[0] === 'commit') dirty = ''
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const { call, state } = await setupHost(t, { gitRunner })

  const pre = await call('cloud-preflight', { sessionId: 'a' })
  assert.equal(pre.ok, true)
  assert.equal(pre.value.isGitRepo, true)
  assert.equal(pre.value.dirtyCount, 1)
  assert.equal(pre.value.branch, 'feat/demo')

  // Dirty branch without pushWip must be rejected and revert phase to idle.
  const rejected = await call('cloud-handoff-to-cloud', { sessionId: 'a', scope: 'branch', pushWip: false })
  assert.equal(rejected.ok, false)
  assert.match(rejected.error.message, /Uncommitted local changes/)

  const statusAfterReject = await call('cloud-status', {})
  assert.equal(statusAfterReject.value.sessions.a.location, 'local')
  assert.equal(statusAfterReject.value.sessions.a.phase, 'idle')

  // pushWip creates/pushes a wip/handoff branch and delivers singular POST /v1/machines/:id/message.
  const accepted = await call('cloud-handoff-to-cloud', { sessionId: 'a', scope: 'branch', pushWip: true, note: 'run cloud check' })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.value.runtime.location, 'cloud')
  assert.equal(accepted.value.runtime.phase, 'running')
  assert.match(accepted.value.runtime.branch, /^wip\/handoff-/)
  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].machineId, 'm-1')
  assert.equal(state.messages[0].threadId, 'a')
  assert.equal(state.messages[0].botId, 'a')
  assert.match(state.messages[0].text, /run cloud check/)
  assert.ok(gitCommands.some(c => c[0] === 'checkout' && c[1] === '-b' && c[2].startsWith('wip/handoff-')))
  assert.ok(gitCommands.some(c => c[0] === 'push' && c[1] === '-u' && c[2] === 'origin'))

  // Empty machine list provisions a new machine via POST /v1/machines and summary-only skips git push.
  const summaryHost = await setupHost(t, {
    gitRunner,
    controllerState: { online: true, machines: [], created: [], messages: [], auths: [] },
  })
  const summaryRes = await summaryHost.call('cloud-handoff-to-cloud', { sessionId: 'a', scope: 'summary', note: 'summary only' })
  assert.equal(summaryRes.ok, true)
  assert.equal(summaryHost.state.created.length, 1)
  assert.equal(summaryHost.state.created[0].snapshot, 'ds-bot-dsh')
  assert.equal(summaryRes.value.runtime.scope, 'summary')
})

test('cloud prompt routing queues offline messages and flushes FIFO on reconnect, and handoffToLocal restores local execution', async (t) => {
  const { call, ctx, state, localPrompts } = await setupHost(t)

  // Local by default goes to local sessionController.prompt.
  const r0 = await ctx.sessionController.prompt({ sessionId: 'a', content: [{ type: 'text', text: 'local msg' }] })
  assert.equal(r0.routed, 'local')
  assert.equal(localPrompts.length, 1)

  // Hand off to cloud -> mirrors prompt to Daytona inbox AND runs live prompt turn when online.
  await call('cloud-handoff-to-cloud', { sessionId: 'a', scope: 'summary' })
  const r1 = await ctx.sessionController.prompt({ sessionId: 'a', content: [{ type: 'text', text: 'cloud online msg' }] })
  assert.equal(r1.routed, 'local')
  assert.equal(localPrompts.length, 2)
  assert.equal(state.messages.at(-1).text, 'cloud online msg')

  // Offline -> queues message and marks cached-offline without calling local prompt.
  state.online = false
  const r2 = await ctx.sessionController.prompt({ sessionId: 'a', content: [{ type: 'text', text: 'queued 1' }] })
  const r3 = await ctx.sessionController.prompt({ sessionId: 'a', content: [{ type: 'text', text: 'queued 2' }] })
  assert.equal(r2.queued, true)
  assert.equal(r3.queued, true)
  assert.equal(localPrompts.length, 2)

  const offlineStatus = await call('cloud-status', {})
  assert.equal(offlineStatus.value.sessions.a.phase, 'cached-offline')
  assert.equal(offlineStatus.value.sessions.a.queuedMessages.length, 2)

  // Offline pull requires keepOfflineFork: true.
  const deniedPull = await call('cloud-handoff-to-local', { sessionId: 'a' })
  assert.equal(deniedPull.ok, false)

  // Reconnect flushes queued messages FIFO.
  state.online = true
  const reconnected = await call('cloud-status', {})
  assert.equal(reconnected.value.sessions.a.phase, 'running')
  assert.equal(reconnected.value.sessions.a.queuedMessages.length, 0)
  assert.deepEqual(state.messages.slice(-2).map(m => m.text), ['queued 1', 'queued 2'])

  // Pull back to local restores local prompt routing and keeps lastTransition until dismissed.
  const pulled = await call('cloud-handoff-to-local', { sessionId: 'a' })
  assert.equal(pulled.ok, true)
  assert.equal(pulled.value.runtime.location, 'local')
  assert.equal(pulled.value.runtime.lastTransition.direction, 'to-local')
  const r4 = await ctx.sessionController.prompt({ sessionId: 'a', content: [{ type: 'text', text: 'back local' }] })
  assert.equal(r4.routed, 'local')
  assert.equal(localPrompts.length, 3)

  const dismissed = await call('cloud-dismiss-handoff', { sessionId: 'a' })
  assert.equal(dismissed.ok, true)
  assert.equal(dismissed.value.view.sessions.a.dismissedTransitionId, pulled.value.runtime.lastTransition.id)
})

test('cloud_exec tool and bot-cloud-runtime systemPrompt section follow Local <-> Cloud state', async (t) => {
  const { call, ctx, rt, state } = await setupHost(t)
  const cloudExec = rt.teamTools.find(tool => tool.name === 'cloud_exec')
  const section = ctx.sections.get('bot-cloud-runtime')
  assert.ok(cloudExec)
  assert.ok(section)

  // Local mode: prompt section is empty and cloud_exec refuses politely.
  assert.equal(section.text({ agent: { id: 'a' } }), '')
  const localOut = await cloudExec.execute({ script: 'uname -a' }, { agent: { id: 'a' } })
  assert.match(localOut, /Local mode/)

  // Hand off to cloud: prompt section instructs using cloud_exec on Daytona, and cloud_exec executes over HMAC API.
  await call('cloud-handoff-to-cloud', { sessionId: 'a', scope: 'summary' })
  const activePrompt = section.text({ agent: { id: 'a' } })
  assert.match(activePrompt, /Active Cloud Runtime/)
  assert.match(activePrompt, /ds-worker-1/)
  assert.match(activePrompt, /cloud_exec/)

  const cloudOut = await cloudExec.execute({ script: 'uname -a' }, { agent: { id: 'b' } })
  assert.equal(cloudOut, '[cloud_exec on ds-worker-1 | exit=0]\nLinux daytona-box\n')
  assert.equal(state.execs.length, 1)
  assert.equal(state.execs[0].machineId, 'm-1')
  assert.equal(state.execs[0].cwd, '/workspace')
  assert.equal(state.execs[0].script, 'uname -a')

  // Verify team-wide sync across both bots a and b + sidebar switch (no sessionId).
  const stCloud = await call('cloud-status', {})
  assert.equal(stCloud.value.team.location, 'cloud')
  assert.equal(stCloud.value.sessions.a.location, 'cloud')
  assert.equal(stCloud.value.sessions.b.location, 'cloud')
  assert.match(section.text({ agent: { id: 'b' } }), /Active Cloud Runtime/)

  const backLocal = await call('cloud-handoff-to-local', { sessionId: '' })
  assert.equal(backLocal.ok, true)
  assert.equal(backLocal.value.view.team.location, 'local')
  assert.equal(backLocal.value.view.sessions.a.location, 'local')
  assert.equal(backLocal.value.view.sessions.b.location, 'local')
  assert.equal(section.text({ agent: { id: 'a' } }), '')
  assert.equal(section.text({ agent: { id: 'b' } }), '')

  const viaSidebarCloud = await call('cloud-handoff-to-cloud', { scope: 'summary', note: 'sidebar switch' })
  assert.equal(viaSidebarCloud.ok, true)
  assert.equal(viaSidebarCloud.value.view.team.location, 'cloud')
  assert.equal(viaSidebarCloud.value.view.sessions.a.location, 'cloud')
  assert.equal(viaSidebarCloud.value.view.sessions.b.location, 'cloud')
})

test('RuntimeStatusPill, SidebarRuntimeSwitch, RuntimeBadge, ComposerRuntimeChip, and CloudHandoffDock render all states cleanly', () => {
  const hook = value => select => select(value)
  const localRoster = {
    byId: { a: { id: 'a', name: 'Chief' }, b: { id: 'b', name: 'Planner' } },
    roomsById: {},
    cloudRuntime: { controllerOnline: true, configured: true, syncedAt: new Date().toISOString(), machines: [], sessions: {} },
  }
  const localPill = RuntimeStatusPill({ sessionId: 'a', useRoster: hook(localRoster), actions: {} })
  const localSide = SidebarRuntimeSwitch({ sessionId: '__team__', useRoster: hook(localRoster), actions: {} })
  assert.equal(localPill.children[0].props['aria-label'], 'Local · Mac')
  assert.equal(localSide.children[0].props['aria-label'], 'Local · Mac')
  assert.equal(RuntimeBadge({ runtime: runtimeOf(localRoster, 'a') }), null)

  const sharedTeam = {
    location: 'cloud',
    phase: 'cached-offline',
    machineId: 'm-1',
    machineName: 'ds-worker-1',
    branch: 'feat/demo',
    queuedMessages: [{ id: 'q1', text: 'hi' }],
    lastTransition: { id: 'tr-1', direction: 'to-cloud', machineName: 'ds-worker-1', branch: 'feat/demo', summary: 'Handed off' },
    dismissedTransitionId: null,
  }
  const cloudRoster = {
    byId: { a: { id: 'a', name: 'Chief' }, b: { id: 'b', name: 'Planner' } },
    roomsById: {},
    cloudRuntime: {
      controllerOnline: false,
      configured: true,
      syncedAt: new Date().toISOString(),
      machines: [{ id: 'm-1', name: 'ds-worker-1', status: 'running' }],
      team: sharedTeam,
      sessions: { __team__: sharedTeam, a: sharedTeam, b: sharedTeam },
    },
  }
  const rtView = runtimeOf(cloudRoster, 'b')
  assert.equal(rtView.label, 'Cloud · Cached')
  assert.equal(rtView.dotTone, 'offline')
  const cloudPill = RuntimeStatusPill({ sessionId: 'b', useRoster: hook(cloudRoster), actions: {} })
  const cloudSide = SidebarRuntimeSwitch({ sessionId: '__team__', useRoster: hook(cloudRoster), actions: {} })
  assert.equal(cloudPill.children[0].props['aria-label'], 'Cloud · Cached')
  assert.equal(cloudSide.children[0].props['aria-label'], 'Cloud · Cached')
  const badge = RuntimeBadge({ runtime: rtView })
  assert.equal(badge.props['aria-label'], 'Cloud · Cached')
  const chip = ComposerRuntimeChip({ sessionId: 'b', useRoster: hook(cloudRoster), actions: {} })
  assert.equal(chip.children[0].props.title, 'Cloud · Cached')
  const dock = CloudHandoffDock({ sessionId: 'b', useRoster: hook(cloudRoster), actions: {} })
  assert.equal(dock.children.filter(Boolean).length, 2)
})

test('5-part git sync: aheadCount auto-push, missing-origin gh bootstrap, Daytona clone, Mac broker job, and Cloud->Local reverse sync', async (t) => {
  // Part 1 + 4 + 5: Clean local repo with unpushed commit (aheadCount=1) and missing origin bootstraps GH repo and clones into Daytona.
  let remoteUrl = ''
  const gitCalls = []
  const ghCalls = []
  const macCalls = []
  const gitRunner = async (args) => {
    gitCalls.push(args)
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { exitCode: 0, stdout: 'true\n', stderr: '' }
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { exitCode: 0, stdout: 'main\n', stderr: '' }
    if (args[0] === 'rev-parse' && args[1] === '--short') return { exitCode: 0, stdout: 'abc1234\n', stderr: '' }
    if (args[0] === 'rev-list') return { exitCode: 0, stdout: '1\n', stderr: '' }
    if (args[0] === 'status') return { exitCode: 0, stdout: '', stderr: '' }
    if (args[0] === 'remote' && args[1] === 'get-url') {
      return remoteUrl ? { exitCode: 0, stdout: `${remoteUrl}\n`, stderr: '' } : { exitCode: 2, stdout: '', stderr: 'no origin' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const ghRunner = async (args) => {
    ghCalls.push(args)
    remoteUrl = 'https://github.com/callingforhelp/ws-a.git'
    return { exitCode: 0, stdout: `${remoteUrl}\n`, stderr: '' }
  }
  const macBrokerCall = async (method, path, body) => {
    macCalls.push({ method, path, body })
    return { status: 201, ok: true, data: { mac_online: true, job: { job_id: `mac_${macCalls.length}`, status: 'queued' } } }
  }
  const execResponder = async ({ script }) => {
    if (script.includes('DSBOT_SYNC_DIR=')) {
      return {
        woke: false,
        exitCode: 0,
        stdout: 'DSBOT_SYNC_DIR=/workspace/ws-a\nDSBOT_SYNC_BRANCH=main\nDSBOT_SYNC_COMMIT=abc1234\nDSBOT_SYNC_REMOTE=https://github.com/callingforhelp/ws-a.git\n',
      }
    }
    if (script.includes('DSBOT_PUSH_DIR=')) {
      return {
        woke: false,
        exitCode: 0,
        stdout: 'DSBOT_PUSH_DIR=/workspace/ws-a\nDSBOT_PUSH_REPO=ws-a\nDSBOT_PUSH_BRANCH=wip/cloud-999\nDSBOT_PUSH_COMMIT=def5678\nDSBOT_PUSH_REMOTE=https://github.com/callingforhelp/ws-a.git\nDSBOT_PUSH_DIRTY=1\nDSBOT_PUSH_DONE=1\n',
      }
    }
    return { woke: false, exitCode: 0, stdout: '' }
  }

  const { call, ctx, rt, state } = await setupHost(t, { gitRunner, ghRunner, macBrokerCall, execResponder })

  const toCloud = await call('cloud-handoff-to-cloud', { sessionId: 'a', scope: 'branch', pushWip: false })
  assert.equal(toCloud.ok, true)
  assert.equal(ghCalls.length, 1)
  assert.deepEqual(ghCalls[0].slice(0, 3), ['repo', 'create', 'ws-a'])
  assert.equal(toCloud.value.runtime.remoteUrl, 'https://github.com/callingforhelp/ws-a.git')
  assert.equal(toCloud.value.runtime.cloudRepoDir, '/workspace/ws-a')
  assert.equal(state.execs.length, 1)
  assert.match(state.execs[0].script, /git clone 'https:\/\/github\.com\/callingforhelp\/ws-a\.git' '\/workspace\/ws-a'/)

  // Part 2: Inbound [MAC_JOB_RESULT ... target=git_sync] automatically clones/checks out in Daytona before prompt turn.
  const macMsg = `[MAC_JOB_RESULT job_id=mac_42 status=succeeded target=git_sync]\nSummary:\n${JSON.stringify({
    action: 'push',
    repo: 'new-ios-app',
    remote_url: 'https://github.com/callingforhelp/new-ios-app.git',
    branch: 'feat/swift-ui',
    commit: '999aaaa',
  })}`
  await ctx.sessionController.prompt({ sessionId: 'a', content: [{ type: 'text', text: macMsg }] })
  assert.equal(state.execs.length, 2)
  assert.match(state.execs[1].script, /new-ios-app\.git/)
  assert.match(state.execs[1].script, /feat\/swift-ui/)

  // Part 3: handoffToLocal with pullBranch=true pushes Daytona dirty changes, pulls locally, and enqueues Mac Mini git_sync pull.
  const backLocal = await call('cloud-handoff-to-local', { sessionId: 'a', pullBranch: true })
  assert.equal(backLocal.ok, true)
  assert.equal(backLocal.value.runtime.branch, 'wip/cloud-999')
  assert.equal(state.execs.length, 3)
  assert.match(state.execs[2].script, /DSBOT_PUSH_DIR=/)
  assert.ok(gitCalls.some(c => c[0] === 'fetch' && c[1] === 'origin' && c[2] === 'wip/cloud-999'))
  assert.ok(gitCalls.some(c => c[0] === 'pull' && c[1] === '--ff-only' && c[3] === 'wip/cloud-999'))
  assert.equal(macCalls.length, 1)
  assert.equal(macCalls[0].body.target, 'git_sync')
  assert.match(macCalls[0].body.task, /"action":"pull"/)

  // cloud_git_sync tool checks mode and runs cloud-to-mac cleanly.
  const cloudGitSync = rt.teamTools.find(tool => tool.name === 'cloud_git_sync')
  assert.ok(cloudGitSync)
  const syncRes = JSON.parse(await cloudGitSync.execute({ direction: 'cloud-to-mac', repo: 'ws-a', branch: 'wip/cloud-999' }, { agent: { id: 'a' } }))
  assert.equal(syncRes.ok, true)
  assert.equal(syncRes.cloudPush.branch, 'wip/cloud-999')
  assert.equal(syncRes.macPullJob.job_id, 'mac_2')
})
