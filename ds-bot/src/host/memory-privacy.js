// Four-state memory privacy mode controller (`on` | `silent` | `incognito` | `off`)
// layered orthogonally atop `bot.private` isolation.
import { own } from './store.js'

export const MEMORY_MODES = new Set(['on', 'silent', 'incognito', 'off'])

export function normalizeMemoryMode(value, fallback = 'on') {
  if (typeof value !== 'string') return fallback
  const mode = value.trim().toLowerCase()
  return MEMORY_MODES.has(mode) ? mode : fallback
}

export function install(rt) {
  const { state } = rt

  function resolveMemoryMode({ botId, roomId, sessionId, client } = {}) {
    if (rt.memoryEnabled === false) return 'off'
    const clientMode = client?.memoryMode ? normalizeMemoryMode(client.memoryMode, '') : ''
    if (clientMode === 'off') return 'off'

    const sid = sessionId ?? (botId ? rt.chatOf?.(botId) : undefined)
    const sessionMode = sid ? own(state.sessionMemoryModes, sid) : undefined
    const botMode = botId ? rt.botOf?.(botId)?.memoryMode : undefined
    const roomMode = roomId ? rt.roomOf?.(roomId)?.memoryMode : undefined
    const prefMode = state.prefs?.memoryMode

    let resolved = normalizeMemoryMode(
      sessionMode ?? botMode ?? roomMode ?? prefMode,
      'on',
    )

    // A restricting client mode (`incognito` or `silent`) narrows an open local mode.
    if (clientMode === 'incognito' && (resolved === 'on' || resolved === 'silent')) resolved = 'incognito'
    else if (clientMode === 'silent' && resolved === 'on') resolved = 'silent'
    return resolved
  }

  const canReadMemory = (ctx = {}) => resolveMemoryMode(ctx) !== 'off'
  const canInjectMemory = (ctx = {}) => {
    const mode = resolveMemoryMode(ctx)
    return mode === 'on' || mode === 'incognito'
  }
  const canWriteMemory = (ctx = {}) => {
    const mode = resolveMemoryMode(ctx)
    return mode === 'on' || mode === 'silent'
  }

  async function setMemoryMode({ scope = 'global', id, mode } = {}) {
    await rt.load()
    const next = normalizeMemoryMode(mode, '')
    if (next === '') throw Object.assign(new Error(`Invalid memory mode "${String(mode ?? '')}"`), { code: 'bot/invalid' })
    const readOnly = rt.readOnly?.()
    if (readOnly !== undefined) throw Object.assign(new Error(readOnly), { code: 'bot/read-only' })

    if (scope === 'global') {
      state.prefs ??= {}
      state.prefs.memoryMode = next
      if (next === 'on') delete state.prefs.memoryAutoRecall
    } else if (scope === 'bot') {
      const bot = rt.botOf?.(String(id ?? ''))
      if (bot === undefined) throw Object.assign(new Error('Unknown Bot'), { code: 'bot/invalid' })
      bot.memoryMode = next
    } else if (scope === 'room') {
      const room = rt.roomOf?.(String(id ?? ''))
      if (room === undefined) throw Object.assign(new Error('Unknown group chat'), { code: 'bot/invalid' })
      room.memoryMode = next
    } else if (scope === 'session') {
      const sid = String(id ?? '').trim()
      if (sid === '') throw Object.assign(new Error('Session id is required'), { code: 'bot/invalid' })
      state.sessionMemoryModes ??= {}
      state.sessionMemoryModes[sid] = next
    } else {
      throw Object.assign(new Error(`Unknown scope "${scope}"`), { code: 'bot/invalid' })
    }
    await rt.save()
    return { scope, id: id ?? null, mode: next }
  }

  Object.assign(rt, {
    MEMORY_MODES,
    normalizeMemoryMode,
    resolveMemoryMode,
    canReadMemory,
    canInjectMemory,
    canWriteMemory,
    setMemoryMode,
  })
}
