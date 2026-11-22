// IM: talk to Bots from chat apps. A connection is one IM bot account bound to a Bot;
// direct chats reach that Bot, platform group chats can be bound to a DS Bot group.
// The platform adapters (im/platforms/) own the wire; this module owns pairing,
// routing, cards and the send queues. Only the dsh holding the team lock connects.
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { replaceFile } from '../files.js'
import { viewCardText } from '../parts.js'
import { imPlatform, IM_PLATFORMS } from '../../shared/im-platforms.js'
import { REPLY_KIND, SOURCE_KIND } from '../constants.js'
import { adapters } from './platforms/index.js'
import { summarizeStep } from './step.js'
import { imText } from './texts.js'
import { CustomerFailures } from './customer-failures.js'

const RECONCILE_MS = 15_000
const RUNTIME_SAVE_MS = 400
const RETRY_MS = 5_000
// A send that keeps failing is given up on, with a bounded backoff, so one broken
// message cannot hold every later message in the same chat forever (#1417).
const RETRY_MAX_MS = 30_000
const SEND_ATTEMPTS = 4
const TYPING_MS = 4_000
const NUMBERS = /^\s*\d+(\s+\d+)*\s*$/

const secretField = key => key.replace(/[A-Z]/g, char => `_${char}`).toUpperCase()
const stoppedInbound = () => Object.assign(new Error('IM connection stopped before message admission'), { retryInbound: true })

