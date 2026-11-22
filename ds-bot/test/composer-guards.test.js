import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import {
  installDraftDebounce,
  installPromptTimeout,
  isComposerSeatMutation,
  readComposerHeight,
  staleComposerDraftText,
} from '../src/client/composer-guards.js'

test('installPromptTimeout aborts stalled POST api/session/prompt and restores fetch', async () => {
  const calls = []
  const scope = {
    fetch: (input, init) => {
      calls.push({ input, init })
      if (String(input).includes('hang')) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
        })
      }
      return Promise.resolve({ ok: true })
    },
  }
  const dispose = installPromptTimeout({ scope, timeoutMs: 25 })
  try {
    // Non-prompt and GET requests pass through untouched.
    await scope.fetch('/api/session/prompt', { method: 'GET' })
    assert.equal(calls.at(-1).init.signal, undefined)
    await scope.fetch('/api/bot', { method: 'POST' })
    assert.equal(calls.at(-1).init.signal, undefined)

    // Stalled POST /api/session/prompt aborts with TimeoutError.
    await assert.rejects(
      () => scope.fetch('/api/session/prompt?hang=1', { method: 'POST' }),
      error => error?.name === 'TimeoutError',
    )

    // Caller signal abort propagates immediately.
    const outer = new AbortController()
    const pending = scope.fetch('/api/session/prompt?hang=2', { method: 'POST', signal: outer.signal })
    outer.abort(new Error('cancelled by caller'))
    await assert.rejects(() => pending, /cancelled by caller/)
  } finally {
    dispose()
  }
  assert.equal(scope.__dsBotPromptTimeoutPatched, false)
})

test('installDraftDebounce coalesces draft writes and flushes on clear or pagehide', async () => {
  const writes = []
  const backing = new Map()
  class FakeStorage {
    setItem(key, value) { writes.push([key, value]); backing.set(key, value) }
    getItem(key) { return backing.has(key) ? backing.get(key) : null }
    removeItem(key) { backing.delete(key) }
  }
  const storage = new FakeStorage()
  const listeners = new Map()
  const target = {
    visibilityState: 'visible',
    addEventListener(type, fn) { listeners.set(type, fn) },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type) },
  }
  const scope = {}
  const dispose = installDraftDebounce({
    scope,
    storage,
    storageProto: FakeStorage.prototype,
    doc: target,
    win: target,
    delayMs: 40,
  })
  try {
    // Unrelated keys write through immediately.
    storage.setItem('other.key', '1')
    assert.deepEqual(writes, [['other.key', '1']])

    // Rapid draft writes coalesce while getItem returns the latest value.
    storage.setItem('dsh.conversation:s1', '{"draft":"h"}')
    storage.setItem('dsh.conversation:s1', '{"draft":"hi"}')
    assert.equal(writes.length, 1)
    assert.equal(storage.getItem('dsh.conversation:s1'), '{"draft":"hi"}')

    // Clearing the draft flushes synchronously.
    storage.setItem('dsh.conversation:s1', '{"draft":""}')
    assert.deepEqual(writes.at(-1), ['dsh.conversation:s1', '{"draft":""}'])

    // Pending writes flush on pagehide.
    storage.setItem('dsh.conversation:s2', '{"draft":"keep"}')
    assert.equal(writes.length, 2)
    listeners.get('pagehide')()
    assert.deepEqual(writes.at(-1), ['dsh.conversation:s2', '{"draft":"keep"}'])

    // Pending writes flush when document hides.
    storage.setItem('dsh.conversation:s3', '{"draft":"tab"}')
    target.visibilityState = 'hidden'
    listeners.get('visibilitychange')()
    assert.deepEqual(writes.at(-1), ['dsh.conversation:s3', '{"draft":"tab"}'])

    // Debounce timer flushes on its own when idle.
    storage.setItem('dsh.conversation:s4', '{"draft":"idle"}')
    await new Promise(resolve => setTimeout(resolve, 65))
    assert.deepEqual(writes.at(-1), ['dsh.conversation:s4', '{"draft":"idle"}'])
  } finally {
    dispose()
  }
  assert.equal(scope.__dsBotDraftDebouncePatched, false)
  assert.equal(listeners.size, 0)
})

test('isComposerSeatMutation and readComposerHeight isolate composer edits', () => {
  const seatEl = { closest: selector => (selector === '[data-composer-seat]' ? seatEl : null) }
  const textNode = { parentElement: seatEl }
  const outsideEl = { closest: () => null }
  assert.equal(isComposerSeatMutation([]), false)
  assert.equal(isComposerSeatMutation([{ target: seatEl }, { target: textNode }]), true)
  assert.equal(isComposerSeatMutation([{ target: seatEl }, { target: outsideEl }]), false)

  let computedCalls = 0
  const scroller = { style: { getPropertyValue: prop => (prop === '--dsh-composer-height' ? '184px' : '') } }
  assert.equal(readComposerHeight(scroller, 152, () => { computedCalls += 1; return { getPropertyValue: () => '200px' } }), 184)
  assert.equal(computedCalls, 0)
  const emptyScroller = { style: { getPropertyValue: () => '' } }
  assert.equal(readComposerHeight(emptyScroller, 152, () => { computedCalls += 1; return { getPropertyValue: () => '196px' } }), 196)
  assert.equal(computedCalls, 1)
})

