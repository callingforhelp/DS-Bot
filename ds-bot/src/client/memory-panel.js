// The memory dialog of a Bot or a group chat (`owner`: { id, name, group }): a summary
// a model writes from every saved entry, the entries themselves behind the ⋯ menu,
// and "Ask or update", one model call that answers from the entries or changes them.
// Modeled on ChatGPT's memory summary.
import { createElement as h, Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { useEscape } from './overlay-hooks.js'
import { ArrowUpIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, DotsIcon, MemoryIcon, MoveIcon, PinIcon, TrashIcon } from './icons.js'
import { dateLocale, hostText, t } from './i18n.js'
import { summaryBlocks } from './text.js'
import { stepMenuFocus, useLinger } from './motion.js'

const POLL_MS = 1500
const MENU_EXIT_MS = 120
const MOVE_MENU_GAP = 12

// Entry counts per Bot or group, for the details pane; the dialog updates them as it loads.
const counts = new Map()
const countListeners = new Set()
function noteCount(id, count) {
  if (counts.get(id) === count) return
  counts.set(id, count)
  for (const listener of countListeners) listener()
}

// A menu closes on a press outside it or on Escape, without closing the dialog under it.
function useMenuDismiss(open, menuRef, triggerRef, close) {
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (menuRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return
      close()
    }
    const onKey = (event) => {
      if (stepMenuFocus(menuRef.current, event, triggerRef.current)) return
      if (event.key === 'Escape') { event.stopPropagation(); close(); triggerRef.current?.focus() }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])
}

export function useMemoryCount(id, actions) {
  const [count, setCount] = useState(counts.get(id) ?? null)
  useEffect(() => {
    const listener = () => setCount(counts.get(id) ?? null)
    countListeners.add(listener)
    listener()
    let stop = false
    actions.memoryView?.(id).then((view) => { if (!stop) noteCount(id, view.entries.length) }).catch(() => {})
    return () => { stop = true; countListeners.delete(listener) }
  }, [id])
  return count
}

// The details pane's row: how much the Bot or group keeps, and the way into the dialog.
export function MemoryRow({ owner, actions }) {
  const count = useMemoryCount(owner.id, actions)
  const label = count === null ? t('Loading…') : count === 0 ? t('Nothing saved yet') : count === 1 ? t('1 entry') : t('{count} entries', { count })
  return h('div', null,
    h('div', { className: 'bt-section-title' }, t('Memory')),
    h('button', { type: 'button', className: 'bt-mem-row', 'aria-label': t("Manage {name}'s memory", { name: owner.name }), onClick: () => actions.openMemory(owner.id) },
      h(MemoryIcon),
      h('span', { className: 'bt-mem-row-copy' }, label),
      h('span', { className: 'bt-mem-row-go' }, t('Manage'), h(ChevronRightIcon))))
}

function ago(at, now) {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return null
  const format = new Intl.RelativeTimeFormat(dateLocale(), { numeric: 'auto' })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return format.format(-minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours < 24) return format.format(-hours, 'hour')
  return format.format(-Math.round(hours / 24), 'day')
}

function Skeleton({ label }) {
  return h('div', { className: 'bt-mem-skel', 'aria-busy': true },
    [0, 1].map(block => h('div', { key: block, className: 'bt-mem-skel-block' },
      h('span', { className: 'bt-mem-skel-head' }),
      h('span', null), h('span', null), h('span', { style: { width: block === 0 ? '62%' : '48%' } }))),
    label ? h('div', { className: 'bt-mem-skel-label' }, label) : null)
}

function Summary({ owner, view, regenerate }) {
  if (view.entries.length === 0) {
    return h('div', { className: 'bt-mem-empty' },
      h('div', { className: 'bt-mem-empty-mark' }, h(MemoryIcon)),
      h('div', { className: 'bt-mem-empty-title' }, owner.group ? t('Nothing is saved for this group yet') : t('{name} has not saved anything yet', { name: owner.name })),
      h('div', { className: 'bt-mem-empty-text' }, owner.group
        ? t('A group keeps the decisions, rules, and facts its work needs, for its members to read here. Tell it below, or in the group.')
        : t('Bots keep lasting preferences, decisions, and what you ask them to remember. Tell {name} below, or in its chat.', { name: owner.name })))
  }
  const failed = view.error && !view.summarizing
    ? h('div', { className: 'bt-mem-failed', role: 'alert' },
        h('span', null, view.summary ? t('The summary is out of date: {reason}', { reason: hostText(view.error) }) : t('The summary could not be written: {reason}', { reason: hostText(view.error) })),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: regenerate }, t('Try again')))
    : null
  if (!view.summary) return h(Fragment, null, failed, failed ? null : h(Skeleton, { label: t('Writing the summary…') }))
  return h(Fragment, null, failed,
    h('div', { key: view.summary.at, className: 'bt-mem-summary', 'data-stale': !view.fresh || undefined },
      summaryBlocks(view.summary.text).map((block, index) => (block.kind === 'h'
        ? h('h3', { key: index }, block.text)
        : h('p', { key: index }, block.text)))))
}

