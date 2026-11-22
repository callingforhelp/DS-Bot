import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const VALID_OFFER_SDP = 'v=0\r\no=- 100 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'
const VALID_ANSWER_SDP = 'v=0\r\no=- 200 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'

function verifyHmac(headers, method, path, rawBody, secret) {
  const hash = createHash('sha256').update(rawBody ?? '').digest('hex')
  const canon = [headers['x-timestamp'], headers['x-nonce'], method.toUpperCase(), path, hash].join('\n')
  const expected = createHmac('sha256', secret).update(canon).digest('hex')
  assert.equal(headers['x-signature'], expected)
  assert.equal(headers['x-principal'], 'operator')
  assert.equal(headers['x-tenant'], 'dsbot-cloud')
}

// Bundle client voice-live.js to test WebRTC, Standby, transcript concatenation, and client delegation.
const clientBundle = await build({
  stdin: { contents: "export * from './src/client/voice-live.js'", resolveDir: dirname(dirname(fileURLToPath(import.meta.url))) },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
})
const clientMod = { exports: {} }
runInNewContext(clientBundle.outputFiles[0].text, {
  module: clientMod,
  exports: clientMod.exports,
  setTimeout,
  clearTimeout,
  Date,
  Math,
  JSON,
  Promise,
  Error,
  Object,
  String,
  Number,
  Array,
})
const { openLiveVoiceSession, formatCommentary, createCommentaryEvent } = clientMod.exports

function seedState({ cloudRuntime } = {}) {
  return {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', instructions: 'Keep answers crisp.', sessionId: 'a', workDir: '/tmp/ws-a', createdAt: 1 },
    },
    rooms: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    ...(cloudRuntime ? { cloudRuntimes: { a: cloudRuntime } } : {}),
    revision: 0,
  }
}

