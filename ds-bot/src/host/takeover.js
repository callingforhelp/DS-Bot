// Take-over: bring an earlier agent's notes and transcripts into the memory index, give a
// fresh Session the context it needs to continue, and export that context as a bundle.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { sanitizeText } from './ingest.js'
import { splitMeta } from './memory-entries.js'
import { output } from './tools.js'

const FILE_MAX = 5 * 1024 * 1024
const ENTRIES_MAX = 500
const TURNS_MAX = 200
const SNIPPET_MAX = 600
const ALLOWED = new Set(['.md', '.jsonl', '.txt', '.json'])

const failSoft = fn => { try { return fn() } catch { return undefined } }

/** Reads `*.md` files of a folder into entries `{ file, topic, text }`: bullets, or paragraphs when a file has none. */
export function parseMarkdownMemoryDir(dir) {
  const entries = []
  let names
  try { names = readdirSync(dir).filter(name => name.endsWith('.md')).sort() } catch { return entries }
  for (const name of names) {
    const path = join(dir, name)
    const text = failSoft(() => (statSync(path).size <= FILE_MAX ? readFileSync(path, 'utf8') : undefined))
    if (text === undefined) continue
    const topic = name === 'MEMORY.md' ? undefined : basename(name, '.md')
    const lines = text.split(/\r?\n/)
    const bullets = lines.filter(line => /^\s*[-*]\s+\S/.test(line))
    const items = bullets.length > 0
      ? bullets.map(line => splitMeta(line.replace(/^\s*[-*]\s+/, '')).text)
      : text.split(/\n\s*\n/).map(part => part.split('\n').filter(line => !/^#{1,6}\s/.test(line)).join(' ').trim())
    for (const item of items) {
      if (item !== '') entries.push({ file: name, topic, text: item })
      if (entries.length >= ENTRIES_MAX) return entries
    }
  }
  return entries
}

const roleOf = value => {
  const role = String(value ?? '').toLowerCase()
  if (role === 'user' || role === 'human') return 'user'
  if (role === 'assistant' || role === 'ai' || role === 'model') return 'assistant'
  return undefined
}
const flatten = content => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => (typeof part === 'string' ? part : part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text' ? String(part.text ?? '') : '')).filter(Boolean).join('\n')
}

/** Reads JSONL transcript lines of common agent formats into `[{ role, text, at }]`; bad lines are skipped. */
export function parseTranscriptLines(input) {
  const lines = Array.isArray(input) ? input : String(input ?? '').split(/\r?\n/)
  const turns = []
  for (const line of lines) {
    if (typeof line !== 'string' || line.trim() === '') continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const payload = row?.message ?? row?.payload ?? row
    const role = roleOf(payload?.role ?? row?.role ?? row?.type)
    const text = flatten(payload?.content ?? payload?.text ?? row?.text).trim()
    if (role === undefined || text === '') continue
    turns.push({ role, text, at: row?.timestamp ?? row?.time ?? row?.created_at ?? null })
  }
  return turns
}

export function install(rt) {
  const redact = text => (typeof rt.redactSecrets === 'function' ? rt.redactSecrets(text) : text)
  const callerIds = ctx => ({ botId: ctx.botId, roomId: ctx.roomId, sessionId: ctx.sessionId })
  const snippet = text => sanitizeText(text, redact).replace(/\s+/g, ' ').slice(0, SNIPPET_MAX)

  function readable(path) {
    const full = resolve(String(path ?? ''))
    const home = resolve(rt.home)
    if (full === home || full.startsWith(home + sep)) throw Object.assign(new Error('That path is inside the Bot data folder.'), { code: 'bot/invalid' })
    if (!ALLOWED.has(extname(full).toLowerCase())) throw Object.assign(new Error('Only .md, .txt, .json and .jsonl files can be imported.'), { code: 'bot/invalid' })
    if (statSync(full).size > FILE_MAX) throw Object.assign(new Error('The file is over 5 MB.'), { code: 'bot/invalid' })
    return full
  }

  /** Turns a transcript into observations, one per user request with the reply that followed. Idempotent. */
  function importTranscript({ path, text, botId, roomId, sessionId, repoKey, branch, agentSource = 'import' } = {}) {
    const raw = text ?? readFileSync(readable(path), 'utf8')
    const source = path ? basename(String(path)) : 'text'
    const turns = parseTranscriptLines(raw)
    let inserted = 0
    let duplicate = 0
    let skipped = 0
    let count = 0
    for (let i = 0; i < turns.length && count < TURNS_MAX; i += 1) {
      if (turns[i].role !== 'user') continue
      count += 1
      const reply = turns.slice(i + 1).find(turn => turn.role === 'assistant')
      const request = snippet(turns[i].text)
      const result = rt.ingestObservation?.({
        botId, roomId, sessionId, repoKey, branch, agentSource,
        turn: count,
        kind: 'transcript',
        title: request.slice(0, 120),
        summary: [request, reply === undefined ? '' : `→ ${snippet(reply.text)}`].filter(Boolean).join('\n'),
        idempotencyKey: `import:${source}:${i}:${request.slice(0, 80)}`,
      })
      if (result?.inserted) inserted += 1
      else if (result?.duplicate) duplicate += 1
      else skipped += 1
    }
    return { turns: turns.length, inserted, duplicate, skipped }
  }

  /** A short block a fresh Session reads first: recent work, saved notes, recent code changes. */
  async function buildStartupContext({ botId, roomId, sessionId, repoKey, limit = 8 } = {}) {
    if (typeof rt.canInjectMemory === 'function' && !rt.canInjectMemory({ botId, roomId, sessionId })) return ''
    const allow = botId ?? null
    const parts = []
    const observations = rt.listRecentObservations?.({ repoKey, allowPrivateBotId: allow, limit }) ?? []
    if (observations.length > 0) {
      parts.push('## Recent work', ...observations.map(row => `- ${row.title || row.kind}${row.summary ? `: ${row.summary.split('\n')[0].slice(0, 200)}` : ''}`))
    }
    const code = rt.queryCodeProvenance?.({ repo: repoKey, allowPrivateBotId: allow, limit: Math.min(limit, 5) }) ?? []
    if (code.length > 0) {
      parts.push('## Recent code changes', ...code.map(row => `- ${[row.commitSha?.slice(0, 8), row.branch, row.prUrl].filter(Boolean).join(' · ')}${row.files.length > 0 ? ` (${row.files.slice(0, 4).join(', ')})` : ''}`))
    }
    const artifacts = (rt.artifactsView?.() ?? []).slice(0, 5)
    if (artifacts.length > 0) parts.push('## Team artifacts', ...artifacts.map(art => `- ${art.slug} (v${art.version}): ${art.title}`))
    return parts.length === 0 ? '' : ['# Take-over context', ...parts].join('\n')
  }

  /** Everything a successor needs, as plain data without private Bots' memory. */
  async function exportTakeoverBundle({ botId, repoKey, limit = 50 } = {}) {
    const memories = (await rt.memoryExportEntries?.({ includePrivate: false }) ?? [])
      .map(item => ({ scopeKey: item.scopeKey, topic: item.topic, text: sanitizeText(item.text, redact) }))
      .filter(item => item.text !== '')
    const observations = (rt.listRecentObservations?.({ repoKey, allowPrivateBotId: botId ?? null, limit }) ?? [])
      .map(row => ({ kind: row.kind, title: row.title, summary: row.summary, createdAt: row.created_at }))
    const provenance = (rt.queryCodeProvenance?.({ repo: repoKey, allowPrivateBotId: botId ?? null, limit }) ?? [])
      .map(({ commitSha, branch, prUrl, repoRemote, files, diffSummary, createdAt }) => ({ commitSha, branch, prUrl, repoRemote, files, diffSummary, createdAt }))
    const artifacts = (rt.artifactsView?.() ?? []).map(art => ({ ...art, content: rt.getArtifact?.(art.slug)?.content ?? '' }))
    return { version: 1, exportedAt: new Date().toISOString(), memories, observations, provenance, artifacts }
  }

  async function importMarkdownDir({ dir, botId, roomId, sessionId } = {}) {
    const entries = parseMarkdownMemoryDir(readable(join(String(dir ?? ''), 'x.md')).replace(/[\\/]x\.md$/, ''))
    let inserted = 0
    for (const entry of entries) {
      const result = rt.ingestObservation?.({
        botId, roomId, sessionId, agentSource: 'import', kind: 'note',
        title: entry.topic ?? entry.file, summary: entry.text,
        idempotencyKey: `md:${entry.file}:${entry.text.slice(0, 120)}`,
      })
      if (result?.inserted) inserted += 1
    }
    return { entries: entries.length, inserted }
  }

  rt.teamTools?.push(defineTool({
    name: 'bot_takeover',
    description: 'Pick up where an earlier agent or Session left off. Actions: "context" (summary of recent work, code changes and shared artifacts), "export" (a JSON bundle of that state), "import_transcript" (read a .jsonl/.md/.txt transcript file into memory), "import_notes" (read a folder of markdown notes).',
    parameters: {
      action: { type: 'string', required: true, description: '"context", "export", "import_transcript" or "import_notes"' },
      path: { type: 'string', description: 'File (import_transcript) or folder (import_notes)' },
      repo: { type: 'string', description: 'Limit to one repository key' },
    },
    output,
    async execute(args, exec) {
      await rt.load?.()
      const sessionId = exec?.agent?.id
      const botId = rt.selfOf?.(sessionId)
      if (botId === undefined) return 'Only Bots on the team can take over work.'
      const ids = { botId, sessionId, roomId: rt.groupOwners?.get?.(sessionId)?.roomId }
      try {
        if (args.action === 'context') return (await buildStartupContext({ ...ids, repoKey: args.repo })) || 'Nothing recorded yet.'
        if (args.action === 'export') return JSON.stringify(await exportTakeoverBundle({ botId, repoKey: args.repo }))
        if (typeof rt.canWriteMemory === 'function' && !rt.canWriteMemory(callerIds(ids))) return 'Memory is not writable in this chat.'
        if (args.action === 'import_transcript') {
          const r = importTranscript({ ...ids, path: args.path, repoKey: args.repo })
          return `Read ${r.turns} turns: ${r.inserted} saved, ${r.duplicate} already known, ${r.skipped} skipped.`
        }
        if (args.action === 'import_notes') {
          const r = await importMarkdownDir({ ...ids, dir: args.path })
          return `Read ${r.entries} notes: ${r.inserted} saved.`
        }
        return 'Unknown action.'
      } catch (error) {
        return error.message
      }
    },
  }))

  Object.assign(rt, { buildStartupContext, exportTakeoverBundle, importTranscript, parseMarkdownMemoryDir, parseTranscriptLines })
}
