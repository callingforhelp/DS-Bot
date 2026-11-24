// dsbot-mem mcp: a stdio MCP server that prefers DS Bot's live loopback MCP (8798, then 8797),
// and otherwise answers from the offline local-mem.sqlite store. An optional Cloud endpoint
// (POST <cloudUrl>/v1/mcp) is tried before the offline store when it is configured.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { embedText, looksSecret, memHome, openStore, readJson, readMode } from './local-store.js'

export const LOCAL_URLS = ['http://127.0.0.1:8798/mcp', 'http://127.0.0.1:8797/mcp']
export const PROBE_MS = 250
export const PROTOCOL = '2025-06-18'

const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const schema = (properties, required = []) => ({ type: 'object', properties, required })

export const TOOLS = [
  ['mem_save', 'Save one durable, self-contained fact.', schema({ text: str('The fact (max 4000 chars). Never include secrets.'), topic: str('Short topic slug'), scope: str('team | workspace | bot'), repo: str('Repository name'), commit: str('Commit SHA') }, ['text'])],
  ['mem_ingest', 'Ingest an observation or fact into DS Bot memory (alias of mem_save).', schema({ text: str('The fact or observation (max 4000 chars). Never include secrets.'), topic: str('Short topic slug'), scope: str('team | workspace | bot'), repo: str('Repository name'), commit: str('Commit SHA') }, ['text'])],
  ['mem_search', 'Search saved memories (full-text, plus vectors when Ollama embeddings are on).', schema({ query: str('Search words'), limit: num('Max results (default 8)'), scope: str('Scope filter'), repo: str('Repository filter') }, ['query'])],
  ['mem_context', 'Build compact startup context from relevant and recent memories.', schema({ query: str('Optional focus query'), repo: str('Repository filter'), limit: num('Max results') })],
  ['mem_recent', 'List the newest memories.', schema({ limit: num('Max results'), repo: str('Repository filter') })],
  ['mem_forget', 'Soft-delete memories by id (restorable).', schema({ ids: { type: 'array', items: { type: 'number' } }, id: num('Single memory id') })],
  ['mem_restore', 'Restore a forgotten memory.', schema({ id: num('Memory id') }, ['id'])],
  ['mem_mode', 'Get or set the local memory privacy mode (on, silent, incognito, off).', schema({ mode: str('on | silent | incognito | off') })],
  ['mem_code_search', 'Find the commits, PRs and agent sessions linked to a file, commit or PR.', schema({ term: str('File path, commit SHA, PR URL or repo'), query: str('Alias of term') })],
  ['mem_stats', 'Counts for the local store.', schema({})],
  ['skill_save', 'Save a reusable skill (Markdown).', schema({ name: str('Skill name'), body: str('Markdown body') }, ['name', 'body'])],
  ['skill_get', 'Read a skill.', schema({ name: str('Skill name') }, ['name'])],
  ['skill_list', 'List skills.', schema({})],
  ['skill_delete', 'Delete a skill.', schema({ name: str('Skill name') }, ['name'])],
  ['artifact_save', 'Save a shared artifact (text).', schema({ name: str('Artifact name'), title: str('Alias of name'), body: str('Content'), content: str('Alias of body') })],
  ['artifact_get', 'Read an artifact.', schema({ name: str('Artifact name'), id: str('Alias of name') })],
  ['artifact_list', 'List artifacts.', schema({})],
  ['artifact_delete', 'Delete an artifact.', schema({ name: str('Artifact name'), id: str('Alias of name') })],
  ['swarm_post', 'Post a note to a swarm channel.', schema({ swarm: str('Swarm id'), swarmId: str('Alias of swarm'), text: str('Note'), author: str('Author name') }, ['text'])],
  ['swarm_read', 'Read swarm notes after a sequence number.', schema({ swarm: str('Swarm id'), swarmId: str('Alias of swarm'), since: num('Last seen seq'), limit: num('Max notes') })],
  ['swarm_list', 'List swarms that have notes.', schema({})],
].map(([name, description, inputSchema]) => ({ name, description, inputSchema }))

const text = (value, isError = false) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
})

