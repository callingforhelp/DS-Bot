import { createElement as h, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDownIcon } from './icons.js'
import { SPRING_TAP, useMorph } from './motion.js'
import { TaskReaderView } from './bot-tasks.js'
import { sendsOnEnter, isImeComposing } from './enter-key.js'
import { relativeShort } from './text.js'
import { hostText, t } from './i18n.js'
import {
  BOARD_POLL_MS,
  WORKER_STATES,
  channelsOf,
  inChannel,
  isLiveSwarm,
  isQuotaWorker,
  mergePosts,
  postBadge,
  postParts,
  swarmCounts,
  swarmPodLabel,
  swarmsForSession,
  workersOf,
} from './swarm-model.js'

export {
  BOARD_POLL_MS,
  WORKER_STATES,
  channelsOf,
  inChannel,
  isLiveSwarm,
  isQuotaWorker,
  mergePosts,
  postBadge,
  postParts,
  swarmCounts,
  swarmPodLabel,
  swarmsForSession,
  workersOf,
}

// -------------------------------------------------------------------------
// Native swarm UI:
// - Header pod (`SwarmIslandPod`): `N working · M waiting · K quota`, one bar in
//   the same island surface as the task pod; a click opens the swarm in the panel.
// - Right-panel board (`SwarmBoardPanel`): roster strip, channel tabs, the
//   monotonic `#seq` feed, an operator composer, and `Close & Ingest Swarm`.

const BADGES = { done: 'Done', stall: 'Stalled', quota: 'Quota' }

const stateOf = worker => (isQuotaWorker(worker) ? 'quota' : (worker.state ?? worker.status ?? 'waiting'))
const stateLabel = state => (state === 'working' ? t('Working') : state === 'quota' ? t('Quota') : state === 'stopped' ? t('Stopped') : t('Waiting'))
const modelText = (model) => {
  if (!model) return ''
  if (typeof model === 'string') return model
  return model.model ? `${model.provider ? `${model.provider}/` : ''}${model.model}` : ''
}

export function SwarmIslandPod({ swarms = [], targetId, actions }) {
  const box = useRef(null)
  const live = swarms.filter(isLiveSwarm)
  const counts = live.reduce((sum, swarm) => {
    const next = swarmCounts(swarm)
    return { working: sum.working + next.working, waiting: sum.waiting + next.waiting, quota: sum.quota + next.quota }
  }, { working: 0, waiting: 0, quota: 0 })
  useMorph(box, `${counts.working}:${counts.waiting}:${counts.quota}`, { width: true })
  if (live.length === 0) return null
  const label = swarmPodLabel(counts)
  return h('button', {
    ref: box,
    type: 'button',
    className: 'bt-task-bar bt-swarm-bar',
    'data-quota': counts.quota > 0 || undefined,
    'aria-label': label,
    title: label,
    onClick: () => actions.openSwarm?.(targetId, live[0].id),
  },
  h('span', { className: 'bt-swarm-dot', 'data-state': counts.quota > 0 ? 'quota' : counts.working > 0 ? 'working' : 'waiting', 'aria-hidden': true }),
  h('span', { className: 'bt-task-bar-label' }, label),
  h('span', { className: 'bt-goal-chev', 'aria-hidden': true }, h(ChevronDownIcon)))
}

function PostText({ text, onJump }) {
  return h('span', { className: 'bt-swarm-text' }, postParts(text).map((part, index) => {
    if (part.type === 'mention') return h('span', { key: index, className: 'bt-swarm-mention' }, part.value)
    if (part.type === 'seq') {
      return h('button', { key: index, type: 'button', className: 'bt-swarm-ref', onClick: () => onJump(Number(part.value.slice(1))) }, part.value)
    }
    return h(Fragment, { key: index }, part.value)
  }))
}

