// Code provenance: which commit, branch, pull request and files a Session's work touched.
// Signals come from tool output and workspace-change events; rows live in the memory
// index and answer `bot_code_search`.
import { createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { sanitizeText } from './ingest.js'
import { output } from './tools.js'

const PR_URL = /https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/(?:pull|merge_requests|-\/merge_requests)\/(\d+)/i
const COMMIT_LINE = /^\[([^\]\s]+(?:\s+\(root-commit\))?)\s+([0-9a-f]{7,40})\]\s*(.*)$/im
const BRANCH_ON = /^On branch (\S+)/im
const BRANCH_SWITCH = /Switched to (?:a new )?branch '([^']+)'/i
const REMOTE_URL = /(?:git@|https?:\/\/)([\w.-]+)[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?(?=\s|$)/
const FILES_MAX = 100
const SUMMARY_MAX = 600

/** Reads git facts from text (tool output or a command line). Missing facts stay undefined. */
export function extractGitSignals(text) {
  const src = String(text ?? '')
  const out = {}
  const pr = PR_URL.exec(src)
  if (pr) {
    out.prUrl = pr[0].replace(/[).,;]+$/, '')
    out.prNumber = Number(pr[1])
  }
  const commit = COMMIT_LINE.exec(src)
  if (commit) {
    out.commitSha = commit[2]
    const label = commit[1].replace(/\s+\(root-commit\)$/, '')
    if (label !== 'detached') out.branch = label
    if (commit[3]?.trim()) out.message = commit[3].trim()
  }
  out.branch ??= BRANCH_ON.exec(src)?.[1] ?? BRANCH_SWITCH.exec(src)?.[1]
  const remote = REMOTE_URL.exec(src)
  if (remote) out.repoRemote = `${remote[1]}/${remote[2]}`
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key]
  return out
}

const textOfContent = content => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => (typeof part === 'string' ? part : part?.type === 'text' ? String(part.text ?? '') : '')).join('\n')
}

const filesOfChange = data => {
  const list = data?.files ?? data?.changes ?? data?.paths ?? []
  if (!Array.isArray(list)) return []
  return list.map(item => (typeof item === 'string' ? item : String(item?.path ?? item?.file ?? ''))).filter(Boolean)
}

