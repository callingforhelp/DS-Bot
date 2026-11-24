// MCP access: other agents on this computer (Claude Desktop, Cursor, Codex, a script)
// reach the Bot team through a small MCP server on 127.0.0.1. They come in as a channel
// the user authorized, like IM or the phone app, not as team members: each client has
// its own revocable token, sees only the Bots and groups it was given, and can only
// read chats, send messages and wait for replies. Approvals, questions, settings,
// secrets and private Bots stay with the person at the computer.
//
// mcp.json keeps the switch, the port and the clients. A client's token is shown once
// when it is made; the file keeps only its SHA-256.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE = 'mcp.json'
export const DEFAULT_PORT = 8797
const PROTOCOL = '2025-06-18'
const MAX_BODY = 1 << 20
const MAX_TEXT = 20_000
const WAIT_DEFAULT_S = 25
// Most MCP clients give up on a tool call after about 60 seconds.
const WAIT_MAX_S = 50
const MAX_PAGES = 20
const POLL_MS = 1_000
const LAST_USED_SAVE_MS = 60_000
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const refused = message => Object.assign(new Error(message), { code: 'bot/refused' })
const hashOf = token => createHash('sha256').update(token).digest()
const ids = list => (Array.isArray(list) ? [...new Set(list.map(String).filter(Boolean))] : [])

export const MCP_TOOLS = [
  {
    name: 'list_bots',
    description: 'List the DS Bot Bots this client may talk to, with their role and whether each is working now.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_groups',
    description: 'List the DS Bot group chats this client may post in, with their members.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'send_to_bot',
    description: 'Send a message to a Bot\'s own chat. It is queued if the Bot is working. Returns at once; call wait_for_reply with the returned `after` to get the answer.',
    inputSchema: {
      type: 'object',
      properties: { bot: { type: 'string', description: 'Bot id or name, from list_bots' }, text: { type: 'string' } },
      required: ['bot', 'text'],
    },
  },
  {
    name: 'send_to_group',
    description: 'Post a message in a group chat. Mention a member with @Name to ask that member. Returns at once; call wait_for_reply with the returned `after`.',
    inputSchema: {
      type: 'object',
      properties: { group: { type: 'string', description: 'Group id or name, from list_groups' }, text: { type: 'string' } },
      required: ['group', 'text'],
    },
  },
  {
    name: 'wait_for_reply',
    description: 'Wait until a Bot or group has finished working, or until the timeout, and return the messages posted after `after`. When `done` is false, call it again with the returned `after`.',
    inputSchema: {
      type: 'object',
      properties: {
        bot: { type: 'string' },
        group: { type: 'string' },
        after: { type: 'number', description: 'Time in ms, from send_to_bot, send_to_group or an earlier wait_for_reply' },
        timeoutSeconds: { type: 'number', description: `At most ${WAIT_MAX_S}; default ${WAIT_DEFAULT_S}` },
      },
    },
  },
  {
    name: 'read_chat',
    description: 'Read the newest messages of a Bot\'s chat or a group chat. Pass the returned cursor to read older ones.',
    inputSchema: {
      type: 'object',
      properties: { bot: { type: 'string' }, group: { type: 'string' }, cursor: { type: 'object' } },
    },
  },
  {
    name: 'list_waiting',
    description: 'List the approvals and questions that wait for the person at the computer in this client\'s Bots and groups. Read only: answer them in DS Bot.',
    inputSchema: { type: 'object', properties: {} },
  },
]

const VALID_MEMORY_SCOPES = new Set(['read', 'write', 'code', 'team'])
const VALID_MEMORY_MODES = new Set(['on', 'silent', 'incognito', 'off'])

