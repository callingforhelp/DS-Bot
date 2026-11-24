// Lifecycle hooks for coding agents. Every handler is fast, never blocks on the network,
// and prints exactly one JSON object. Antigravity gets its nested systemMessage shape on
// SessionStart and on the first PreInvocation, and `{}` on PostToolUse and Stop.
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, openSync, readSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ensureDir, ftsQuery, memHome, openStore, readJson, readMode, redact, writeJsonAtomic } from './local-store.js'

export const AGENTS = ['agy', 'claude', 'codex', 'cursor', 'grok', 'pi']
const CONTEXT_CAP = 1500
const GIT_CMD = /\b(git\s+(commit|merge|cherry-pick)|gh\s+pr\s+(create|merge))\b/

// Maps each agent's raw event name to one of four actions.
export function canonicalEvent(agent, event) {
  const e = String(event).toLowerCase().replace(/[-_]/g, '')
  if (e === 'sessionstart') return 'recall'
  if (['preinvocation', 'userpromptsubmit', 'beforesubmitprompt', 'beforeagentstart'].includes(e)) return 'prompt'
  if (['posttooluse', 'toolexecutionend'].includes(e)) return 'tool'
  if (['stop', 'sessionend', 'agentend', 'sessionshutdown', 'postinvocation'].includes(e)) return 'ingest'
  return 'none'
}

export async function readStdinJson(stream = process.stdin, timeoutMs = 800) {
  if (stream.isTTY) return {}
  const chunks = []
  const read = (async () => { for await (const c of stream) chunks.push(c) })()
  await Promise.race([read, new Promise(r => setTimeout(r, timeoutMs))])
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return {} }
}

export function normalizePayload(p = {}) {
  const call = p.toolCall ?? {}
  const input = call.args ?? p.tool_input ?? p.toolInput ?? {}
  return {
    session: String(p.conversationId ?? p.session_id ?? p.sessionId ?? p.conversation_id ?? ''),
    cwd: String(p.cwd ?? p.workspacePaths?.[0] ?? p.workspace_roots?.[0] ?? process.cwd()),
    transcript: String(p.transcriptPath ?? p.transcript_path ?? ''),
    prompt: String(p.lastUserInput ?? p.prompt ?? ''),
    invocation: Number(p.invocationNum ?? 0),
    toolName: String(call.name ?? p.tool_name ?? p.toolName ?? ''),
    command: String(input.CommandLine ?? input.command ?? ''),
    path: String(input.Path ?? input.file_path ?? input.path ?? ''),
    stepIdx: p.stepIdx ?? null,
    error: p.error ? String(p.error) : '',
  }
}

export function formatOutput(agent, event, text) {
  if (!text) return {}
  if (agent === 'agy') return { injectSteps: [{ systemMessage: { systemMessage: text } }] }
  if (agent === 'cursor') return { additional_context: text }
  if (agent === 'pi') return { systemPrompt: text }
  const name = String(event) === 'UserPromptSubmit' ? 'UserPromptSubmit' : 'SessionStart'
  return { hookSpecificOutput: { hookEventName: name, additionalContext: text } }
}

export function buildContext(store, { cwd, prompt = '', limit = 6 }) {
  const repo = basename(cwd)
  const seen = new Set()
  const rows = []
  const add = (list) => { for (const m of list) if (!seen.has(m.id)) { seen.add(m.id); rows.push(m) } }
  if (ftsQuery(prompt)) add(store.search(prompt, { limit: 5 }))
  add(store.recent({ limit, repo, kind: 'note' }))
  if (rows.length < 3) add(store.recent({ limit: 3, kind: 'note' }))
  if (!rows.length) return ''
  let body = '<dsbot-memory-context>\nPrior notes (verify mutable repo state before acting):\n'
  for (const m of rows.slice(0, limit)) {
    const line = `- ${m.topic ? `[${m.topic}] ` : ''}${m.text.replace(/\s+/g, ' ').slice(0, 240)}\n`
    if (body.length + line.length + 26 > CONTEXT_CAP) break
    body += line
  }
  return `${body}</dsbot-memory-context>`
}

function spool(dir, name, entry) {
  const d = ensureDir(join(dir, 'spool'))
  appendFileSync(join(d, name), `${JSON.stringify(entry)}\n`)
}

function firstPrompt(dir, session) {
  if (!session) return true
  const d = ensureDir(join(dir, 'spool', 'seen'))
  const file = join(d, session.replace(/[^\w.-]/g, '_'))
  if (existsSync(file)) return false
  writeFileSync(file, '1')
  return true
}