export function install(rt) {
  const { ctx } = rt
  /** @type {Map<string, {turn:number, files:Set<string>, signals:object}>} */
  const sessions = new Map()
  const stateOf = sessionId => {
    let entry = sessions.get(sessionId)
    if (entry === undefined) {
      entry = { turn: 0, files: new Set(), signals: {} }
      sessions.set(sessionId, entry)
    }
    return entry
  }
  const redact = text => (typeof rt.redactSecrets === 'function' ? rt.redactSecrets(text) : text)

  function recordProvenance(input = {}) {
    if (typeof rt.insertProvenanceRow !== 'function') return null
    const ids = { botId: input.botId, roomId: input.roomId, sessionId: input.sessionId }
    if (typeof rt.canWriteMemory === 'function' && !rt.canWriteMemory(ids)) return null
    const files = (Array.isArray(input.files) ? input.files : []).map(String).filter(Boolean).slice(0, FILES_MAX)
    if (!input.commitSha && !input.prUrl && files.length === 0) return null
    const key = [input.sessionId ?? '', input.commitSha ?? input.prUrl ?? `turn${input.turn ?? 0}`].join('|')
    const id = input.id ?? `prov:${createHash('sha256').update(key).digest('hex').slice(0, 20)}`
    return rt.insertProvenanceRow({
      ...input,
      id,
      files,
      diffSummary: sanitizeText(input.diffSummary ?? '', redact).slice(0, SUMMARY_MAX),
    })
  }

  function identify(sessionId) {
    const botId = rt.selfOf?.(sessionId)
    const roomId = rt.groupOwners?.get?.(sessionId)?.roomId ?? rt.taskOwners?.get?.(sessionId)?.roomId
    return { botId, roomId, repoRoot: botId ? rt.workDirOf?.({ botId, ...(roomId ? { roomId } : {}) }) : undefined }
  }

  function flush(sessionId, event, { final }) {
    const entry = sessions.get(sessionId)
    if (entry === undefined) return
    const { signals } = entry
    const files = [...entry.files]
    const hasCommit = signals.commitSha !== undefined || signals.prUrl !== undefined
    if (!hasCommit && !(final && files.length > 0)) return
    try {
      recordProvenance({
        ...identify(sessionId),
        sessionId,
        turn: entry.turn,
        eventSeq: Number.isInteger(event?.seq) ? event.seq : 0,
        files,
        diffSummary: [signals.message, files.length > 0 ? `${files.length} file(s) changed: ${files.slice(0, 8).join(', ')}` : ''].filter(Boolean).join(' · '),
        ...signals,
      })
    } catch (error) {
      rt.warn?.('ds-bot: provenance not recorded: %s', error?.message ?? error)
    }
    if (hasCommit) entry.signals = { branch: signals.branch, repoRemote: signals.repoRemote }
    if (final) entry.files.clear()
  }

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || event === undefined) return
    if (event.type === 'turn/start' && Number.isInteger(event.data?.turn)) {
      stateOf(sessionId).turn = event.data.turn
    } else if (event.type === 'workspace/changes') {
      const entry = stateOf(sessionId)
      if (Number.isInteger(event.data?.turn)) entry.turn = event.data.turn
      for (const file of filesOfChange(event.data)) entry.files.add(file)
    } else if (event.type === 'tool/result' || event.type === 'tools/result') {
      const found = extractGitSignals(textOfContent(event.data?.message?.content ?? event.data?.content))
      if (Object.keys(found).length === 0) return
      const entry = stateOf(sessionId)
      const newWork = found.commitSha !== undefined || found.prUrl !== undefined
      entry.signals = { ...entry.signals, ...found }
      if (newWork) flush(sessionId, event, { final: false })
    } else if (event.type === 'turn/end') {
      if (Number.isInteger(event.data?.turn)) stateOf(sessionId).turn = event.data.turn
      flush(sessionId, event, { final: true })
    }
  })

  function codeSearch(args = {}, { botId } = {}) {
    if (typeof rt.queryCodeProvenance !== 'function') return []
    return rt.queryCodeProvenance({
      query: args.query,
      commitSha: args.commit,
      prUrl: args.prUrl,
      prNumber: args.pr,
      filePath: args.file,
      repo: args.repo,
      branch: args.branch,
      limit: args.limit,
      allowPrivateBotId: botId ?? null,
    })
  }

  const line = row => [
    row.commitSha ? `commit ${row.commitSha.slice(0, 10)}` : undefined,
    row.branch ? `branch ${row.branch}` : undefined,
    row.prUrl ? `PR ${row.prUrl}` : undefined,
    row.repoRemote ? `repo ${row.repoRemote}` : undefined,
    row.files.length > 0 ? `files: ${row.files.slice(0, 6).join(', ')}${row.files.length > 6 ? ` (+${row.files.length - 6})` : ''}` : undefined,
    row.sessionId ? `session ${row.sessionId}` : undefined,
    `at ${new Date(row.createdAt).toISOString()}`,
  ].filter(Boolean).join(' · ')

  rt.teamTools?.push(defineTool({
    name: 'bot_code_search',
    description: 'Find which commit, branch, pull request, files and Session produced a change. Search by words, a commit hash, a PR number or URL, a file path, a repo or a branch.',
    parameters: {
      query: { type: 'string', description: 'Words to look for in file names, branches and change summaries' },
      commit: { type: 'string', description: 'A commit hash or its prefix' },
      pr: { type: 'number', description: 'A pull request number' },
      file: { type: 'string', description: 'A file path or part of one' },
      repo: { type: 'string', description: 'A repository name or path' },
      branch: { type: 'string', description: 'A branch name' },
      limit: { type: 'number', description: 'How many results at most (default 10)' },
    },
    output,
    async execute(args, exec) {
      await rt.load?.()
      const botId = rt.selfOf?.(exec?.agent?.id)
      if (botId === undefined) return 'Only Bots on the team can search code provenance.'
      const rows = codeSearch(args, { botId })
      if (rows.length === 0) return 'No recorded change matches.'
      return rows.map(row => `- ${line(row)}`).join('\n')
    },
  }))

  ctx.effect?.(() => () => sessions.clear(), 'ds-bot: provenance')
  Object.assign(rt, { recordProvenance, codeSearch, extractGitSignals })
}