export const MEMORY_MCP_TOOLS = [
  {
    name: 'mem_search',
    description: 'Hybrid lexical and semantic search across DS Bot memory and observations.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' }, scope: { type: 'string' } }, required: ['query'] },
    requiredScope: 'read',
  },
  {
    name: 'mem_code_search',
    description: 'Search commit SHAs, PRs, and file paths linked to past sessions and observations.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, commit: { type: 'string' }, pr: { type: 'string' }, path: { type: 'string' }, limit: { type: 'number' } } },
    requiredScope: 'code',
  },
  {
    name: 'mem_ingest',
    description: 'Ingest an observation or turn summary into DS Bot memory (honors privacy mode and redaction).',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, topic: { type: 'string' }, sessionId: { type: 'string' }, botId: { type: 'string' }, scope: { type: 'string' } }, required: ['text'] },
    requiredScope: 'write',
  },
  {
    name: 'mem_context',
    description: 'Build startup context from relevant memories and recent observations.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, sessionId: { type: 'string' }, botId: { type: 'string' }, limit: { type: 'number' } } },
    requiredScope: 'read',
  },
  {
    name: 'mem_forget',
    description: 'Soft-delete a memory entry by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    requiredScope: 'write',
  },
  {
    name: 'mem_restore',
    description: 'Restore a previously soft-deleted memory entry by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    requiredScope: 'write',
  },
  {
    name: 'mem_takeover',
    description: 'Export a lossless session takeover bundle for handoff.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    requiredScope: 'read',
  },
  {
    name: 'mem_import',
    description: 'Import a transcript or markdown memory directory into DS Bot memory.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, format: { type: 'string' }, botId: { type: 'string' } } },
    requiredScope: 'write',
  },
  {
    name: 'mem_mode',
    description: 'Get or set the memory privacy mode (on, silent, incognito, off) for a session.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, mode: { type: 'string' } } },
    requiredScope: 'write',
  },
  {
    name: 'artifact_save',
    description: 'Create or update a shared team artifact.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, kind: { type: 'string' }, content: { type: 'string' } }, required: ['title'] },
    requiredScope: 'write',
  },
  {
    name: 'artifact_get',
    description: 'Read a shared team artifact by id or slug.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    requiredScope: 'read',
  },
  {
    name: 'artifact_list',
    description: 'List shared team artifacts.',
    inputSchema: { type: 'object', properties: {} },
    requiredScope: 'read',
  },
  {
    name: 'artifact_delete',
    description: 'Delete a shared team artifact by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    requiredScope: 'write',
  },
]

export const SWARM_MCP_TOOLS = [
  {
    name: 'swarm_status',
    description: 'List active swarms or inspect one swarm roster and state.',
    inputSchema: { type: 'object', properties: { swarmId: { type: 'string' } } },
  },
  {
    name: 'swarm_post',
    description: 'Post a message to a swarm board.',
    inputSchema: { type: 'object', properties: { swarmId: { type: 'string' }, text: { type: 'string' }, channel: { type: 'string' } }, required: ['swarmId', 'text'] },
  },
  {
    name: 'swarm_read',
    description: 'Read messages from a swarm board.',
    inputSchema: { type: 'object', properties: { swarmId: { type: 'string' }, since: { type: 'number' }, limit: { type: 'number' }, channel: { type: 'string' } }, required: ['swarmId'] },
  },
  {
    name: 'swarm_switch_model',
    description: 'Switch a swarm member model preserving history.',
    inputSchema: { type: 'object', properties: { swarmId: { type: 'string' }, name: { type: 'string' }, model: { type: 'string' } }, required: ['swarmId', 'name', 'model'] },
  },
  {
    name: 'swarm_close',
    description: 'Close a swarm and ingest its distilled decisions into memory.',
    inputSchema: { type: 'object', properties: { swarmId: { type: 'string' } }, required: ['swarmId'] },
  },
]

const stripScopeMeta = ({ requiredScope: _ignored, ...tool }) => tool

export function toolsForClient(client) {
  const scopes = new Set(Array.isArray(client?.memoryScopes) ? client.memoryScopes : [])
  const memoryTools = MEMORY_MCP_TOOLS.filter(tool => scopes.has(tool.requiredScope)).map(stripScopeMeta)
  const swarmTools = client?.swarmAccess === true ? SWARM_MCP_TOOLS : []
  return [...MCP_TOOLS, ...memoryTools, ...swarmTools]
}