const groupEntries = entries => entries.reduce((groups, entry) => {
  const key = `${entry.scope}:${entry.topic ?? ''}`
  const group = groups.find(item => item.key === key)
  if (group) group.entries.push(entry)
  else groups.push({ key, scope: entry.scope, topic: entry.topic, entries: [entry] })
  return groups
}, [])

export const MEMORY_MODES = ['on', 'silent', 'incognito', 'off']

export function memoryModeLabel(mode) {
  switch (mode) {
    case 'silent': return t('Silent')
    case 'incognito': return t('Incognito')
    case 'off': return t('Off')
    default: return t('On')
  }
}

export function provenanceBadges(entry) {
  const badges = []
  const sha = entry?.commitSha ?? entry?.provenance?.commitSha
  if (sha) badges.push({ kind: 'commit', label: String(sha).slice(0, 7), value: String(sha) })
  const pr = entry?.prNumber ?? entry?.provenance?.prNumber
  if (pr) badges.push({ kind: 'pr', label: `#${pr}`, value: String(pr) })
  const file = entry?.filePath ?? entry?.provenance?.filePath
  if (file && badges.length === 0) badges.push({ kind: 'file', label: String(file).split('/').pop(), value: String(file) })
  return badges
}

function EntryRow({ entry, remove, pin, layer, openMove, onProvenance }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(false), 3000)
    return () => clearTimeout(timer)
  }, [confirming])
  const by = entry.source === 'memory panel' ? t('by you') : entry.by ? t('by {name}', { name: entry.by }) : null
  const until = entry.until ? t(entry.expired ? 'ended {day}' : 'until {day}', { day: entry.until }) : null
  const meta = [entry.added, by, until].filter(Boolean).join(' · ')
  const badges = provenanceBadges(entry)
  const click = async () => {
    if (!confirming) { setConfirming(true); return }
    setBusy(true)
    if (!await remove(entry)) setBusy(false)
  }
  return h('li', { className: 'bt-mem-entry', 'data-busy': busy || undefined },
    h('div', { className: 'bt-mem-entry-copy' },
      h('span', { className: 'bt-mem-entry-text' }, entry.text),
      badges.length > 0 ? h('span', { className: 'bt-mem-prov-row' }, badges.map(badge => h('button', {
        key: `${badge.kind}:${badge.value}`, type: 'button', className: 'bt-chip bt-mem-prov',
        title: badge.value, onClick: () => onProvenance?.(entry, badge),
      }, badge.label))) : null,
      meta ? h('span', { className: 'bt-mem-entry-meta' }, meta) : null),
    h('button', {
      type: 'button', className: 'bt-mem-remove bt-mem-pin', 'data-on': entry.pinned || undefined, disabled: busy, 'aria-pressed': entry.pinned,
      'aria-label': entry.pinned ? t('Unpin') : t('Pin'), title: entry.pinned ? t('Unpin') : t('Pin'), onClick: () => pin(entry, !entry.pinned),
    }, h(PinIcon)),
    entry.scope === 'team' ? h('button', {
      type: 'button', className: 'bt-mem-place', disabled: busy, onClick: () => layer(entry, entry.topic !== null),
    }, entry.topic === null ? t('Only when needed') : t('Every conversation')) : null,
    h('button', {
      type: 'button', className: 'bt-mem-remove', disabled: busy, 'aria-haspopup': 'menu',
      'aria-label': t('Move to…'), title: t('Move to…'), onClick: event => openMove(entry, event.currentTarget),
    }, h(MoveIcon)),
    h('button', {
      type: 'button', className: 'bt-mem-remove', 'data-confirm': confirming || undefined, disabled: busy,
      'aria-label': confirming ? t('Click again to remove') : t('Remove from memory'), title: confirming ? undefined : t('Remove from memory'), onClick: click,
    }, confirming ? t('Remove') : h(TrashIcon)))
}

