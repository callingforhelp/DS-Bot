// The swarm board: one append-only book per swarm (`swarm-<swarmId>` in the ledger) that
// every member of the swarm reads and writes. A post has a monotonic `seq`; channel and
// membership changes are `event` records without a seq, so replaying the book rebuilds the
// channel registry. A mention is a doorbell: it wakes the named member and is never a copy.
//
//   @name      wakes the member with that name
//   @prefix    wakes every numbered member `prefix-1`, `prefix-2`, ...
//   @all       wakes everyone who can see the post
//   @#channel  wakes the members of that channel
//
// "main" is the channel everyone is on; `@#main` is refused because `@all` already says it.
export const MAIN = 'main'
export const BOOK_PREFIX = 'swarm-'
export const READ_LIMIT = 20
export const READ_LIMIT_MAX = 100
const ADDRESS_BEFORE = /[a-z0-9_./]/i
const NAME_GOES_ON = /^[a-z0-9_]/i
const CHANNEL_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g

export const bookOf = swarmId => `${BOOK_PREFIX}${swarmId}`
export const channelProblem = (name) => {
  const text = String(name ?? '').replace(/^#/, '').trim()
  if (text.toLowerCase() === MAIN) return 'Channel "main" always exists; use @all for everyone'
  if (!CHANNEL_NAME.test(text)) return 'A channel name is 1-32 letters, digits, "_" or "-"'
  return undefined
}

const overlaps = (spans, at) => spans.some(span => at >= span.start && at < span.end)

/**
 * Doorbells in `text`, outside code. `members` is `[{ name }]`; `channels` is a list of
 * channel names. Returns `{ names, all, channels, rejected }`; `names` holds exact member
 * names, `prefixes` the prefixes that matched numbered members.
 */
export function parseDoorbells(text, members = [], channels = []) {
  const value = String(text ?? '')
  const skip = [...value.matchAll(CODE)].map(match => ({ start: match.index, end: match.index + match[0].length }))
  const names = new Set()
  const prefixes = new Set()
  const hit = new Set()
  const rejected = []
  let all = false
  const byLength = [...members].filter(member => member?.name).sort((a, b) => b.name.length - a.name.length)
  const bases = new Set(byLength.map(member => /^(.*)-\d+$/.exec(member.name)?.[1]).filter(Boolean))
  const fits = (at, word) => value.slice(at, at + word.length).toLowerCase() === word.toLowerCase() && !NAME_GOES_ON.test(value.slice(at + word.length))
  for (let at = value.indexOf('@'); at !== -1; at = value.indexOf('@', at + 1)) {
    if ((at > 0 && ADDRESS_BEFORE.test(value[at - 1])) || overlaps(skip, at)) continue
    const rest = at + 1
    if (value[rest] === '#') {
      const match = /^[a-z0-9_-]+/i.exec(value.slice(rest + 1))
      if (match === null) continue
      const name = match[0]
      if (name.toLowerCase() === MAIN) rejected.push(`@#${MAIN}`)
      else {
        const known = channels.find(channel => channel.toLowerCase() === name.toLowerCase())
        if (known !== undefined) hit.add(known)
      }
      at = rest + match[0].length
      continue
    }
    const member = byLength.find(candidate => fits(rest, candidate.name))
    if (member !== undefined) {
      names.add(member.name)
      at = rest + member.name.length - 1
      continue
    }
    if (fits(rest, 'all')) { all = true; at = rest + 2; continue }
    const base = [...bases].sort((a, b) => b.length - a.length).find(candidate => fits(rest, candidate))
    if (base !== undefined) { prefixes.add(base); at = rest + base.length - 1 }
  }
  for (const base of prefixes) {
    for (const member of byLength) if (member.name.startsWith(`${base}-`) && /^\d+$/.test(member.name.slice(base.length + 1))) names.add(member.name)
  }
  return { names: [...names], prefixes: [...prefixes], all, channels: [...hit], rejected }
}

/** The board of one swarm, over `rt.ledger`. Synchronous reads, ordered writes. */
export function createBoard(ledger, swarmId, { now = Date.now } = {}) {
  const book = bookOf(swarmId)

  // Replay the event records into the channel registry: name -> Set of members.
  const registry = () => {
    const channels = new Map([[MAIN, null]])
    for (const record of ledger.records(book)) {
      if (record.event !== 'channel') continue
      if (record.op === 'create') channels.set(record.name, new Set(record.members ?? []))
      else if (record.op === 'join') channels.get(record.name)?.add(record.member)
      else if (record.op === 'leave') channels.get(record.name)?.delete(record.member)
      else if (record.op === 'drop' && record.name !== MAIN) channels.delete(record.name)
    }
    return channels
  }
  const channelNames = () => [...registry().keys()]
  const membersOf = (name) => {
    const set = registry().get(name)
    return set === undefined ? undefined : set === null ? null : [...set]
  }
  const visible = (record, viewer, coordinator) => {
    const channel = record.channel ?? MAIN
    if (channel === MAIN || viewer === undefined || viewer === coordinator) return true
    return registry().get(channel)?.has(viewer) === true
  }
  const lastSeq = () => ledger.lastSeq(book)

  function channelOp({ op, name, member, members = [], by }) {
    const bare = String(name ?? '').replace(/^#/, '').trim()
    const problem = channelProblem(bare)
    if (problem !== undefined) throw new Error(problem)
    const channels = registry()
    if (op === 'create') {
      if (channels.has(bare)) throw new Error(`Channel "${bare}" already exists`)
      ledger.append(book, { event: 'channel', op, name: bare, members: [...new Set([by, ...members].filter(Boolean))], by, time: now() })
    } else if (op === 'join' || op === 'leave') {
      if (!channels.has(bare)) throw new Error(`No channel "${bare}"`)
      ledger.append(book, { event: 'channel', op, name: bare, member: member ?? by, by, time: now() })
    } else if (op === 'drop') {
      if (!channels.has(bare)) throw new Error(`No channel "${bare}"`)
      ledger.append(book, { event: 'channel', op, name: bare, by, time: now() })
    } else throw new Error(`Unknown channel op "${op}"`)
    return { channels: channelNames() }
  }

  /**
   * Appends one post and returns it with its doorbells resolved against `members`.
   * A post to a channel the author is not on is refused. The wake list never includes the
   * author and, for a channel post, only channel members.
   */
  function post({ agent, text, channel = MAIN, kind = 'post', members = [] }) {
    const body = String(text ?? '').trim()
    if (body === '') throw new Error('A post needs text')
    const room = String(channel ?? MAIN).replace(/^#/, '') || MAIN
    const channels = registry()
    if (!channels.has(room)) throw new Error(`No channel "${room}"`)
    const roomMembers = channels.get(room)
    if (roomMembers !== null && kind === 'post' && !roomMembers.has(agent)) throw new Error(`${agent} is not on channel "${room}"`)
    const bells = parseDoorbells(body, members, [...channels.keys()].filter(name => name !== MAIN))
    const audience = (names) => names.filter(name => name !== agent && (roomMembers === null || roomMembers.has(name)))
    let wake = bells.names
    for (const name of bells.channels) {
      const set = channels.get(name)
      if (set !== null && set !== undefined) wake = wake.concat([...set])
    }
    if (bells.all) wake = wake.concat(members.map(member => member.name))
    wake = audience([...new Set(wake)])
    const record = {
      seq: lastSeq() + 1, kind, agent, channel: room, text: body, time: now(),
      ...(wake.length > 0 ? { wake } : {}),
      ...(bells.all ? { all: true } : {}),
      ...(bells.rejected.length > 0 ? { rejected: bells.rejected } : {}),
    }
    ledger.append(book, record)
    return record
  }

  /**
   * One read of the board. `seqs` wins over `since`/`limit`; `since` gives the oldest posts
   * after it; neither gives the most recent. `channel` narrows to one channel.
   */
  function readBoard({ since, limit, seqs, channel, viewer, coordinator } = {}) {
    const posts = ledger.records(book).filter(record => Number.isInteger(record.seq))
    const can = record => visible(record, viewer, coordinator) && (channel === undefined || (record.channel ?? MAIN) === String(channel).replace(/^#/, ''))
    const head = lastSeq()
    if (Array.isArray(seqs)) {
      const wanted = new Set(seqs)
      return { messages: posts.filter(record => wanted.has(record.seq) && can(record)), head }
    }
    const size = Math.min(Math.max(Number.isInteger(limit) ? limit : READ_LIMIT, 1), READ_LIMIT_MAX)
    const rows = posts.filter(record => can(record) && (since === undefined || record.seq > since))
    return { messages: since === undefined ? rows.slice(-size) : rows.slice(0, size), head }
  }

  return { book, post, readBoard, channelOp, channelNames, membersOf, lastSeq, registry }
}