function ModelSwitcher({ swarm, worker, actions }) {
  const [models, setModels] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    void Promise.resolve(actions.swarmModels?.(swarm.id)).then(result => { if (live) setModels(result?.models ?? result ?? []) }).catch(() => { if (live) setModels([]) })
    return () => { live = false }
  }, [swarm.id, worker.name])
  const choose = (event) => {
    const model = event.target.value
    if (model === '' || busy) return
    setBusy(true)
    setError('')
    void Promise.resolve(actions.swarmSwitchModel(swarm.id, worker.name, model))
      .catch(err => setError(hostText(err?.message ?? String(err))))
      .finally(() => setBusy(false))
  }
  return h('label', { className: 'bt-swarm-switch' },
    h('span', null, t('Switch model')),
    h('select', { className: 'bt-swarm-select', value: '', disabled: busy || models === null, onChange: choose, 'aria-label': t('Switch model') },
      h('option', { value: '' }, models === null ? t('Loading…') : t('Choose a model')),
      (models ?? []).map(model => {
        const id = typeof model === 'string' ? model : (model.id ?? `${model.provider}/${model.model}`)
        const limited = typeof model === 'object' && (model.quota === true || model.quota === 'limited' || model.limited === true)
        const label = typeof model === 'object' ? (model.name ?? model.label ?? id) : id
        return h('option', { key: id, value: id, disabled: limited }, limited ? `${label} · ${t('Quota')}` : label)
      })),
    error ? h('span', { className: 'bt-swarm-error', role: 'alert' }, error) : null)
}

function Roster({ swarm, selected, onSelect }) {
  const workers = workersOf(swarm)
  return h('div', { className: 'bt-swarm-roster', role: 'tablist', 'aria-label': t('Swarm members') }, workers.map(worker => {
    const state = stateOf(worker)
    const label = modelText(worker.model)
    return h('button', {
      key: worker.name, type: 'button', role: 'tab', 'aria-selected': selected === worker.name, className: 'bt-swarm-member',
      'data-state': state, title: `${worker.name} · ${stateLabel(state)}`, onClick: () => onSelect(selected === worker.name ? null : worker.name),
    },
    h('span', { className: 'bt-swarm-dot', 'data-state': state, 'aria-hidden': true }),
    h('span', { className: 'bt-swarm-member-name' }, worker.name),
    label ? h('span', { className: 'bt-chip bt-swarm-model' }, label) : null)
  }))
}

function Inspector({ swarm, worker, roster, actions }) {
  const bot = worker.botId ? roster.byId?.[worker.botId] : undefined
  const task = bot && worker.taskId ? (bot.tasks ?? []).find(item => item?.id === worker.taskId) : undefined
  return h('div', { className: 'bt-swarm-inspect' },
    isQuotaWorker(worker) ? h(ModelSwitcher, { swarm, worker, actions }) : null,
    bot && task
      ? h('div', { className: 'bt-swarm-reader' }, h(TaskReaderView, { bot, task, actions }))
      : h('div', { className: 'bt-swarm-empty' }, t('No transcript for this member yet.')))
}

