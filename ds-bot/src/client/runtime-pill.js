import { createElement as h, Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDownLeftIcon, ArrowUpRightIcon, ChevronDownIcon, CloseIcon, CloudIcon, MonitorIcon } from './icons.js'
import { SPRING_TAP, useViewport, viewBottom } from './motion.js'
import { t } from './i18n.js'

const keepFocus = event => event.preventDefault()

const TARGET_LABEL = {
  local: () => t('Local · Mac'),
  cloud: () => t('Cloud · AWS'),
  sleeping: () => t('Cloud · Sleeping'),
  offline: () => t('Cloud · Cached'),
  toCloud: () => t('Handing off…'),
  toLocal: () => t('Pulling to Local…'),
  error: () => t('Cloud error'),
}

export function runtimeOf(roster, sessionId) {
  const cloud = roster?.cloudRuntime
  const bot = sessionId ? roster?.byId?.[sessionId] : undefined
  const room = sessionId ? roster?.roomsById?.[sessionId] : undefined
  const targetId = bot?.id ?? room?.id ?? sessionId
  const entry = cloud?.team ?? (targetId && cloud?.sessions?.[targetId]) ?? cloud?.sessions?.__team__ ?? null
  const location = entry?.location === 'cloud' ? 'cloud' : 'local'
  const phase = entry?.phase ?? 'idle'
  const queuedCount = Array.isArray(entry?.queuedMessages) ? entry.queuedMessages.length : 0

  let dotTone = 'local'
  let label = TARGET_LABEL.local()
  let shortLabel = t('Local')
  if (phase === 'handing-off-to-cloud') {
    dotTone = 'cloud'
    label = TARGET_LABEL.toCloud()
    shortLabel = label
  } else if (phase === 'pulling-to-local') {
    dotTone = 'local'
    label = TARGET_LABEL.toLocal()
    shortLabel = label
  } else if (phase === 'error') {
    dotTone = 'error'
    label = TARGET_LABEL.error()
    shortLabel = label
  } else if (location === 'cloud') {
    if (phase === 'cached-offline' || cloud?.controllerOnline === false) {
      dotTone = 'offline'
      label = TARGET_LABEL.offline()
      shortLabel = label
    } else if (phase === 'sleeping') {
      dotTone = 'sleeping'
      label = TARGET_LABEL.sleeping()
      shortLabel = label
    } else {
      dotTone = 'cloud'
      label = TARGET_LABEL.cloud()
      shortLabel = label
    }
  }

  return {
    targetId,
    location,
    phase,
    dotTone,
    label,
    shortLabel,
    machineId: entry?.machineId ?? null,
    machineName: entry?.machineName ?? null,
    branch: entry?.branch ?? null,
    scope: entry?.scope ?? 'branch',
    syncedAt: entry?.lastSyncedAt ?? cloud?.syncedAt ?? null,
    queuedCount,
    lastTransition: entry?.lastTransition ?? null,
    dismissedTransitionId: entry?.dismissedTransitionId ?? null,
    controllerOnline: Boolean(cloud?.controllerOnline),
    configured: Boolean(cloud?.configured),
    machines: Array.isArray(cloud?.machines) ? cloud.machines : [],
    error: entry?.error ?? null,
  }
}