// Only what an agent reads: who said it, what, and when. No tool calls or step details.
function chatItems(items) {
  return (items ?? [])
    .filter(item => typeof item?.text === 'string' && item.text.trim() !== '')
    .map(item => ({
      kind: item.kind,
      ...(item.name ? { from: item.name } : {}),
      text: item.text.length > MAX_TEXT ? `${item.text.slice(0, MAX_TEXT)}…` : item.text,
      ...(Number.isFinite(item.time) ? { time: item.time } : {}),
    }))
}

// The tools one client may use, scoped to its Bots and groups. `rt` is the runtime.
// `current()` returns the client as it is saved now, or undefined once removed, so
// a long wait_for_reply notices a revoked client or a narrowed scope.
export function clientTools(rt, client, { pollMs = POLL_MS, current = () => client } = {}) {
  const { state } = rt
  const scope = () => {
    const now = current()
    if (now === undefined) throw refused('This client was removed')
    return now
  }
  const requireMemoryScope = (needed) => {
    const now = scope()
    const scopes = Array.isArray(now.memoryScopes) ? now.memoryScopes : []
    if (!scopes.includes(needed)) throw refused(`This client lacks memory scope "${needed}"`)
    return now
  }
  const requireSwarmAccess = () => {
    const now = scope()
    if (now.swarmAccess !== true) throw refused('This client does not have swarm access')
    return now
  }
  const clientMode = () => scope().memoryMode ?? 'on'
  const allowedBot = bot => bot !== undefined && bot.private !== true && scope().bots.includes(bot.id)
  const allowedRoom = room => room !== undefined && scope().rooms.includes(room.id)
  const named = (entry, key) => String(entry.name ?? '').toLowerCase() === key.toLowerCase()
  // Scope first, so a Bot or group out of scope never hides one in scope with the same name.
  const findBot = (ref) => {
    const key = String(ref ?? '').trim()
    const byId = rt.botOf(key)
    const bot = allowedBot(byId) ? byId : Object.values(state.bots).filter(allowedBot).find(entry => named(entry, key))
    if (bot === undefined) throw refused(`No Bot "${key}" for this client. Call list_bots.`)
    return bot
  }
  const findRoom = (ref) => {
    const key = String(ref ?? '').trim()
    const byId = rt.roomOf(key)
    const room = allowedRoom(byId) ? byId : Object.values(state.rooms ?? {}).filter(allowedRoom).find(entry => named(entry, key))
    if (room === undefined) throw refused(`No group "${key}" for this client. Call list_groups.`)
    return room
  }
  const isPrivate = id => id !== undefined && id !== null && (rt.botOf(id) ?? rt.botOf(rt.selfOf?.(id)))?.private === true
  // A group can have a private Bot as a member: its posts are left out.
  const visible = items => chatItems((items ?? []).filter(item => !isPrivate(item?.botId)))
  const target = (args) => {
    if (args.bot !== undefined && args.group !== undefined) throw invalid('Pass bot or group, not both')
    if (args.group !== undefined) return { room: findRoom(args.group) }
    if (args.bot !== undefined) return { bot: findBot(args.bot) }
    throw invalid('Pass bot or group')
  }
  // A Bot that handed work on and ended its turn is still busy until the results are in.
  const botBusy = bot => rt.live.get(rt.chatOf(bot.id))?.turn !== undefined || rt.waitingView?.()[bot.id] !== undefined
  const read = async ({ bot, room }, cursor) => {
    if (bot !== undefined) {
      const page = await rt.chatPage(bot.id, cursor)
      return { items: page.items, cursor: page.cursor ?? null, working: botBusy(bot) }
    }
    const page = await rt.mobileEndpoint('room-chat', { roomId: room.id, ...(cursor ? { cursor } : {}) })
    return { items: page.items, cursor: page.cursor ?? null, working: page.running === true }
  }
  // The newest page, plus older ones until one starts at or before `after`, so
  // replies that span pages or conversation parts are not skipped.
  const readSince = async (place, after) => {
    const page = await read(place)
    let { cursor } = page
    for (let pages = 1; cursor && pages < MAX_PAGES && (page.items[0]?.time ?? 0) > after; pages += 1) {
      const older = await read(place, cursor)
      page.items = [...older.items, ...page.items]
      cursor = older.cursor
    }
    return page
  }
  // The client's name goes with every message, so a Bot knows it is not the user typing.
  const send = async (sessionId, text) => {
    const body = String(text ?? '').trim()
    if (body === '') throw invalid('text is empty')
    if (body.length > MAX_TEXT) throw invalid(`text is longer than ${MAX_TEXT} characters`)
    const after = Date.now()
    await rt.sendUser({
      sessionId,
      requestId: `mcp:${client.id}:${randomUUID()}`,
      content: [{ type: 'text', text: `[Sent by the external agent "${client.name}" through DS Bot MCP access]\n${body}` }],
    })
    return { sent: true, after }
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  const handlers = {
    list_bots: () => ({
      bots: Object.values(state.bots).filter(allowedBot).map(bot => ({
        id: bot.id,
        name: bot.name,
        ...(bot.role ? { role: bot.role } : {}),
        main: rt.isMain(bot.id),
        working: botBusy(bot),
      })),
    }),
    list_groups: () => ({
      groups: Object.values(state.rooms ?? {}).filter(allowedRoom).map(room => ({
        id: room.id,
        name: room.name,
        members: (room.members ?? []).map(id => rt.botOf(id)).filter(bot => bot !== undefined && bot.private !== true).map(bot => bot.name),
      })),
    }),
    send_to_bot: args => send(findBot(args.bot).id, args.text),
    send_to_group: args => send(findRoom(args.group).id, args.text),
    read_chat: async (args) => {
      const page = await read(target(args), args.cursor)
      return { messages: visible(page.items), cursor: page.cursor, working: page.working }
    },
    wait_for_reply: async (args) => {
      target(args)
      const after = Number.isFinite(args.after) ? args.after : Date.now()
      const seconds = Math.min(Math.max(Number(args.timeoutSeconds) || WAIT_DEFAULT_S, 1), WAIT_MAX_S)
      const until = Date.now() + seconds * 1000
      const replies = page => visible(page.items).filter(item => item.kind !== 'user' && (item.time ?? 0) > after)
      // A turn can take a moment to start after send: one poll before trusting "idle".
      // Only the first and the last poll read back over older pages; the ones between
      // need only the newest page to see whether the Bot is still working.
      let polls = 0
      for (;;) {
        // Checked on every poll: the client can be removed or its scope narrowed mid-wait.
        const page = polls === 0 ? await readSince(target(args), after) : await read(target(args))
        const done = !page.working && (replies(page).length > 0 || polls > 0)
        if (done || Date.now() >= until) {
          const fresh = polls === 0 ? replies(page) : replies(await readSince(target(args), after))
          const last = fresh.at(-1)?.time ?? after
          return { done, working: page.working, messages: fresh, after: last }
        }
        polls += 1
        await sleep(Math.min(pollMs, Math.max(until - Date.now(), 0)))
      }
    },
    list_waiting: () => {
      const owned = ({ botId, roomId }) => !isPrivate(botId) && (roomId !== undefined ? allowedRoom(rt.roomOf(roomId)) : allowedBot(rt.botOf(botId)))
      const approvals = (rt.approvalsView?.() ?? []).filter(owned).map(entry => ({
        kind: 'approval',
        ...(entry.id ? { id: String(entry.id) } : {}),
        bot: rt.botOf(entry.botId)?.name,
        ...(entry.roomId ? { group: rt.roomOf(entry.roomId)?.name } : {}),
        tool: entry.tool,
        reason: entry.reason,
      }))
      const questions = Object.entries(state.questions ?? {}).flatMap(([sessionId, question]) => {
        const bot = rt.botOf(rt.selfOf?.(sessionId))
        if (!allowedBot(bot)) return []
        return [{
          kind: 'question',
          ...(question?.id ? { id: String(question.id) } : {}),
          bot: bot.name,
          question: String(question?.question ?? ''),
          ...(typeof question?.detail === 'string' && question.detail.trim() !== '' ? { detail: question.detail } : {}),
          options: Array.isArray(question?.options)
            ? question.options.map(o => (typeof o === 'string' ? o : String(o?.label ?? ''))).filter(Boolean)
            : [],
          multiSelect: question?.multiSelect === true,
          allowCustom: question?.allowCustom !== false,
        }]
      })
      const views = Object.entries(state.views ?? {}).flatMap(([sessionId, view]) => {
        const bot = rt.botOf(rt.selfOf?.(sessionId))
        if (!allowedBot(bot) || view?.issueDraft !== undefined) return []
        return [{
          kind: 'view',
          ...(view?.id ? { id: String(view.id) } : {}),
          bot: bot.name,
          title: String(view?.title ?? ''),
        }]
      })
      return { waiting: [...approvals, ...questions, ...views], answerIn: 'DS Bot on this computer' }
    },
    mem_search: async (args) => {
      requireMemoryScope('read')
      const mode = clientMode()
      if (mode === 'silent' || mode === 'off') return { results: [], mode }
      const results = await (rt.hybridSearch?.(String(args.query ?? ''), { limit: args.limit, scope: args.scope }) ?? [])
      return { results }
    },
    mem_code_search: async (args) => {
      requireMemoryScope('code')
      const results = await (rt.codeSearch?.({ query: args.query, commit: args.commit, pr: args.pr, path: args.path, limit: args.limit }) ?? [])
      return { results }
    },
    mem_ingest: async (args) => {
      requireMemoryScope('write')
      const mode = clientMode()
      if (mode === 'incognito' || mode === 'off') return { ingested: false, mode }
      return (await rt.ingestObservation?.({
        text: String(args.text ?? ''),
        topic: args.topic,
        sessionId: args.sessionId,
        botId: args.botId,
        scope: args.scope ?? 'team',
        source: `mcp:${client.name}`,
      })) ?? { ingested: false }
    },
    mem_context: async (args) => {
      requireMemoryScope('read')
      const mode = clientMode()
      if (mode === 'silent' || mode === 'off') return { context: '', mode }
      const context = await (rt.buildStartupContext?.({ query: args.query, sessionId: args.sessionId, botId: args.botId, limit: args.limit }) ?? '')
      return { context }
    },
    mem_forget: async (args) => {
      requireMemoryScope('write')
      const id = String(args.id ?? '').trim()
      if (id === '') throw invalid('id is required')
      return { deleted: Boolean(await rt.memoryIndexDelete?.(id)), id }
    },
    mem_restore: async (args) => {
      requireMemoryScope('write')
      const id = String(args.id ?? '').trim()
      if (id === '') throw invalid('id is required')
      return { restored: Boolean(await rt.memoryIndexRestore?.(id)), id }
    },
    mem_takeover: async (args) => {
      requireMemoryScope('read')
      const sessionId = String(args.sessionId ?? '').trim()
      if (sessionId === '') throw invalid('sessionId is required')
      return (await rt.exportTakeoverBundle?.(sessionId)) ?? { sessionId, entries: [] }
    },
    mem_import: async (args) => {
      requireMemoryScope('write')
      return (await rt.importTranscript?.(args)) ?? { imported: 0 }
    },
    mem_mode: async (args) => {
      requireMemoryScope('write')
      const sessionId = String(args.sessionId ?? '').trim()
      if (args.mode !== undefined) {
        if (!VALID_MEMORY_MODES.has(args.mode)) throw invalid(`Invalid memory mode: ${args.mode}`)
        if (sessionId) rt.setSessionMemoryMode?.(sessionId, args.mode)
        return { sessionId: sessionId || null, mode: args.mode }
      }
      return { sessionId: sessionId || null, mode: rt.resolveMemoryMode?.({ sessionId }) ?? clientMode() }
    },
    artifact_save: async (args) => {
      requireMemoryScope('write')
      return (await rt.artifactEndpoint?.('artifact-save', args)) ?? { ok: false }
    },
    artifact_get: async (args) => {
      requireMemoryScope('read')
      const artifact = rt.getArtifact?.(String(args.id ?? ''))
      if (!artifact) throw invalid('Artifact not found')
      return { artifact }
    },
    artifact_list: () => {
      requireMemoryScope('read')
      return { artifacts: Object.values(rt.artifactsView?.() ?? {}) }
    },
    artifact_delete: async (args) => {
      requireMemoryScope('write')
      return (await rt.artifactEndpoint?.('artifact-delete', { id: args.id })) ?? { ok: false }
    },
    swarm_status: (args) => {
      requireSwarmAccess()
      const swarms = rt.swarmsView?.() ?? {}
      if (args.swarmId) return { swarm: swarms[args.swarmId] ?? null }
      return { swarms }
    },
    swarm_post: async (args) => {
      requireSwarmAccess()
      return (await rt.swarmEndpoint?.('swarm-post', { ...args, from: `mcp:${client.name}` })) ?? { ok: false }
    },
    swarm_read: async (args) => {
      requireSwarmAccess()
      return (await rt.swarmEndpoint?.('swarm-read', args)) ?? { messages: [] }
    },
    swarm_switch_model: async (args) => {
      requireSwarmAccess()
      return (await rt.swarmEndpoint?.('swarm-switch-model', args)) ?? { ok: false }
    },
    swarm_close: async (args) => {
      requireSwarmAccess()
      return (await rt.swarmEndpoint?.('swarm-close', args)) ?? { ok: false }
    },
  }
  return async (name, args) => {
    const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined
    if (handler === undefined) throw invalid(`Unknown tool ${name}`)
    await rt.load()
    return handler(args ?? {})
  }
}

// The HTTP side: MCP's Streamable HTTP transport, plain JSON answers, no sessions.
// `authorize(token)` returns the client or undefined; `callFor(client)` its tools.
export function mcpHttpServer({ authorize, callFor, version = '0' }) {
  const send = (response, status, body, headers = {}) => {
    response.writeHead(status, { 'content-type': 'application/json', ...headers })
    response.end(body === undefined ? undefined : JSON.stringify(body))
  }
  const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
  const answer = async (client, { id, method, params }) => {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'ds-bot', version },
          instructions: 'DS Bot is a team of long-lived Bots on this computer. list_bots, then send_to_bot and wait_for_reply.',
        }
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: toolsForClient(client) }
      case 'tools/call': {
        try {
          const result = await callFor(client)(String(params?.name ?? ''), params?.arguments ?? {})
          return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
        } catch (error) {
          return { isError: true, content: [{ type: 'text', text: error?.message ?? String(error) }] }
        }
      }
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { rpc: -32601, id })
    }
  }
  const readBody = request => new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }))
        request.destroy()
      } else chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })

  const serve = async (request, response) => {
    // A web page may not call this server: browsers send Origin, MCP clients do not.
    // The Host check stops DNS rebinding.
    const host = String(request.headers.host ?? '').replace(/:\d+$/, '')
    if (request.headers.origin !== undefined || !LOCAL_HOSTS.has(host)) return send(response, 403, { error: 'Forbidden' })
    if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname !== '/mcp') return send(response, 404, { error: 'Not found' })
    const auth = String(request.headers.authorization ?? '')
    const client = auth.startsWith('Bearer ') ? authorize(auth.slice(7).trim()) : undefined
    if (client === undefined) return send(response, 401, { error: 'Unauthorized' }, { 'www-authenticate': 'Bearer' })
    if (request.method !== 'POST') return send(response, 405, { error: 'Method not allowed' }, { allow: 'POST' })
    let message
    try { message = JSON.parse(await readBody(request)) } catch (error) {
      if (error?.status === 413) return send(response, 413, { error: error.message })
      return send(response, 400, rpcError(null, -32700, 'Parse error'))
    }
    const batch = Array.isArray(message)
    const replies = []
    for (const entry of batch ? message : [message]) {
      if (entry?.id === undefined || entry?.id === null) continue
      try {
        replies.push({ jsonrpc: '2.0', id: entry.id, result: await answer(client, entry) })
      } catch (error) {
        replies.push(rpcError(entry.id, error?.rpc ?? -32603, error?.message ?? String(error)))
      }
    }
    if (replies.length === 0) return send(response, 202)
    return send(response, 200, batch ? replies : replies[0])
  }
  return createServer((request, response) => void serve(request, response).catch(() => {
    if (!response.headersSent) send(response, 500, { error: 'Internal error' })
    else response.end()
  }))
}