// Returns the JSON object to print.
export async function runHook({ agent, event, payload = {}, env = process.env, dir = memHome(env), spawnFlush = true }) {
  const mode = readMode(dir)
  const p = normalizePayload(payload)
  const action = canonicalEvent(agent, event)
  try {
    if (action === 'recall' || action === 'prompt') {
      if (mode === 'off' || mode === 'silent') return {}
      if (action === 'prompt') {
        const first = agent === 'agy' ? p.invocation === 1 : firstPrompt(dir, p.session)
        if (!first || !p.prompt.trim()) return {}
        if (agent === 'agy' && !firstPrompt(dir, `${p.session}-pre`)) return {}
      }
      const store = await openStore(dir)
      try {
        return formatOutput(agent, event, buildContext(store, { cwd: p.cwd, prompt: action === 'prompt' ? p.prompt : '' }))
      } finally { store.close() }
    }
    if (mode === 'off' || mode === 'incognito') return {}
    if (action === 'tool' && !p.error) {
      if (GIT_CMD.test(p.command)) spool(dir, 'events.jsonl', { kind: 'git', session: p.session, cwd: p.cwd, transcript: p.transcript, step: p.stepIdx, command: p.command.slice(0, 400), at: Date.now() })
      else if (p.path) spool(dir, 'touched.jsonl', { session: p.session, path: p.path, step: p.stepIdx, at: Date.now() })
    } else if (action === 'ingest') {
      spool(dir, 'ingest-queue.jsonl', { session: p.session, cwd: p.cwd, transcript: p.transcript, at: Date.now() })
      if (spawnFlush && !env.DSBOT_MEM_NO_SPAWN) {
        const child = spawn(process.execPath, [new URL('../../bin/dsbot-mem.mjs', import.meta.url).pathname, 'ingest', '--flush'], { detached: true, stdio: 'ignore', env })
        child.unref()
      }
    }
  } catch { /* a hook must never fail the agent */ }
  return {}
}

// ---- ingest: turn spooled hook records into stored memories and provenance links.
function readNew(file, offset) {
  const size = statSync(file).size
  if (size <= offset) return { text: '', size }
  const len = Math.min(size - offset, 256 * 1024)
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, offset)
    return { text: buf.toString('utf8'), size: offset + len }
  } finally { closeSync(fd) }
}

export function extractTurns(raw) {
  const out = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let v = null
    try { v = JSON.parse(s) } catch { out.push(s); continue }
    const c = v.content ?? v.text ?? v.message?.content ?? v.message ?? v.response
    const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x?.text ?? '').join(' ') : ''
    if (t.trim()) out.push(`${v.role ?? v.type ?? v.source ?? ''}: ${t}`.trim())
  }
  return out
}

function gitOut(cwd, args) {
  try { return execFileSync('git', ['-C', cwd, ...args], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { return '' }
}

export async function flushSpool({ dir = memHome(), store: given, git = gitOut } = {}) {
  const store = given ?? await openStore(dir)
  const marks = readJson(join(dir, 'spool', 'watermarks.json'), {})
  const result = { turns: 0, links: 0 }
  try {
    const queueFile = join(dir, 'spool', 'ingest-queue.jsonl')
    if (existsSync(queueFile)) {
      const entries = readFileSync(queueFile, 'utf8').split('\n').filter(Boolean).map(l => readJson_(l))
      writeFileSync(queueFile, '')
      for (const e of entries.filter(Boolean)) {
        if (!e.transcript || !existsSync(e.transcript)) continue
        const { text, size } = readNew(e.transcript, marks[e.transcript] ?? 0)
        marks[e.transcript] = size
        const turns = extractTurns(text).slice(-40)
        if (!turns.length) continue
        const body = redact(turns.join('\n')).slice(0, 3500)
        store.save({ text: body, kind: 'turn', scope: 'workspace', source: 'ingest', repo: basename(e.cwd ?? ''), session: e.session ?? '' })
        result.turns++
      }
    }
    const eventsFile = join(dir, 'spool', 'events.jsonl')
    if (existsSync(eventsFile)) {
      const events = readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).map(l => readJson_(l))
      writeFileSync(eventsFile, '')
      for (const e of events.filter(Boolean)) {
        const commit = /git\s+(commit|merge|cherry-pick)/.test(e.command) ? git(e.cwd, ['rev-parse', 'HEAD']) : ''
        const pr = (e.command.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/) ?? [''])[0]
        if (!commit && !pr) continue
        const files = commit ? git(e.cwd, ['show', '--name-only', '--format=', commit]).split('\n').filter(Boolean).slice(0, 50) : []
        store.linkProvenance({ commit, pr, session: e.session ?? '', repo: basename(e.cwd ?? ''), files, transcript: e.transcript ?? '', step: e.step ?? null })
        result.links++
      }
    }
    writeJsonAtomic(join(dir, 'spool', 'watermarks.json'), marks)
  } finally { if (!given) store.close() }
  return result
}

function readJson_(line) { try { return JSON.parse(line) } catch { return null } }