function formatSyncTime(iso) {
  if (!iso) return '—'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '—'
  const diff = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (diff < 10) return t('Just now')
  if (diff < 60) return `${diff}s`
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function HandoffPopover({ sessionId, runtime, anchorRect, upward, actions, onClose }) {
  const popRef = useRef(null)
  const [targetSide, setTargetSide] = useState(runtime.location)
  const [preflight, setPreflight] = useState(null)
  const [scope, setScope] = useState('auto')
  const [pushWip, setPushWip] = useState(true)
  const [keepOfflineFork, setKeepOfflineFork] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState(null)

  useEffect(() => {
    setTargetSide(runtime.location)
    setLocalError(null)
  }, [sessionId, runtime.location])

  useEffect(() => {
    let active = true
    if (typeof actions?.cloudPreflight !== 'function') return undefined
    void actions.cloudPreflight(sessionId)
      .then((info) => { if (active && info) setPreflight(info) })
      .catch(() => {})
    return () => { active = false }
  }, [sessionId])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onDown = (event) => {
      if (!popRef.current?.contains(event.target)) onClose()
    }
    const onKey = (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  const controllerOnline = preflight?.controllerOnline ?? runtime.controllerOnline
  const switching = targetSide !== runtime.location
  const effectiveScope = scope === 'auto' ? (preflight?.defaultScope ?? 'branch') : scope
  const hasDirty = preflight?.isGitRepo && (preflight?.dirtyCount ?? 0) > 0
  const needsWipDecision = targetSide === 'cloud' && switching && effectiveScope === 'branch' && hasDirty && !pushWip
  const needsOfflineConfirm = targetSide === 'local' && switching && !controllerOnline && !keepOfflineFork

  const posStyle = useMemo(() => {
    if (!anchorRect || typeof window === 'undefined') return {}
    const left = Math.min(Math.max(12, anchorRect.left), Math.max(12, window.innerWidth - 332))
    if (upward) return { left, bottom: Math.max(12, viewBottom() - anchorRect.top + 8) }
    return { left, top: Math.round(anchorRect.bottom + 8) }
  }, [anchorRect, upward])

  const refresh = async () => {
    setBusy(true)
    setLocalError(null)
    try { await actions?.cloudStatus?.() } catch (e) { setLocalError(e?.message ?? String(e)) }
    finally { setBusy(false) }
  }

  const confirmSwitch = async () => {
    setBusy(true)
    setLocalError(null)
    try {
      if (targetSide === 'cloud') {
        await actions?.handoffToCloud?.({ sessionId, scope: effectiveScope, pushWip, note })
      } else {
        await actions?.handoffToLocal?.({ sessionId, pullBranch: true, keepOfflineFork })
      }
      onClose()
    } catch (error) {
      setLocalError(error?.message ?? String(error))
    } finally {
      setBusy(false)
    }
  }

  const stateText = controllerOnline ? t('Online') : t('Offline')

  return h('div', {
    ref: popRef,
    className: upward ? 'bt-rt-pop bt-rt-pop-up' : 'bt-rt-pop',
    role: 'dialog',
    'aria-label': t('Execution environment'),
    style: posStyle,
  },
  h('div', { className: 'bt-rt-pop-head' },
    h('span', { className: 'bt-rt-pop-title' }, t('Execution environment')),
    h('button', { type: 'button', className: 'bt-rt-refresh', disabled: busy, onClick: refresh }, t('Refresh'))),
  h('div', { className: 'bt-rt-seg', role: 'radiogroup', 'aria-label': t('Execution environment') },
    h('button', {
      type: 'button', role: 'radio', 'aria-checked': targetSide === 'local',
      className: 'bt-rt-seg-btn', 'data-active': targetSide === 'local' ? '' : undefined,
      onClick: () => { setTargetSide('local'); setLocalError(null) },
    }, h(MonitorIcon), h('span', null, t('Local (Mac)'))),
    h('button', {
      type: 'button', role: 'radio', 'aria-checked': targetSide === 'cloud',
      className: 'bt-rt-seg-btn', 'data-active': targetSide === 'cloud' ? '' : undefined,
      onClick: () => { setTargetSide('cloud'); setLocalError(null) },
    }, h(CloudIcon), h('span', null, t('Cloud (AWS)')))),
  h('dl', { className: 'bt-rt-meta' },
    h('div', { className: 'bt-rt-meta-row' }, h('dt', null, t('Machine')), h('dd', null, runtime.machineName ?? (runtime.location === 'local' ? t('Local (Mac)') : 'ds-bot-dsh'))),
    h('div', { className: 'bt-rt-meta-row' }, h('dt', null, t('State')), h('dd', null, `${runtime.label} · ${stateText}`)),
    h('div', { className: 'bt-rt-meta-row' }, h('dt', null, t('Branch')), h('dd', null, runtime.branch ?? preflight?.branch ?? '—')),
    h('div', { className: 'bt-rt-meta-row' }, h('dt', null, t('Last synced')), h('dd', null, formatSyncTime(runtime.syncedAt)))),
  switching && targetSide === 'cloud' ? h('div', { className: 'bt-rt-handoff' },
    preflight?.isGitRepo ? h('div', { className: 'bt-rt-scope' },
      h('button', {
        type: 'button', className: 'bt-rt-scope-btn', 'data-active': effectiveScope === 'branch' ? '' : undefined,
        onClick: () => setScope('branch'),
      }, t('Branch + summary')),
      h('button', {
        type: 'button', className: 'bt-rt-scope-btn', 'data-active': effectiveScope === 'summary' ? '' : undefined,
        onClick: () => setScope('summary'),
      }, t('Summary only'))) : null,
    effectiveScope === 'branch' && hasDirty ? h('div', { className: 'bt-rt-warn' },
      h('p', null, t('Uncommitted local changes will stay untouched unless you push a WIP branch or choose summary only.')),
      h('label', { className: 'bt-rt-check' },
        h('input', { type: 'checkbox', checked: pushWip, onChange: e => setPushWip(e.target.checked) }),
        h('span', null, t('Push WIP branch & hand off')))) : null,
    h('input', {
      type: 'text', className: 'bt-rt-note', value: note,
      placeholder: t('Optional handoff note'),
      onChange: e => setNote(e.target.value),
    })) : null,
  switching && targetSide === 'local' && !controllerOnline ? h('div', { className: 'bt-rt-warn' },
    h('p', null, t('Controller is offline. Pull from cache to continue locally as a fork.')),
    h('label', { className: 'bt-rt-check' },
      h('input', { type: 'checkbox', checked: keepOfflineFork, onChange: e => setKeepOfflineFork(e.target.checked) }),
      h('span', null, t('Continue locally (offline fork)')))) : null,
  localError || runtime.error ? h('p', { className: 'bt-rt-err', role: 'alert' }, localError ?? runtime.error) : null,
  switching ? h('div', { className: 'bt-rt-foot' },
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: onClose }, t('Cancel')),
    h('button', {
      type: 'button', className: 'bt-mini bt-rt-go',
      disabled: busy || needsWipDecision || needsOfflineConfirm || (targetSide === 'cloud' && !controllerOnline),
      onClick: confirmSwitch,
    },
    targetSide === 'cloud' ? h(ArrowUpRightIcon) : h(ArrowDownLeftIcon),
    h('span', null, targetSide === 'cloud' ? t('Hand off to Cloud') : t('Pull to Local')))) : null)
}

