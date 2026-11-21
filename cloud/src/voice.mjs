import { randomUUID } from 'node:crypto'

export const DEFAULT_LIVE_MODEL = 'gpt-live-1.1'
export const ALLOWED_LIVE_MODELS = ['gpt-live-1.1', 'gpt-live-1']
export const DEFAULT_LIVE_VOICE = 'marin'
export const ALLOWED_LIVE_VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse']
export const DEFAULT_IDLE_TIMEOUT_S = 15
export const DEFAULT_VAD_THRESHOLD = 0.5
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const LIVE_DATA_CHANNEL = 'oai-events'

const MODEL_SET = new Set(ALLOWED_LIVE_MODELS)
const VOICE_SET = new Set(ALLOWED_LIVE_VOICES)
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/

function badInput(message) {
  return Object.assign(new Error(message), { status: 400 })
}

function upstreamError(message, status = 502) {
  return Object.assign(new Error(message), { status })
}

function redactSecret(text, secret) {
  if (!secret || typeof text !== 'string') return String(text ?? '')
  return text.split(secret).join('[redacted]')
}

export function buildOpenAiLivePayload({
  sdp,
  model = DEFAULT_LIVE_MODEL,
  voice = DEFAULT_LIVE_VOICE,
  instructions,
  standby = true,
  idleTimeoutS = DEFAULT_IDLE_TIMEOUT_S,
  vadThreshold = DEFAULT_VAD_THRESHOLD,
  delegation,
} = {}) {
  if (typeof sdp !== 'string' || sdp.trim() === '' || sdp.length > 65536 || !sdp.includes('v=0')) {
    throw badInput('sdp must be a non-empty WebRTC SDP offer (<= 65536 chars)')
  }
  const chosenModel = model ?? DEFAULT_LIVE_MODEL
  if (typeof chosenModel !== 'string' || !MODEL_SET.has(chosenModel)) {
    throw badInput(`model must be one of: ${ALLOWED_LIVE_MODELS.join(', ')}`)
  }
  const chosenVoice = voice ?? DEFAULT_LIVE_VOICE
  if (typeof chosenVoice !== 'string' || !VOICE_SET.has(chosenVoice)) {
    throw badInput(`voice must be one of: ${ALLOWED_LIVE_VOICES.join(', ')}`)
  }

  let timeoutInt = null
  let vadNum = null
  if (standby !== false) {
    timeoutInt = idleTimeoutS === undefined || idleTimeoutS === null ? DEFAULT_IDLE_TIMEOUT_S : Number(idleTimeoutS)
    if (!Number.isInteger(timeoutInt) || timeoutInt < 5 || timeoutInt > 60) {
      throw badInput('idleTimeoutS must be an integer between 5 and 60')
    }
    vadNum = vadThreshold === undefined || vadThreshold === null ? DEFAULT_VAD_THRESHOLD : Number(vadThreshold)
    if (!Number.isFinite(vadNum) || vadNum < 0 || vadNum > 1) {
      throw badInput('vadThreshold must be a finite number between 0 and 1')
    }
  }

  const trimmedInstructions = typeof instructions === 'string' ? instructions.trim() : ''

  return {
    session: {
      model: chosenModel,
      ...(trimmedInstructions ? { instructions: trimmedInstructions.slice(0, 12_000) } : {}),
      audio: { output: { voice: chosenVoice } },
      delegation: delegation ?? { type: 'client' },
      ...(standby !== false
        ? {
            wake_policy: { type: 'speech', vad_threshold: vadNum },
            idle_timeout_s: timeoutInt,
          }
        : {}),
    },
    transport: {
      type: 'webrtc',
      sdp,
    },
  }
}