async function setupVoiceHost(t, { cloudRuntime, operator = true, controllerConfigured = true, controllerOnline = true, directKey, credentialsKey, secretKey } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-voice-live-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seedState({ cloudRuntime })))
  const operatorFile = join(home, 'operator.json')
  const secret = 'voice-test-operator-secret-123456'
  if (operator) {
    writeFileSync(operatorFile, JSON.stringify({ id: 'operator', tenant: 'dsbot-cloud', secret }))
  }
  if (secretKey) {
    writeFileSync(join(home, 'secrets.json'), JSON.stringify({
      version: 1,
      secrets: [{ name: 'OPENAI_API_KEY', value: secretKey, purpose: 'voice', scope: 'all', createdAt: 1, updatedAt: 1 }],
    }))
  }

  const controllerCalls = []
  const openaiCalls = []

  const voiceFetch = async (url, init = {}) => {
    const u = new URL(url)
    const method = init.method ?? 'GET'
    const raw = init.body ?? ''
    const json = raw ? JSON.parse(raw) : null

    if (u.hostname === '127.0.0.1') {
      if (!controllerOnline) throw new Error('ECONNREFUSED')
      verifyHmac(init.headers ?? {}, method, `${u.pathname}${u.search}`, raw, secret)
      controllerCalls.push({ method, path: u.pathname, body: json })

      if (method === 'GET' && u.pathname === '/v1/voice/config') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            configured: controllerConfigured,
            provider: 'openai',
            model: 'gpt-live-1.1',
            models: ['gpt-live-1.1', 'gpt-live-1'],
            defaultVoice: 'marin',
            voices: ['marin', 'cedar', 'alloy'],
            dataChannel: 'oai-events',
            standby: { enabled: true, wakePolicy: 'speech', idleTimeoutS: 15, vadThreshold: 0.5, activeRatePerMinUsd: 0.05, standbyRatePerMinUsd: 0.02 },
          }),
        }
      }
      if (method === 'POST' && u.pathname === '/v1/voice/sessions') {
        if (!controllerConfigured) {
          return { ok: false, status: 501, json: async () => ({ error: 'voice is not configured' }) }
        }
        return {
          ok: true,
          status: 201,
          json: async () => ({
            liveSessionId: `live_ctl_${controllerCalls.length}`,
            sdp: VALID_ANSWER_SDP,
            model: json.model ?? 'gpt-live-1.1',
            voice: json.voice ?? 'marin',
            standby: { enabled: true, wakePolicy: 'speech', idleTimeoutS: json.idleTimeoutS ?? 15, vadThreshold: json.vadThreshold ?? 0.5 },
            dataChannel: 'oai-events',
            via: 'cloud-controller',
          }),
        }
      }
      if (method === 'DELETE' && u.pathname.startsWith('/v1/voice/sessions/')) {
        return { ok: true, status: 200, json: async () => ({ closed: true }) }
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
    }

    if (u.hostname === 'api.openai.test') {
      openaiCalls.push({ method, path: u.pathname, headers: init.headers, body: json })
      if (method === 'POST' && u.pathname === '/v1/live/sessions') {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({
            session: { id: 'live_direct_1' },
            transport: { type: 'webrtc', sdp: VALID_ANSWER_SDP },
          }),
        }
      }
      if (method === 'DELETE' && u.pathname.startsWith('/v1/live/sessions/')) {
        return { ok: true, status: 200, headers: new Headers(), text: async () => '{}' }
      }
    }
    throw new Error(`Unexpected fetch ${method} ${url}`)
  }

  const ctx = fakeContext({
    services: credentialsKey
      ? { credentials: { resolve: async ref => (ref === 'OPENAI_API_KEY' ? { value: credentialsKey, source: 'file' } : undefined) } }
      : {},
  })
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, cancel() {}, followup() {}, steer() {} } }),
      selectModel: async () => {},
      prompt: async () => ({ accepted: true }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }

  createRuntime(ctx, {
    home,
    cloudOperatorFile: operatorFile,
    cloudCacheFile: join(home, 'cloud-cache', 'latest.json'),
    voiceFetch,
    openaiBaseUrl: 'https://api.openai.test/v1',
    openaiApiKey: directKey,
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

  return { home, call, controllerCalls, openaiCalls }
}

test('both Local and Cloud bots call the same signed /v1/voice/* controller API with gpt-live-1.1 and Standby', async (t) => {
  const localHost = await setupVoiceHost(t)
  const localStatus = await localHost.call('voice-status', { sessionId: 'a' })
  assert.equal(localStatus.ok, true)
  assert.equal(localStatus.value.available, true)
  assert.equal(localStatus.value.model, 'gpt-live-1.1')
  assert.equal(localStatus.value.via, 'cloud-controller')
  assert.equal(localStatus.value.runtimeLocation, 'local')

  const localCreated = await localHost.call('voice-session-create', { sessionId: 'a', sdp: VALID_OFFER_SDP })
  assert.equal(localCreated.ok, true)
  assert.equal(localCreated.value.via, 'cloud-controller')
  assert.equal(localCreated.value.runtimeLocation, 'local')
  assert.equal(localCreated.value.sdp, VALID_ANSWER_SDP)
  const localPost = localHost.controllerCalls.find(c => c.method === 'POST')
  assert.equal(localPost.path, '/v1/voice/sessions')
  assert.equal(localPost.body.model, 'gpt-live-1.1')
  assert.equal(localPost.body.idleTimeoutS, 15)
  assert.match(localPost.body.instructions, /Active runtime: Local machine/)
  assert.equal(localPost.body.machineId, undefined)

  const localClosed = await localHost.call('voice-session-close', { liveSessionId: localCreated.value.liveSessionId })
  assert.equal(localClosed.ok, true)
  assert.equal(localHost.controllerCalls.some(c => c.method === 'DELETE' && c.path === `/v1/voice/sessions/${localCreated.value.liveSessionId}`), true)

  // Cloud-handed-off bot calls the exact same /v1/voice/* API
  const cloudHost = await setupVoiceHost(t, {
    cloudRuntime: { location: 'cloud', phase: 'running', machineId: 'm-99', machineName: 'aws-box-99' },
  })
  const cloudStatus = await cloudHost.call('voice-status', { sessionId: 'a' })
  assert.equal(cloudStatus.ok, true)
  assert.equal(cloudStatus.value.via, 'cloud-controller')
  assert.equal(cloudStatus.value.runtimeLocation, 'cloud')

  const cloudCreated = await cloudHost.call('voice-session-create', { sessionId: 'a', sdp: VALID_OFFER_SDP })
  assert.equal(cloudCreated.ok, true)
  assert.equal(cloudCreated.value.via, 'cloud-controller')
  assert.equal(cloudCreated.value.runtimeLocation, 'cloud')
  const cloudPost = cloudHost.controllerCalls.find(c => c.method === 'POST')
  assert.equal(cloudPost.path, '/v1/voice/sessions')
  assert.equal(cloudPost.body.machineId, 'm-99')
  assert.match(cloudPost.body.instructions, /Cloud machine "aws-box-99"/)

  await cloudHost.call('voice-session-close', { liveSessionId: cloudCreated.value.liveSessionId })
  assert.equal(cloudHost.controllerCalls.some(c => c.method === 'DELETE' && c.path === `/v1/voice/sessions/${cloudCreated.value.liveSessionId}`), true)
})

test('host falls back to direct OpenAI /v1/live/sessions via credentials or secrets without leaking keys', async (t) => {
  // 1. Offline/unconfigured controller falls back to ctx.credentials OPENAI_API_KEY
  const credKey = 'sk-cred-secret-key-999'
  const credHost = await setupVoiceHost(t, {
    controllerOnline: false,
    credentialsKey: credKey,
  })
  const status = await credHost.call('voice-status', { sessionId: 'a' })
  assert.equal(status.ok, true)
  assert.equal(status.value.available, true)
  assert.equal(status.value.via, 'openai-direct')
  assert.equal(JSON.stringify(status).includes(credKey), false)

  const created = await credHost.call('voice-session-create', { sessionId: 'a', sdp: VALID_OFFER_SDP })
  assert.equal(created.ok, true)
  assert.equal(created.value.via, 'openai-direct')
  assert.equal(created.value.liveSessionId, 'live_direct_1')
  assert.equal(credHost.openaiCalls[0].path, '/v1/live/sessions')
  assert.equal(credHost.openaiCalls[0].headers.authorization, `Bearer ${credKey}`)
  assert.equal(credHost.openaiCalls[0].body.session.model, 'gpt-live-1.1')
  assert.deepEqual(credHost.openaiCalls[0].body.session.wake_policy, { type: 'speech', vad_threshold: 0.5 })
  assert.equal(credHost.openaiCalls[0].body.session.idle_timeout_s, 15)
  assert.deepEqual(credHost.openaiCalls[0].body.session.delegation, { type: 'client' })

  await credHost.call('voice-session-close', { liveSessionId: 'live_direct_1' })
  assert.equal(credHost.openaiCalls[1].method, 'DELETE')
  assert.equal(credHost.openaiCalls[1].path, '/v1/live/sessions/live_direct_1')

  // 2. Controller returning 501 falls back to ds-bot secret store OPENAI_API_KEY
  const storeSecret = 'sk-store-secret-key-888'
  const secretHost = await setupVoiceHost(t, {
    controllerConfigured: false,
    secretKey: storeSecret,
  })
  const secretStatus = await secretHost.call('voice-status', { sessionId: 'a' })
  assert.equal(secretStatus.ok, true)
  assert.equal(secretStatus.value.via, 'openai-direct')
  assert.equal(JSON.stringify(secretStatus).includes(storeSecret), false)

  const secretCreated = await secretHost.call('voice-session-create', { sessionId: 'a', sdp: VALID_OFFER_SDP })
  assert.equal(secretCreated.ok, true)
  assert.equal(secretHost.openaiCalls[0].headers.authorization, `Bearer ${storeSecret}`)

  // 3. No controller and no key reports unavailable cleanly
  const unconfiguredHost = await setupVoiceHost(t, { operator: false })
  const noStatus = await unconfiguredHost.call('voice-status', { sessionId: 'a' })
  assert.equal(noStatus.ok, true)
  assert.equal(noStatus.value.available, false)
  assert.equal(noStatus.value.via, 'none')
  const failCreate = await unconfiguredHost.call('voice-session-create', { sessionId: 'a', sdp: VALID_OFFER_SDP })
  assert.equal(failCreate.ok, false)
})

test('client openLiveVoiceSession handles WebRTC setup, Standby, exact transcript deltas, and delegation commentary', async () => {
  const track = { enabled: true, stopped: false, stop() { this.stopped = true } }
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
  const sentMessages = []
  let createdChannel = null
  let createdPc = null

  class FakePeerConnection {
    constructor() {
      this.iceGatheringState = 'gathering'
      this.connectionState = 'new'
      this.localDescription = null
      this.remoteDescription = null
      this.addedTracks = []
      this.closed = false
      this._listeners = new Map()
      createdPc = this
    }
    addEventListener(name, fn) {
      if (!this._listeners.has(name)) this._listeners.set(name, new Set())
      this._listeners.get(name).add(fn)
    }
    removeEventListener(name, fn) {
      this._listeners.get(name)?.delete(fn)
    }
    addTrack(t, s) {
      this.addedTracks.push({ track: t, stream: s })
    }
    createDataChannel(label) {
      createdChannel = {
        label,
        readyState: 'open',
        closed: false,
        onmessage: null,
        send(payload) { sentMessages.push(JSON.parse(payload)) },
        close() { this.closed = true; this.readyState = 'closed' },
      }
      return createdChannel
    }
    async createOffer() {
      // Data channel and mic track must be added before createOffer.
      assert.equal(createdChannel?.label, 'oai-events')
      assert.equal(this.addedTracks.length, 1)
      return { type: 'offer', sdp: VALID_OFFER_SDP }
    }
    async setLocalDescription(desc) {
      this.localDescription = desc
      setTimeout(() => {
        this.iceGatheringState = 'complete'
        for (const fn of this._listeners.get('icegatheringstatechange') ?? []) fn()
      }, 10)
    }
    async setRemoteDescription(desc) {
      this.remoteDescription = desc
    }
    close() { this.closed = true }
  }

  const phases = []
  const transcripts = []
  const committed = []
  const delegations = []
  const closedIds = []
  const createRequests = []

  const session = await openLiveVoiceSession({
    sessionId: 'a',
    createSession: async (req) => {
      createRequests.push(req)
      return { liveSessionId: 'live_webrtc_1', sdp: VALID_ANSWER_SDP, model: 'gpt-live-1.1', voice: 'marin' }
    },
    closeSession: async (id) => { closedIds.push(id) },
    onPhase: p => phases.push(p),
    onTranscript: tr => transcripts.push(tr),
    onTranscriptCommit: c => committed.push(c),
    onDelegation: d => delegations.push(d),
    mediaDevices: { getUserMedia: async () => stream },
    PeerConnection: FakePeerConnection,
    createAudioElement: () => ({ autoplay: false, playsInline: false, srcObject: null, play: async () => {}, pause() {}, remove() {} }),
    AudioContextImpl: undefined,
  })

  assert.equal(createRequests.length, 1)
  assert.equal(createRequests[0].sdp, VALID_OFFER_SDP)
  assert.equal(createRequests[0].standby, true)
  assert.equal(createdPc.remoteDescription.sdp, VALID_ANSWER_SDP)

  const emit = obj => createdChannel.onmessage({ data: JSON.stringify(obj) })

  emit({ type: 'session.started' })
  assert.equal(phases.at(-1), 'listening')

  // Standby keeps microphone track active
  emit({ type: 'session.paused' })
  assert.equal(phases.at(-1), 'standby')
  assert.equal(track.stopped, false)
  assert.equal(track.enabled, true)

  emit({ type: 'session.resumed' })
  assert.equal(phases.at(-1), 'listening')

  // Deltas append without inserting extra spaces
  emit({ type: 'session.input_transcript.delta', delta: 'Check ' })
  emit({ type: 'session.input_transcript.delta', delta: 'my tests' })
  assert.equal(transcripts.at(-1).role, 'user')
  assert.equal(transcripts.at(-1).text, 'Check my tests')

  emit({ type: 'session.delegation.created', delegation: { id: 'del_42', type: 'client' } })
  assert.equal(delegations.length, 1)
  assert.equal(delegations[0].delegationId, 'del_42')
  assert.equal(delegations[0].query, 'Check my tests')

  const sentOk = session.sendCommentary('del_42', '```js\nignore\n```\nAll **12 tests** passed in [repo](https://example.com).')
  assert.equal(sentOk, true)
  assert.equal(sentMessages.length, 1)
  assert.equal(sentMessages[0].type, 'session.commentary.append')
  assert.equal(sentMessages[0].delegation_id, 'del_42')
  assert.equal(sentMessages[0].content, 'All 12 tests passed in repo.')

  emit({ type: 'session.output_transcript.delta', delta: 'All 12 ' })
  emit({ type: 'session.output_transcript.delta', delta: 'tests passed.' })
  assert.equal(phases.at(-1), 'speaking')
  assert.equal(transcripts.at(-1).role, 'assistant')
  assert.equal(transcripts.at(-1).text, 'All 12 tests passed.')

  emit({ type: 'response.done' })
  assert.equal(phases.at(-1), 'listening')
  // Delegated turn must NOT double-commit via onTranscriptCommit
  assert.equal(committed.length, 0)

  // Non-delegated turn commits both user and assistant once
  emit({ type: 'input_audio_buffer.speech_started' })
  emit({ type: 'session.input_transcript.delta', delta: 'Hi Chief' })
  emit({ type: 'session.output_transcript.delta', delta: 'Hello! Ready to help.' })
  emit({ type: 'response.done' })
  assert.equal(committed.length, 2)
  assert.equal(committed[0].role, 'user')
  assert.equal(committed[0].text, 'Hi Chief')
  assert.equal(committed[1].role, 'assistant')
  assert.equal(committed[1].text, 'Hello! Ready to help.')

  session.setMuted(true)
  assert.equal(track.enabled, false)
  session.setMuted(false)
  assert.equal(track.enabled, true)

  session.close()
  session.close()
  assert.equal(track.stopped, true)
  assert.equal(createdChannel.closed, true)
  assert.equal(createdPc.closed, true)
  assert.deepEqual(closedIds, ['live_webrtc_1'])

  const longEvt = createCommentaryEvent(null, 'word '.repeat(500))
  assert.ok(longEvt.content.length <= 1600)
  assert.equal(formatCommentary(''), '')
})

test('voice-transcript-append persists non-delegated voice context across Local <-> Cloud handoff and seeds new sessions', async (t) => {
  const { call, controllerCalls } = await setupVoiceHost(t, {
    cloudRuntime: { location: 'local', phase: 'idle', machineId: null, recentMessages: [] },
  })

  const u1 = await call('voice-transcript-append', { sessionId: 'a', role: 'user', text: 'Remember the deploy window is 9pm.' })
  assert.equal(u1.ok, true)
  assert.equal(u1.value.saved, true)
  assert.equal(u1.value.count, 1)

  const a1 = await call('voice-transcript-append', { sessionId: 'a', role: 'assistant', text: 'Got it, 9pm deploy window noted.' })
  assert.equal(a1.ok, true)
  assert.equal(a1.value.count, 2)

  // New voice session on Local is seeded with recent voice context
  const localVoice = await call('voice-session-create', { sessionId: 'a', sdp: VALID_OFFER_SDP })
  assert.equal(localVoice.ok, true)
  const localPost = controllerCalls.filter(c => c.method === 'POST' && c.path === '/v1/voice/sessions').at(-1)
  assert.match(localPost.body.instructions, /Recent conversation context/)
  assert.match(localPost.body.instructions, /User: Remember the deploy window is 9pm\./)
  assert.match(localPost.body.instructions, /Assistant: Got it, 9pm deploy window noted\./)

  // Cloud-handed-off host still sees persisted voiceHistory and records voice turns in recentMessages
  const cloudHost = await setupVoiceHost(t, {
    cloudRuntime: { location: 'cloud', phase: 'running', machineId: 'm-55', machineName: 'aws-voice-55', recentMessages: [] },
  })
  await cloudHost.call('voice-transcript-append', { sessionId: 'a', role: 'user', text: 'Run checks on AWS box.' })
  await cloudHost.call('voice-transcript-append', { sessionId: 'a', role: 'assistant', text: 'All checks passed on AWS.' })
  const cloudVoice = await cloudHost.call('voice-session-create', { sessionId: 'a', sdp: VALID_OFFER_SDP })
  assert.equal(cloudVoice.ok, true)
  const cloudPost = cloudHost.controllerCalls.filter(c => c.method === 'POST' && c.path === '/v1/voice/sessions').at(-1)
  assert.match(cloudPost.body.instructions, /Cloud machine "aws-voice-55"/)
  assert.match(cloudPost.body.instructions, /User: Run checks on AWS box\./)
  assert.match(cloudPost.body.instructions, /Assistant: All checks passed on AWS\./)
})