export function RuntimeStatusPill({ sessionId, useRoster, actions }) {
  const roster = useRoster(value => value)
  const [open, setOpen] = useState(false)
  const btnRef = useRef(null)
  const tick = useViewport()
  const runtime = runtimeOf(roster, sessionId)
  const rect = useMemo(() => (open && btnRef.current ? btnRef.current.getBoundingClientRect() : null), [open, tick])

  if (sessionId === undefined) return null
  return h('div', { className: 'bt-rt-wrap' },
    h('button', {
      ref: btnRef,
      type: 'button',
      className: 'bt-pill bt-rt-pill',
      'data-tone': runtime.dotTone,
      'aria-expanded': open,
      'aria-haspopup': 'dialog',
      'aria-label': runtime.label,
      onClick: () => setOpen(v => !v),
    },
    h('span', { className: 'bt-rt-dot', 'data-tone': runtime.dotTone, 'aria-hidden': true }),
    h('span', { className: 'bt-rt-label' }, runtime.label),
    h('span', { className: 'bt-rt-chev', 'aria-hidden': true }, h(ChevronDownIcon))),
    open && typeof createPortal === 'function' && typeof document !== 'undefined' ? createPortal(
      h(HandoffPopover, { sessionId, runtime, anchorRect: rect, upward: false, actions, onClose: () => setOpen(false) }),
      document.body) : null)
}

