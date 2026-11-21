import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApi } from '../src/api.mjs'
import { apiClient } from '../src/client.mjs'
import { createDaytonaMachineManager, mockDaytonaClient } from '../src/daytona-machine.mjs'
import { mockEmbedder } from '../src/embed.mjs'
import { buildOpenAiLivePayload, createOpenAiLiveVoice } from '../src/voice.mjs'

const VALID_OFFER_SDP = 'v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'
const VALID_ANSWER_SDP = 'v=0\r\no=- 67890 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'

const principals = {
  alice: { secret: 'alice-secret-at-least-32-chars-long!', tenants: ['t1'], scopes: ['read-only'], role: 'user' },
  bob: { secret: 'bob-secret-at-least-32-chars-long-!!', tenants: ['t2'], scopes: ['read-only'], role: 'user' },
  worker: { secret: 'worker-secret-at-least-32-chars-long', tenants: ['t1', 't2'], scopes: [], role: 'worker' },
}

function mockPool() {
  const nonces = new Set()
  return {
    async query(sql, params) {
      if (String(sql).includes('request_nonces')) {
        const key = params[0]
        if (nonces.has(key)) return { rowCount: 0, rows: [] }
        nonces.add(key)
        return { rowCount: 1, rows: [] }
      }
      return { rowCount: 0, rows: [] }
    },
  }
}

test('buildOpenAiLivePayload produces gpt-live-1.1 WebRTC + Standby defaults and validates inputs', () => {
  const payload = buildOpenAiLivePayload({
    sdp: VALID_OFFER_SDP,
    instructions: 'Be helpful and concise.',
  })
  assert.deepEqual(payload, {
    session: {
      model: 'gpt-live-1.1',
      instructions: 'Be helpful and concise.',
      audio: { output: { voice: 'marin' } },
      delegation: { type: 'client' },
      wake_policy: { type: 'speech', vad_threshold: 0.5 },
      idle_timeout_s: 15,
    },
    transport: {
      type: 'webrtc',
      sdp: VALID_OFFER_SDP,
    },
  })

  const noStandby = buildOpenAiLivePayload({
    sdp: VALID_OFFER_SDP,
    model: 'gpt-live-1',
    voice: 'cedar',
    standby: false,
  })
  assert.equal(noStandby.session.model, 'gpt-live-1')
  assert.equal(noStandby.session.audio.output.voice, 'cedar')
  assert.equal('wake_policy' in noStandby.session, false)
  assert.equal('idle_timeout_s' in noStandby.session, false)

  assert.throws(() => buildOpenAiLivePayload({ sdp: '' }), err => err.status === 400)
  assert.throws(() => buildOpenAiLivePayload({ sdp: 'not-sdp' }), err => err.status === 400)
  assert.throws(() => buildOpenAiLivePayload({ sdp: VALID_OFFER_SDP, model: 'gpt-4o-realtime' }), err => err.status === 400)
  assert.throws(() => buildOpenAiLivePayload({ sdp: VALID_OFFER_SDP, voice: 'unknown-voice' }), err => err.status === 400)
  assert.throws(() => buildOpenAiLivePayload({ sdp: VALID_OFFER_SDP, idleTimeoutS: 4 }), err => err.status === 400)
  assert.throws(() => buildOpenAiLivePayload({ sdp: VALID_OFFER_SDP, idleTimeoutS: 61 }), err => err.status === 400)
  assert.throws(() => buildOpenAiLivePayload({ sdp: VALID_OFFER_SDP, idleTimeoutS: 12.5 }), err => err.status === 400)
  assert.throws(() => buildOpenAiLivePayload({ sdp: VALID_OFFER_SDP, vadThreshold: -0.1 }), err => err.status === 400)
  assert.throws(() => buildOpenAiLivePayload({ sdp: VALID_OFFER_SDP, vadThreshold: 1.2 }), err => err.status === 400)
})

test('createOpenAiLiveVoice calls POST/DELETE /v1/live/sessions and redacts secrets on error', async () => {
  const secretKey = 'sk-live-secret-token-xyz'
  const calls = []
  const voice = createOpenAiLiveVoice({
    apiKey: secretKey,
    baseUrl: 'https://api.openai.test/v1/',
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null })
      if (init.method === 'POST') {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({
            session: { id: 'live_abc123' },
            transport: { type: 'webrtc', sdp: VALID_ANSWER_SDP },
          }),
        }
      }
      if (init.method === 'DELETE' && url.endsWith('/live/sessions/live_404')) {
        return { ok: false, status: 404, headers: new Headers(), text: async () => 'Not Found' }
      }
      if (init.method === 'DELETE') {
        return { ok: true, status: 200, headers: new Headers(), text: async () => '{}' }
      }
      throw new Error(`unexpected ${init.method} ${url}`)
    },
  })

  const cfg = voice.config()
  assert.equal(cfg.configured, true)
  assert.equal(cfg.model, 'gpt-live-1.1')
  assert.equal(cfg.standby.idleTimeoutS, 15)
  assert.equal(JSON.stringify(cfg).includes(secretKey), false)

  const session = await voice.createSession({ sdp: VALID_OFFER_SDP, instructions: 'Speak clearly.' })
  assert.equal(session.liveSessionId, 'live_abc123')
  assert.equal(session.sdp, VALID_ANSWER_SDP)
  assert.equal(session.model, 'gpt-live-1.1')
  assert.equal(session.voice, 'marin')
  assert.equal(session.standby.enabled, true)
  assert.equal(session.standby.wakePolicy, 'speech')
  assert.equal(session.standby.idleTimeoutS, 15)
  assert.equal(session.dataChannel, 'oai-events')

  assert.equal(calls[0].url, 'https://api.openai.test/v1/live/sessions')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers.authorization, `Bearer ${secretKey}`)
  assert.equal(calls[0].body.session.model, 'gpt-live-1.1')
  assert.equal(calls[0].body.session.idle_timeout_s, 15)

  assert.deepEqual(await voice.closeSession('live_abc123'), { closed: true, liveSessionId: 'live_abc123' })
  assert.deepEqual(await voice.closeSession('live_404'), { closed: true, liveSessionId: 'live_404' })
  assert.equal(calls[1].url, 'https://api.openai.test/v1/live/sessions/live_abc123')
  assert.equal(calls[1].method, 'DELETE')

  const failingVoice = createOpenAiLiveVoice({
    apiKey: secretKey,
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => JSON.stringify({ error: { message: `Invalid key ${secretKey}` } }),
    }),
  })
  await assert.rejects(
    () => failingVoice.createSession({ sdp: VALID_OFFER_SDP }),
    err => err.status === 502 && !err.message.includes(secretKey) && err.message.includes('[redacted]'),
  )
})