// Where an entry can go: the team's memory, a Bot's, or a group chat's.
function MoveMenu({ menuRef, moving, view, move, leaving }) {
  const { entry, box } = moving
  const here = view.keys[entry.scope]
  const item = (key, label) => h('button', { key, type: 'button', role: 'menuitem', onClick: () => move(entry, key) }, h('span', { className: 'bt-menu-label' }, label))
  const list = (kind, head) => {
    const places = view.places.filter(place => place.kind === kind && place.key !== here)
    return places.length === 0 ? null : h(Fragment, { key: kind }, h('div', { className: 'bt-menu-sub-head' }, head), places.map(place => item(place.key, place.name)))
  }
  return h('div', { ref: menuRef, className: 'bt-menu bt-mem-move', role: 'menu', 'aria-label': t('Move to…'), style: box, 'data-leaving': leaving || undefined },
    here === 'team' ? null : item('team', t('Team memory')),
    list('bot', t('Bots')),
    list('group', t('Group chats')))
}

function TidyNote({ tidy, undo }) {
  const [busy, setBusy] = useState(false)
  const line = t('Tidied: {merged} merged, {moved} moved, {retired} archived', { merged: tidy.merged, moved: tidy.moved, retired: tidy.retired })
  return h('details', { className: 'bt-mem-tidy' },
    h('summary', null, h('span', null, line),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: async (event) => { event.preventDefault(); setBusy(true); await undo(tidy); setBusy(false) } }, t('Undo'))),
    h('ul', null, tidy.items.map((item, at) => h('li', { key: at }, item.text))))
}

function Entries({ owner, view, remove, pin, layer, openMove, undoTidy, onProvenance, searchHits, searching, searchQuery }) {
  const filtered = searchQuery.trim() !== '' && Array.isArray(searchHits)
    ? searchHits
    : view.entries
  const groups = groupEntries(filtered)
  const sections = owner.group
    ? [{ scope: 'group', title: t('Group memory'), hint: t('Only its members read it'), size: view.sizes.group }]
    : [
        { scope: 'own', title: t("{name}'s memory", { name: owner.name }), size: view.sizes.own },
        { scope: 'team', title: t('Team memory'), hint: t('Every Bot reads it'), size: view.sizes.team },
      ]
  return h('div', { className: 'bt-mem-entries' },
    searching ? h('div', { className: 'bt-mem-none' }, t('Searching…')) : null,
    view.tidy ? h(TidyNote, { tidy: view.tidy, undo: undoTidy }) : null,
    sections.map(section => h('section', { key: section.scope, className: 'bt-mem-section' },
      h('div', { className: 'bt-mem-section-head' },
        h('h3', null, section.title),
        section.hint ? h('span', null, section.hint) : null,
        h('span', { className: 'bt-mem-size', title: t('MEMORY.md, which every conversation reads') }, t('{used} of {limit} characters', { used: section.size.toLocaleString(dateLocale()), limit: view.limits[section.scope].toLocaleString(dateLocale()) }))),
      groups.some(group => group.scope === section.scope)
        ? groups.filter(group => group.scope === section.scope).map(group => h(Fragment, { key: group.key },
            group.topic ? h('div', { className: 'bt-mem-topic' }, group.topic) : null,
            h('ul', { className: 'bt-mem-list' }, group.entries.map(entry => h(EntryRow, { key: `${entry.topic ?? ''}:${entry.text}`, entry, remove, pin, layer, openMove, onProvenance })))))
        : h('div', { className: 'bt-mem-none' }, searchQuery.trim() ? t('No matching entries') : t('Nothing saved yet')))))
}

function changeLine(change) {
  const text = change.text.length > 120 ? `${change.text.slice(0, 120)}…` : change.text
  if (!change.ok) return t('Not changed: {text} ({reason})', { text, reason: hostText(change.error ?? '') })
  if (change.op === 'remove') return change.scope === 'team' ? t('Removed from team memory: {text}', { text }) : t('Removed: {text}', { text })
  if (change.op === 'edit') return t('Updated: {text}', { text })
  return change.scope === 'team' ? t('Added to team memory: {text}', { text }) : t('Added: {text}', { text })
}

