export const PROMPT_TIMEOUT_MS = 20_000
export const DRAFT_DEBOUNCE_MS = 300

const PROMPT_PATH = /(?:^|\/)api\/session\/prompt(?:\?|$)/
const DRAFT_PREFIX = 'dsh.conversation'

// Typing inside the composer mutates Lexical DOM under [data-composer-seat];
// transcript pinning only needs height changes (ResizeObserver), not text edits.
export function isComposerSeatMutation(records) {
  if (!Array.isArray(records) || records.length === 0) return false
  return records.every((record) => {
    const node = record?.target
    const el = typeof node?.closest === 'function' ? node : node?.parentElement
    return el !== null && el !== undefined && typeof el.closest === 'function' && el.closest('[data-composer-seat]') !== null
  })
}

export function readComposerHeight(scroller, fallback = 152, computeStyle = globalThis.getComputedStyle) {
  const inline = scroller?.style?.getPropertyValue?.('--dsh-composer-height') ?? ''
  const raw = inline || (typeof computeStyle === 'function' && scroller ? computeStyle(scroller)?.getPropertyValue?.('--dsh-composer-height') ?? '' : '')
  return parseFloat(raw) || fallback
}

// Recover from IME / compositionend desyncs where Lexical shows typed text in the
// DOM while the shell's draft store stayed empty (leaving the send arrow hidden).
export function staleComposerDraftText(box, currentDraft) {
  if (!box || box.isContentEditable !== true) return null
  if (typeof box.hasAttribute === 'function' && box.hasAttribute('data-composer-composing')) return null
  if (typeof box.querySelector === 'function' && box.querySelector('[data-lexical-decorator]') !== null) return null
  const domText = String(box.innerText ?? box.textContent ?? '').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n')
  if (domText.trim() !== '' && String(currentDraft ?? '').trim() === '') {
    return domText.replace(/\n+$/, '')
  }
  return null
}

export function installPromptTimeout({ scope = globalThis, timeoutMs = PROMPT_TIMEOUT_MS } = {}) {
  if (typeof scope?.fetch !== 'function' || scope.__dsBotPromptTimeoutPatched) return () => {}
  const origFetch = scope.fetch
  const rawFetch = origFetch.bind(scope)
  const wrappedFetch = function wrappedPromptFetch(input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? ''
    const method = (init?.method ?? (typeof input === 'object' && input !== null && 'method' in input ? input.method : 'GET') ?? 'GET').toUpperCase()
    if (method !== 'POST' || !PROMPT_PATH.test(url)) return rawFetch(input, init)
    const controller = new AbortController()
    const outer = init?.signal ?? (typeof input === 'object' && input !== null && 'signal' in input ? input.signal : undefined)
    const onOuterAbort = () => controller.abort(outer?.reason)
    if (outer) {
      if (outer.aborted) controller.abort(outer.reason)
      else outer.addEventListener('abort', onOuterAbort, { once: true })
    }
    const timer = setTimeout(() => {
      const error = typeof DOMException === 'function'
        ? new DOMException('Send timed out after 20s — please retry', 'TimeoutError')
        : Object.assign(new Error('Send timed out after 20s — please retry'), { name: 'TimeoutError' })
      controller.abort(error)
    }, timeoutMs)
    return rawFetch(input, { ...init, signal: controller.signal }).finally(() => {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuterAbort)
    })
  }
  scope.__dsBotPromptTimeoutPatched = true
  scope.fetch = wrappedFetch
  return () => {
    if (scope.fetch === wrappedFetch) scope.fetch = origFetch
    scope.__dsBotPromptTimeoutPatched = false
  }
}

export function installDraftDebounce({
  scope = globalThis,
  storage = typeof localStorage !== 'undefined' ? localStorage : undefined,
  storageProto = typeof Storage !== 'undefined' ? Storage.prototype : undefined,
  doc = typeof document !== 'undefined' ? document : undefined,
  win = typeof window !== 'undefined' ? window : undefined,
  delayMs = DRAFT_DEBOUNCE_MS,
} = {}) {
  if (!storage || !storageProto || scope.__dsBotDraftDebouncePatched) return () => {}
  const rawSet = storageProto.setItem
  const rawGet = storageProto.getItem
  const rawRemove = storageProto.removeItem
  const pending = new Map()
  let flushTimer = 0
  const isDraftKey = key => typeof key === 'string' && key.startsWith(DRAFT_PREFIX)
  const flushAll = () => {
    clearTimeout(flushTimer)
    flushTimer = 0
    if (pending.size === 0) return
    for (const [key, value] of pending) {
      try { rawSet.call(storage, key, value) } catch {}
    }
    pending.clear()
  }
  const wrappedSet = function wrappedSetItem(key, value) {
    if (this !== storage || !isDraftKey(key)) return rawSet.call(this, key, value)
    const str = String(value)
    if (str.includes('"draft":""')) {
      pending.delete(key)
      return rawSet.call(this, key, str)
    }
    pending.set(key, str)
    clearTimeout(flushTimer)
    flushTimer = setTimeout(flushAll, delayMs)
  }
  const wrappedGet = function wrappedGetItem(key) {
    if (this === storage && pending.has(key)) return pending.get(key)
    return rawGet.call(this, key)
  }
  const wrappedRemove = function wrappedRemoveItem(key) {
    if (this === storage) pending.delete(key)
    return rawRemove.call(this, key)
  }
  const onVis = () => { if (doc?.visibilityState === 'hidden') flushAll() }
  scope.__dsBotDraftDebouncePatched = true
  storageProto.setItem = wrappedSet
  storageProto.getItem = wrappedGet
  storageProto.removeItem = wrappedRemove
  win?.addEventListener?.('pagehide', flushAll)
  doc?.addEventListener?.('visibilitychange', onVis)
  return () => {
    flushAll()
    if (storageProto.setItem === wrappedSet) storageProto.setItem = rawSet
    if (storageProto.getItem === wrappedGet) storageProto.getItem = rawGet
    if (storageProto.removeItem === wrappedRemove) storageProto.removeItem = rawRemove
    win?.removeEventListener?.('pagehide', flushAll)
    doc?.removeEventListener?.('visibilitychange', onVis)
    scope.__dsBotDraftDebouncePatched = false
  }
}

export function installComposerGuards(options = {}) {
  const cleanups = [
    installPromptTimeout(options),
    installDraftDebounce(options),
  ]
  return () => {
    for (const off of cleanups) off()
  }
}