// close() waits for open responses, and a wait_for_reply can be open for 50 s: drop
// the connections first so turning access off or moving the port does not hang.
export function closeServer(server) {
  const closed = new Promise(resolve => server.close(() => resolve()))
  server.closeAllConnections?.()
  return closed
}

export function install(rt) {
  const path = join(rt.home, FILE)
  let data
  let server = null
  let listening
  let status = 'off'
  let error = null

  const read = () => {
    if (data !== undefined) return data
    try { data = JSON.parse(readFileSync(path, 'utf8')) } catch { data = {} }
    if (!Array.isArray(data.clients)) data.clients = []
    if (!Number.isInteger(data.port)) data.port = DEFAULT_PORT
    data.on = data.on === true
    return data
  }
  const write = () => {
    mkdirSync(rt.home, { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, path)
  }
  const usedSavedAt = new Map()
  const authorize = (token) => {
    if (token === '') return undefined
    const hash = hashOf(token)
    // A hand-edited entry with a bad hash must not break every other client.
    const client = read().clients.find(entry => typeof entry.hash === 'string' && /^[0-9a-f]{64}$/.test(entry.hash)
      && timingSafeEqual(Buffer.from(entry.hash, 'hex'), hash))
    if (client === undefined) return undefined
    const now = Date.now()
    client.lastUsedAt = now
    // Saved at most once a minute, so a polling client does not rewrite the file every second.
    if (now - (usedSavedAt.get(client.id) ?? 0) >= LAST_USED_SAVE_MS) {
      usedSavedAt.set(client.id, now)
      try { write() } catch {}
    }
    return client
  }
  const tools = new Map()
  const callFor = (client) => {
    const cached = tools.get(client.id)
    if (cached?.client === client) return cached.call
    const call = clientTools(rt, client, { current: () => read().clients.find(entry => entry.id === client.id) })
    tools.set(client.id, { client, call })
    return call
  }
  // Cached clients go stale on edit: rebuild their tools.
  const forget = () => tools.clear()

  const stop = async () => {
    const closing = server
    server = null
    listening = undefined
    if (closing !== null) await closeServer(closing)
  }
  // Only the dsh that owns the team serves it, like the phone link. One pass at a
  // time: the view asks again on every read, so a lock that moved is noticed.
  let chain = Promise.resolve()
  const reconcile = () => (chain = chain.then(settle, settle))
  const settle = async () => {
    read()
    const blocked = rt.readOnly?.()
    if (!data.on || blocked !== undefined) {
      await stop()
      status = 'off'
      error = data.on ? blocked : null
      return
    }
    if (server !== null && listening === data.port) return
    await stop()
    const next = mcpHttpServer({ authorize, callFor, version: rt.version ?? '0' })
    try {
      await new Promise((resolve, reject) => next.once('error', reject).listen(data.port, '127.0.0.1', resolve))
      server = next
      listening = data.port
      status = 'on'
      error = null
    } catch (failure) {
      status = 'off'
      error = failure?.code === 'EADDRINUSE' ? `Port ${data.port} is in use` : failure?.message ?? String(failure)
    }
  }

  rt.mcpView = () => {
    read()
    if ((status === 'on') !== (data.on && rt.readOnly?.() === undefined)) void reconcile()
    return {
      on: data.on,
      port: data.port,
      status,
      error,
      url: `http://127.0.0.1:${data.port}/mcp`,
      clients: data.clients.map(({ id, name, bots, rooms, memoryScopes, memoryMode, swarmAccess, createdAt, lastUsedAt }) => ({
        id, name, bots, rooms,
        ...(Array.isArray(memoryScopes) && memoryScopes.length > 0 ? { memoryScopes } : {}),
        ...(memoryMode ? { memoryMode } : {}),
        ...(swarmAccess === true ? { swarmAccess: true } : {}),
        createdAt, lastUsedAt: lastUsedAt ?? null,
      })),
    }
  }

  const scope = (body, fallback) => ({
    bots: body.bots === undefined ? fallback.bots : ids(body.bots).filter(id => rt.botOf(id) !== undefined && rt.botOf(id).private !== true),
    rooms: body.rooms === undefined ? fallback.rooms : ids(body.rooms).filter(id => rt.roomOf(id) !== undefined),
    memoryScopes: body.memoryScopes === undefined ? (fallback.memoryScopes ?? []) : ids(body.memoryScopes).filter(s => VALID_MEMORY_SCOPES.has(s)),
    ...(body.memoryMode !== undefined
      ? (VALID_MEMORY_MODES.has(body.memoryMode) ? { memoryMode: body.memoryMode } : {})
      : (fallback.memoryMode ? { memoryMode: fallback.memoryMode } : {})),
    swarmAccess: body.swarmAccess === undefined ? fallback.swarmAccess === true : body.swarmAccess === true,
  })
  const clientOf = (id) => {
    const client = data.clients.find(entry => entry.id === String(id ?? ''))
    if (client === undefined) throw invalid('This MCP client does not exist')
    return client
  }

  rt.mcpEndpoint = async (endpoint, body) => {
    read()
    let token
    switch (endpoint) {
      case 'mcp-set': {
        if (body.port !== undefined) {
          const port = Number(body.port)
          if (!Number.isInteger(port) || port < 1024 || port > 65535) throw invalid('The port must be a number from 1024 to 65535')
          data.port = port
        }
        if (body.on !== undefined) data.on = body.on === true
        write()
        break
      }
      case 'mcp-client-add': {
        const name = String(body.name ?? '').trim().slice(0, 60)
        if (name === '') throw invalid('Give the client a name')
        // The Main Bots unless the user picks others: they answer and hand work on.
        const mains = Object.values(rt.state.bots).filter(bot => bot.private !== true && rt.isMain(bot.id)).map(bot => bot.id)
        token = `dsb_${randomBytes(32).toString('base64url')}`
        data.clients.push({ id: randomUUID(), name, hash: hashOf(token).toString('hex'), ...scope(body, { bots: mains, rooms: [] }), createdAt: Date.now() })
        write()
        break
      }
      case 'mcp-client-update': {
        const client = clientOf(body.id)
        if (body.name !== undefined) {
          const name = String(body.name).trim().slice(0, 60)
          if (name === '') throw invalid('Give the client a name')
          client.name = name
        }
        Object.assign(client, scope(body, client))
        forget()
        write()
        break
      }
      case 'mcp-client-remove': {
        const client = clientOf(body.id)
        data.clients = data.clients.filter(entry => entry !== client)
        forget()
        write()
        break
      }
      default:
        throw invalid(`Unknown endpoint ${endpoint}`)
    }
    await reconcile()
    return token === undefined ? rt.mcpView() : { ...rt.mcpView(), token }
  }

  rt.ctx.effect(() => {
    void rt.load().then(reconcile, () => {})
    return () => { void stop() }
  }, 'ds-bot: mcp access')
}
