// Swarms: a coordinator Session and the helper Sessions it adds, talking over one board
// (swarm-board.js). A member is a DSH Session; DS Bot owns who is waiting, working,
// stopped or killed, wakes a member when a post rings its doorbell, and keeps a swarm from
// ringing itself forever. Nothing here patches DSH: Sessions are made, forked and modelled
// through `ctx.sessionController`, and a member hears the board as an ordinary follow-up.
//
// Hooks the turn code calls (see `rt.swarmHooks`): turnStart, turnEnd, turnFailure.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { MAIN, createBoard } from './swarm-board.js'

const run = promisify(execFile)

export const MAX_SWARM_HOPS = 24
export const COORDINATOR = 'coordinator'
export const QUOTA_CODES = new Set(['429', 'QUOTA', 'ACCOUNT_QUOTA', 'LOCAL_AGENT_QUOTA'])
export const QUOTA_TTL_MS = 10 * 60_000
export const STATUSES = ['working', 'waiting', 'stopped', 'killed']
const WORKSPACES = ['inherit', 'share', 'branch']
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i
const WAKE_TEXT_MAX = 1500
const SHA = /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g

const isQuota = failure => QUOTA_CODES.has(String(failure?.code ?? '')) || failure?.status === 429

export function install(rt) {
  const { ctx } = rt
  const state = rt.state ?? (rt.state = {})
  state.swarms ??= {}
  /** @type {Map<string, { swarmId: string, memberName: string, role: string, ownerBotId?: string }>} */
  const owners = rt.swarmOwners ??= new Map()
  const boards = new Map()
  const quotaMap = new Map()
  const failed = new Set()
  const now = () => rt.now?.() ?? Date.now()
  const warn = (...args) => rt.warn?.(...args)
  const save = () => Promise.resolve(rt.save?.()).catch(error => warn('ds-bot: swarms not saved: %s', error))

  const swarmOf = (id) => {
    const swarm = state.swarms[id]
    if (swarm === undefined) throw new Error(`No swarm "${id}"`)
    return swarm
  }
  const boardOf = (id) => {
    if (!boards.has(id)) boards.set(id, createBoard(rt.ledger, id, { now }))
    return boards.get(id)
  }
  const memberOf = (swarm, name) => {
    const key = Object.keys(swarm.members).find(known => known.toLowerCase() === String(name ?? '').toLowerCase())
    if (key === undefined) throw new Error(`No member "${name}" in swarm "${swarm.title}"`)
    return swarm.members[key]
  }
  const roster = swarm => Object.values(swarm.members).filter(member => member.status !== 'killed').map(member => ({ name: member.name }))
  const own = (swarm, caller) => {
    const member = memberOf(swarm, caller)
    return member
  }
  const register = (swarm, member) => {
    owners.set(member.sessionId, { swarmId: swarm.id, memberName: member.name, role: member.role, ...(swarm.ownerBotId === undefined ? {} : { ownerBotId: swarm.ownerBotId }) })
  }

  // ── delivery ────────────────────────────────────────────────────────────────
  async function deliver(sessionId, text) {
    if (typeof rt.swarmDeliver === 'function') return rt.swarmDeliver(sessionId, text)
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const agent = await rt.resolveAgent(sessionId)
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'swarm' } }))
    await ctx.sessions?.flush?.(agent.session)
  }
  const clip = text => (text.length > WAKE_TEXT_MAX ? `${text.slice(0, WAKE_TEXT_MAX)}… (read_board seqs=[…] for the rest)` : text)

  // Rings the doorbell of every member a post names. A member that is working gets it as
  // a follow-up for its next turn; one that is waiting starts a turn.
  async function ring(swarm, record) {
    if (swarm.closed || record.wake === undefined) return []
    const rung = []
    for (const name of record.wake) {
      const member = swarm.members[name]
      if (member === undefined || member.status === 'killed') continue
      if (member.status === 'stopped' && swarm.members[record.agent]?.role !== 'coordinator' && record.agent !== 'user') continue
      if (record.agent !== 'user' && record.agent !== 'monitor') {
        swarm.hops = (swarm.hops ?? 0) + 1
        if (swarm.hops > MAX_SWARM_HOPS) {
          if (!swarm.halted) {
            swarm.halted = true
            boardOf(swarm.id).post({ agent: 'monitor', kind: 'system', text: `[halt] ${MAX_SWARM_HOPS} bells in a row with no user post (#${record.seq}); the swarm waits for the user.`, members: [] })
            await save()
          }
          return rung
        }
      }
      if (member.status !== 'working') { member.status = 'working'; member.since = now() }
      const text = `[swarm "${swarm.title}" · board #${record.seq} from ${record.agent}${record.channel === MAIN ? '' : ` on #${record.channel}`}]\n${clip(record.text)}`
      try {
        await deliver(member.sessionId, text)
        member.lastBellSeq = record.seq
        rung.push(name)
      } catch (error) {
        member.status = 'stopped'
        member.failure = { message: String(error?.message ?? error).slice(0, 200), at: now() }
        warn('ds-bot: swarm bell to %s failed: %s', name, error)
      }
    }
    return rung
  }

  /** A post on the board, by a member (or `user`), with its doorbells rung. */
  async function post(swarmId, { agent, text, channel }) {
    const swarm = swarmOf(swarmId)
    if (agent !== 'user' && agent !== 'monitor') memberOf(swarm, agent)
    if (swarm.closed) throw new Error(`Swarm "${swarm.title}" is closed`)
    if (agent === 'user') { swarm.hops = 0; swarm.halted = false; swarm.dormant = false; swarm.idleTicks = 0 }
    const kind = agent === 'user' ? 'user' : agent === 'monitor' ? 'system' : 'post'
    const record = boardOf(swarmId).post({ agent, text, channel, kind, members: roster(swarm) })
    const member = swarm.members[agent]
    if (member !== undefined) member.lastPostSeq = record.seq
    swarm.lastPostAt = now()
    if (agent !== 'monitor') swarm.dormant = false
    await ring(swarm, record)
    await save()
    return record
  }

  // ── workspaces ──────────────────────────────────────────────────────────────
  async function worktree(swarm, member, mode) {
    const repo = rt.swarmRepoDir?.(swarm.coordinatorSessionId) ?? rt.config?.cwd ?? process.cwd()
    const path = join(rt.home, 'swarms', swarm.id, 'wt', member)
    mkdirSync(join(rt.home, 'swarms', swarm.id, 'wt'), { recursive: true })
    const branch = `swarm/${swarm.id.slice(0, 8)}/${member}`
    const args = mode === 'branch' ? ['worktree', 'add', '-b', branch, path] : ['worktree', 'add', '--detach', path]
    await run('git', ['-C', repo, ...args], { timeout: 60_000 })
    return { path, repo, ...(mode === 'branch' ? { branch } : {}) }
  }

  async function startSession(swarm, name, { fork, dir }) {
    const sourceName = fork === 'coordinator' ? COORDINATOR : fork
    const source = sourceName === undefined ? undefined : swarm.members[sourceName]
    if (sourceName !== undefined && source === undefined) throw new Error(`Cannot fork "${fork}": not a member`)
    if (source !== undefined && dir === undefined && typeof ctx.sessionController?.fork === 'function') {
      try {
        const res = await ctx.sessionController.fork({ sessionId: source.sessionId })
        if (typeof res?.sessionId === 'string' && res.sessionId !== '') return { sessionId: res.sessionId, warm: true }
      } catch { /* the first turn of a Session cannot be forked: start cold */ }
    }
    const sessionId = await rt.createSession(`${swarm.title} · ${name}`, dir === undefined ? {} : { dir })
    return { sessionId, warm: false }
  }

  const memberNames = (swarm, base, count) => {
    if (count === 1 && !(base in swarm.members)) return [base]
    const names = []
    for (let k = 1; names.length < count; k += 1) {
      const name = `${base}-${k}`
      if (!(name in swarm.members)) names.push(name)
    }
    return names
  }

  // ── public operations ───────────────────────────────────────────────────────
  function createSwarm({ coordinatorSessionId, ownerBotId, title, name = COORDINATOR }) {
    if (typeof coordinatorSessionId !== 'string' || coordinatorSessionId === '') throw new Error('A swarm needs a coordinator Session')
    const held = owners.get(coordinatorSessionId)
    if (held !== undefined) return state.swarms[held.swarmId]
    const id = randomUUID()
    const swarm = {
      id, title: String(title ?? 'swarm').slice(0, 80) || 'swarm', coordinatorSessionId, ...(ownerBotId === undefined ? {} : { ownerBotId }),
      createdAt: now(), hops: 0, members: {},
    }
    swarm.members[name] = { name, sessionId: coordinatorSessionId, role: 'coordinator', addedBy: 'user', status: 'working', since: now(), lastPostSeq: 0, workspace: 'inherit' }
    state.swarms[id] = swarm
    register(swarm, swarm.members[name])
    boardOf(id)
    void save()
    return swarm
  }

  /**
   * Adds one worker, `n` copies (`name-1`…), or one per entry of `tasks`. The brief is
   * posted on the board as an @mention of each and is what the member starts from.
   */
  async function addMembers(swarmId, caller, { name, brief, model, n, tasks, fork, workspace = 'inherit' } = {}) {
    const swarm = swarmOf(swarmId)
    if (swarm.closed) throw new Error(`Swarm "${swarm.title}" is closed`)
    own(swarm, caller)
    if (!NAME.test(String(name ?? ''))) throw new Error('A member name is 1-32 letters, digits, "_" or "-"')
    if (name.toLowerCase() === 'all' || name.toLowerCase() === 'user' || name.toLowerCase() === 'monitor') throw new Error(`"${name}" is reserved`)
    if (!WORKSPACES.includes(workspace)) throw new Error(`workspace is one of ${WORKSPACES.join(', ')}`)
    if (typeof brief !== 'string' || brief.trim() === '') throw new Error('A member needs a brief: what it owns and what done looks like')
    const slices = Array.isArray(tasks) && tasks.length > 0 ? tasks.map(String) : undefined
    const count = slices?.length ?? (Number.isInteger(n) && n > 0 ? n : 1)
    if (count > 12) throw new Error('At most 12 members at once')
    const names = memberNames(swarm, name, count)
    const added = []
    for (const [at, memberName] of names.entries()) {
      let tree
      let dir
      if (workspace !== 'inherit') {
        tree = await worktree(swarm, memberName, workspace)
        dir = tree.path
      }
      let started
      try {
        started = await startSession(swarm, memberName, { fork, dir })
      } catch (error) {
        if (tree !== undefined) await run('git', ['-C', tree.repo, 'worktree', 'remove', tree.path], { timeout: 30_000 }).catch(() => {})
        throw error
      }
      const member = {
        name: memberName, sessionId: started.sessionId, role: 'worker', addedBy: caller, status: 'waiting', since: now(), lastPostSeq: 0, workspace,
        warm: started.warm, ...(model === undefined ? {} : { model }),
        ...(tree === undefined ? {} : { worktree: tree.path, repo: tree.repo, ...(tree.branch === undefined ? {} : { branch: tree.branch }) }),
      }
      swarm.members[memberName] = member
      register(swarm, member)
      if (tree !== undefined) await Promise.resolve(rt.preauthorizeDir?.(member.sessionId, tree.path)).catch(error => warn('ds-bot: swarm folder not pre-authorized: %s', error))
      if (model !== undefined && typeof model === 'object') await rt.selectSessionModel?.(member.sessionId, model, { force: true })
      const intro = [
        slices === undefined ? brief.trim() : `${brief.trim()}\n\nYour slice: ${slices[at]}`,
        started.warm ? '' : await coldStartContext(member, swarm),
      ].filter(Boolean).join('\n\n')
      await post(swarmId, { agent: caller, text: `@${memberName} ${intro}` })
      added.push(member)
    }
    await save()
    return added
  }

  async function coldStartContext(member, swarm) {
    if (rt.canInjectMemory?.() !== true) return ''
    try {
      const context = await rt.buildStartupContext?.({ sessionId: member.sessionId, swarmId: swarm.id })
      return typeof context === 'string' && context !== '' ? `[Memory]\n${context}` : ''
    } catch (error) {
      warn('ds-bot: swarm startup memory skipped: %s', error)
      return ''
    }
  }

  function statusView(swarmId, viewer) {
    const swarm = swarmOf(swarmId)
    const board = boardOf(swarmId)
    return {
      id: swarm.id, title: swarm.title, head: board.lastSeq(), channels: board.channelNames(),
      closed: swarm.closed === true, dormant: swarm.dormant === true, halted: swarm.halted === true, hops: swarm.hops ?? 0,
      members: Object.values(swarm.members).map(member => ({
        name: member.name, role: member.role, status: member.status, model: member.model, addedBy: member.addedBy,
        lastPostSeq: member.lastPostSeq ?? 0, workspace: member.workspace, ...(member.worktree === undefined ? {} : { worktree: member.worktree }),
        ...(member.failure === undefined ? {} : { failure: member.failure }),
        ...(member.quota === undefined ? {} : { quota: member.quota }),
        ...(viewer !== undefined && member.name === viewer ? { you: true } : {}),
      })),
    }
  }

  // The models to choose from: DSH's catalog, with those that returned a quota failure
  // lately marked `limited`.
  function listModelsWithQuota({ all = false } = {}) {
    const raw = rt.cachedCatalog?.()
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.models) ? raw.models : []
    const rows = []
    for (const entry of list) {
      const provider = entry.provider ?? entry.providerId
      const model = entry.model ?? entry.id
      if (provider === undefined || model === undefined) continue
      if (!all && entry.hidden === true) continue
      const at = quotaMap.get(`${provider}/${model}`)
      const limited = at !== undefined && now() - at < QUOTA_TTL_MS
      rows.push({ provider, model, label: entry.name ?? entry.label ?? model, quota: limited ? 'limited' : 'ok', ...(limited ? { limitedAt: at } : {}) })
    }
    return rows
  }

  async function switchMemberModel(swarmId, caller, name, route) {
    const swarm = swarmOf(swarmId)
    const actor = own(swarm, caller)
    const member = memberOf(swarm, name)
    if (member.status === 'killed') throw new Error(`${member.name} was killed`)
    if (actor.role !== 'coordinator' && actor.name !== member.name && member.addedBy !== actor.name) throw new Error(`${actor.name} may switch only itself or the members it added`)
    if (member.status === 'working' && actor.name !== member.name) throw new Error(`${member.name} is working; switch a waiting member`)
    if (typeof route?.provider !== 'string' || typeof route?.model !== 'string') throw new Error('model needs provider and model')
    await rt.selectSessionModel(member.sessionId, route, { force: true })
    member.model = route
    delete member.quota
    if (member.status === 'stopped') member.status = 'waiting'
    failed.delete(member.sessionId)
    await save()
    return member
  }

  async function killMember(swarmId, caller, name, { removeWorkspace = false } = {}) {
    const swarm = swarmOf(swarmId)
    const actor = own(swarm, caller)
    const member = memberOf(swarm, name)
    if (member.role === 'coordinator') throw new Error('The coordinator cannot be killed; close the swarm instead')
    if (actor.role !== 'coordinator' && member.addedBy !== actor.name) throw new Error(`${actor.name} may kill only the members it added`)
    if (member.status === 'killed') return { member, workspace: 'kept' }
    try { await rt.stopSession?.(member.sessionId) } catch (error) { warn('ds-bot: swarm member not stopped: %s', error) }
    member.status = 'killed'
    member.since = now()
    owners.delete(member.sessionId)
    let workspace = member.worktree === undefined ? 'none' : 'kept'
    if (removeWorkspace && member.worktree !== undefined) {
      // No --force: a worktree with uncommitted work stays, and the caller is told.
      try {
        await run('git', ['-C', member.repo, 'worktree', 'remove', member.worktree], { timeout: 30_000 })
        workspace = 'removed'
      } catch (error) { workspace = `kept (${String(error?.stderr ?? error?.message ?? error).trim().split('\n')[0].slice(0, 120)})` }
    }
    await save()
    return { member, workspace }
  }

  function channelOp(swarmId, caller, { op, name, member, members }) {
    const swarm = swarmOf(swarmId)
    own(swarm, caller)
    const names = (members ?? []).map(each => memberOf(swarm, each).name)
    return boardOf(swarmId).channelOp({ op, name, member: member === undefined ? undefined : memberOf(swarm, member).name, members: names, by: caller })
  }

  async function setTitle(swarmId, caller, title) {
    const swarm = swarmOf(swarmId)
    if (own(swarm, caller).role !== 'coordinator') throw new Error('Only the coordinator names the swarm')
    swarm.title = String(title ?? '').trim().slice(0, 80) || swarm.title
    await save()
    return swarm.title
  }

  // Closing keeps what the swarm decided: each `[done]` post goes to memory as an
  // observation, and each commit it names as provenance.
  async function closeSwarm(swarmId, caller) {
    const swarm = swarmOf(swarmId)
    if (caller !== 'user' && own(swarm, caller).role !== 'coordinator') throw new Error('Only the coordinator closes the swarm')
    if (swarm.closed) return { decisions: 0, shas: 0 }
    const dones = rt.ledger.records(boardOf(swarmId).book).filter(record => Number.isInteger(record.seq) && /^\s*(?:@[\w#-]+\s+)*\[done\]/i.test(record.text))
    let decisions = 0
    let shas = 0
    for (const record of dones) {
      const text = record.text.replace(/^\s*(?:@[\w#-]+\s+)*/, '').slice(0, 2000)
      try { await rt.ingestObservation?.({ source: 'swarm', swarmId, swarmTitle: swarm.title, member: record.agent, seq: record.seq, text }); decisions += 1 } catch (error) { warn('ds-bot: swarm decision not kept: %s', error) }
      for (const sha of new Set(text.match(SHA) ?? [])) {
        try { await rt.recordProvenance?.({ sha, source: 'swarm', swarmId, member: record.agent, seq: record.seq }); shas += 1 } catch (error) { warn('ds-bot: swarm commit not recorded: %s', error) }
      }
    }
    swarm.closed = true
    swarm.closedAt = now()
    for (const member of Object.values(swarm.members)) {
      if (member.role !== 'coordinator' && member.status !== 'killed') { try { await rt.stopSession?.(member.sessionId) } catch { /* already idle */ } member.status = 'stopped' }
      owners.delete(member.sessionId)
    }
    await save()
    return { decisions, shas }
  }

  // ── turn hooks ──────────────────────────────────────────────────────────────
  const hooked = sessionId => {
    const held = owners.get(sessionId)
    if (held === undefined) return undefined
    const swarm = state.swarms[held.swarmId]
    const member = swarm?.members[held.memberName]
    return swarm === undefined || member === undefined || member.status === 'killed' ? undefined : { swarm, member }
  }
  const hooks = {
    turnStart(sessionId) {
      const at = hooked(sessionId)
      if (at === undefined) return
      failed.delete(sessionId)
      at.member.status = 'working'
      at.member.since = now()
      delete at.member.failure
    },
    // A turn that ends cleanly parks the member as waiting, whether or not it called
    // swarm_wait; a failed turn leaves it stopped.
    turnEnd(sessionId) {
      const at = hooked(sessionId)
      if (at === undefined || failed.has(sessionId) || at.member.status === 'stopped') return
      at.member.status = 'waiting'
      at.member.since = now()
      void save()
    },
    turnFailure(sessionId, failure = {}) {
      const at = hooked(sessionId)
      if (at === undefined) return
      failed.add(sessionId)
      at.member.status = 'stopped'
      at.member.since = now()
      at.member.failure = { code: failure.code, status: failure.status, message: String(failure.message ?? '').slice(0, 200), at: now() }
      if (isQuota(failure)) {
        at.member.quota = { code: String(failure.code ?? failure.status), at: now() }
        const route = at.member.model
        if (route?.provider && route?.model) quotaMap.set(`${route.provider}/${route.model}`, now())
        if (!at.swarm.closed) {
          try {
            const record = boardOf(at.swarm.id).post({ agent: 'monitor', kind: 'system', text: `[quota] ${at.member.name} stopped on ${at.member.quota.code}. @${COORDINATOR} switch its model (swarm action "model") or kill it.`, members: roster(at.swarm) })
            void ring(at.swarm, record)
          } catch (error) { warn('ds-bot: quota notice not posted: %s', error) }
        }
      }
      void save()
    },
  }

  // A restart leaves no turn running: whatever was working is stopped, not working.
  for (const swarm of Object.values(state.swarms)) {
    for (const member of Object.values(swarm.members)) {
      if (member.status === 'working' && member.role !== 'coordinator') member.status = 'stopped'
      if (member.status !== 'killed' && !swarm.closed) register(swarm, member)
    }
  }

  // ── views and endpoint for the MCP server and the channel ───────────────────
  const swarmsView = () => Object.values(state.swarms).map(swarm => statusView(swarm.id))
  const swarmsLiveView = () => Object.values(state.swarms).map(swarm => ({
    ...statusView(swarm.id),
    lastPostAt: swarm.lastPostAt, idleTicks: swarm.idleTicks ?? 0, stalls: swarm.stalls ?? 0,
  }))

  async function swarmEndpoint(endpoint, body = {}) {
    try {
      switch (endpoint) {
        case 'list': return { swarms: swarmsView() }
        case 'live': return { swarms: swarmsLiveView() }
        case 'status': return statusView(body.swarmId)
        case 'board': return boardOf(swarmOf(body.swarmId).id).readBoard({ since: body.since, limit: body.limit, seqs: body.seqs, channel: body.channel, viewer: body.viewer, coordinator: COORDINATOR })
        case 'post': return { post: await post(body.swarmId, { agent: body.agent ?? 'user', text: body.text, channel: body.channel }) }
        case 'models': return { models: listModelsWithQuota(body) }
        case 'close': return await closeSwarm(body.swarmId, body.agent ?? 'user')
        case 'kill': return await killMember(body.swarmId, body.agent ?? COORDINATOR, body.name, { removeWorkspace: body.removeWorkspace === true })
        default: return { error: `Unknown swarm endpoint "${endpoint}"` }
      }
    } catch (error) {
      return { error: String(error?.message ?? error) }
    }
  }

  const swarm = {
    createSwarm, addMembers, statusView, listModelsWithQuota, switchMemberModel, killMember, channelOp, closeSwarm, setTitle,
    post, ring, boardOf, swarmOf, memberOf, roster, hooks, quotaMap,
    readBoard: (swarmId, options) => boardOf(swarmId).readBoard({ coordinator: COORDINATOR, ...options }),
  }
  Object.assign(rt, {
    swarm, swarmHooks: hooks, swarmsView, swarmsLiveView, swarmEndpoint,
    swarmBoard: { post, read: swarm.readBoard, channels: swarmId => boardOf(swarmId).channelNames() },
  })
  return swarm
}