export function SidebarRuntimeSwitch({ sessionId = '__team__', useRoster, actions }) {
  const roster = useRoster(value => value)
  const [open, setOpen] = useState(false)
  const btnRef = useRef(null)
  const tick = useViewport()
  const runtime = runtimeOf(roster, sessionId)
  const rect = useMemo(() => (open && btnRef.current ? btnRef.current.getBoundingClientRect() : null), [open, tick])
  const portal = open && typeof createPortal === 'function' && typeof document !== 'undefined'

  return h('div', { className: 'bt-rt-side-wrap' },
    h('button', {
      ref: btnRef,
      type: 'button',
      className: 'bt-rt-side',
      'data-tone': runtime.dotTone,
      'aria-expanded': open,
      'aria-haspopup': 'dialog',
      'aria-label': runtime.label,
      onClick: () => setOpen(v => !v),
    },
    h('span', { className: 'bt-rt-dot', 'data-tone': runtime.dotTone, 'aria-hidden': true }),
    h('span', { className: 'bt-rt-side-label' }, runtime.label),
    runtime.location === 'cloud' && runtime.machineName
      ? h('span', { className: 'bt-rt-side-machine' }, runtime.machineName)
      : null,
    h('span', { className: 'bt-rt-chev', 'aria-hidden': true }, h(ChevronDownIcon))),
    portal ? createPortal(
      h(HandoffPopover, { sessionId, runtime, anchorRect: rect, upward: false, actions, onClose: () => setOpen(false) }),
      document.body) : null)
}

export function ComposerRuntimeChip({ sessionId, useRoster, actions }) {
  const roster = useRoster(value => value)
  const [open, setOpen] = useState(false)
  const btnRef = useRef(null)
  const tick = useViewport()
  const runtime = runtimeOf(roster, sessionId)
  const rect = useMemo(() => (open && btnRef.current ? btnRef.current.getBoundingClientRect() : null), [open, tick])

  if (sessionId === undefined || (roster?.byId?.[sessionId] === undefined && roster?.roomsById?.[sessionId] === undefined)) {
    return null
  }
  return h(Fragment, null,
    h('button', {
      ref: btnRef,
      type: 'button',
      className: 'bt-rt-chip',
      'data-tone': runtime.dotTone,
      'aria-expanded': open,
      'aria-haspopup': 'dialog',
      title: runtime.label,
      onMouseDown: keepFocus,
      onClick: () => setOpen(v => !v),
    },
    h('span', { className: 'bt-rt-dot', 'data-tone': runtime.dotTone, 'aria-hidden': true }),
    h('span', { className: 'bt-rt-chip-label' }, runtime.shortLabel),
    h('span', { className: 'bt-rt-chev', 'aria-hidden': true }, h(ChevronDownIcon))),
    open && typeof createPortal === 'function' && typeof document !== 'undefined' ? createPortal(
      h(HandoffPopover, { sessionId, runtime, anchorRect: rect, upward: true, actions, onClose: () => setOpen(false) }),
      document.body) : null)
}

export function RuntimeBadge({ runtime }) {
  if (!runtime) return null
  const active = runtime.location === 'cloud'
    || runtime.phase === 'handing-off-to-cloud'
    || runtime.phase === 'pulling-to-local'
  if (!active) return null
  return h('span', { className: 'bt-rt-sbadge', 'data-tone': runtime.dotTone, title: runtime.label, 'aria-label': runtime.label },
    h(CloudIcon),
    h('span', { className: 'bt-rt-dot', 'data-tone': runtime.dotTone, 'aria-hidden': true }))
}

export function CloudHandoffDock({ sessionId, useRoster, actions }) {
  const roster = useRoster(value => value)
  const runtime = runtimeOf(roster, sessionId)
  if (sessionId === undefined) return null

  const tr = runtime.lastTransition
  const showTransition = Boolean(tr && tr.id !== runtime.dismissedTransitionId)
  const showOffline = runtime.location === 'cloud' && runtime.phase === 'cached-offline'
  if (!showTransition && !showOffline) return null

  return h('div', { className: 'bt-rt-dock' },
    showTransition ? h('section', { className: 'bt-q bt-handoff bt-rt-card', role: 'status' },
      h('div', { className: 'bt-rt-card-row' },
        h('span', { className: 'bt-rt-card-ico', 'aria-hidden': true }, tr.direction === 'to-cloud' ? h(ArrowUpRightIcon) : h(ArrowDownLeftIcon)),
        h('div', { className: 'bt-rt-card-body' },
          h('div', { className: 'bt-rt-card-title' }, tr.direction === 'to-cloud' ? t('Handed off to Cloud') : t('Returned to Local')),
          h('div', { className: 'bt-rt-card-sub' }, [tr.machineName, tr.branch, tr.summary].filter(Boolean).join(' · '))),
        h('button', {
          type: 'button', className: 'bt-icon-btn bt-rt-close', 'aria-label': t('Dismiss'), title: t('Dismiss'),
          onClick: () => actions?.dismissCloudHandoff?.(sessionId),
        }, h(CloseIcon)))) : null,
    showOffline ? h('div', { className: 'bt-rt-offline', role: 'status' },
      h('span', { className: 'bt-rt-dot', 'data-tone': 'offline', 'aria-hidden': true }),
      h('span', { className: 'bt-rt-offline-text' },
        `${t('Offline cache')} · ${t('Last synced')}: ${formatSyncTime(runtime.syncedAt)}${runtime.queuedCount > 0 ? ` · ${t('Queued messages')}: ${runtime.queuedCount}` : ''}`),
      h('button', {
        type: 'button', className: 'bt-soft bt-soft-sm',
        onClick: () => actions?.handoffToLocal?.({ sessionId, keepOfflineFork: true }),
      }, t('Pull to Local'))) : null)
}