function historyLine(row) {
  const text = row.text.length > 120 ? `${row.text.slice(0, 120)}…` : row.text
  if (row.op === 'remove') return row.scope === 'team' ? t('Removed from team memory: {text}', { text }) : t('Removed: {text}', { text })
  if (row.op === 'replace') return t('Updated: {text}', { text })
  return row.scope === 'team' ? t('Added to team memory: {text}', { text }) : t('Added: {text}', { text })
}

export function HistoryRow({ row, undo, now }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(false), 3000)
    return () => clearTimeout(timer)
  }, [confirming])
  const when = ago(Date.parse(row.time), now) ?? t('just now')
  const meta = [when, row.by === 'user' ? t('by you') : t('by {name}', { name: row.by })].join(' · ')
  const click = async () => {
    if (!confirming) { setConfirming(true); return }
    setBusy(true)
    if (!await undo(row)) setBusy(false)
  }
  return h('li', { className: 'bt-mem-entry', 'data-busy': busy || undefined },
    h('div', { className: 'bt-mem-entry-copy' },
      h('span', { className: 'bt-mem-entry-text' }, historyLine(row)),
      h('span', { className: 'bt-mem-entry-meta' }, meta)),
    row.restored
      ? h('span', { className: 'bt-mem-undone' }, t('Undone'))
      : h('button', {
        type: 'button', className: 'bt-mem-remove', 'data-confirm': confirming || undefined, disabled: busy,
        'aria-label': confirming ? t('Click again to undo') : t('Undo this change'), title: confirming ? undefined : t('Undo this change'), onClick: click,
      }, t('Undo')))
}

export function History({ owner, actions, undo, now }) {
  const [rows, setRows] = useState(null)
  const [more, setMore] = useState(null)
  const [paging, setPaging] = useState(false)
  const [loadError, setLoadError] = useState('')
  const load = useCallback(async (before) => {
    try {
      setLoadError('')
      const page = await actions.memoryHistory(owner.id, before)
      setRows(prev => (before === undefined ? page.rows : [...(prev ?? []), ...page.rows]))
      setMore(page.more)
    } catch (failure) {
      setLoadError(failure?.message ?? String(failure))
      setRows(prev => prev ?? [])
    }
  }, [owner.id])
  useEffect(() => { void load() }, [owner.id])
  const reload = async () => { setRows(null); setMore(null); await load() }
  const undoRow = async row => (await undo(row) ? reload() : false)
  const moreClick = async () => {
    setPaging(true)
    try { await load(more) } finally { setPaging(false) }
  }
  if (rows === null) return h(Skeleton)
  if (loadError) return h('div', { className: 'bt-error', role: 'alert' }, hostText(loadError))
  if (rows.length === 0) return h('div', { className: 'bt-mem-none' }, t('No changes yet'))
  return h('div', { className: 'bt-mem-entries' },
    h('ul', { className: 'bt-mem-list' }, rows.map(row => h(HistoryRow, { key: row.id, row, undo: undoRow, now }))),
    more ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: paging, onClick: () => void moreClick() }, t('Load more')) : null)
}

function Reply({ answer, dismiss }) {
  return h('div', { className: 'bt-mem-reply', role: 'status' },
    h('div', { className: 'bt-mem-reply-head' },
      h('span', { className: 'bt-mem-reply-asked' }, answer.asked),
      answer.pending ? null : h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Dismiss'), onClick: dismiss }, h(CloseIcon))),
    answer.pending ? h('div', { className: 'bt-mem-reply-text bt-shimmer' }, t('Thinking…'))
      : answer.error ? h('div', { className: 'bt-mem-reply-text bt-danger' }, hostText(answer.error))
        : h(Fragment, null,
            answer.reply ? h('div', { className: 'bt-mem-reply-text' }, answer.reply) : null,
            answer.changes.length > 0
              ? h('ul', { className: 'bt-mem-changes' }, answer.changes.map((change, index) => h('li', { key: index, 'data-ok': change.ok || undefined },
                  change.ok ? h(CheckIcon) : h(CloseIcon), h('span', null, changeLine(change)))))
              : null))
}

// The view as the host has it, loaded again while a summary is being written. Only the
// latest request's answer counts.
function useMemoryView(id, actions) {
  const [view, setView] = useState(null)
  const [error, setError] = useState('')
  const timer = useRef(0)
  const latest = useRef(0)
  const alive = useRef(true)
  const show = useCallback((next) => {
    setView(next)
    setError('')
    noteCount(id, next.entries.length)
  }, [id])
  const load = useCallback(async (flags = {}) => {
    clearTimeout(timer.current)
    const ticket = ++latest.current
    try {
      const next = await actions.memoryView(id, flags)
      if (!alive.current || ticket !== latest.current) return
      show(next)
      if (next.summarizing) timer.current = setTimeout(() => void load({ summarize: flags.summarize || flags.regenerate }), POLL_MS)
    } catch (failure) {
      if (alive.current && ticket === latest.current) setError(failure?.message ?? String(failure))
    }
  }, [id])
  useEffect(() => {
    alive.current = true
    void load({ summarize: true })
    return () => { alive.current = false; clearTimeout(timer.current) }
  }, [id])
  return { view, error, load, show }
}

function useNow(every) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(id)
  }, [every])
  return now
}