test('createApi exposes /v1/voice/* with auth, role checks, tenant isolation, and 501 when unconfigured', async (t) => {
  const unconfiguredApi = createApi({
    pool: mockPool(),
    embedder: mockEmbedder(),
    principals,
  })
  const unconfiguredSrv = await unconfiguredApi.listen(0, '127.0.0.1')
  t.after(() => unconfiguredSrv.close())
  const unconfiguredBase = `http://127.0.0.1:${unconfiguredSrv.address().port}`
  const aliceUnconf = apiClient({ baseUrl: unconfiguredBase, principal: 'alice', secret: principals.alice.secret, tenant: 't1' })

  const cfgOff = await aliceUnconf('GET', '/v1/voice/config')
  assert.equal(cfgOff.status, 200)
  assert.equal(cfgOff.body.configured, false)
  assert.equal(cfgOff.body.model, 'gpt-live-1.1')

  const createOff = await aliceUnconf('POST', '/v1/voice/sessions', { sdp: VALID_OFFER_SDP })
  assert.equal(createOff.status, 501)

  // Configured API with machine manager for tenant machine ownership checks
  const machines = createDaytonaMachineManager({ client: mockDaytonaClient(), defaultIdleMinutes: 10 })
  const t2Machine = await machines.createMachine({ name: 't2-box', labels: { tenant_id: 't2', owner: 'bob' } })

  const voice = createOpenAiLiveVoice({
    apiKey: 'sk-voice-test-1234',
    fetchImpl: async (_url, init) => {
      if (init.method === 'POST') {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({
            session_id: 'live_tenant_1',
            sdp: VALID_ANSWER_SDP,
          }),
        }
      }
      return { ok: true, status: 200, headers: new Headers(), text: async () => '{}' }
    },
  })

  const api = createApi({
    pool: mockPool(),
    embedder: mockEmbedder(),
    principals,
    machines,
    voice,
  })
  const srv = await api.listen(0, '127.0.0.1')
  t.after(() => srv.close())
  const base = `http://127.0.0.1:${srv.address().port}`

  const unauthRes = await fetch(`${base}/v1/voice/config`)
  assert.equal(unauthRes.status, 401)

  const workerClient = apiClient({ baseUrl: base, principal: 'worker', secret: principals.worker.secret, tenant: 't1' })
  const workerCfg = await workerClient('GET', '/v1/voice/config')
  assert.equal(workerCfg.status, 403)

  const alice = apiClient({ baseUrl: base, principal: 'alice', secret: principals.alice.secret, tenant: 't1' })
  const bob = apiClient({ baseUrl: base, principal: 'bob', secret: principals.bob.secret, tenant: 't2' })

  const cfgOn = await alice('GET', '/v1/voice/config')
  assert.equal(cfgOn.status, 200)
  assert.equal(cfgOn.body.configured, true)

  const crossMachine = await alice('POST', '/v1/voice/sessions', { sdp: VALID_OFFER_SDP, machineId: t2Machine.id })
  assert.equal(crossMachine.status, 404)

  const badSdp = await alice('POST', '/v1/voice/sessions', { sdp: 'broken' })
  assert.equal(badSdp.status, 400)

  const created = await alice('POST', '/v1/voice/sessions', { sdp: VALID_OFFER_SDP, botId: 'a', voice: 'cedar', idleTimeoutS: 20 })
  assert.equal(created.status, 201)
  assert.equal(created.body.liveSessionId, 'live_tenant_1')
  assert.equal(created.body.sdp, VALID_ANSWER_SDP)
  assert.equal(created.body.voice, 'cedar')
  assert.equal(created.body.standby.idleTimeoutS, 20)

  // Cross-tenant delete is blocked
  const bobDel = await bob('DELETE', '/v1/voice/sessions/live_tenant_1')
  assert.equal(bobDel.status, 404)

  const aliceDel = await alice('DELETE', '/v1/voice/sessions/live_tenant_1')
  assert.equal(aliceDel.status, 200)
  assert.deepEqual(aliceDel.body, { closed: true, liveSessionId: 'live_tenant_1' })

  // Second delete returns 404 since ownership record was removed
  const aliceDelAgain = await alice('DELETE', '/v1/voice/sessions/live_tenant_1')
  assert.equal(aliceDelAgain.status, 404)
})