// Runs one tool against the local store. Returns an MCP tool result.
export async function callLocal(store, name, args = {}, { config = {}, mode = 'on', dir = store?.dir } = {}) {
  const writes = /^(mem_save|mem_ingest|mem_forget|mem_restore|skill_save|skill_delete|artifact_save|artifact_delete|swarm_post)$/
  if (mode === 'off' && name !== 'mem_mode') return text('DS Bot memory is off. Run `dsbot-mem mode on` to use it.', true)
  if (mode === 'incognito' && writes.test(name)) return text('DS Bot memory is in incognito mode: writes are disabled.', true)
  try {
    switch (name) {
      case 'mem_save':
      case 'mem_ingest': {
        const r = store.save({ ...args, source: 'mcp' })
        if (config.embeddings !== 'none' && r.created) {
          const vec = await embedText(args.text)
          if (vec) store.putEmbedding(r.id, 'nomic-embed-text', vec)
        }
        return text(r)
      }
      case 'mem_search': return text(await searchMemories(store, args.query, args, config))
      case 'mem_context': {
        if (mode === 'silent') return text({ context: '', mode })
        const hits = args.query ? await searchMemories(store, args.query, { limit: args.limit ?? 6, repo: args.repo }, config) : store.recent({ limit: args.limit ?? 6, repo: args.repo })
        return text({ context: hits.map(m => `- ${m.topic ? `[${m.topic}] ` : ''}${m.text}`).join('\n'), hits })
      }
      case 'mem_recent': return text(store.recent(args))
      case 'mem_forget': {
        const ids = Array.isArray(args.ids) ? args.ids.map(Number) : args.id !== undefined ? [Number(args.id)] : []
        return text({ forgotten: store.forget(ids) })
      }
      case 'mem_restore': return text({ restored: store.restore(Number(args.id)) })
      case 'mem_mode': {
        if (args.mode !== undefined && dir) {
          const { writeMode } = await import('./local-store.js')
          return text({ mode: writeMode(dir, args.mode) })
        }
        return text({ mode })
      }
      case 'mem_code_search': return text(store.codeSearch(args.term ?? args.query ?? '', args))
      case 'mem_stats': return text(store.stats())
      case 'skill_save': return text({ name: store.libraryPut('skill', args.name, args.body) })
      case 'skill_get': return text(store.libraryGet('skill', args.name) ?? 'not found', !store.libraryGet('skill', args.name))
      case 'skill_list': return text(store.libraryList('skill'))
      case 'skill_delete': return text({ deleted: store.libraryDelete('skill', args.name) })
      case 'artifact_save': return text({ name: store.libraryPut('artifact', args.name ?? args.title, args.body ?? args.content ?? '') })
      case 'artifact_get': {
        const key = args.name ?? args.id
        const item = store.libraryGet('artifact', key)
        return text(item ?? 'not found', !item)
      }
      case 'artifact_list': return text(store.libraryList('artifact'))
      case 'artifact_delete': return text({ deleted: store.libraryDelete('artifact', args.name ?? args.id) })
      case 'swarm_post': return text({ seq: store.swarmPost(args.swarm ?? args.swarmId, args.text, args.author) })
      case 'swarm_read': return text(store.swarmRead(args.swarm ?? args.swarmId, args))
      case 'swarm_list': return text(store.swarmList())
      default: return text(`unknown tool ${name}`, true)
    }
  } catch (err) {
    return text(String(err?.message ?? err), true)
  }
}

// Full-text search first; adds vector hits when embeddings are on and Ollama answers.
export async function searchMemories(store, query, opts = {}, config = {}) {
  const hits = store.search(query, opts)
  if (config.embeddings !== 'ollama') return hits
  const vec = await embedText(query)
  if (!vec) return hits
  const seen = new Set(hits.map(h => h.id))
  const extra = store.vectorSearch(vec, { limit: opts.limit ?? 8 }).filter(h => !seen.has(h.id))
  return [...hits, ...extra].slice(0, opts.limit ?? 8)
}

// ---- credentials: Keychain on macOS, else a 0600 file. Never printed, never put in agent configs.
export function readToken(dir, account = 'local-mcp', { env = process.env, platform = process.platform } = {}) {
  if (env.DSBOT_MCP_TOKEN && account === 'local-mcp') return env.DSBOT_MCP_TOKEN
  if (platform === 'darwin' && !env.DSBOT_MEM_NO_KEYCHAIN) {
    try {
      const out = execFileSync('security', ['find-generic-password', '-s', 'dsbot-memory', '-a', account, '-w'], { timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] })
      const t = out.toString().trim()
      if (t) return t
    } catch { /* not in Keychain */ }
  }
  const file = join(dir, account === 'local-mcp' ? 'client.token' : `${account}.token`)
  if (!existsSync(file)) return ''
  try { chmodSync(file, 0o600) } catch { /* best effort */ }
  return readFileSync(file, 'utf8').trim()
}

async function post(url, body, { token = '', session = '', timeoutMs = 4000 } = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL }
  if (token) headers.authorization = `Bearer ${token}`
  if (session) headers['mcp-session-id'] = session
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  const raw = await res.text()
  let msg = null
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for (const line of raw.split('\n')) if (line.startsWith('data:')) { try { msg = JSON.parse(line.slice(5)) } catch { /* skip */ } }
  } else if (raw) {
    try { msg = JSON.parse(raw) } catch { /* not JSON */ }
  }
  return { status: res.status, session: res.headers.get('mcp-session-id') ?? session, msg }
}

// The first loopback URL that answers a ping within 250 ms, or ''.
export async function probeLocal(urls = LOCAL_URLS, token = '', timeoutMs = PROBE_MS) {
  for (const url of urls) {
    try {
      const r = await post(url, { jsonrpc: '2.0', id: 'probe', method: 'ping' }, { token, timeoutMs })
      if (r.status >= 200 && r.status < 500 && r.status !== 404) return url
    } catch { /* try the next one */ }
  }
  return ''
}