export function createOpenAiLiveVoice({
  apiKey,
  baseUrl = DEFAULT_OPENAI_BASE_URL,
  defaultModel = DEFAULT_LIVE_MODEL,
  defaultVoice = DEFAULT_LIVE_VOICE,
  defaultIdleTimeoutS = DEFAULT_IDLE_TIMEOUT_S,
  defaultVadThreshold = DEFAULT_VAD_THRESHOLD,
  fetchImpl = fetch,
  timeoutMs = 15_000,
} = {}) {
  const normalizedBaseUrl = String(baseUrl || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '')

  function config() {
    return {
      configured: Boolean(apiKey),
      provider: 'openai',
      model: defaultModel,
      models: [...ALLOWED_LIVE_MODELS],
      defaultVoice,
      voices: [...ALLOWED_LIVE_VOICES],
      dataChannel: LIVE_DATA_CHANNEL,
      standby: {
        enabled: true,
        wakePolicy: 'speech',
        idleTimeoutS: defaultIdleTimeoutS,
        vadThreshold: defaultVadThreshold,
        activeRatePerMinUsd: 0.05,
        standbyRatePerMinUsd: 0.02,
      },
    }
  }

  async function readErrorDetail(res) {
    const raw = await res.text().catch(() => '')
    let detail = raw
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed?.error?.message === 'string') detail = parsed.error.message
      else if (typeof parsed?.message === 'string') detail = parsed.message
    } catch {}
    return redactSecret(detail, apiKey).slice(0, 300) || `HTTP ${res.status}`
  }

  async function createSession(input = {}) {
    if (!apiKey) {
      throw upstreamError('OpenAI Live voice is not configured', 501)
    }
    const standby = input.standby !== false
    const payload = buildOpenAiLivePayload({
      ...input,
      model: input.model ?? defaultModel,
      voice: input.voice ?? defaultVoice,
      standby,
      idleTimeoutS: input.idleTimeoutS ?? defaultIdleTimeoutS,
      vadThreshold: input.vadThreshold ?? defaultVadThreshold,
    })

    const res = await fetchImpl(`${normalizedBaseUrl}/live/sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!res.ok) {
      const detail = await readErrorDetail(res)
      throw upstreamError(`OpenAI Live API failed (HTTP ${res.status}): ${detail}`, 502)
    }

    const contentType = String(res.headers?.get?.('content-type') ?? '').toLowerCase()
    let liveSessionId
    let answerSdp
    if (contentType.includes('application/sdp')) {
      answerSdp = await res.text()
      liveSessionId = res.headers?.get?.('x-session-id') ?? res.headers?.get?.('openai-session-id') ?? `live_${randomUUID()}`
    } else {
      const text = await res.text()
      let json = null
      try { json = JSON.parse(text) } catch {}
      if (json && typeof json === 'object') {
        liveSessionId = json.session?.id ?? json.session_id ?? json.id
        answerSdp = json.transport?.sdp ?? json.sdp
      } else if (text.includes('v=0')) {
        answerSdp = text
        liveSessionId = res.headers?.get?.('x-session-id') ?? res.headers?.get?.('openai-session-id') ?? `live_${randomUUID()}`
      }
    }

    if (typeof answerSdp !== 'string' || answerSdp.trim() === '') {
      throw upstreamError('OpenAI Live API returned no SDP answer', 502)
    }

    return {
      liveSessionId: String(liveSessionId || `live_${randomUUID()}`),
      sdp: String(answerSdp),
      model: payload.session.model,
      voice: payload.session.audio.output.voice,
      standby: {
        enabled: standby,
        wakePolicy: standby ? 'speech' : null,
        idleTimeoutS: standby ? payload.session.idle_timeout_s : null,
        vadThreshold: standby ? payload.session.wake_policy.vad_threshold : null,
      },
      dataChannel: LIVE_DATA_CHANNEL,
      via: 'cloud-controller',
    }
  }

  async function closeSession(liveSessionId) {
    if (typeof liveSessionId !== 'string' || !SESSION_ID_RE.test(liveSessionId)) {
      throw badInput('invalid liveSessionId')
    }
    if (!apiKey) {
      throw upstreamError('OpenAI Live voice is not configured', 501)
    }
    const res = await fetchImpl(`${normalizedBaseUrl}/live/sessions/${encodeURIComponent(liveSessionId)}`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.ok || res.status === 404) {
      return { closed: true, liveSessionId }
    }
    const detail = await readErrorDetail(res)
    throw upstreamError(`OpenAI Live API close failed (HTTP ${res.status}): ${detail}`, 502)
  }

  return { config, createSession, closeSession }
}