export function SwarmBoardPanel({ swarmId, roster, actions }) {
  const swarm = roster.swarms?.[swarmId]
  const [messages, setMessages] = useState([])
  const [channel, setChannel] = useState('all')
  const [member, setMember] = useState(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [flash, setFlash] = useState(null)
  const [closing, setClosing] = useState(false)
  const feed = useRef(null)
  const body = useRef(null)
  const seen = useRef(0)
  const actionsRef = useRef(actions)
  actionsRef.current = actions

  const load = useCallback(async () => {
    const page = await actionsRef.current.swarmRead?.(swarmId, { since: seen.current })
    const posts = page?.messages ?? (Array.isArray(page) ? page : [])
    if (posts.length === 0) return
    seen.current = Math.max(seen.current, ...posts.map(post => post.seq))
    setMessages(known => mergePosts(known, posts))
  }, [swarmId])

  useEffect(() => {
    seen.current = 0
    setMessages([])
    setChannel('all')
    setMember(null)
    let stop = false
    const tick = () => { void load().catch(() => {}) }
    tick()
    const timer = setInterval(() => { if (!stop) tick() }, BOARD_POLL_MS)
    return () => { stop = true; clearInterval(timer) }
  }, [swarmId, load])

  const tabs = useMemo(() => channelsOf(swarm, messages), [swarm, messages])
  const shown = useMemo(() => inChannel(messages, channel), [messages, channel])
  const lastSeq = shown.length > 0 ? shown[shown.length - 1].seq : 0
  useEffect(() => {
    const node = feed.current
    if (node) node.scrollTop = node.scrollHeight
  }, [lastSeq, channel])
  useMorph(body, member ?? '')

  const jump = useCallback((seq) => {
    const node = feed.current?.querySelector(`[data-seq="${seq}"]`)
    if (!node) return
    node.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    setFlash(seq)
    setTimeout(() => setFlash(current => (current === seq ? null : current)), 1400)
  }, [])

  if (!swarm) return h('div', { className: 'bt-swarm-empty' }, t('This swarm is gone.'))

  const closed = swarm.status === 'closed' || swarm.closed === true
  const send = async () => {
    const text = draft.trim()
    if (text === '' || busy) return
    setBusy(true)
    setError('')
    try {
      await actions.swarmPost(swarmId, { text, ...(channel !== 'all' ? { channel } : {}) })
      setDraft('')
      await load()
    } catch (err) {
      setError(hostText(err?.message ?? String(err)))
    } finally {
      setBusy(false)
    }
  }
  const closeAndIngest = async () => {
    if (closing) return
    setClosing(true)
    setError('')
    try { await actions.closeSwarm(swarmId) } catch (err) { setError(hostText(err?.message ?? String(err))) } finally { setClosing(false) }
  }
  const selected = member ? workersOf(swarm).find(worker => worker.name === member) : undefined
  const counts = swarmCounts(swarm)

  return h('div', { className: 'bt-swarm', 'data-closed': closed || undefined },
    h('div', { className: 'bt-swarm-head' },
      h('div', { className: 'bt-swarm-title' },
        h('span', { className: 'bt-swarm-name' }, swarm.title ?? t('Swarm')),
        h('span', { className: 'bt-swarm-sub' }, closed ? t('Closed') : swarmPodLabel(counts))),
      closed ? null : h('button', {
        type: 'button', className: 'bt-swarm-close', disabled: closing, onClick: closeAndIngest,
      }, closing ? t('Closing…') : t('Close & Ingest Swarm'))),
    h(Roster, { swarm, selected: member, onSelect: setMember }),
    h('div', { ref: body, className: 'bt-swarm-body' },
      selected
        ? h(Inspector, { key: selected.name, swarm, worker: selected, roster, actions })
        : h(Fragment, null,
          h('div', { className: 'bt-swarm-tabs', role: 'tablist', 'aria-label': t('Channels') },
            h('button', { type: 'button', role: 'tab', 'aria-selected': channel === 'all', className: 'bt-swarm-tab', onClick: () => setChannel('all') }, t('All')),
            tabs.map(name => h('button', {
              key: name, type: 'button', role: 'tab', 'aria-selected': channel === name, className: 'bt-swarm-tab', onClick: () => setChannel(name),
            }, name === 'main' ? 'main' : `#${name}`))),
          h('div', { ref: feed, className: 'bt-swarm-feed', role: 'log', 'aria-live': 'polite' },
            shown.length === 0
              ? h('div', { className: 'bt-swarm-empty' }, t('No posts yet.'))
              : shown.map(post => {
                const badge = postBadge(post.text)
                return h('div', { key: post.seq, className: 'bt-swarm-post', 'data-seq': post.seq, 'data-flash': flash === post.seq || undefined },
                  h('button', { type: 'button', className: 'bt-swarm-seq', onClick: () => jump(post.seq), 'aria-label': `#${post.seq}` }, `#${post.seq}`),
                  h('div', { className: 'bt-swarm-post-body' },
                    h('div', { className: 'bt-swarm-post-meta' },
                      h('span', { className: 'bt-swarm-from' }, post.from ?? post.agent ?? ''),
                      channel === 'all' && post.channel && post.channel !== 'main' ? h('span', { className: 'bt-chip' }, `#${post.channel}`) : null,
                      badge ? h('span', { className: 'bt-swarm-badge', 'data-kind': badge }, t(BADGES[badge])) : null,
                      post.at ? h('span', { className: 'bt-swarm-at' }, relativeShort(post.at)) : null),
                    h(PostText, { text: post.text, onJump: jump })))
              })),
          closed ? null : h('div', { className: 'bt-swarm-composer' },
            h('textarea', {
              className: 'bt-swarm-input', rows: 2, value: draft, placeholder: t('Post to the swarm. Use @name to wake someone.'),
              'aria-label': t('Post to the swarm'), onChange: event => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !event.shiftKey && !isImeComposing(event) && sendsOnEnter(roster.prefs)) { event.preventDefault(); void send() }
              },
            }),
            h('button', { type: 'button', className: 'bt-swarm-send', disabled: busy || draft.trim() === '', onClick: send }, t('Send'))))),
    error ? h('div', { className: 'bt-swarm-error', role: 'alert' }, error) : null)
}