export function install(rt) {
  const { ctx, state } = rt
  const imDir = join(rt.home, 'im')
  const langKey = () => {
    const label = String(rt.uiLanguage?.() ?? '')
    if (label.startsWith('Traditional Chinese')) return 'zh-TW'
    if (label.startsWith('Chinese')) return 'zh'
    if (label.startsWith('Japanese')) return 'ja'
    if (label.startsWith('Korean')) return 'ko'
    if (label.startsWith('Spanish')) return 'es'
    if (label.startsWith('French')) return 'fr'
    if (label.startsWith('German')) return 'de'
    return 'en'
  }
  const text = (key, values = {}) => imText(langKey(), key, values)

  // ---------------------------------------------------------------- runtime file
  const runtimes = new Map() // id → { data: {runtime, cards, open}, timer }
  const runtimeOf = async (id) => {
    let held = runtimes.get(id)
    if (held !== undefined) return held
    let data
    try {
      data = JSON.parse(await readFile(join(imDir, `${id}.json`), 'utf8'))
    } catch { data = undefined }
    held = {
      data: {
        runtime: data?.runtime !== null && typeof data?.runtime === 'object' ? data.runtime : {},
        cards: data?.cards !== null && typeof data?.cards === 'object' ? data.cards : {},
      },
      timer: undefined,
    }
    runtimes.set(id, held)
    return held
  }
  const scheduleWrite = (id) => {
    const held = runtimes.get(id)
    if (held === undefined || held.timer !== undefined) return
    held.timer = setTimeout(() => {
      held.timer = undefined
      void writeRuntime(id).catch(error => rt.warn('ds-bot: im runtime %s not saved: %s', id, error))
    }, RUNTIME_SAVE_MS)
    held.timer.unref?.()
  }
  const writeRuntime = async (id) => {
    const held = runtimes.get(id)
    if (held === undefined || rt.readOnly() !== undefined) return
    await mkdir(imDir, { recursive: true })
    const temp = join(imDir, `${id}.${process.pid}.tmp`)
    try {
      await writeFile(temp, JSON.stringify(held.data), { encoding: 'utf8', mode: 0o600 })
      await chmod(temp, 0o600)
      await replaceFile(temp, join(imDir, `${id}.json`))
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }
  const runtimeEnv = async (id) => {
    const held = await runtimeOf(id)
    return {
      get: () => held.data.runtime,
      set: (patch) => {
        Object.assign(held.data.runtime, patch)
        scheduleWrite(id)
      },
    }
  }
  // Sent cards: cardKey → [{ chatKey, messageId, answer? }]. Persisted so a restart
  // does not send a card twice; an `answer` marks it settled from this side.
  const cardsOf = async (id) => (await runtimeOf(id)).data
  const markCard = async (id, cardKey, chatKey, messageId, body) => {
    const data = await cardsOf(id)
    const entries = data.cards[cardKey] ?? []
    const held = entries.find(entry => entry.chatKey === chatKey)
    if (held !== undefined) {
      held.messageId = messageId ?? held.messageId
      held.text = body ?? held.text
      held.delivered = true
    } else {
      entries.push({ chatKey, messageId, text: body, delivered: true })
    }
    data.cards[cardKey] = entries
    scheduleWrite(id)
  }
  const unmarkCard = async (id, cardKey, chatKey) => {
    const data = await cardsOf(id)
    const entries = data.cards[cardKey]
    if (entries === undefined) return
    const kept = entries.filter(entry => entry.chatKey !== chatKey)
    if (kept.length === entries.length) return
    if (kept.length === 0) delete data.cards[cardKey]
    else data.cards[cardKey] = kept
    scheduleWrite(id)
  }
  const settleCard = async (id, cardKey, answer) => {
    const data = await cardsOf(id)
    const entries = data.cards[cardKey]
    if (entries === undefined) return
    for (const entry of entries) entry.answer ??= answer
    scheduleWrite(id)
  }

  // ------------------------------------------------------------- connections
  const connections = () => (state.im ??= { connections: {} }).connections
  const adaptersFor = () => Object.keys(adapters)
  const hasSecrets = conn => Object.values(conn.secrets ?? {}).every(name => rt.secretValue(name) !== undefined)
  const fieldsOf = (conn) => {
    const fields = { ...conn.settings }
    for (const [key, name] of Object.entries(conn.secrets ?? {})) fields[key] = rt.secretValue(name)
    return fields
  }
  // The reason a request failed, with the chain under it: `fetch failed` alone
  // hides the DNS, TLS or connection error that the user needs (#1120).
  const reasonOf = (error) => {
    const parts = []
    for (let at = error, depth = 0; at !== undefined && at !== null && depth < 4; at = at.cause, depth += 1) {
      const text = typeof at === 'string' ? at : at?.message
      if (typeof text === 'string' && text.trim() !== '' && !parts.includes(text.trim())) parts.push(text.trim())
    }
    return parts.length === 0 ? 'The connection failed' : parts.join(': ')
  }

  // The reason can quote the request URL, and a platform URL carries the token:
  // keep the secret field values, also as they appear in a URL, out of the text before it
  // reaches the UI or the log.
  const scrub = (text, fields, platform) => {
    let out = text
    for (const field of platform.fields) {
      const value = fields[field.key]
      if (!field.secret || typeof value !== 'string' || value.length < 4) continue
      for (const form of new Set([value, encodeURIComponent(value)])) out = out.split(form).join('***')
    }
    return out
  }
  const checkAccount = async (platform, fields, env) => {
    try {
      return await adapters[platform.id].check(fields, env)
    } catch (error) {
      throw new Error(scrub(rt.redactSecrets(reasonOf(error)), fields, platform))
    }
  }

  const envFor = async (conn, runtime) => ({
    fetch: globalThis.fetch,
    WebSocket: globalThis.WebSocket,
    config: rt.config.im?.[conn.platform],
    runtime: runtime ?? await runtimeEnv(conn.id),
    log: { warn: (template, ...args) => rt.warn(template, ...args) },
    uploadFile: async (sessionId, file) => {
      const uploads = ctx.get?.('fileUploads')
      if (typeof uploads?.uploadStream !== 'function') throw new Error('no upload service')
      const data = file.data?.[Symbol.asyncIterator] !== undefined ? file.data : (async function* () { yield file.data })()
      const value = await uploads.uploadStream({ sessionId, data, name: file.name })
      return value.receiptId
    },
  })

  // ------------------------------------------------------------------ send out
  /** @type {Map<string, {handle:any, queues:Map<string, {jobs:any[], retry?:any}>}>} */
  const runners = new Map()
  const statuses = new Map()
  /** @type {Map<string, Map<string, {state:string, error?:string, at:number}>>} */
  const sendStatuses = new Map()
  const failedSends = new Map()
  const pendingSends = new Map()
  const setPendingSend = (id, chatKey, entry) => {
    let chats = pendingSends.get(id)
    if (chats === undefined) pendingSends.set(id, chats = new Map())
    chats.set(chatKey, entry)
  }
  const clearPendingSend = (id, chatKey, entry) => {
    if (entry === undefined) return
    const chats = pendingSends.get(id)
    if (chats?.get(chatKey) === entry) {
      chats.delete(chatKey)
      if (chats.size === 0) pendingSends.delete(id)
    }
    entry.resolve()
  }
  const failedFor = (id, chatKey) => {
    let chats = failedSends.get(id)
    if (chats === undefined) failedSends.set(id, chats = new Map())
    let jobs = chats.get(chatKey)
    if (jobs === undefined) chats.set(chatKey, jobs = [])
    return jobs
  }
  const setStatus = (id, next) => {
    // Adapter errors can echo platform responses that quote the token; keep them out of the UI and logs.
    if (typeof next.error === 'string' && next.error !== '') return statuses.set(id, { ...next, error: rt.redactSecrets(next.error), at: Date.now() })
    return statuses.set(id, { ...next, at: Date.now() })
  }
  const setSendStatus = (id, chatKey, next) => {
    if (next === undefined) {
      const byChat = sendStatuses.get(id)
      if (byChat === undefined) return
      byChat.delete(chatKey)
      if (byChat.size === 0) sendStatuses.delete(id)
      return
    }
    let byChat = sendStatuses.get(id)
    if (byChat === undefined) sendStatuses.set(id, byChat = new Map())
    const error = typeof next.error === 'string' && next.error !== '' ? rt.redactSecrets(next.error) : next.error
    byChat.set(chatKey, { ...next, error, at: Date.now() })
  }
  const combinedStatus = (id) => {
    const adapter = statuses.get(id)
    if (adapter?.state === 'error' || adapter?.state === 'off') return adapter
    const byChat = sendStatuses.get(id)
    if (byChat !== undefined && byChat.size > 0) {
      let picked
      for (const entry of byChat.values()) {
        if (picked === undefined || (picked.state !== 'error' && entry.state === 'error') || (picked.state === entry.state && entry.at > picked.at)) {
          picked = entry
        }
      }
      if (picked !== undefined && (picked.state === 'error' || adapter === undefined || adapter.state === 'ready' || adapter.state === 'connecting')) {
        return picked
      }
    }
    return adapter
  }
  const targetsOf = (conn) => {
    const out = []
    for (const [chatKey, chat] of Object.entries(conn.chats ?? {})) {
      const target = chat.target ?? (chat.kind === 'direct' ? { botId: conn.botId } : undefined)
      out.push({ chatKey, chat, target })
    }
    return out
  }

  // ------------------------------------------------------------ reply origin
  // A reply leaves the app only for the chat that asked for the turn that produced it.
  // An IM message starts a turn carrying the request it came in on; every other way a
  // turn starts — the Web UI, a peer Bot's message, a scheduled task, work picked up
  // after a restart — has no IM origin, and its replies, views and cards stay in the app.
  // Nothing is persisted: after a restart there is no origin, so nothing goes out. A
  // Bot's origin lives until its turn ends or another source joins it, however long the
  // turn runs; a group's own Session ends its relay turn at once while its members keep
  // working, so its origin lives until another source writes in the group or the user
  // is unpaired. A request lives until the message it names is admitted, however long
  // that message waits in the queue behind a busy Bot.
  const paired = (conn, senderId) => imPlatform(conn.platform)?.public === true || (conn.paired ?? []).some(entry => entry.id === senderId)
  // Session id → the chat its running turn came from.
  const origins = new Map()
  const mixed = new Set()

  // The target a chat currently points at, as a comparable string. A direct chat falls
  // back to the connection's Bot; an unbound group chat has no target.
  const bindingOf = (conn, chatKey) => {
    const chat = conn?.chats?.[chatKey]
    if (chat === undefined) return undefined
    const target = chat.target ?? (chat.kind === 'direct' ? { botId: conn.botId } : undefined)
    if (target?.botId !== undefined) return `bot:${target.botId}`
    if (target?.roomId !== undefined) return `room:${target.roomId}`
    return undefined
  }
  // Turns that may be a member's late result waking a group up again: wait for the first
  // message of the turn before dropping the chat's origin (see the turn/start handler).
  const pendingReset = new Set()
  // Request id of an IM message → the chat it came from, until that message shows up.
  const requests = new Map()
  // IM origin held across a part switch until the resumed/handoff message opens.
  const resumedOrigins = new Map()
  const holdImOrigin = (sessionId) => {
    if (sessionId === undefined || mixed.has(sessionId)) return undefined
    const entry = origins.get(sessionId)
    if (entry === undefined) return undefined
    const token = randomUUID()
    resumedOrigins.set(token, { ...entry, activeOn: sessionId })
    return token
  }
  const peekImOrigin = (sessionId, token) => {
    const entry = token === undefined ? undefined : resumedOrigins.get(token)
    if (entry === undefined) return
    claimOrigin(sessionId, entry.connId, entry.chatKey, entry.senderId, entry.binding)
    if (!mixed.has(sessionId)) entry.activeOn = sessionId
  }
  const dropImOrigin = (token) => {
    if (token !== undefined) resumedOrigins.delete(token)
  }
  const detachHeldOrigin = (sessionId) => {
    for (const held of resumedOrigins.values()) if (held.activeOn === sessionId) held.activeOn = undefined
  }
  const claimOrigin = (sessionId, connId, chatKey, senderId, binding) => {
    if (sessionId === undefined || connId === undefined) return
    if (mixed.has(sessionId)) return
    const previous = origins.get(sessionId)
    if (previous !== undefined && (previous.connId !== connId || previous.chatKey !== chatKey || previous.senderId !== senderId)) {
      dropOrigin(sessionId)
      return
    }
    for (const [token, held] of resumedOrigins) {
      if (held.activeOn === sessionId && (held.connId !== connId || held.chatKey !== chatKey || held.senderId !== senderId)) {
        resumedOrigins.delete(token)
      }
    }
    let bound = binding
    if (bound === undefined) {
      const conn = Object.values(connections()).find(item => item.id === connId)
      bound = conn === undefined ? undefined : bindingOf(conn, chatKey)
    }
    origins.set(sessionId, { connId, chatKey, senderId, binding: bound, at: Date.now() })
  }
  const dropOrigin = (sessionId) => {
    origins.delete(sessionId)
    mixed.add(sessionId)
    for (const [token, held] of resumedOrigins) if (held.activeOn === sessionId) resumedOrigins.delete(token)
  }
  const resetOrigin = (sessionId) => {
    origins.delete(sessionId)
    mixed.delete(sessionId)
  }
  /**
   * The connection and chat a Session's replies go to, or undefined when nothing may
   * leave: no origin, its connection gone, its chat gone, the user who asked no longer
   * paired, or the chat no longer pointing at the target whose turn asked. A card goes
   * out on this connection alone.
   */
  const originOf = (sessionId) => {
    const entry = sessionId === undefined ? undefined : origins.get(sessionId)
    if (entry === undefined) return undefined
    const conn = Object.values(connections()).find(item => item.id === entry.connId)
    if (conn === undefined || !runners.has(conn.id)) return undefined
    if (entry.senderId !== undefined && !paired(conn, entry.senderId)) return undefined
    const chat = conn.chats?.[entry.chatKey]
    if (chat === undefined) return undefined
    // The chat may have been unbound or pointed at another Bot or group while the work
    // it started keeps running; that work's late lines must not follow the old origin.
    if (entry.binding === undefined || bindingOf(conn, entry.chatKey) !== entry.binding) return undefined
    return { conn, chatKey: entry.chatKey, chat }
  }
  const rememberRequest = (requestId, conn, chatKey, senderId) => {
    // The binding is captured when the message arrives, not when it is admitted: a chat
    // rebound while the message waits in the queue still answers the target that asked.
    requests.set(requestId, { connId: conn.id, chatKey, senderId, binding: bindingOf(conn, chatKey), at: Date.now() })
  }
  // The Session a Bot writes into now, for a card that carries no Session of its own.
  const chatOfBot = botId => rt.botOf(botId) === undefined ? undefined : rt.chatOf(botId)
  const customerSession = (conn, chatKey, botId) => (rt.botOf(botId)?.openParts ?? [])
    .find(part => part.customer?.connId === conn.id && part.customer.chatKey === chatKey)?.sessionId
  const targetSession = (conn, chatKey, target) => target?.roomId !== undefined
    ? (rt.roomOf(target.roomId)?.sessionId ?? target.roomId)
    : imPlatform(conn.platform)?.public === true ? customerSession(conn, chatKey, target?.botId) : chatOfBot(target?.botId)
  // A card answered here continues that turn: its replies belong to this chat too.
  const claimChat = (conn, chat, senderId) => {
    const target = conn.chats?.[chat.key]?.target ?? (chat.kind === 'direct' ? { botId: conn.botId } : undefined)
    const sessionId = targetSession(conn, chat.key, target)
    claimOrigin(sessionId, conn.id, chat.key, senderId)
  }

  const failClass = (error) => {
    if (error?.permanent === true || (typeof error?.status === 'number' && error.status >= 400 && error.status < 500 && error.status !== 429)) return 'permanent'
    if (error?.unknown === true || error?.stopped === true) return 'drop'
    return 'retry'
  }

  const enqueue = (conn, chatKey, job) => {
    const runner = runners.get(conn.id)
    if (runner === undefined) {
      void Promise.resolve(job.onDrop?.()).catch(() => {})
      return
    }
    let queue = runner.queues.get(chatKey)
    if (queue === undefined) runner.queues.set(chatKey, queue = { jobs: [] })
    job.attempts = 0
    queue.jobs.push(job)
    if (!queue.draining && queue.jobs.length === 1) void drain(conn, chatKey)
  }
  const failMessage = error => String(error?.message ?? error).slice(0, 300)
  const retainFailed = (id, chatKey, job, errorText, insertBefore) => {
    const list = failedFor(id, chatKey)
    const idx = insertBefore !== undefined ? list.indexOf(insertBefore) : -1
    if (idx !== -1) list.splice(idx, 0, job)
    else list.push(job)
    setSendStatus(id, chatKey, { state: 'error', error: errorText })
  }
  const clearSettledSendStatus = (id, chatKey, runner, settled) => {
    if (connections()[id] === undefined || (failedSends.get(id)?.get(chatKey)?.length ?? 0) > 0) return
    const current = runners.get(id)
    const activeDone = !runner.stopped && current === runner
    const waiterDone = settled?.waiter !== undefined && current === settled.waiter.runner && (current.queues.get(chatKey)?.jobs.length ?? 0) === 0
    if (activeDone || waiterDone) setSendStatus(id, chatKey, undefined)
  }
  const drain = async (conn, chatKey) => {
    const runner = runners.get(conn.id)
    const queue = runner?.queues.get(chatKey)
    // A reserved slot has no handle until connect() lands; start() re-kicks
    // anything queued in the meantime.
    if (runner?.handle === undefined || queue === undefined || queue.draining) return
    clearTimeout(queue.retry)
    queue.retry = undefined
    queue.draining = true
    try {
      while (!runner.stopped && queue.jobs.length > 0) {
        const prior = pendingSends.get(conn.id)?.get(chatKey)
        if (prior !== undefined) {
          await prior.promise
          continue
        }
        const job = queue.jobs[0]
        queue.sending = true
        let sent
        try {
          sent = await runner.handle.send(job.chat, job)
        } catch (error) {
          queue.sending = false
          const settled = queue.stoppedSend
          queue.stoppedSend = undefined
          const how = failClass(error)
          if (runner.stopped || connections()[conn.id] === undefined) {
            queue.jobs.shift()
            const waiter = settled?.waiter
            const replay = waiter !== undefined && !waiter.runner.stopped && runners.get(conn.id) === waiter.runner ? waiter : undefined
            if (connections()[conn.id] === undefined || stopped || how === 'drop') {
              await Promise.resolve(job.onDrop?.()).catch(() => {})
              clearSettledSendStatus(conn.id, chatKey, runner, settled)
              clearPendingSend(conn.id, chatKey, settled)
            } else if (replay !== undefined) {
              let nextQueue = replay.runner.queues.get(chatKey)
              if (nextQueue === undefined) replay.runner.queues.set(chatKey, nextQueue = { jobs: [] })
              job.attempts = 0
              nextQueue.jobs.unshift(job)
              clearPendingSend(conn.id, chatKey, settled)
              if (!nextQueue.draining) void drain(replay.conn, chatKey)
            } else {
              retainFailed(conn.id, chatKey, job, failMessage(error), settled?.firstRetained ?? queue.firstRetained)
              clearPendingSend(conn.id, chatKey, settled)
            }
            break
          }
          if (how === 'retry') {
            job.attempts += 1
            if (job.attempts < SEND_ATTEMPTS) {
              const backoff = Math.min(RETRY_MS * 2 ** (job.attempts - 1), RETRY_MAX_MS)
              const asked = Number(error?.retryAfter) > 0 ? Math.min(error.retryAfter * 1000, RETRY_MAX_MS) : backoff
              setSendStatus(conn.id, chatKey, { state: 'retrying', error: failMessage(error) })
              queue.retry = setTimeout(() => { void drain(conn, chatKey) }, asked)
              queue.retry.unref?.()
              return
            }
            // A failed job keeps its delivery callback: Try again resumes the same
            // message and card instead of dropping it or creating a second card.
            queue.jobs.shift()
            retainFailed(conn.id, chatKey, job, `Send failed after ${job.attempts} attempts: ${failMessage(error)}`)
            rt.warn('ds-bot: im send to %s failed after %d attempts: %s', chatKey, job.attempts, failMessage(error))
            continue
          }
          queue.jobs.shift()
          if (how === 'permanent') {
            retainFailed(conn.id, chatKey, job, failMessage(error))
            rt.warn('ds-bot: im send to %s failed: %s', chatKey, failMessage(error))
          } else {
            await Promise.resolve(job.onDrop?.()).catch(() => {})
            clearSettledSendStatus(conn.id, chatKey, runner, undefined)
          }
          continue
        }
        queue.sending = false
        queue.jobs.shift()
        const settled = queue.stoppedSend
        queue.stoppedSend = undefined
        if (connections()[conn.id] !== undefined) job.after?.(sent)
        clearSettledSendStatus(conn.id, chatKey, runner, settled)
        clearPendingSend(conn.id, chatKey, settled)
        if (runner.stopped || runners.get(conn.id) !== runner) break
      }
    } finally {
      queue.sending = false
      queue.draining = false
    }
  }
  const sendText = (conn, chat, body, buttons, after) => enqueue(conn, chat.key, { chat, text: body, buttons, after })
  const sendTo = (conn, chatKey, chat, body, buttons, after) => enqueue(conn, chatKey, { chat, text: body, buttons, after })

  // ----------------------------------------------------------------- inbound
  const requested = (conn, msg) => {
    if ((conn.requests ?? []).some(entry => entry.id === msg.sender.id)) return false
    conn.requests = [...(conn.requests ?? []), { id: msg.sender.id, name: msg.sender.name, chatKey: msg.chat.key, chatKind: msg.chat.kind, at: Date.now() }]
    return true
  }

  const targetName = (conn, target) => {
    if (target?.botId !== undefined) return rt.botOf(target.botId)?.name
    if (target?.roomId !== undefined) return rt.roomOf(target.roomId)?.name
    return undefined
  }
  const resolveTarget = (conn, chat) => {
    const target = chat.target ?? (chat.kind === 'direct' ? { botId: conn.botId } : undefined)
    if (target?.botId !== undefined && rt.botOf(target.botId) !== undefined) return target
    if (target?.roomId !== undefined && rt.roomOf(target.roomId) !== undefined) return target
    return undefined
  }

  // One card this chat was sent and has not answered yet. A button names its own
  // card, so it must never fall through to a newer card of the same kind.
  const wasDelivered = entry => entry.delivered !== false
  const openCard = (conn, chatKey, cardKey) => {
    const entries = runtimes.get(conn.id)?.data?.cards[cardKey]
    const entry = entries?.find(item => item.chatKey === chatKey && item.answer === undefined && wasDelivered(item))
    return entry === undefined ? undefined : { cardKey, entry }
  }
  const questionById = (id) => {
    for (const [sessionId, question] of Object.entries(state.questions ?? {})) {
      if (question.id === id) return { sessionId, question }
    }
    return undefined
  }
  // 'answered': the answer continued the turn the chat claimed. 'stale': the card was
  // gone and only the stale text was sent, so this chat claims nothing. false: the pick
  // was not an answer to this card at all.
  const answerQuestionCard = async (conn, chat, cardKey, labels, senderId) => {
    const held = openCard(conn, chat.key, cardKey)
    if (held === undefined) return false
    const found = questionById(held.cardKey.slice(2))
    if (found !== undefined && imPlatform(conn.platform)?.public === true
      && found.sessionId !== customerSession(conn, chat.key, resolveTarget(conn, conn.chats?.[chat.key])?.botId)) return false
    if (found === undefined) {
      await sendCardReply(conn, chat, text('stale'))
      return 'stale'
    }
    const valid = labels.filter(label => (found.question.options ?? []).some(option => option.label === label))
    if (valid.length === 0) return false
    const requestId = `im:${conn.platform}:${randomUUID()}`
    rememberRequest(requestId, conn, chat.key, senderId)
    try {
      await rt.answerQuestion(found.sessionId, found.question.id, { selected: valid }, requestId)
      await settleCard(conn.id, held.cardKey, valid.join(', '))
      await settledEdits(conn)
    } catch (error) {
      requests.delete(requestId)
      if (error?.code === 'bot/stale') {
        await settleCard(conn.id, held.cardKey, text('answered'))
        await sendCardReply(conn, chat, text('stale'))
        await settledEdits(conn)
        return 'stale'
      }
      throw error
    }
    return 'answered'
  }
  const answerApprovalCard = async (conn, chat, cardKey, choice) => {
    const held = openCard(conn, chat.key, cardKey)
    if (held === undefined) return false
    try {
      rt.answerApproval(held.cardKey.slice(2), choice)
      await settleCard(conn.id, held.cardKey, choice === 'allow' ? text('allow') : text('reject'))
      await settledEdits(conn)
    } catch (error) {
      if (error?.code === 'bot/stale') {
        await sendCardReply(conn, chat, text('stale'))
        return 'stale'
      }
      throw error
    }
    return 'answered'
  }
  const sendCardReply = async (conn, chat, body) => sendText(conn, { key: chat.key, kind: chat.kind, title: chat.title }, body)

  // The chat's newest still-open card, questions and approvals together: a bare
  // number answers whatever arrived last, not always a question.
  const newestOpenCard = (conn, chatKey) => {
    const data = runtimes.get(conn.id)?.data
    if (data === undefined) return undefined
    for (const [cardKey, entries] of Object.entries(data.cards).reverse()) {
      if (!cardKey.startsWith('q:') && !cardKey.startsWith('a:')) continue
      const entry = entries.find(item => item.chatKey === chatKey && item.answer === undefined && wasDelivered(item))
      if (entry !== undefined) return { cardKey, entry }
    }
    return undefined
  }

  const receiveMessage = (conn) => async (msg) => {
    const body = String(msg.text ?? '').trim()
    const chat = conn.chats[msg.chat.key]
    const target = resolveTarget(conn, chat)
    if (imPlatform(conn.platform)?.public !== true && /^\/start(?:@\S+)?\s*$/.test(body)) {
      const name = target === undefined ? undefined : targetName(conn, target)
      await sendText(conn, msg.chat, name === undefined ? text(msg.chat.kind === 'group' ? 'unboundGroup' : 'unbound') : text('greeting', { name }))
      return
    }
    if (imPlatform(conn.platform)?.public !== true && /^\/stop(?:@\S+)?\s*$/.test(body)) {
      if (target === undefined) {
        await sendText(conn, msg.chat, text(msg.chat.kind === 'group' ? 'unboundGroup' : 'unbound'))
        return
      }
      const stopped = target.botId !== undefined ? await rt.stopChat(target.botId) : await rt.stopRoomWork(target.roomId)
      await sendText(conn, msg.chat, text(stopped ? 'stopped' : 'idle'))
      return
    }
    if (NUMBERS.test(body)) {
      const picked = body.trim().split(/\s+/).map(Number)
      const held = newestOpenCard(conn, msg.chat.key)
      // Anything that does not clearly answer the newest open card — a stale
      // source, an out-of-range pick, several picks on a single choice — is a
      // normal message for the Bot, never swallowed and never 'stale'.
      if (held !== undefined && held.cardKey.startsWith('q:')) {
        const found = questionById(held.cardKey.slice(2))
        if (found !== undefined) {
          const options = found.question.options ?? []
          const inRange = picked.length > 0 && (found.question.multiSelect === true || picked.length === 1)
            && picked.every(index => options[index - 1] !== undefined)
          if (inRange) {
            const answered = await answerQuestionCard(conn, msg.chat, held.cardKey, picked.map(index => options[index - 1].label), msg.sender.id)
            if (answered !== false) return
          }
        }
      } else if (imPlatform(conn.platform)?.public !== true && held !== undefined && held.cardKey.startsWith('a:')
        && picked.length === 1 && (picked[0] === 1 || picked[0] === 2)
        && rt.approvalsView().some(entry => `a:${entry.id}` === held.cardKey)) {
        const answered = await answerApprovalCard(conn, msg.chat, held.cardKey, picked[0] === 1 ? 'allow' : 'reject')
        if (answered === 'answered') claimChat(conn, msg.chat, msg.sender.id)
        if (answered !== false) return
      }
    }
    if (target === undefined) {
      await sendText(conn, msg.chat, text(msg.chat.kind === 'group' ? 'unboundGroup' : 'unbound'))
      return
    }
    // A window that does not own the team cannot start a turn or save its receipt.
    // Say so instead of accepting the message and losing it.
    if (rt.readOnly() !== undefined) {
      await sendText(conn, msg.chat, text('readonly'))
      return
    }
    const customer = imPlatform(conn.platform)?.public === true
    if (customer && (msg.chat.kind !== 'direct' || target.botId === undefined)) throw new Error('Public customer chats require a direct conversation bound to a Bot')
    const sessionId = customer ? await rt.customerPart(target.botId, conn.id, msg.chat.key) : target.botId ?? target.roomId
    // The receipt has to sit on the Session that takes the message. A group's own
    // Session moves on to a fresh part (`room.sessionId`) while `room.id` stays the
    // first one, so uploading under the id leaves the receipt on a Session the
    // message never reaches and DSH drops the file (#1121).
    const uploadTo = customer ? sessionId : target.botId !== undefined
      ? rt.chatOf(target.botId)
      : rt.sessionOfRoom(rt.roomOf(target.roomId))
    const content = []
    if (body !== '') content.push({ type: 'text', text: body })
    for (const image of msg.images ?? []) content.push({ type: 'image', mediaType: image.mediaType, data: image.data })
    const env = await envFor(conn)
    for (const file of msg.files ?? []) {
      const summary = summarizeStep(file.name, file.data)
      if (summary) content.push({ type: 'text', text: summary })
      try {
        const receiptId = await env.uploadFile(uploadTo, file)
        content.push({ type: 'file', receiptId })
      } catch {
        await sendText(conn, msg.chat, text('noFile'))
      }
    }
    if (content.length === 0) return
    const requestId = `im:${conn.platform}:${randomUUID()}`
    // The turn this starts belongs to this chat: its replies go back here and nowhere else.
    const send = async () => {
      rememberRequest(requestId, conn, msg.chat.key, msg.sender.id)
      await rt.sendUser({ sessionId, content, requestId })
      return 'accepted'
    }
    await send()
  }
  const customerFailures = new CustomerFailures()
  const onMessage = (conn, runner) => async (msg) => {
    if (msg.sender.bot === true) return
    if (!paired(conn, msg.sender.id)) {
      if (msg.chat.kind === 'group' && !msg.mentioned) return
      if (!requested(conn, msg)) return
      await rt.save()
      await sendText(conn, msg.chat, text('requested'))
      return
    }
    conn.chats ??= {}
    if (msg.chat.kind === 'group' && !msg.mentioned) return
    if (conn.chats[msg.chat.key] === undefined) {
      conn.chats[msg.chat.key] = { kind: msg.chat.kind, title: msg.chat.title, at: Date.now() }
      await rt.save()
    }
    if (rt.readOnly() !== undefined) {
      await sendText(conn, msg.chat, text('readonly'))
      return
    }
    if (imPlatform(conn.platform)?.public === true && msg.chat.kind === 'direct') {
      if (runner.stopped === true) throw stoppedInbound()
      const target = resolveTarget(conn, conn.chats[msg.chat.key])
      if (target?.botId !== undefined) {
        const key = typeof msg.messageId === 'string' && msg.messageId !== ''
          ? JSON.stringify([conn.id, msg.chat.key, msg.sender.id, msg.messageId]) : undefined
        if (customerFailures.exhausted(key)) return
        try {
          await rt.customerPart(target.botId, conn.id, msg.chat.key)
          if (runner.stopped === true) throw stoppedInbound()
          customerFailures.success(key)
        } catch (error) {
          if (runner.stopped === true) throw stoppedInbound()
          if (customerFailures.fail(conn.id, key, error?.permanent === true)) {
            throw Object.assign(new Error('Customer conversation could not be opened', { cause: error }), { retryInbound: true })
          }
          rt.warn('ds-bot: customer conversation failed: %s', reasonOf(error))
          await sendText(conn, msg.chat, text('unavailable'))
          return
        }
      }
    }
    if (typeof msg.messageId === 'string' && msg.messageId !== '') {
      const event = rt.requestIdentity({ caller: `im:${conn.id}`, context: msg.chat.key, name: msg.messageId, payload: msg.sender.id })
      // The lock can move between the check above and the admission; no receipt was
      // written in that case, so the user can send the platform event again later.
      const admitted = await rt.admitRequest(event, async () => {
        await receiveMessage(conn)(msg)
        return 'accepted'
      })
      if (admitted?.status === 'readonly') await sendText(conn, msg.chat, text('readonly'))
      // A receipt from an earlier run left the outcome unknown: the message may have
      // run, so sending it again could repeat the work. Tell the user where to look.
      else if (admitted?.status === 'uncertain') await sendText(conn, msg.chat, text('uncertain'))
    } else await receiveMessage(conn)(msg)
  }

  const onAction = (conn) => async (action) => {
    if (imPlatform(conn.platform)?.public === true) return
    if (!paired(conn, action.sender.id)) return
    const data = String(action.data ?? '')
    const chat = { key: action.chat.key, kind: action.chat.kind, title: action.chat.title }
    // Button data is `<kind>:<id>:<choice>`; the id is everything between the
    // first and the last colon, so an id with a colon in it still parses.
    const cut = data.lastIndexOf(':')
    const cardKey = data.slice(0, cut)
    const choice = data.slice(cut + 1)
    if (data.startsWith('q:') && cut > 2) {
      const found = questionById(cardKey.slice(2))
      const label = found?.question.options?.[Number(choice)]?.label
      if (label === undefined) {
        await sendCardReply(conn, chat, text('stale'))
        return
      }
      const answered = await answerQuestionCard(conn, chat, cardKey, [label], action.sender.id)
      if (answered === false) await sendCardReply(conn, chat, text('stale'))
      return
    }
    if (data.startsWith('a:') && cut > 2) {
      if (choice === 'allow' || choice === 'reject') {
        const answered = await answerApprovalCard(conn, chat, cardKey, choice)
        if (answered === 'answered') claimChat(conn, chat, action.sender.id)
        else if (answered === false) await sendCardReply(conn, chat, text('stale'))
      }
    }
  }

  // ------------------------------------------------------------------ cards
  const cardText = {
    question: (bot, question) => {
      const options = (question.options ?? []).map((option, index) => `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`).join('\n')
      const hint = question.multiSelect === true ? text('numbersMulti') : text('numbers')
      return `${text('question', { bot })}${question.question}${question.detail ? `\n${question.detail}` : ''}\n${options}\n(${hint})`
    },
    approval: (bot, entry) => `${text('approval', { bot })}${entry.tool}${entry.reason ? ` — ${entry.reason}` : ''}${entry.detail?.text ? `\n${entry.detail.text}` : ''}${entry.detail?.code ? `\n${entry.detail.code}` : ''}`,
  }
  const cardButtons = {
    question: (question) => (question.multiSelect === true ? undefined : (question.options ?? []).map((option, index) => ({ data: `q:${question.id}:${index}`, label: option.label }))),
    approval: (id) => [{ data: `a:${id}:allow`, label: text('allow') }, { data: `a:${id}:reject`, label: text('reject') }],
  }

  const sendCard = async (conn, cardKey, targets, body, buttons) => {
    if (cardKey.startsWith('a:') && imPlatform(conn.platform)?.public === true) return
    const data = await cardsOf(conn.id)
    if (!runners.has(conn.id)) return
    const entries = data.cards[cardKey] ??= []
    const recorded = new Set(entries.map(entry => entry.chatKey))
    const pending = targets.filter(({ chatKey }) => !recorded.has(chatKey))
    if (pending.length === 0) return
    // Reserve pending chats synchronously before enqueueing so concurrent diffs cannot double-send.
    for (const { chatKey } of pending) entries.push({ chatKey, messageId: undefined, text: body, delivered: false })
    scheduleWrite(conn.id)
    for (const { chatKey, chat } of pending) {
      enqueue(conn, chatKey, {
        chat: { key: chatKey, kind: chat.kind, title: chat.title },
        text: body,
        buttons,
        after: (sent) => { void markCard(conn.id, cardKey, chatKey, sent?.messageId, body) },
        onDrop: () => unmarkCard(conn.id, cardKey, chatKey),
      })
    }
  }

  const diffCards = async () => {
    if (rt.readOnly() !== undefined) return
    for (const conn of Object.values(connections())) {
      const runner = runners.get(conn.id)
      if (runner === undefined) continue
      await cardsOf(conn.id)
      // Questions: one card per open question id, on the connection whose chat asked.
      for (const [sessionId, question] of Object.entries(state.questions ?? {})) {
        const cardKey = `q:${question.id}`
        const botId = rt.chatOwners.get(sessionId) ?? rt.pastOwners.get(sessionId)?.botId
        const bot = rt.botOf(botId)
        if (bot === undefined) continue
        // A card follows its own turn: only the chat that asked for it gets one.
        const origin = originOf(sessionId)
        if (origin === undefined || origin.conn.id !== conn.id) continue
        const buttons = imPlatform(conn.platform)?.buttons === true ? cardButtons.question(question) : undefined
        await sendCard(conn, cardKey, [{ chatKey: origin.chatKey, chat: origin.chat }], cardText.question(bot.name, question), buttons)
      }
      // Approvals: one card per open approval id, resent to chats whose earlier send dropped.
      for (const entry of rt.approvalsView?.() ?? []) {
        if (imPlatform(conn.platform)?.public === true) continue
        const cardKey = `a:${entry.id}`
        const bot = rt.botOf(entry.botId)
        const origin = originOf(entry.roomId !== undefined ? (rt.roomOf(entry.roomId)?.sessionId ?? entry.roomId) : chatOfBot(entry.botId))
        if (origin === undefined || origin.conn.id !== conn.id) continue
        const targets = [{ chatKey: origin.chatKey, chat: origin.chat }]
        const buttons = imPlatform(conn.platform)?.buttons === true ? cardButtons.approval(entry.id) : undefined
        await sendCard(conn, cardKey, targets, cardText.approval(bot?.name ?? '?', entry), buttons)
      }
      // Secret requests: text only — the key is typed on the computer or phone.
      for (const [botId, list] of Object.entries(state.secretRequests ?? {})) {
        if (imPlatform(conn.platform)?.public === true) continue
        const bot = rt.botOf(botId)
        if (bot === undefined) continue
        for (const request of list) {
          const cardKey = `s:${request.id}`
          if (request.status !== 'pending') continue
          const origin = originOf(chatOfBot(botId))
          if (origin === undefined || origin.conn.id !== conn.id) continue
          await sendCard(conn, cardKey, [{ chatKey: origin.chatKey, chat: origin.chat }], text('secretAsk', { bot: bot.name, name: request.name }))
        }
      }
      // Views awaiting a reply: text form only.
      for (const [sessionId, view] of Object.entries(state.views ?? {})) {
        const cardKey = `v:${view.id}`
        const botId = rt.chatOwners.get(sessionId)
        const bot = rt.botOf(botId)
        if (bot === undefined) continue
        const origin = originOf(sessionId)
        if (origin === undefined || origin.conn.id !== conn.id) continue
        const form = viewCardText({ title: view.title, view: view.view })
        await sendCard(conn, cardKey, [{ chatKey: origin.chatKey, chat: origin.chat }], `${text('viewShow', { bot: bot.name })}${form !== '' ? `\n${form}` : view.title ? `\n${view.title}` : ''}`)
      }
    }
  }

  // Buttons drop and the answer shows wherever the card was settled.
  const settledEdits = async (conn) => {
    const runner = runners.get(conn.id)
    const data = runtimes.get(conn.id)?.data
    if (runner?.handle.edit === undefined || data === undefined) return
    for (const entries of Object.values(data.cards)) {
      for (const entry of entries) {
        if (entry.answer === undefined || entry.messageId === undefined || entry.edited === true) continue
        const chat = conn.chats?.[entry.chatKey]
        if (chat === undefined) continue
        entry.edited = true
        const body = entry.text !== undefined ? `${entry.text}\n— ${entry.answer}` : `(${text('answered')})`
        runner.handle.edit({ key: entry.chatKey, kind: chat.kind, title: chat.title }, entry.messageId, { text: body }).catch(() => {})
        scheduleWrite(conn.id)
      }
    }
  }
  // A card answered on the computer leaves the state; its IM copy settles too.
  const settleGone = async () => {
    for (const conn of Object.values(connections())) {
      const data = runtimes.get(conn.id)?.data
      if (data === undefined) continue
      let touched = false
      const openIds = new Set(Object.values(state.questions ?? {}).map(question => `q:${question.id}`))
      const openSecret = new Set(Object.values(state.secretRequests ?? {}).flat().filter(entry => entry.status === 'pending').map(entry => `s:${entry.id}`))
      const openViews = new Set(Object.values(state.views ?? {}).map(view => `v:${view.id}`))
      const openCard = cardKey => cardKey.startsWith('q:') ? openIds.has(cardKey)
        : cardKey.startsWith('a:') ? rt.approvalsView().some(entry => `a:${entry.id}` === cardKey)
          : cardKey.startsWith('s:') ? openSecret.has(cardKey)
            : cardKey.startsWith('v:') ? openViews.has(cardKey) : false
      for (const [cardKey, entries] of Object.entries(data.cards)) {
        if (openCard(cardKey)) continue
        for (const entry of entries) {
          if (entry.answer === undefined) {
            entry.answer = text('answered')
            touched = true
          }
        }
      }
      if (touched) {
        scheduleWrite(conn.id)
        await settledEdits(conn)
      }
      // A card whose source is gone stays only until its copies are settled and
      // edited where the platform can edit; keeping it forever grows the file.
      const editable = runners.get(conn.id)?.handle?.edit !== undefined
      let pruned = false
      for (const [cardKey, entries] of Object.entries(data.cards)) {
        if (openCard(cardKey)) continue
        const droppable = entries.length === 0 || entries.every(entry => entry.answer !== undefined
          && (entry.edited === true || entry.messageId === undefined || !editable || conn.chats?.[entry.chatKey] === undefined))
        if (droppable) {
          delete data.cards[cardKey]
          pruned = true
        }
      }
      if (pruned) scheduleWrite(conn.id)
    }
  }

  // ---------------------------------------------------------------- lifecycle
  // `state.im.connections` is replaced wholesale when a save is adopted, so anything
  // bound at connect time looks the connection up again by id instead of keeping it.
  const fresh = id => connections()[id]
  const onStatus = (id) => (next) => {
    setStatus(id, { state: next.state, error: next.error, at: Date.now() })
    const conn = fresh(id)
    if (conn !== undefined && next.account !== undefined && (conn.account?.id !== next.account.id || conn.account?.name !== next.account.name)) {
      conn.account = next.account
      void rt.save().catch(() => {})
    }
  }

  const busyOf = (conn, chatKey, target) => {
    if (target?.botId !== undefined) return rt.live.get(targetSession(conn, chatKey, target))?.turn !== undefined
    if (target?.roomId !== undefined) return (rt.roomWorkView?.()[target.roomId] ?? []).length > 0
    return false
  }

  const start = async (conn) => {
    const adapter = adapters[conn.platform]
    if (adapter === undefined || runners.has(conn.id)) return
    const platform = imPlatform(conn.platform)
    if (platform?.ws === true && globalThis.WebSocket === undefined) {
      setStatus(conn.id, { state: 'error', error: 'This dsh runs on a Node without WebSocket', at: Date.now() })
      return
    }
    // The slot is reserved before the async work: a concurrent sync cannot
    // start a second adapter for the same connection.
    const runner = { handle: undefined, queues: new Map(), typing: undefined }
    runners.set(conn.id, runner)
    setStatus(conn.id, { state: 'connecting', at: Date.now() })
    try {
      const env = await envFor(conn)
      const handle = adapter.connect(fieldsOf(conn), env, {
        onMessage: (msg) => {
          const current = fresh(conn.id)
          if (current === undefined && platform?.public === true) return Promise.reject(stoppedInbound())
          return current === undefined ? undefined : onMessage(current, runner)(msg).catch(error => {
            rt.warn('ds-bot: im message failed: %s', reasonOf(error))
            if (error?.retryInbound === true) throw error
          })
        },
        onAction: (action) => {
          const current = fresh(conn.id)
          return current === undefined ? undefined : onAction(current)(action).catch(error => rt.warn('ds-bot: im action failed: %s', error))
        },
        onStatus: onStatus(conn.id),
      })
      // A stop() during connect took the slot back: undo the just-started
      // adapter instead of leaving it running unreachable.
      if (runners.get(conn.id) !== runner) {
        void Promise.resolve(handle?.stop?.()).catch(() => {})
        return
      }
      runner.handle = handle
      for (const chatKey of runner.queues.keys()) void drain(conn, chatKey)
      if (typeof runner.handle?.typing === 'function') {
        runner.typing = setInterval(() => {
          for (const { chatKey, chat, target } of targetsOf(fresh(conn.id) ?? conn)) {
            if (target !== undefined && busyOf(conn, chatKey, target)) void runner.handle.typing({ key: chat.key ?? chatKey, kind: chat.kind, title: chat.title }).catch?.(() => {})
          }
        }, TYPING_MS)
        runner.typing.unref?.()
      }
      await diffCards()
    } catch (error) {
      runners.delete(conn.id)
      setStatus(conn.id, { state: 'error', error: String(error?.message ?? error).slice(0, 300), at: Date.now() })
    }
  }
  const stop = async (id) => {
    customerFailures.clear(id)
    const runner = runners.get(id)
    runners.delete(id)
    if (runner === undefined) {
      sendStatuses.delete(id)
      if (statuses.get(id)?.state !== 'error') setStatus(id, { state: 'off', at: Date.now() })
      return
    }
    runner.stopped = true
    if (runner.typing !== undefined) clearInterval(runner.typing)
    const dropOnly = stopped || connections()[id] === undefined
    if (dropOnly) {
      sendStatuses.delete(id)
    } else {
      const failed = failedSends.get(id)
      const byChat = sendStatuses.get(id)
      if (byChat !== undefined) {
        for (const chatKey of byChat.keys()) {
          if ((failed?.get(chatKey)?.length ?? 0) === 0) byChat.delete(chatKey)
        }
        if (byChat.size === 0) sendStatuses.delete(id)
      }
    }
    const dropped = []
    for (const [chatKey, queue] of runner.queues) {
      clearTimeout(queue.retry)
      queue.retry = undefined
      const rest = queue.jobs.splice(queue.sending ? 1 : 0)
      const pending = pendingSends.get(id)?.get(chatKey)
      if (!dropOnly && queue.sending && queue.stoppedSend === undefined) {
        let resolve
        const promise = new Promise((done) => { resolve = done })
        queue.stoppedSend = { firstRetained: rest[0], promise, resolve }
        setPendingSend(id, chatKey, queue.stoppedSend)
      }
      if (rest.length === 0) continue
      if (dropOnly) {
        for (const job of rest) dropped.push(Promise.resolve(job.onDrop?.()).catch(() => {}))
        continue
      }
      const prevError = sendStatuses.get(id)?.get(chatKey)?.error
      queue.firstRetained = rest[0]
      if (pending !== undefined) pending.firstRetained ??= rest[0]
      failedFor(id, chatKey).push(...rest)
      setSendStatus(id, chatKey, { state: 'error', error: prevError || 'Stopped before delivery' })
    }
    await Promise.all(dropped)
    await Promise.resolve(runner.handle?.stop?.()).catch(() => {})
    if (statuses.get(id)?.state !== 'error') setStatus(id, { state: 'off', at: Date.now() })
  }

  // Syncs run one behind the other: endpoints, onSaved and the interval can all
  // fire while a sync is still starting an adapter, and they must see its
  // reserved slots rather than start a second adapter.
  let syncing = Promise.resolve()
  const sync = () => {
    const run = syncing.then(async () => {
      const conns = connections()
      for (const conn of Object.values(conns)) {
        const wants = stopped !== true && adapters[conn.platform] !== undefined && conn.enabled !== false
          && rt.readOnly() === undefined && hasSecrets(conn)
        if (wants && !runners.has(conn.id)) await start(conn)
        else if (!wants && runners.has(conn.id)) await stop(conn.id)
      }
      for (const id of [...runners.keys()]) if (conns[id] === undefined) await stop(id)
      for (const id of [...statuses.keys()]) if (conns[id] === undefined) { statuses.delete(id); sendStatuses.delete(id) }
      for (const conn of Object.values(conns)) {
        if (conn.enabled === false || !runners.has(conn.id)) {
          if (statuses.get(conn.id)?.state !== 'error') setStatus(conn.id, { state: 'off', at: Date.now() })
        }
      }
      await diffCards()
    })
    syncing = run.catch(() => {})
    return run
  }

  let stopped = false

  // ---------------------------------------------------------------- endpoints
  const secretName = (conn, key) => `IM_${conn.platform.toUpperCase()}_${conn.id.slice(3, 9).toUpperCase()}_${secretField(key)}`
  const cleanFields = (platform, fields, base = {}) => {
    const given = fields !== null && typeof fields === 'object' ? fields : {}
    const out = {}
    for (const field of platform.fields) {
      const value = given[field.key]
      if (field.options !== undefined) {
        out[field.key] = field.options.some(([id]) => id === value) ? value
          : (value === undefined && base[field.key] !== undefined ? base[field.key] : field.options[0][0])
      } else if (typeof value === 'string' && value.trim() !== '') {
        out[field.key] = value.trim()
      } else if (!field.secret) {
        if (value !== undefined && typeof value !== 'string') throw new Error(`${field.label} must be text`)
        out[field.key] = value === undefined && base[field.key] !== undefined ? base[field.key] : ''
      }
      // Missing secret fields are allowed only on update, where the saved one stays.
    }
    return out
  }

  const saveSecrets = async (conn, platform, fields) => {
    for (const field of platform.fields) {
      if (!field.secret || fields[field.key] === undefined) continue
      const name = conn.secrets[field.key] ?? secretName(conn, field.key)
      await rt.secretEndpoint('secret-set', { name, value: fields[field.key], purpose: `${platform.name} IM bot`, scope: [] })
      conn.secrets[field.key] = name
    }
  }

  const viewOf = (conn) => ({
    id: conn.id,
    platform: conn.platform,
    account: conn.account ?? null,
    botId: conn.botId ?? null,
    settings: conn.settings ?? {},
    secrets: Object.keys(conn.secrets ?? {}),
    enabled: conn.enabled !== false,
    paired: conn.paired ?? [],
    requests: conn.requests ?? [],
    chats: Object.fromEntries(Object.entries(conn.chats ?? {}).map(([key, chat]) => [key, { ...chat }])),
    createdAt: conn.createdAt,
  })

  const endpoints = {
    async 'im-add'(body) {
      const platform = imPlatform(String(body.platform ?? ''))
      if (platform === undefined || adapters[platform.id] === undefined) throw new Error('This platform is not available yet')
      const bot = rt.botOf(String(body.botId ?? ''))
      if (bot === undefined) throw new Error('Choose a Bot first')
      if (platform.login === 'qr') throw new Error('This platform signs in by scanning a code; not available yet')
      const fields = cleanFields(platform, body.fields)
      for (const field of platform.fields) {
        if (!field.options && !field.optional && (fields[field.key] === undefined || String(fields[field.key]).trim() === '')) throw new Error(`${field.label} is required`)
      }
      const env = await envFor({ id: 'im_check', platform: platform.id, settings: fields, secrets: {} }, { get: () => ({}), set: () => {} })
      const { account } = await checkAccount(platform, fields, env)
      const conn = {
        id: `im_${randomBytes(4).toString('hex')}`,
        platform: platform.id,
        account,
        botId: bot.id,
        settings: Object.fromEntries(platform.fields.filter(field => !field.secret).map(field => [field.key, fields[field.key]])),
        secrets: {},
        enabled: true,
        paired: [],
        requests: [],
        chats: {},
        createdAt: Date.now(),
      }
      await saveSecrets(conn, platform, fields)
      connections()[conn.id] = conn
      await rt.save()
      await sync()
      return viewOf(conn)
    },
    async 'im-update'(body) {
      const conn = connections()[String(body.id ?? '')]
      if (conn === undefined) throw new Error('No such IM bot')
      const platform = imPlatform(conn.platform)
      if (platform === undefined) throw new Error('No such platform')
      if (body.botId !== undefined) {
        const bot = rt.botOf(String(body.botId))
        if (bot === undefined) throw new Error('Choose a Bot first')
        conn.botId = bot.id
      }
      if (body.enabled !== undefined) conn.enabled = body.enabled === true
      if (body.fields !== undefined) {
        const fields = cleanFields(platform, body.fields, conn.settings)
        const env = await envFor(conn)
        const check = { ...fields }
        for (const field of platform.fields) {
          if (field.secret && check[field.key] === undefined) check[field.key] = rt.secretValue(conn.secrets[field.key])
        }
        const { account } = await checkAccount(platform, check, env)
        conn.account = account
        await saveSecrets(conn, platform, fields)
        for (const field of platform.fields) {
          if (!field.secret && fields[field.key] !== undefined) conn.settings[field.key] = fields[field.key]
        }
      }
      await rt.save()
      if (runners.has(conn.id)) await stop(conn.id)
      await sync()
      return viewOf(conn)
    },
    async 'im-remove'(body) {
      const id = String(body.id ?? '')
      const conn = connections()[id]
      if (conn === undefined) throw new Error('No such IM bot')
      await stop(id)
      for (const name of Object.values(conn.secrets ?? {})) {
        await rt.secretEndpoint('secret-delete', { name }).catch(() => {})
      }
      delete connections()[id]
      failedSends.delete(id)
      sendStatuses.delete(id)
      for (const entry of pendingSends.get(id)?.values() ?? []) entry.resolve()
      pendingSends.delete(id)
      runtimes.delete(id)
      await rm(join(imDir, `${id}.json`), { force: true }).catch(() => {})
      await rt.save()
      return true
    },
    async 'im-pair'(body) {
      const conn = connections()[String(body.id ?? '')]
      if (conn === undefined) throw new Error('No such IM bot')
      const at = (conn.requests ?? []).findIndex(entry => entry.id === String(body.senderId ?? ''))
      if (at === -1) throw new Error('This request is gone')
      const [request] = conn.requests.splice(at, 1)
      if (body.allow === true) {
        conn.paired = [...(conn.paired ?? []), { id: request.id, name: request.name, at: Date.now() }]
        conn.chats ??= {}
        conn.chats[request.chatKey] ??= { kind: request.chatKind, title: request.name, at: Date.now() }
        await rt.save()
        const chat = conn.chats[request.chatKey]
        const target = resolveTarget(conn, chat)
        const name = target === undefined ? undefined : targetName(conn, target)
        await sendTo(conn, request.chatKey, { key: request.chatKey, kind: request.chatKind, title: chat.title },
          name === undefined ? text(request.chatKind === 'group' ? 'unboundGroup' : 'unbound') : text('connected', { target: name }))
      } else {
        await rt.save()
      }
      return true
    },
    async 'im-unpair'(body) {
      const conn = connections()[String(body.id ?? '')]
      if (conn === undefined) throw new Error('No such IM bot')
      conn.paired = (conn.paired ?? []).filter(entry => entry.id !== String(body.senderId ?? ''))
      await rt.save()
      return true
    },
    async 'im-chat'(body) {
      const conn = connections()[String(body.id ?? '')]
      if (conn === undefined) throw new Error('No such IM bot')
      const chat = conn.chats?.[String(body.chatKey ?? '')]
      if (chat === undefined) throw new Error('No such chat')
      if (body.remove === true) {
        delete conn.chats[String(body.chatKey ?? '')]
      } else if (body.target === null) {
        delete chat.target
      } else if (body.target !== undefined) {
        const target = body.target
        if (target.botId !== undefined && rt.botOf(target.botId) === undefined) throw new Error('Choose a Bot or a group')
        if (target.roomId !== undefined && rt.roomOf(target.roomId) === undefined) throw new Error('Choose a Bot or a group')
        chat.target = target.botId !== undefined ? { botId: String(target.botId) } : { roomId: String(target.roomId) }
      }
      await rt.save()
      return true
    },
    async 'im-retry'(body) {
      const conn = connections()[String(body.id ?? '')]
      if (conn === undefined) throw new Error('No such IM bot')
      if (statuses.get(conn.id)?.state !== 'ready') {
        if (runners.has(conn.id)) await stop(conn.id)
        await sync()
      }
      if (!runners.has(conn.id)) return true
      const chats = failedSends.get(conn.id)
      failedSends.delete(conn.id)
      const runner = runners.get(conn.id)
      for (const [chatKey, pending] of pendingSends.get(conn.id) ?? []) {
        pending.firstRetained = undefined
        pending.waiter = { conn, runner }
        setSendStatus(conn.id, chatKey, { state: 'retrying' })
      }
      for (const [chatKey, jobs] of chats ?? []) {
        setSendStatus(conn.id, chatKey, { state: 'retrying' })
        for (const job of jobs) enqueue(conn, chatKey, job)
      }
      for (const [chatKey, queue] of runner?.queues ?? []) {
        if (queue.retry === undefined || queue.draining || queue.jobs.length === 0) continue
        clearTimeout(queue.retry)
        queue.retry = undefined
        queue.jobs[0].attempts = 0
        setSendStatus(conn.id, chatKey, { state: 'retrying' })
        void drain(conn, chatKey)
      }
      return true
    },
    async 'im-login-start'(body) {
      const platform = imPlatform(String(body.platform ?? ''))
      const adapter = platform === undefined ? undefined : adapters[platform.id]
      if (platform === undefined || typeof adapter?.loginStart !== 'function') throw new Error('This platform has no QR login')
      const bot = rt.botOf(String(body.botId ?? ''))
      if (bot === undefined) throw new Error('Choose a Bot first')
      const env = await envFor({ id: 'im_login', platform: platform.id, settings: {}, secrets: {} }, { get: () => ({}), set: () => {} })
      const login = await adapter.loginStart(env)
      return { loginId: login.loginId, qr: login.qr, expiresAt: login.expiresAt, botId: bot.id }
    },
    async 'im-login-wait'(body) {
      const platform = imPlatform(String(body.platform ?? 'weixin'))
      const adapter = platform === undefined ? undefined : adapters[platform.id]
      if (platform === undefined || typeof adapter?.loginWait !== 'function') throw new Error('This platform has no QR login')
      const bot = rt.botOf(String(body.botId ?? ''))
      if (bot === undefined) throw new Error('Choose a Bot first')
      const env = await envFor({ id: 'im_login', platform: platform.id, settings: {}, secrets: {} }, { get: () => ({}), set: () => {} })
      const login = await adapter.loginWait(String(body.loginId ?? ''), env)
      if (login.status !== 'done') return { status: login.status }
      // Confirmed: create the connection with the platform credentials the
      // login returned, paired with the scanning owner — no review needed.
      const conn = {
        id: `im_${randomBytes(4).toString('hex')}`,
        platform: platform.id,
        account: login.connection.account,
        botId: bot.id,
        settings: login.connection.settings ?? {},
        secrets: {},
        enabled: true,
        paired: login.owner === undefined ? [] : [{ id: login.owner.id, name: login.owner.name, at: Date.now() }],
        requests: [],
        chats: login.owner === undefined ? {} : { [login.owner.id]: { kind: 'direct', title: login.owner.name, at: Date.now() } },
        createdAt: Date.now(),
      }
      for (const [key, value] of Object.entries(login.connection.secrets ?? {})) {
        const name = secretName(conn, key)
        await rt.secretEndpoint('secret-set', { name, value, purpose: `${platform.name} IM bot`, scope: [] })
        conn.secrets[key] = name
      }
      connections()[conn.id] = conn
      await rt.save()
      await sync()
      return { status: 'done', id: conn.id }
    },
  }

  const imEndpoint = async (endpoint, body) => {
    const result = await endpoints[endpoint]?.(body ?? {})
    if (result === undefined) throw new Error(`Unknown endpoint ${endpoint}`)
    if (endpoint !== 'im-retry') void sync()
    void diffCards()
    return result
  }

  // ------------------------------------------------------------------ im via
  // IM-originated user messages, keyed by session and event seq, so the client
  // can tag a message with the platform it came from. A Session's entries go
  // when it stops being the chat's current part.
  const imVia = new Map()
  const imViaView = () => {
    for (const sessionId of imVia.keys()) if (!rt.chatOwners.has(sessionId)) imVia.delete(sessionId)
    return Object.fromEntries([...imVia.entries()].map(([sessionId, seqs]) => [sessionId, { ...seqs }]))
  }

  // ----------------------------------------------------------------- outbound
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      const room = rt.roomOf(session.id)
      if (room === undefined) {
        resetOrigin(session.id)
      } else {
        const working = rt.roomActive?.(room.id) || (rt.roomWorkView?.()[room.id] ?? []).length > 0
        // A group's own Session can start a turn for the last member's late result after
        // its relay turn ended, when no work looks active. Keep the origin until the
        // turn's first message says whether it continues the work the chat asked for.
        if (!working) pendingReset.add(session.id)
      }
    }
    if (event.type === 'user/message') {
      const source = event.data?.source
      const imOrigin = source?.imOrigin
      const rpcId = source?.rpcId
      // A late member result or part-switch handoff continues the work the chat asked for;
      // any other first message starts a fresh turn, which clears the previous turn's origin.
      if (pendingReset.delete(session.id) && !(typeof imOrigin === 'string' || (source?.kind === SOURCE_KIND && source.role === 'post'))) resetOrigin(session.id)
      if (typeof imOrigin === 'string') {
        const resumed = resumedOrigins.get(imOrigin)
        resumedOrigins.delete(imOrigin)
        if (resumed === undefined) dropOrigin(session.id)
        else claimOrigin(session.id, resumed.connId, resumed.chatKey, resumed.senderId, resumed.binding)
      } else if (typeof rpcId === 'string' && rpcId.startsWith('im:')) {
        if (Number.isInteger(event.seq)) imVia.set(session.id, { ...imVia.get(session.id), [event.seq]: rpcId.split(':')[1] })
        // The chat this message came from is the one its turn answers. A message this
        // process never registered — after a restart, or a redelivery — leaves no origin.
        const asked = requests.get(rpcId)
        requests.delete(rpcId)
        if (asked === undefined) dropOrigin(session.id)
        else claimOrigin(session.id, asked.connId, asked.chatKey, asked.senderId, asked.binding)
      } else if (source?.kind === REPLY_KIND) {
        // Web and phone answers carry no registered IM request.
        dropOrigin(session.id)
      } else if (source?.kind === SOURCE_KIND && source.role === 'post') {
        // A member's late result relayed into the group's own Session. The group's work
        // is still the answer to the chat that asked, wherever the member runs.
      } else {
        // A message from the Web UI, a peer Bot or a scheduled task: this turn is not an
        // IM chat's to answer, even when an earlier turn of this Session was.
        dropOrigin(session.id)
      }
    }
    if (event.type === 'turn/end') {
      // A group's own Session ends its relay turn at once while its members keep
      // working and post later; only a Bot's turn ending ends the chat's claim. A
      // pending reset means the turn never got a message to classify, so apply it now.
      if (rt.roomOf(session.id) === undefined) {
        resetOrigin(session.id)
        detachHeldOrigin(session.id)
      } else if (pendingReset.delete(session.id)) {
        resetOrigin(session.id)
      }
    }
    const botId = rt.chatOwners.get(session.id)
    if (botId === undefined) {
      // A group's own chat has no Bot of its own; its lines go out from onRoomLine.
      imVia.delete(session.id)
      return
    }
    const origin = originOf(session.id)
    if (origin === undefined) return
    for (const item of rt.displayItems(session.id, [event])) {
      if (item.kind !== 'bot' && item.kind !== 'view') continue
      const body = item.kind === 'bot' ? item.text : viewCardText({ title: item.title, view: item.view }) || (item.title ?? '')
      sendTo(origin.conn, origin.chatKey, { key: origin.chatKey, kind: origin.chat.kind, title: origin.chat.title }, body)
    }
  })

  rt.onRoomLine((room, line) => {
    if (line.botId === undefined || line.kind !== undefined || typeof line.text !== 'string' || line.text.trim() === '') return
    const origin = originOf(room.sessionId ?? room.id)
    if (origin === undefined) return
    const body = `**${line.who}**: ${line.text}`
    sendTo(origin.conn, origin.chatKey, { key: origin.chatKey, kind: origin.chat.kind, title: origin.chat.title }, body)
  })

  rt.onApproval((kind, data) => {
    if (kind === 'open') {
      void (async () => {
        const sessionId = data.roomId !== undefined ? (rt.roomOf(data.roomId)?.sessionId ?? data.roomId) : chatOfBot(data.botId)
        const origin = originOf(sessionId)
        if (origin === undefined) return
        if (imPlatform(origin.conn.platform)?.public === true) return
        const bot = rt.botOf(data.botId)
        const buttons = imPlatform(origin.conn.platform)?.buttons === true ? cardButtons.approval(data.id) : undefined
        await sendCard(origin.conn, `a:${data.id}`, [{ chatKey: origin.chatKey, chat: origin.chat }], cardText.approval(bot?.name ?? '?', data), buttons)
      })().catch(error => rt.warn('ds-bot: im approval card failed: %s', error))
      return
    }
    void (async () => {
      for (const conn of Object.values(connections())) {
        await settleCard(conn.id, `a:${data.id}`, data.outcome === 'allowed-once' ? text('allow') : data.outcome === 'rejected' ? text('reject') : text('answered'))
        await settledEdits(conn)
      }
    })().catch(() => {})
  })

  rt.onSaved(() => {
    void diffCards().then(settleGone).catch(() => {})
    void sync().catch(() => {})
  })

  let interval
  ctx.effect(() => {
    interval = setInterval(() => {
      void rt.refresh().then(() => sync()).catch(() => {})
    }, RECONCILE_MS)
    interval.unref?.()
    void rt.load().then(() => sync()).catch(() => {})
    return () => {
      stopped = true
      clearInterval(interval)
      resumedOrigins.clear()
      return Promise.all([...runners.keys()].map(stop)).then(async () => {
        for (const held of runtimes.values()) if (held.timer !== undefined) clearTimeout(held.timer)
        await Promise.all([...runtimes.keys()].map(writeRuntime)).catch(() => {})
      })
    }
  }, 'ds-bot: im')

  const imView = () => ({ connections: Object.values(connections()).map(viewOf), platforms: IM_PLATFORMS.filter(platform => adaptersFor().includes(platform.id)).map(platform => platform.id) })
  const imStatusView = () => Object.fromEntries([...new Set([...statuses.keys(), ...sendStatuses.keys()])].map((id) => {
    const status = combinedStatus(id)
    return [id, { state: status.state, ...(status.error !== undefined ? { error: status.error } : {}), at: status.at }]
  }))

  Object.assign(rt, { imView, imStatusView, imViaView, imEndpoint, holdImOrigin, peekImOrigin, dropImOrigin })
}