export const RUNTIME_CSS = `
.bt-rt-wrap{pointer-events:auto;position:relative;display:inline-flex;align-items:center;margin-left:6px}
.bt-rt-side-wrap{padding:2px 8px 6px}
.bt-rt-side{width:100%;display:flex;align-items:center;gap:7px;height:30px;padding:0 10px;border-radius:10px;border:.5px solid var(--bt-line);background:var(--bt-card);color:var(--bt-ink);font-family:inherit;font-size:12px;line-height:16px;font-weight:500;cursor:pointer;box-sizing:border-box;transition:background-color .12s ease}
.bt-rt-side:hover{background:var(--bt-hover)}
.bt-rt-side[data-tone=cloud]{border-color:color-mix(in srgb,var(--bt-accent) 36%,transparent);background:color-mix(in srgb,var(--bt-accent) 10%,transparent)}
.bt-rt-side-label{white-space:nowrap;font-weight:500}
.bt-rt-side-machine{margin-left:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--bt-ink-2)}
.bt-rt-pill{height:34px;padding:4px 10px;gap:6px;font-size:12.5px;line-height:18px;max-width:none;transition:background-color .12s ease,transform ${SPRING_TAP.duration}ms ${SPRING_TAP.easing}}
.bt-rt-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--bt-green)}
.bt-rt-dot[data-tone=cloud]{background:var(--bt-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--bt-accent) 20%,transparent)}
.bt-rt-dot[data-tone=sleeping]{background:var(--bt-star)}
.bt-rt-dot[data-tone=offline]{background:var(--bt-ink-3)}
.bt-rt-dot[data-tone=error]{background:var(--bt-danger)}
.bt-rt-label{white-space:nowrap;font-weight:500}
.bt-rt-chev{display:inline-flex;color:var(--bt-ink-2);width:12px;height:12px;align-items:center;justify-content:center}
.bt-rt-chev svg{width:12px;height:12px}
.bt-rt-chip{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 9px;border-radius:999px;border:.5px solid var(--bt-line);background:var(--bt-tag-bg);color:var(--bt-ink-2);font-family:inherit;font-size:12px;line-height:16px;font-weight:500;cursor:pointer;margin-left:4px;transition:background-color .12s ease}
.bt-rt-chip:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-rt-chip[data-tone=cloud]{border-color:color-mix(in srgb,var(--bt-accent) 36%,transparent);background:color-mix(in srgb,var(--bt-accent) 12%,transparent);color:var(--bt-ink)}
.bt-rt-chip-label{white-space:nowrap}
.bt-rt-sbadge{display:inline-flex;align-items:center;gap:3px;padding:1px 5px;border-radius:999px;background:color-mix(in srgb,var(--bt-accent) 12%,transparent);color:var(--bt-accent);flex:none}
.bt-rt-sbadge svg{width:11px;height:11px}
.bt-rt-sbadge .bt-rt-dot{width:5px;height:5px;box-shadow:none}
.bt-rt-sbadge[data-tone=offline]{background:var(--bt-tag-bg);color:var(--bt-ink-2)}
.bt-rt-pop{position:fixed;z-index:60;width:320px;padding:12px;border-radius:16px;background:var(--bt-glass-bg);-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);border:.5px solid var(--bt-glass-rim);box-shadow:var(--bt-dialog-shadow);color:var(--bt-ink);font-family:var(--bt-font);box-sizing:border-box}
.bt-rt-pop-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.bt-rt-pop-title{font-size:12px;font-weight:600;color:var(--bt-ink-2)}
.bt-rt-refresh{border:0;background:transparent;color:var(--bt-accent);font-family:inherit;font-size:12px;font-weight:500;cursor:pointer;padding:2px 6px;border-radius:6px}
.bt-rt-refresh:hover{background:var(--bt-accent-soft)}
.bt-rt-seg{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:3px;border-radius:10px;background:var(--bt-tag-bg);border:.5px solid var(--bt-line);margin-bottom:10px}
.bt-rt-seg-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--bt-ink-2);font-family:inherit;font-size:12.5px;font-weight:500;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.bt-rt-seg-btn svg{width:14px;height:14px}
.bt-rt-seg-btn[data-active]{background:var(--bt-card);color:var(--bt-ink);box-shadow:var(--bt-card-shadow)}
.bt-rt-meta{margin:0;display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:10px;background:var(--bt-card);border:.5px solid var(--bt-line)}
.bt-rt-meta-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;line-height:17px}
.bt-rt-meta-row dt{color:var(--bt-ink-2);margin:0}
.bt-rt-meta-row dd{color:var(--bt-ink);margin:0;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:190px;font-weight:500}
.bt-rt-handoff{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.bt-rt-scope{display:grid;grid-template-columns:1fr 1fr;gap:4px}
.bt-rt-scope-btn{height:28px;border-radius:8px;border:.5px solid var(--bt-line);background:var(--bt-card);color:var(--bt-ink-2);font-family:inherit;font-size:12px;cursor:pointer}
.bt-rt-scope-btn[data-active]{border-color:var(--bt-accent);background:var(--bt-accent-soft);color:var(--bt-ink);font-weight:500}
.bt-rt-warn{margin-top:4px;padding:8px 10px;border-radius:10px;background:color-mix(in srgb,var(--bt-star) 12%,transparent);border:.5px solid color-mix(in srgb,var(--bt-star) 35%,transparent);font-size:12px;line-height:17px;color:var(--bt-ink)}
.bt-rt-warn p{margin:0 0 6px}
.bt-rt-check{display:flex;align-items:center;gap:6px;font-weight:500;cursor:pointer}
.bt-rt-note{width:100%;box-sizing:border-box;height:30px;padding:0 9px;border-radius:8px;border:.5px solid var(--bt-line-2);background:var(--bt-card);color:var(--bt-ink);font-family:inherit;font-size:12px}
.bt-rt-err{margin:6px 0 0;padding:6px 8px;border-radius:8px;background:var(--bt-danger-soft);color:var(--bt-danger);font-size:12px;line-height:16px}
.bt-rt-foot{display:flex;align-items:center;justify-content:flex-end;gap:6px;margin-top:10px}
.bt-rt-go{display:inline-flex;align-items:center;gap:4px}
.bt-rt-go svg{width:13px;height:13px}
.bt-rt-dock{display:flex;flex-direction:column;gap:6px;margin:0 0 6px}
.bt-rt-card{padding:8px 10px;border-radius:12px;border:.5px solid var(--bt-line);background:var(--bt-card);box-shadow:var(--bt-card-shadow)}
.bt-rt-card-row{display:flex;align-items:center;gap:8px}
.bt-rt-card-ico{display:inline-flex;width:18px;height:18px;align-items:center;justify-content:center;border-radius:6px;background:var(--bt-accent-soft);color:var(--bt-accent);flex:none}
.bt-rt-card-ico svg{width:13px;height:13px}
.bt-rt-card-body{min-width:0;flex:1 1 auto}
.bt-rt-card-title{font-size:12.5px;font-weight:600;line-height:17px;color:var(--bt-ink)}
.bt-rt-card-sub{font-size:12px;line-height:16px;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-rt-offline{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:12px;border:.5px solid var(--bt-line);background:var(--bt-card);font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-rt-offline-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (prefers-reduced-motion:reduce){.bt-rt-pill,.bt-rt-chip,.bt-rt-seg-btn{transition:none!important}}
body:is([data-bt-effects=reduced],[data-bt-effects=off]) .bt-rt-pop{-webkit-backdrop-filter:none!important;backdrop-filter:none!important}
`