export function MemoryDialog({ owner, actions, leaving = false }) {
  const { view, error, load, show } = useMemoryView(owner.id, actions)
  const [page, setPage] = useState('summary')
  const [menu, setMenu] = useState(false)
  const [menuShown, menuLeaving] = useLinger(menu, MENU_EXIT_MS)
  const [moving, setMoving] = useState(null)
  const [moveOpen, setMoveOpen] = useState(false)
  const [moveShown, moveLeaving] = useLinger(moveOpen, MENU_EXIT_MS)
  const moveRef = useRef(null)
  const moveAnchor = useRef(null)
  const [text, setText] = useState('')
  const [answer, setAnswer] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState(null)
  const [searching, setSearching] = useState(false)
  const [mode, setMode] = useState(null)
  const [importMode, setImportMode] = useState(null)
  const [importText, setImportText] = useState('')
  const menuRef = useRef(null)
  const dotsRef = useRef(null)
  const inputRef = useRef(null)
  const now = useNow(30_000)
  const close = useCallback(() => actions.closeMemory(), [])
  useEscape(close, !leaving)
  useMenuDismiss(menu, menuRef, dotsRef, () => setMenu(false))
  useMenuDismiss(moveOpen, moveRef, moveAnchor, () => setMoveOpen(false))
  useEffect(() => {
    if (!moveOpen) return undefined
    const onScroll = (event) => { if (!moveRef.current?.contains(event.target)) setMoveOpen(false) }
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [moveOpen])
  const openMove = (entry, button) => {
    if (moveOpen && moveAnchor.current === button) { setMoveOpen(false); return }
    moveAnchor.current = button
    const rect = button.getBoundingClientRect()
    const below = window.innerHeight - rect.bottom - MOVE_MENU_GAP
    const above = rect.top - MOVE_MENU_GAP
    const right = Math.max(MOVE_MENU_GAP, window.innerWidth - rect.right)
    setMoving({
      entry,
      box: above > below
        ? { right, bottom: window.innerHeight - rect.top + 4, maxHeight: above, '--bt-origin': 'bottom right' }
        : { right, top: rect.bottom + 4, maxHeight: below, '--bt-origin': 'top right' },
    })
    setMoveOpen(true)
  }
  const regenerate = () => { setMenu(false); setPage('summary'); void load({ regenerate: true }) }
  const openEntries = () => { setMenu(false); setPage('entries') }
  const openHistory = () => { setMenu(false); setPage('history') }
  const openImport = (kind) => { setMenu(false); setImportMode(kind); setImportText('') }
  const backToSummary = () => { setPage('summary'); setSearchQuery(''); setSearchHits(null); void load({ summarize: true }) }
  const activeMode = mode ?? view?.mode ?? 'on'
  const changeMode = async (nextMode) => {
    setMode(nextMode)
    try { await actions.setMemoryMode?.(owner.sessionId ?? owner.id, nextMode) } catch (failure) {
      setAnswer({ asked: memoryModeLabel(nextMode), error: failure?.message ?? String(failure) })
    }
  }
  const onProvenance = async (entry, badge) => {
    try {
      const result = await actions.memoryProvenance?.(owner.id, { kind: badge.kind, value: badge.value, text: entry.text })
      if (result) setAnswer({ asked: `${badge.label}`, reply: result.summary ?? result.message ?? JSON.stringify(result) })
    } catch (failure) {
      setAnswer({ asked: badge.label, error: failure?.message ?? String(failure) })
    }
  }
  const submitImport = async (event) => {
    event.preventDefault()
    const value = importText.trim()
    if (!value) return
    try {
      if (importMode === 'takeover') await actions.memoryTakeover?.(owner.id, { sourceSessionId: value })
      else await actions.memoryImport?.(owner.id, { path: value })
      setImportMode(null)
      setImportText('')
      void load({ summarize: page === 'summary' })
    } catch (failure) {
      setAnswer({ asked: value, error: failure?.message ?? String(failure) })
    }
  }
  useEffect(() => {
    const q = searchQuery.trim()
    if (q === '') { setSearchHits(null); setSearching(false); return undefined }
    setPage('entries')
    let cancelled = false
    setSearching(true)
    const timer = setTimeout(() => {
      if (!actions.memorySearch) {
        const lower = q.toLowerCase()
        setSearchHits((view?.entries ?? []).filter(entry => String(entry.text ?? '').toLowerCase().includes(lower) || String(entry.topic ?? '').toLowerCase().includes(lower)))
        setSearching(false)
        return
      }
      void Promise.resolve(actions.memorySearch(owner.id, q))
        .then(result => { if (!cancelled) setSearchHits(result?.entries ?? result?.results ?? []) })
        .catch(() => {
          if (!cancelled) {
            const lower = q.toLowerCase()
            setSearchHits((view?.entries ?? []).filter(entry => String(entry.text ?? '').toLowerCase().includes(lower)))
          }
        })
        .finally(() => { if (!cancelled) setSearching(false) })
    }, 180)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [searchQuery, owner.id])
  const remove = async (entry) => {
    try {
      show(await actions.memoryForget(owner.id, entry))
      return true
    } catch (failure) {
      setAnswer({ asked: entry.text, error: failure?.message ?? String(failure) })
      return false
    }
  }
  const undoTidy = async (tidy) => {
    try {
      show(await actions.memoryTidyUndo(owner.id, tidy.scope, tidy.batch))
    } catch (failure) {
      setAnswer({ asked: t('Undo'), error: failure?.message ?? String(failure) })
    }
  }
  const move = async (entry, to) => {
    setMoveOpen(false)
    try {
      show(await actions.memoryMove(owner.id, entry, to))
    } catch (failure) {
      setAnswer({ asked: entry.text, error: failure?.message ?? String(failure) })
    }
  }
  const layer = async (entry, always) => {
    try {
      show(await actions.memoryLayer(owner.id, entry, always))
    } catch (failure) {
      setAnswer({ asked: entry.text, error: failure?.message ?? String(failure) })
    }
  }
  const pin = async (entry, on) => {
    try {
      show(await actions.memoryPin(owner.id, entry, on))
    } catch (failure) {
      setAnswer({ asked: entry.text, error: failure?.message ?? String(failure) })
    }
  }
  const undo = async (row) => {
    try {
      show(await actions.memoryRestore(owner.id, row.id))
      return true
    } catch (failure) {
      setAnswer({ asked: row.text, error: failure?.message ?? String(failure) })
      return false
    }
  }
  const ask = async (event) => {
    event.preventDefault()
    const asked = text.trim()
    if (asked === '' || answer?.pending) return
    setText('')
    setAnswer({ asked, pending: true })
    try {
      const result = await actions.memoryAsk(owner.id, asked)
      setAnswer({ asked, reply: result.reply, changes: result.changes })
      show(result.view)
      if (result.changes.some(change => change.ok)) void load({ summarize: page === 'summary' })
    } catch (failure) {
      setAnswer({ asked, error: failure?.message ?? String(failure) })
    }
    inputRef.current?.focus()
  }

  const count = view?.entries.length ?? 0
  const when = view?.summary ? ago(view.summary.at, now) : null
  const status = view === null ? ''
    : page === 'entries' ? (count === 1 ? t('1 entry') : t('{count} entries', { count }))
      : view.summarizing && view.summary ? t('Updating…')
        : view.summary && view.fresh ? (when ? t('Updated {time}', { time: when }) : t('Updated just now'))
          : ''
  const busy = answer?.pending === true
  return h('div', { className: 'bt-mem-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-scrim bt-mem-scrim', onMouseDown: close }),
    h('div', { className: 'bt-mem', role: 'dialog', 'aria-modal': true, 'aria-label': t("{name}'s memory", { name: owner.name }) },
      h('div', { className: 'bt-mem-head' },
        page === 'summary' ? null : h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back to the summary'), onClick: backToSummary }, h(ChevronLeftIcon)),
        h('h2', null, page === 'entries' ? t('All entries') : page === 'history' ? t('Change history') : t('Memory summary')),
        h('span', { className: 'bt-mem-status' }, page === 'summary' ? [owner.name, status].filter(Boolean).join(' · ') : page === 'entries' ? status : ''),
        h('span', { className: 'bt-mem-head-gap' }),
        h('button', { ref: dotsRef, type: 'button', className: 'bt-icon-btn', 'aria-label': t('Memory options'), 'aria-haspopup': 'menu', 'aria-expanded': menu, onClick: () => setMenu(value => !value) }, h(DotsIcon)),
        h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close memory'), onClick: close }, h(CloseIcon)),
        menuShown ? h('div', { ref: menuRef, className: 'bt-menu bt-mem-menu', role: 'menu', 'aria-label': t('Memory options'), 'data-leaving': menuLeaving || undefined },
          h('button', { type: 'button', role: 'menuitem', onClick: openEntries },
            h('span', { className: 'bt-menu-label' }, t('All entries')), h('span', { className: 'bt-menu-hint' }, String(count))),
          h('button', { type: 'button', role: 'menuitem', onClick: openHistory },
            h('span', { className: 'bt-menu-label' }, t('Change history'))),
          h('button', { type: 'button', role: 'menuitem', disabled: count === 0 || view?.summarizing, onClick: regenerate },
            h('span', { className: 'bt-menu-label' }, t('Regenerate summary'))),
          h('button', { type: 'button', role: 'menuitem', onClick: () => openImport('import') },
            h('span', { className: 'bt-menu-label' }, t('Import transcript'))),
          h('button', { type: 'button', role: 'menuitem', onClick: () => openImport('takeover') },
            h('span', { className: 'bt-menu-label' }, t('Session takeover')))) : null),
      h('div', { className: 'bt-mem-toolbar' },
        h('input', {
          type: 'search', className: 'bt-mem-search', value: searchQuery,
          placeholder: t('Search memory…'), 'aria-label': t('Search memory'),
          onChange: event => setSearchQuery(event.target.value),
        }),
        h('div', { className: 'bt-seg bt-mem-mode', role: 'radiogroup', 'aria-label': t('Memory privacy mode') },
          MEMORY_MODES.map(item => h('button', {
            key: item, type: 'button', role: 'radio', 'aria-checked': activeMode === item,
            className: 'bt-seg-btn', onClick: () => void changeMode(item),
          }, memoryModeLabel(item))))),
      importMode ? h('form', { className: 'bt-mem-import', onSubmit: submitImport },
        h('input', {
          className: 'bt-mem-search', value: importText, autoFocus: true,
          placeholder: importMode === 'takeover' ? t('Source session id or path') : t('Transcript file path or JSONL'),
          onChange: event => setImportText(event.target.value),
        }),
        h('button', { type: 'submit', className: 'bt-soft bt-soft-sm' }, importMode === 'takeover' ? t('Take over') : t('Import')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setImportMode(null) }, t('Cancel'))) : null,
      h('div', { className: 'bt-mem-body' },
        error ? h('div', { className: 'bt-error', role: 'alert', style: { padding: 0 } }, hostText(error)) : null,
        view === null ? (error ? null : h(Skeleton))
          : page === 'entries' ? h(Entries, { owner, view, remove, pin, layer, openMove, undoTidy, onProvenance, searchHits, searching, searchQuery })
            : page === 'history' ? h(History, { owner, actions, undo, now })
              : h(Summary, { owner, view, regenerate })),
      h('div', { className: 'bt-mem-foot' },
        answer ? h(Reply, { answer, dismiss: () => setAnswer(null) }) : null,
        h('form', { className: 'bt-mem-ask', onSubmit: ask },
          h('input', {
            ref: inputRef, className: 'bt-mem-input', value: text, maxLength: 2000, disabled: view === null,
            placeholder: t('Ask or update'), 'aria-label': t("Ask about or update {name}'s memory", { name: owner.name }),
            onChange: event => setText(event.target.value),
          }),
          h('button', { type: 'submit', className: 'bt-mem-send', disabled: busy || text.trim() === '', 'aria-label': t('Send') },
            busy ? h('span', { className: 'bt-mem-spin', 'aria-hidden': true }) : h(ArrowUpIcon))))),
    moveShown && moving !== null && view !== null ? h(MoveMenu, { menuRef: moveRef, moving, view, move, leaving: moveLeaving }) : null)
}