test('staleComposerDraftText recovers non-empty DOM text only when draft is empty and idle', () => {
  const makeBox = ({ text = 'hello\u00a0world\n', composing = false, decorator = false, editable = true } = {}) => ({
    isContentEditable: editable,
    innerText: text,
    hasAttribute: attr => composing && attr === 'data-composer-composing',
    querySelector: sel => (decorator && sel === '[data-lexical-decorator]' ? {} : null),
  })
  assert.equal(staleComposerDraftText(makeBox(), ''), 'hello world')
  assert.equal(staleComposerDraftText(makeBox(), 'hello world'), null)
  assert.equal(staleComposerDraftText(makeBox({ composing: true }), ''), null)
  assert.equal(staleComposerDraftText(makeBox({ decorator: true }), ''), null)
  assert.equal(staleComposerDraftText(makeBox({ editable: false }), ''), null)
  assert.equal(staleComposerDraftText(makeBox({ text: '   \n' }), ''), null)
})

test('composer CSS drops per-keystroke :has() rules, isolates input scroll, preserves sending button, and disables touch blur', async () => {
  const { outputFiles } = await build({
    stdin: {
      contents: "export { CONVERSATION_CSS } from './src/client/styles.js'",
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    },
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const mod = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module: mod, exports: mod.exports,
    require: () => ({}),
  })
  const { CONVERSATION_CSS } = mod.exports
  assert.doesNotMatch(CONVERSATION_CSS, /\[data-composer-card\]:has\(\[data-composer-input\]/)
  assert.match(CONVERSATION_CSS, /\[data-composer-card\]>\[data-input-scroll\]\{[^}]*contain:layout style/)
  assert.match(CONVERSATION_CSS, /button\[class\*="_primary"\]:disabled:not\(\[data-sending\]\)\{display:none!important\}/)
  assert.match(CONVERSATION_CSS, /@media \(hover:none\)\{\s*\[data-composer-card\]\{-webkit-backdrop-filter:none!important;backdrop-filter:none!important;background:var\(--bt-card\)!important\}/)
})

test('ComposerVoice syncs stale draft after compositionend without re-rendering on keystrokes', async () => {
  const { outputFiles } = await build({
    stdin: {
      contents: "export { ComposerVoice } from './src/client/composer.js'",
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    },
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const effects = []
  const react = {
    createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
    useContext: ctx => ctx.value,
    useCallback: fn => fn,
    useSyncExternalStore: (_sub, getSnapshot) => getSnapshot(),
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    Fragment: Symbol('Fragment'),
    useEffect: fn => { effects.push(fn) },
    useLayoutEffect: () => {},
    useMemo: make => make(),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: current => ({ current }),
    useId: () => 'id',
  }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, setTimeout, clearTimeout,
    require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: n => n } : {}),
    window: {}, document: { querySelector: () => null }, navigator: { language: 'en-US' },
  })
  const { ComposerVoice } = module.exports
  const listeners = new Map()
  const box = {
    isContentEditable: true,
    innerText: '你好',
    hasAttribute: () => false,
    querySelector: () => null,
  }
  const card = {
    querySelector: sel => (sel === '[data-composer-input]' ? box : null),
    addEventListener(type, fn) { listeners.set(type, fn) },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type) },
  }
  const synced = []
  let selectedValue = 'unset'
  const tree = ComposerVoice({
    sessionId: 'bot-1',
    inputActions: { setDraft: text => synced.push(text), insertText: () => true, captureInsertion: () => ({}) },
    useInput: (select) => { selectedValue = select({ draft: '' }); return selectedValue },
    actions: { speech: () => undefined, clearQuote: () => {}, openVoice: () => {} },
    useUi: select => select({ quote: null }),
    useRoster: select => select({ prefs: {} }),
  })
  // Selector returns null so ComposerVoice stays off the per-keystroke render path.
  assert.equal(selectedValue, null)
  const voiceBtn = tree.props.children.find(node => node?.props?.className === 'bt-voice')
  voiceBtn.props.ref.current = { closest: sel => (sel === '[data-composer-card]' ? card : null) }
  const cleanups = effects.map(fn => fn()).filter(fn => typeof fn === 'function')
  try {
    listeners.get('compositionstart')()
    listeners.get('compositionend')()
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.deepEqual(synced, ['你好'])
  } finally {
    for (const off of cleanups) off()
  }
  assert.equal(listeners.size, 0)
})