export const SWARM_CSS = `
.bt-swarm-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--bt-ink-3);transition:background-color .14s ease,box-shadow .14s ease}
.bt-swarm-dot[data-state=working]{background:var(--bt-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--bt-accent) 18%,transparent)}
.bt-swarm-dot[data-state=waiting]{background:var(--bt-green)}
.bt-swarm-dot[data-state=quota]{background:var(--bt-star);box-shadow:0 0 0 3px color-mix(in srgb,var(--bt-star) 22%,transparent)}
.bt-swarm-dot[data-state=stopped]{background:var(--bt-ink-3)}
.bt-swarm-bar[data-quota]{color:var(--bt-ink);font-weight:500}
.bt-swarm{flex:1;min-height:0;display:flex;flex-direction:column;font-size:13px;line-height:20px;color:var(--bt-ink)}
.bt-swarm-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 16px 8px}
.bt-swarm-title{display:flex;flex-direction:column;min-width:0}
.bt-swarm-name{font-size:15px;line-height:20px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-swarm-sub{font-size:11px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-swarm-close,.bt-swarm-send{flex:none;height:28px;padding:0 12px;border:.5px solid var(--bt-line);border-radius:8px;background:transparent;color:var(--bt-ink);font:inherit;font-size:12px;line-height:16px;font-weight:500;cursor:pointer;transition:background-color .12s ease,transform ${SPRING_TAP.duration}ms ${SPRING_TAP.easing}}
.bt-swarm-close:hover,.bt-swarm-send:hover{background:var(--bt-hover)}
.bt-swarm-close:active,.bt-swarm-send:active{transform:scale(.97)}
.bt-swarm-close:disabled,.bt-swarm-send:disabled{opacity:.5;cursor:default}
.bt-swarm-send{background:var(--bt-accent);border-color:transparent;color:var(--bt-accent-ink)}
.bt-swarm-send:hover{background:var(--bt-accent)}
.bt-swarm-roster{display:flex;gap:4px;padding:0 12px 8px;overflow-x:auto;scrollbar-width:none;flex:none}
.bt-swarm-roster::-webkit-scrollbar{display:none}
.bt-swarm-member{flex:none;display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--bt-ink-2);font:inherit;font-size:12px;line-height:16px;cursor:pointer;transition:background-color .12s ease,color .12s ease,transform ${SPRING_TAP.duration}ms ${SPRING_TAP.easing}}
.bt-swarm-member:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-swarm-member:active{transform:scale(.97)}
.bt-swarm-member[aria-selected=true]{background:var(--bt-hover);color:var(--bt-ink);font-weight:500}
.bt-swarm-member:focus-visible,.bt-swarm-tab:focus-visible,.bt-swarm-ref:focus-visible,.bt-swarm-seq:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-swarm-model{max-width:96px}
.bt-swarm-body{flex:1;min-height:0;display:flex;flex-direction:column;border-top:.5px solid var(--bt-line)}
.bt-swarm-tabs{display:flex;gap:4px;padding:8px 12px 0;flex:none;overflow-x:auto;scrollbar-width:none}
.bt-swarm-tab{flex:none;height:24px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--bt-ink-3);font:inherit;font-size:12px;line-height:16px;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.bt-swarm-tab:hover{color:var(--bt-ink)}
.bt-swarm-tab[aria-selected=true]{background:var(--bt-hover);color:var(--bt-ink);font-weight:500}
.bt-swarm-feed{flex:1;min-height:0;overflow-y:auto;padding:8px 12px;display:flex;flex-direction:column;gap:4px}
.bt-swarm-post{display:flex;gap:8px;padding:4px 8px;border-radius:8px;transition:background-color .4s ease}
.bt-swarm-post[data-flash]{background:color-mix(in srgb,var(--bt-accent) 12%,transparent)}
.bt-swarm-seq,.bt-swarm-ref{border:0;background:transparent;padding:0;font:inherit;font-size:11px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums;cursor:pointer}
.bt-swarm-seq{flex:none;width:32px;text-align:right;padding-top:2px}
.bt-swarm-ref{color:var(--bt-accent)}
.bt-swarm-seq:hover,.bt-swarm-ref:hover{text-decoration:underline}
.bt-swarm-post-body{min-width:0;flex:1}
.bt-swarm-post-meta{display:flex;align-items:center;gap:4px;font-size:11px;line-height:16px;color:var(--bt-ink-3)}
.bt-swarm-from{font-weight:600;color:var(--bt-ink-2)}
.bt-swarm-text{display:block;white-space:pre-wrap;overflow-wrap:anywhere}
.bt-swarm-mention{display:inline-block;padding:0 4px;border-radius:4px;background:color-mix(in srgb,var(--bt-accent) 12%,transparent);color:var(--bt-accent);font-weight:500}
.bt-swarm-badge{padding:0 6px;border-radius:999px;font-size:10px;line-height:16px;font-weight:600;background:color-mix(in srgb,var(--bt-green) 16%,transparent);color:var(--bt-green)}
.bt-swarm-badge[data-kind=stall]{background:color-mix(in srgb,var(--bt-star) 18%,transparent);color:var(--bt-warn)}
.bt-swarm-badge[data-kind=quota]{background:color-mix(in srgb,var(--bt-danger) 14%,transparent);color:var(--bt-danger)}
.bt-swarm-composer{flex:none;display:flex;align-items:flex-end;gap:8px;padding:8px 12px 12px;border-top:.5px solid var(--bt-line)}
.bt-swarm-input{flex:1;min-width:0;resize:none;padding:8px;border:.5px solid var(--bt-line);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);font:inherit;font-size:13px;line-height:20px}
.bt-swarm-input:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-1px}
.bt-swarm-inspect{flex:1;min-height:0;display:flex;flex-direction:column}
.bt-swarm-reader{flex:1;min-height:0;display:flex;flex-direction:column}
.bt-swarm-switch{display:flex;align-items:center;gap:8px;padding:8px 16px;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-swarm-select{height:28px;border:.5px solid var(--bt-line);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);font:inherit;font-size:12px;padding:0 8px}
.bt-swarm-empty{padding:16px;font-size:12px;line-height:16px;color:var(--bt-ink-3);text-align:center}
.bt-swarm-error{padding:4px 16px;font-size:12px;line-height:16px;color:var(--bt-danger)}
@media (prefers-reduced-motion:reduce){.bt-swarm-close,.bt-swarm-send,.bt-swarm-member{transition:none}}
`