class Remote {
  constructor(url, token) { this.url = url; this.token = token; this.session = ''; this.ready = false }
  async call(body) {
    if (!this.ready) {
      const init = await post(this.url, { jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'dsbot-mem', version: '0.1.0' } } }, this)
      if (init.status !== 200) throw new Error(`remote initialize ${init.status}`)
      this.session = init.session
      await post(this.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, this).catch(() => {})
      this.ready = true
    }
    const r = await post(this.url, body, this)
    if (r.status === 401 || r.status === 403) throw new Error(`remote refused (${r.status})`)
    if (!r.msg) throw new Error(`remote ${r.status}`)
    return r.msg
  }
}

// Serves MCP on stdin/stdout. `io` is injectable for tests.
export async function runMcp(opts = {}, io = { input: process.stdin, output: process.stdout }) {
  const env = opts.env ?? process.env
  const dir = opts.dir ?? memHome(env)
  const config = readJson(join(dir, 'config.json'), {})
  const client = readJson(join(dir, 'client.json'), {})
  const urls = opts.url ? [opts.url] : (client.localUrl ? [client.localUrl, ...LOCAL_URLS] : LOCAL_URLS)
  const cloudUrl = opts.fallback === 'none' ? '' : (opts.cloudUrl ?? client.cloudUrl ?? '')
  const store = await openStore(dir)
  const out = (m) => io.output.write(`${JSON.stringify(m)}\n`)
  let remote = null
  let remoteUrl = ''
  let lastProbe = 0

  async function pickRemote() {
    if (opts.offline) return null
    if (remote && Date.now() - lastProbe < 15000) return remote
    lastProbe = Date.now()
    const url = await probeLocal(urls, readToken(dir, 'local-mcp', { env }))
    if (!url) { remote = null; remoteUrl = ''; return null }
    if (url !== remoteUrl) { remote = new Remote(url, readToken(dir, 'local-mcp', { env })); remoteUrl = url }
    return remote
  }

  async function viaCloud(msg) {
    const token = readToken(dir, 'cloud', { env })
    if (!cloudUrl || !token) return null
    try {
      const r = await post(`${cloudUrl.replace(/\/$/, '')}/v1/mcp`, msg, { token })
      return r.status === 200 ? r.msg : null
    } catch { return null }
  }

  const isUnknownToolReply = (reply) => {
    const msgText = String(reply?.error?.message ?? reply?.result?.content?.[0]?.text ?? '')
    return Boolean(reply?.error || (reply?.result?.isError && /unknown tool/i.test(msgText)))
  }

  async function handle(msg) {
    const { id, method, params } = msg
    if (id === undefined) return null // notifications need no reply
    if (method === 'initialize') {
      return { jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'dsbot-memory', version: '0.1.0' } } }
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
    if (method === 'tools/list') {
      const live = await pickRemote()
      if (live) {
        try {
          const reply = await live.call({ jsonrpc: '2.0', id, method: 'tools/list', params: {} })
          const remoteTools = Array.isArray(reply?.result?.tools) ? reply.result.tools : null
          if (remoteTools) {
            const seen = new Set(remoteTools.map(t => t.name))
            return { jsonrpc: '2.0', id, result: { tools: [...remoteTools, ...TOOLS.filter(t => !seen.has(t.name))] } }
          }
        } catch { remote = null; remoteUrl = ''; lastProbe = 0 }
      }
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
    }
    if (method !== 'tools/call') return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
    const name = params?.name
    const localKnown = TOOLS.some(t => t.name === name)
    const live = await pickRemote()
    if (live) {
      try {
        const forwardedName = name === 'mem_save' ? 'mem_ingest' : name
        const forwarded = forwardedName === name ? msg : { ...msg, params: { ...params, name: forwardedName } }
        const reply = await live.call(forwarded)
        if (!isUnknownToolReply(reply)) return { ...reply, id }
        if (!localKnown) return { ...reply, id }
      } catch { remote = null; remoteUrl = ''; lastProbe = 0 }
    }
    if (!localKnown) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${name}` } }
    const cloud = await viaCloud(msg)
    if (cloud && !isUnknownToolReply(cloud)) return { ...cloud, id }
    const result = await callLocal(store, name, params.arguments ?? {}, { config, mode: readMode(dir), dir })
    return { jsonrpc: '2.0', id, result }
  }

  const rl = createInterface({ input: io.input })
  const pending = new Set()
  rl.on('line', (line) => {
    if (!line.trim()) return
    let msg
    try { msg = JSON.parse(line) } catch { return out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) }
    const p = handle(msg).then(r => { if (r) out(r) }, err => out({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: String(err?.message ?? err) } }))
    pending.add(p)
    p.finally(() => pending.delete(p))
  })
  await new Promise(resolve => rl.on('close', resolve))
  await Promise.all(pending)
  store.close()
}

export { looksSecret }
