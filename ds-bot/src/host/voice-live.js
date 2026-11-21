// Unified OpenAI GPT-Live 1.1 WebRTC voice session bridge for both Local and Cloud DS Bot.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { signControllerRequest } from './cloud-handoff.js'

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
const SESSION_TTL_MS = 6 * 3600_000
const REQUEST_TIMEOUT_MS = 15_000
const STATUS_TIMEOUT_MS = 2_000
const MAX_VOICE_HISTORY = 20
const MAX_CONTEXT_CHARS = 2_400

const invalid = (message, code = 'bot/invalid') => Object.assign(new Error(message), { code, status: 400 })
const unavailable = (message, code = 'bot/unavailable') => Object.assign(new Error(message), { code })

function redactSecret(text, secret) {
  if (!secret || typeof text !== 'string') return String(text ?? '')
  return text.split(secret).join('[redacted]')
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function clampIdleTimeout(raw) {
  const num = Number(raw)
  if (!Number.isInteger(num) || num < 5 || num > 60) return DEFAULT_IDLE_TIMEOUT_S
  return num
}

function clampVadThreshold(raw) {
  const num = Number(raw)
  if (!Number.isFinite(num) || num < 0 || num > 1) return DEFAULT_VAD_THRESHOLD
  return num
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
    throw invalid('sdp must be a non-empty WebRTC SDP offer (<= 65536 chars)')
  }
  const chosenModel = model ?? DEFAULT_LIVE_MODEL
  if (typeof chosenModel !== 'string' || !MODEL_SET.has(chosenModel)) {
    throw invalid(`model must be one of: ${ALLOWED_LIVE_MODELS.join(', ')}`)
  }
  const chosenVoice = voice ?? DEFAULT_LIVE_VOICE
  if (typeof chosenVoice !== 'string' || !VOICE_SET.has(chosenVoice)) {
    throw invalid(`voice must be one of: ${ALLOWED_LIVE_VOICES.join(', ')}`)
  }

  let timeoutInt = null
  let vadNum = null
  if (standby !== false) {
    timeoutInt = idleTimeoutS === undefined || idleTimeoutS === null ? DEFAULT_IDLE_TIMEOUT_S : Number(idleTimeoutS)
    if (!Number.isInteger(timeoutInt) || timeoutInt < 5 || timeoutInt > 60) {
      throw invalid('idleTimeoutS must be an integer between 5 and 60')
    }
    vadNum = vadThreshold === undefined || vadThreshold === null ? DEFAULT_VAD_THRESHOLD : Number(vadThreshold)
    if (!Number.isFinite(vadNum) || vadNum < 0 || vadNum > 1) {
      throw invalid('vadThreshold must be a finite number between 0 and 1')
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

function extractRecentSessionTurns(messages, limit = 8) {
  if (!Array.isArray(messages)) return []
  const turns = []
  for (const msg of messages) {
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue
    let text = ''
    if (typeof msg.content === 'string') {
      text = msg.content
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter(b => b && b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
        .join(' ')
    }
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) continue
    turns.push({ role: msg.role, text: clean.slice(0, 320), at: Number(msg.timestamp) || 0 })
  }
  return turns.slice(-limit)
}

export function buildVoiceInstructions(rt, sessionId, { recentSessionTurns = [] } = {}) {
  const room = rt.roomOf?.(sessionId)
  const targetId = room?.id ?? rt.selfOf?.(sessionId) ?? rt.botOf?.(sessionId)?.id ?? sessionId
  const bot = rt.botOf?.(targetId)
  const cloudEntry = targetId ? rt.own?.(rt.state?.cloudRuntimes, targetId) : undefined

  const lines = []
  if (bot) {
    lines.push(`You are ${bot.name}, a Bot on the user's team in DS Bot.${bot.role ? ` Role: ${bot.role}.` : ''}`)
    if (bot.instructions) lines.push(bot.instructions)
  } else if (room) {
    lines.push(`You are speaking for group chat "${room.name}" in DS Bot.`)
  } else {
    lines.push('You are a Bot assistant in DS Bot.')
  }

  if (cloudEntry?.location === 'cloud') {
    const label = cloudEntry.machineName ?? cloudEntry.machineId ?? 'cloud'
    lines.push(`Active runtime: Cloud machine "${label}" (Daytona sandbox).`)
  } else {
    lines.push('Active runtime: Local machine.')
  }

  const savedVoice = Array.isArray(rt.state?.voiceHistory?.[targetId]) ? rt.state.voiceHistory[targetId].slice(-10) : []
  const combined = [...recentSessionTurns, ...savedVoice]
  if (combined.length > 0) {
    const seen = new Set()
    const formatted = []
    let budget = MAX_CONTEXT_CHARS
    for (const item of combined.slice(-12)) {
      const text = String(item?.text ?? '').replace(/\s+/g, ' ').trim()
      if (!text) continue
      const key = `${item.role}:${text}`
      if (seen.has(key)) continue
      seen.add(key)
      const row = `- ${item.role === 'assistant' ? 'Assistant' : 'User'}: ${text.slice(0, 320)}`
      if (row.length > budget) break
      budget -= row.length
      formatted.push(row)
    }
    if (formatted.length > 0) {
      lines.push(`Recent conversation context (shared across Local & Cloud):\n${formatted.join('\n')}`)
    }
  }

  lines.push(
    'Voice mode style: respond naturally, warmly, and concisely for spoken playback. Never read raw markdown syntax, code fences, file paths, or long URLs verbatim; summarize them clearly in plain speech. Reply in the user\'s language.',
    'Delegation policy: answer quick conversational questions and acknowledgements directly. Whenever the user asks you to take action — inspect or edit files, run local or cloud shell commands, search the workspace or web, check memory or schedules, or coordinate other Bots — immediately create a client delegation so the DS Bot backend executes the tools and sends back commentary for you to speak.',
  )
  return lines.join('\n\n')
}

export function install(rt) {
  const { ctx, config = {} } = rt
  const fetchImpl = config.voiceFetch ?? config.cloudFetch ?? globalThis.fetch
  const viaMode = String(config.voiceVia ?? process.env.DS_BOT_VOICE_VIA ?? 'auto').toLowerCase()
  const controllerUrl = String(config.voiceControllerUrl ?? config.cloudControllerUrl ?? process.env.DS_BOT_VOICE_API_URL ?? process.env.DS_BOT_CONTROLLER_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '')
  const operatorFile = config.cloudOperatorFile ?? process.env.DS_BOT_OPERATOR_FILE ?? join(rt.dshHome, 'cloud-cache', 'operator.json')
  const openaiBaseUrl = String(config.openaiBaseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '')
  const defaultModel = ALLOWED_LIVE_MODELS.includes(config.voiceModel ?? process.env.OPENAI_LIVE_MODEL)
    ? (config.voiceModel ?? process.env.OPENAI_LIVE_MODEL)
    : DEFAULT_LIVE_MODEL
  const defaultVoice = ALLOWED_LIVE_VOICES.includes(config.voiceName ?? process.env.OPENAI_LIVE_VOICE)
    ? (config.voiceName ?? process.env.OPENAI_LIVE_VOICE)
    : DEFAULT_LIVE_VOICE
  const defaultIdleTimeoutS = clampIdleTimeout(config.voiceIdleTimeoutS ?? process.env.OPENAI_LIVE_IDLE_TIMEOUT_S ?? DEFAULT_IDLE_TIMEOUT_S)
  const defaultVadThreshold = clampVadThreshold(config.voiceVadThreshold ?? process.env.OPENAI_LIVE_VAD_THRESHOLD ?? DEFAULT_VAD_THRESHOLD)

  const activeSessions = new Map()

  const targetIdOf = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    return rt.roomOf?.(sessionId)?.id ?? rt.selfOf?.(sessionId) ?? rt.botOf?.(sessionId)?.id ?? sessionId
  }

  const readOperator = () => {
    const creds = readJsonSafe(operatorFile)
    if (creds && typeof creds.secret === 'string' && creds.secret !== '') {
      return {
        id: creds.id ?? 'operator',
        tenant: creds.tenant ?? 'dsbot-cloud',
        secret: creds.secret,
        controllerUrl: typeof creds.controllerUrl === 'string' && creds.controllerUrl.trim() !== '' ? creds.controllerUrl.trim().replace(/\/+$/, '') : null,
      }
    }
    return null
  }

  async function resolveOpenAiKey() {
    if (typeof config.openaiApiKey === 'string' && config.openaiApiKey.trim() !== '') {
      return config.openaiApiKey.trim()
    }
    try {
      const credentials = ctx.get?.('credentials')
      if (typeof credentials?.resolve === 'function') {
        const resolved = await credentials.resolve('OPENAI_API_KEY')
        if (typeof resolved?.value === 'string' && resolved.value.trim() !== '') {
          return resolved.value.trim()
        }
      }
    } catch {}
    const fromSecret = rt.secretValue?.('OPENAI_API_KEY')
    if (typeof fromSecret === 'string' && fromSecret.trim() !== '') {
      return fromSecret.trim()
    }
    if (typeof process.env.OPENAI_API_KEY === 'string' && process.env.OPENAI_API_KEY.trim() !== '') {
      return process.env.OPENAI_API_KEY.trim()
    }
    return undefined
  }

  async function controllerRequest(method, path, body, timeoutMs = REQUEST_TIMEOUT_MS) {
    const creds = readOperator()
    if (!creds) return null
    if (typeof fetchImpl !== 'function') throw unavailable('Fetch implementation is unavailable')
    const baseUrl = creds.controllerUrl ?? controllerUrl
    const { raw, headers } = signControllerRequest({
      principal: creds.id,
      secret: creds.secret,
      tenant: creds.tenant,
      method,
      path,
      body,
    })
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: method === 'GET' || method === 'DELETE' ? undefined : raw,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const json = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, body: json, baseUrl }
  }

  function pruneSessions() {
    const cutoff = Date.now() - SESSION_TTL_MS
    for (const [id, entry] of activeSessions) {
      if (entry.createdAt < cutoff) activeSessions.delete(id)
    }
  }

  async function readErrorDetail(res, apiKey) {
    const raw = await res.text().catch(() => '')
    let detail = raw
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed?.error?.message === 'string') detail = parsed.error.message
      else if (typeof parsed?.message === 'string') detail = parsed.message
    } catch {}
    return redactSecret(detail, apiKey).slice(0, 300) || `HTTP ${res.status}`
  }

  async function voiceStatus(body = {}) {
    const targetId = targetIdOf(body?.sessionId)
    const cloudEntry = targetId ? rt.own?.(rt.state?.cloudRuntimes, targetId) : undefined
    const runtimeLocation = cloudEntry?.location === 'cloud' ? 'cloud' : 'local'

    let controllerConfig = null
    if (viaMode !== 'direct') {
      try {
        const res = await controllerRequest('GET', '/v1/voice/config', undefined, STATUS_TIMEOUT_MS)
        if (res?.ok && res.body && typeof res.body === 'object') {
          controllerConfig = res.body
        }
      } catch {}
    }

    const localKeyConfigured = viaMode !== 'controller' ? Boolean(await resolveOpenAiKey()) : false
    const controllerConfigured = Boolean(controllerConfig?.configured)

    let via = 'none'
    if (viaMode !== 'direct' && controllerConfigured) via = 'cloud-controller'
    else if (viaMode !== 'controller' && localKeyConfigured) via = 'openai-direct'

    return {
      available: via !== 'none',
      provider: 'openai',
      model: controllerConfig?.model ?? defaultModel,
      models: controllerConfig?.models ?? [...ALLOWED_LIVE_MODELS],
      defaultVoice: controllerConfig?.defaultVoice ?? defaultVoice,
      voices: controllerConfig?.voices ?? [...ALLOWED_LIVE_VOICES],
      dataChannel: controllerConfig?.dataChannel ?? LIVE_DATA_CHANNEL,
      standby: controllerConfig?.standby ?? {
        enabled: true,
        wakePolicy: 'speech',
        idleTimeoutS: defaultIdleTimeoutS,
        vadThreshold: defaultVadThreshold,
        activeRatePerMinUsd: 0.05,
        standbyRatePerMinUsd: 0.02,
      },
      via,
      runtimeLocation,
      controllerConfigured,
      localKeyConfigured,
    }
  }

  async function createSession(body = {}) {
    if (typeof body?.sessionId !== 'string' || body.sessionId === '') {
      throw invalid('sessionId is required')
    }
    if (typeof body?.sdp !== 'string' || body.sdp.trim() === '') {
      throw invalid('sdp is required')
    }
    if (typeof fetchImpl !== 'function') {
      throw unavailable('Fetch implementation is unavailable')
    }

    const targetId = targetIdOf(body.sessionId)
    const bot = targetId ? rt.botOf?.(targetId) : undefined
    const cloudEntry = targetId ? rt.own?.(rt.state?.cloudRuntimes, targetId) : undefined
    const runtimeLocation = cloudEntry?.location === 'cloud' ? 'cloud' : 'local'
    let recentSessionTurns = []
    try {
      const agent = typeof rt.resolveAgent === 'function' ? await rt.resolveAgent(body.sessionId) : null
      const derived = agent?.session?.deriveMessages?.()
      recentSessionTurns = extractRecentSessionTurns(derived, 8)
    } catch {}
    const instructions = buildVoiceInstructions(rt, body.sessionId, { recentSessionTurns })

    const model = body.model ?? defaultModel
    const voice = body.voice ?? defaultVoice
    const standby = body.standby !== false
    const idleTimeoutS = body.idleTimeoutS ?? defaultIdleTimeoutS
    const vadThreshold = body.vadThreshold ?? defaultVadThreshold

    // Validate payload up front so invalid SDP/params fail fast before touching upstream.
    const payload = buildOpenAiLivePayload({
      sdp: body.sdp,
      model,
      voice,
      instructions,
      standby,
      idleTimeoutS,
      vadThreshold,
    })

    if (viaMode !== 'direct') {
      const creds = readOperator()
      if (creds) {
        let controllerRes = null
        let controllerNetError = null
        try {
          controllerRes = await controllerRequest('POST', '/v1/voice/sessions', {
            sdp: body.sdp,
            botId: bot?.id ?? targetId,
            botName: bot?.name,
            botRole: bot?.role,
            instructions,
            voice,
            model,
            standby,
            idleTimeoutS,
            vadThreshold,
            ...(cloudEntry?.location === 'cloud' && cloudEntry.machineId ? { machineId: cloudEntry.machineId } : {}),
          })
        } catch (error) {
          controllerNetError = error
        }

        if (controllerRes?.ok && controllerRes.body?.sdp) {
          pruneSessions()
          const liveSessionId = String(controllerRes.body.liveSessionId || `live_${randomUUID()}`)
          activeSessions.set(liveSessionId, {
            via: 'cloud-controller',
            controllerBaseUrl: controllerRes.baseUrl,
            createdAt: Date.now(),
          })
          return {
            ...controllerRes.body,
            liveSessionId,
            via: 'cloud-controller',
            runtimeLocation,
          }
        }

        if (controllerRes) {
          if (controllerRes.status >= 400 && controllerRes.status < 500) {
            throw invalid(
              controllerRes.body?.error ?? `Cloud controller voice rejected request (HTTP ${controllerRes.status})`,
              controllerRes.status === 400 ? 'bot/invalid' : 'bot/refused',
            )
          }
          if (viaMode === 'controller' || controllerRes.status !== 501) {
            throw unavailable(
              controllerRes.body?.error ?? `Cloud controller voice failed (HTTP ${controllerRes.status})`,
            )
          }
        } else if (controllerNetError && viaMode === 'controller') {
          throw unavailable(`Cloud controller voice unreachable: ${controllerNetError?.message ?? controllerNetError}`)
        }
      } else if (viaMode === 'controller') {
        throw unavailable('Cloud controller operator credentials are not configured for voice')
      }
    }

    const apiKey = await resolveOpenAiKey()
    if (!apiKey) {
      throw unavailable('OpenAI API key is not configured for GPT-Live 1.1 voice. Set OPENAI_API_KEY or connect the Cloud Controller.')
    }

    const res = await fetchImpl(`${openaiBaseUrl}/live/sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!res.ok) {
      const detail = await readErrorDetail(res, apiKey)
      throw unavailable(`OpenAI Live API failed (HTTP ${res.status}): ${detail}`)
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
      throw unavailable('OpenAI Live API returned no SDP answer')
    }

    const resolvedId = String(liveSessionId || `live_${randomUUID()}`)
    pruneSessions()
    activeSessions.set(resolvedId, { via: 'openai-direct', createdAt: Date.now() })

    return {
      liveSessionId: resolvedId,
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
      via: 'openai-direct',
      runtimeLocation,
    }
  }

  async function closeSession(body = {}) {
    const liveSessionId = String(body?.liveSessionId ?? '').trim()
    if (!SESSION_ID_RE.test(liveSessionId)) {
      throw invalid('invalid liveSessionId')
    }
    const entry = activeSessions.get(liveSessionId)
    activeSessions.delete(liveSessionId)

    if (entry?.via === 'cloud-controller' || (entry === undefined && viaMode === 'controller')) {
      const creds = readOperator()
      if (creds && typeof fetchImpl === 'function') {
        await controllerRequest('DELETE', `/v1/voice/sessions/${encodeURIComponent(liveSessionId)}`).catch(() => {})
      }
      return { closed: true, liveSessionId }
    }

    const apiKey = await resolveOpenAiKey()
    if (apiKey && typeof fetchImpl === 'function') {
      await fetchImpl(`${openaiBaseUrl}/live/sessions/${encodeURIComponent(liveSessionId)}`, {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch(() => {})
    }
    return { closed: true, liveSessionId }
  }

  async function appendTranscript(body = {}) {
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    const targetId = targetIdOf(sessionId)
    if (!targetId) throw invalid('sessionId is required')
    const role = body?.role === 'assistant' ? 'assistant' : body?.role === 'user' ? 'user' : ''
    if (!role) throw invalid('role must be user or assistant')
    const text = String(body?.text ?? '').replace(/\s+/g, ' ').trim()
    if (!text) return { saved: false }

    if (!rt.state.voiceHistory || typeof rt.state.voiceHistory !== 'object') {
      rt.state.voiceHistory = {}
    }
    const prev = Array.isArray(rt.state.voiceHistory[targetId]) ? rt.state.voiceHistory[targetId] : []
    const cloudEntry = rt.own?.(rt.state?.cloudRuntimes, targetId)
    const runtimeLocation = cloudEntry?.location === 'cloud' ? 'cloud' : 'local'
    const item = { role, text: text.slice(0, 2000), at: Date.now(), location: runtimeLocation }
    rt.state.voiceHistory[targetId] = [...prev, item].slice(-MAX_VOICE_HISTORY)

    if (cloudEntry && typeof cloudEntry === 'object') {
      const label = role === 'assistant' ? `[Voice Assistant] ${item.text}` : `[Voice User] ${item.text}`
      cloudEntry.recentMessages = [...(cloudEntry.recentMessages ?? []), { text: label, at: item.at, delivered: true, source: 'voice' }].slice(-MAX_VOICE_HISTORY)
    }
    await rt.save?.()
    return { saved: true, count: rt.state.voiceHistory[targetId].length, runtimeLocation }
  }

  async function voiceEndpoint(endpoint, body = {}) {
    switch (endpoint) {
      case 'voice-status':
        return voiceStatus(body)
      case 'voice-session-create':
        return createSession(body)
      case 'voice-session-close':
        return closeSession(body)
      case 'voice-transcript-append':
        return appendTranscript(body)
      default:
        throw invalid(`Unknown voice endpoint ${endpoint}`, 'bot/not-found')
    }
  }

  Object.assign(rt, { voiceEndpoint })
}
