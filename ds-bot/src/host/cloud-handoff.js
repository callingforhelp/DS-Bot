// Unified Local <-> Cloud runtime tracking, controller client, and offline cache sync.
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './tools.js'

const execFileAsync = promisify(execFile)
const MAX_HISTORY = 10
const MAX_RECENT_MESSAGES = 20
const POLL_INTERVAL_MS = 30_000
const REQUEST_TIMEOUT_MS = 10_000
const TEAM_KEY = '__team__'

const invalid = (message, code = 'bot/invalid') => Object.assign(new Error(message), { code })

export function signControllerRequest({ principal, secret, tenant, method, path, body, ts = Date.now(), nonce = randomUUID() }) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  const bodyHash = createHash('sha256').update(raw).digest('hex')
  const canonical = [ts, nonce, String(method).toUpperCase(), path, bodyHash].join('\n')
  const signature = createHmac('sha256', secret).update(canonical).digest('hex')
  return {
    raw,
    headers: {
      'content-type': 'application/json',
      'x-principal': principal,
      'x-tenant': tenant,
      'x-timestamp': String(ts),
      'x-nonce': nonce,
      'x-signature': signature,
    },
  }
}

export function defaultRuntime() {
  return {
    location: 'local',
    phase: 'idle',
    machineId: null,
    machineName: null,
    snapshot: null,
    branch: null,
    workDir: null,
    repoName: null,
    remoteUrl: null,
    cloudRepoDir: null,
    macSyncJobId: null,
    scope: 'branch',
    lastSyncedAt: null,
    lastTransition: null,
    dismissedTransitionId: null,
    history: [],
    queuedMessages: [],
    recentMessages: [],
    error: null,
  }
}

export function deriveRepoName(input, fallback = '') {
  const raw = String(input ?? '').trim().replace(/\/+$/, '').replace(/\.git$/i, '')
  if (!raw) return fallback
  const tail = raw.split(/[/:]/).filter(Boolean).pop()
  return tail || fallback
}

export function parseMacSyncResult(text) {
  const raw = String(text ?? '')
  if (!raw.includes('[MAC_JOB_RESULT') || !raw.includes('target=git_sync')) return null
  if (!raw.includes('status=succeeded')) return null
  const jsonStart = raw.indexOf('{')
  const jsonEnd = raw.lastIndexOf('}')
  if (jsonStart < 0 || jsonEnd <= jsonStart) return null
  try {
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1))
    if (!parsed || typeof parsed !== 'object') return null
    return {
      action: parsed.action ?? 'push',
      repo: parsed.repo ?? null,
      path: parsed.path ?? null,
      remoteUrl: parsed.remote_url ?? parsed.remoteUrl ?? null,
      branch: parsed.branch ?? null,
      commit: parsed.commit ?? null,
    }
  } catch {
    return null
  }
}

export function extractTextFromContent(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

async function defaultGitRunner(args, { cwd } = {}) {
  try {
    const { stdout = '', stderr = '' } = await execFileAsync('git', args, { cwd, timeout: 10_000 })
    return { exitCode: 0, stdout: String(stdout), stderr: String(stderr) }
  } catch (error) {
    return {
      exitCode: typeof error?.code === 'number' ? error.code : 1,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? error?.message ?? ''),
    }
  }
}

async function defaultGhRunner(args, { cwd } = {}) {
  try {
    const { stdout = '', stderr = '' } = await execFileAsync('gh', args, { cwd, timeout: 30_000 })
    return { exitCode: 0, stdout: String(stdout), stderr: String(stderr) }
  } catch (error) {
    return {
      exitCode: typeof error?.code === 'number' ? error.code : 1,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? error?.message ?? ''),
    }
  }
}

export async function inspectGitWorkspace(workDir, gitRunner = defaultGitRunner) {
  if (typeof workDir !== 'string' || workDir.trim() === '') {
    return { isGitRepo: false, workDir: null, branch: null, dirtyCount: 0, remoteUrl: null, headSha: null, aheadCount: 0, repoName: null }
  }
  const probe = await gitRunner(['rev-parse', '--is-inside-work-tree'], { cwd: workDir })
  if (probe.exitCode !== 0 || probe.stdout.trim() !== 'true') {
    return { isGitRepo: false, workDir, branch: null, dirtyCount: 0, remoteUrl: null, headSha: null, aheadCount: 0, repoName: deriveRepoName(workDir, null) }
  }
  const [branchRes, statusRes, remoteRes, shaRes, aheadRes] = await Promise.all([
    gitRunner(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workDir }),
    gitRunner(['status', '--porcelain'], { cwd: workDir }),
    gitRunner(['remote', 'get-url', 'origin'], { cwd: workDir }),
    gitRunner(['rev-parse', '--short', 'HEAD'], { cwd: workDir }),
    gitRunner(['rev-list', '--count', '@{u}..HEAD'], { cwd: workDir }),
  ])
  const branch = branchRes?.exitCode === 0 ? branchRes.stdout.trim() || null : null
  const dirtyCount = statusRes?.exitCode === 0
    ? statusRes.stdout.split(/\r?\n/).filter(line => line.trim() !== '').length
    : 0
  const remoteUrl = remoteRes?.exitCode === 0 ? remoteRes.stdout.trim() || null : null
  const headSha = shaRes?.exitCode === 0 ? shaRes.stdout.trim() || null : null
  const aheadRaw = aheadRes?.exitCode === 0 ? Number.parseInt(aheadRes.stdout.trim(), 10) : 0
  const aheadCount = Number.isFinite(aheadRaw) && aheadRaw > 0 ? aheadRaw : 0
  const repoName = deriveRepoName(remoteUrl || workDir, basename(workDir))
  return { isGitRepo: true, workDir, branch, dirtyCount, remoteUrl, headSha, aheadCount, repoName }
}

export function mergeMachineStatus(runtime, machine, controllerOnline) {
  if (!runtime || runtime.location !== 'cloud') return runtime
  if (!controllerOnline) return { ...runtime, phase: 'cached-offline' }
  if (!machine) return runtime
  const raw = String(machine.state ?? machine.status ?? '').toLowerCase()
  let phase = runtime.phase
  if (raw === 'running' || raw === 'started') phase = 'running'
  else if (raw === 'stopped' || raw === 'sleeping' || raw === 'archived') phase = 'sleeping'
  return {
    ...runtime,
    phase,
    machineId: machine.id ?? runtime.machineId,
    machineName: machine.name ?? runtime.machineName,
    snapshot: machine.snapshot ?? runtime.snapshot,
  }
}

function writeJsonAtomic(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = join(dirname(filePath), `.tmp.${process.pid}.${Date.now()}.json`)
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, filePath)
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

export function install(rt) {
  const { ctx, config = {} } = rt
  const controllerUrl = String(config.cloudControllerUrl ?? process.env.DS_BOT_CONTROLLER_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '')
  const operatorFile = config.cloudOperatorFile ?? process.env.DS_BOT_OPERATOR_FILE ?? join(rt.dshHome, 'cloud-cache', 'operator.json')
  const cacheFile = config.cloudCacheFile ?? process.env.DS_BOT_CLOUD_CACHE_FILE ?? join(rt.dshHome, 'cloud-cache', 'latest.json')
  const projectId = config.cloudProject ?? process.env.DS_BOT_CLOUD_PROJECT ?? 'dsbot-aws-staging'
  const defaultSnapshot = config.cloudSnapshot ?? process.env.DS_BOT_CLOUD_SNAPSHOT ?? 'ds-bot-dsh'
  const fetchImpl = config.cloudFetch ?? globalThis.fetch
  const gitRunner = config.cloudGitRunner ?? defaultGitRunner
  const ghRunner = config.cloudGhRunner ?? (config.cloudGitRunner ? null : defaultGhRunner)
  const macBrokerSock = config.macBrokerSock ?? process.env.BROKER_UNIX_SOCK ?? '/data/mac-broker.sock'
  const macTokenFile = config.macBrokerTokenFile ?? process.env.BROKER_PRODUCER_TOKEN_FILE ?? '/data/.mac-broker-producer-token'
  const macTokenOverride = config.macBrokerToken ?? process.env.BROKER_PRODUCER_TOKEN ?? ''
  const macSyncWaitMs = Number.isFinite(Number(config.macSyncWaitMs)) ? Math.max(0, Number(config.macSyncWaitMs)) : 4000

  const liveMeta = {
    controllerOnline: false,
    configured: false,
    syncedAt: null,
    machines: [],
    authorizations: [],
    events: [],
  }

  const runtimesStore = () => {
    if (!rt.state.cloudRuntimes || typeof rt.state.cloudRuntimes !== 'object') rt.state.cloudRuntimes = {}
    return rt.state.cloudRuntimes
  }

  const targetIdOf = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '' || sessionId === TEAM_KEY) return undefined
    return rt.roomOf?.(sessionId)?.id ?? rt.selfOf?.(sessionId) ?? rt.botOf?.(sessionId)?.id ?? sessionId
  }

  const resolveTargetId = sessionId =>
    targetIdOf(sessionId) ?? rt.state?.mainBotIds?.[0] ?? Object.keys(rt.state?.bots ?? {})[0] ?? TEAM_KEY

  const ensureTeamEntry = () => {
    const map = runtimesStore()
    if (!Object.hasOwn(map, TEAM_KEY) || !map[TEAM_KEY]) {
      const legacy = Object.values(map).find(item => item?.location === 'cloud') ?? Object.values(map).find(Boolean)
      map[TEAM_KEY] = legacy ? { ...defaultRuntime(), ...legacy } : defaultRuntime()
    }
    return map[TEAM_KEY]
  }

  const setTeamEntry = (next) => {
    const map = runtimesStore()
    map[TEAM_KEY] = next
    for (const key of Object.keys(map)) {
      if (key !== TEAM_KEY) delete map[key]
    }
    return map[TEAM_KEY]
  }

  const readOperator = () => {
    const creds = readJsonSafe(operatorFile)
    if (creds && typeof creds.secret === 'string' && creds.secret !== '') {
      return {
        id: creds.id ?? 'operator',
        tenant: creds.tenant ?? 'dsbot-cloud',
        secret: creds.secret,
        controllerUrl: typeof creds.controllerUrl === 'string' && creds.controllerUrl.trim() !== '' ? creds.controllerUrl.trim().replace(/\/+$/, '') : null,
      }
    }
    return null
  }

  const workDirForTarget = (targetId) => {
    const bot = rt.botOf?.(targetId)
    if (bot) return rt.workDirOf?.({ botId: bot.id }) ?? bot.workDir ?? config.cloudWorkDir ?? rt.teamFolder?.()
    const room = rt.roomOf?.(targetId)
    if (room) return rt.workDirOf?.({ roomId: room.id }) ?? room.workDir ?? config.cloudWorkDir ?? rt.teamFolder?.()
    return config.cloudWorkDir ?? rt.teamFolder?.()
  }

  async function controllerCall(method, path, body) {
    const creds = readOperator()
    if (!creds) throw invalid('Cloud controller operator credentials are not configured', 'bot/unavailable')
    if (typeof fetchImpl !== 'function') throw invalid('Fetch implementation is unavailable', 'bot/unavailable')
    const baseUrl = creds.controllerUrl ?? controllerUrl
    const { raw, headers } = signControllerRequest({
      principal: creds.id, secret: creds.secret, tenant: creds.tenant, method, path, body,
    })
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: method === 'GET' ? undefined : raw,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const json = await res.json().catch(() => ({}))
    return { status: res.status, ok: res.status >= 200 && res.status < 300, body: json }
  }

  function loadCacheIntoLiveMeta() {
    const cached = readJsonSafe(cacheFile)
    if (!cached) return false
    liveMeta.syncedAt = cached.syncedAt ?? liveMeta.syncedAt
    liveMeta.machines = Array.isArray(cached.machines) ? cached.machines : []
    liveMeta.authorizations = Array.isArray(cached.authorizations) ? cached.authorizations : []
    liveMeta.events = Array.isArray(cached.events) ? cached.events : []
    return true
  }

  function persistCacheSnapshot(machines, authorizations, events) {
    const syncedAt = new Date().toISOString()
    liveMeta.syncedAt = syncedAt
    liveMeta.machines = machines
    liveMeta.authorizations = authorizations
    liveMeta.events = events
    const creds = readOperator()
    const baseUrl = creds?.controllerUrl ?? controllerUrl
    try {
      writeJsonAtomic(cacheFile, {
        syncedAt,
        baseUrl,
        tenant: creds?.tenant ?? 'dsbot-cloud',
        projectId,
        machines,
        authorizations,
        events,
      })
    } catch { /* cache write errors should not break runtime state */ }
  }

  async function postMachineMessage(machineId, { threadId, botId, text }) {
    const res = await controllerCall('POST', `/v1/machines/${encodeURIComponent(machineId)}/message`, {
      threadId,
      botId,
      text,
    })
    if (!res.ok) throw invalid(res.body?.error ?? `Cloud message delivery failed (HTTP ${res.status})`, 'bot/unavailable')
    return res.body?.result ?? res.body
  }

  async function flushQueuedMessages(machinesById) {
    const entry = ensureTeamEntry()
    if (entry.location !== 'cloud' || !entry.machineId || !Array.isArray(entry.queuedMessages) || entry.queuedMessages.length === 0) return
    let dirty = false
    const remaining = []
    let halted = false
    for (const item of entry.queuedMessages) {
      if (halted) { remaining.push(item); continue }
      try {
        const sid = item.sessionId ?? resolveTargetId()
        const bid = resolveTargetId(sid)
        await postMachineMessage(entry.machineId, { threadId: sid, botId: bid, text: item.text })
        entry.recentMessages = [...(entry.recentMessages ?? []), { text: item.text, at: Date.now(), delivered: true }].slice(-MAX_RECENT_MESSAGES)
        dirty = true
      } catch {
        halted = true
        remaining.push(item)
      }
    }
    if (remaining.length !== entry.queuedMessages.length) {
      entry.queuedMessages = remaining
      dirty = true
    }
    if (machinesById.has(entry.machineId)) {
      const merged = mergeMachineStatus(entry, machinesById.get(entry.machineId), true)
      if (merged.phase !== entry.phase) {
        Object.assign(entry, merged)
        dirty = true
      }
    }
    if (dirty && !rt.readOnly?.()) await rt.save?.().catch(() => {})
  }

  async function refreshStatus({ quiet = false, includeAuths = true } = {}) {
    const creds = readOperator()
    liveMeta.configured = creds !== null
    const current = ensureTeamEntry()
    if (!creds) {
      liveMeta.controllerOnline = false
      loadCacheIntoLiveMeta()
      if (current.location === 'cloud') setTeamEntry(mergeMachineStatus(current, null, false))
      return cloudRuntimeView()
    }
    try {
      const machinesRes = await controllerCall('GET', '/v1/machines')
      if (!machinesRes.ok) throw new Error(machinesRes.body?.error ?? `HTTP ${machinesRes.status}`)
      const machines = Array.isArray(machinesRes.body?.machines) ? machinesRes.body.machines : []
      const authRes = includeAuths
        ? await controllerCall('GET', `/v1/authorizations?project_id=${encodeURIComponent(projectId)}&limit=50`).catch(() => ({ ok: false, body: {} }))
        : { ok: false, body: {} }
      const auths = authRes.ok ? (authRes.body?.items ?? authRes.body?.authorizations ?? []) : liveMeta.authorizations
      liveMeta.controllerOnline = true
      persistCacheSnapshot(machines, auths, liveMeta.events)
      const byId = new Map(machines.map(m => [m.id, m]))
      let changed = false
      if (current.location === 'cloud') {
        const merged = mergeMachineStatus(current, byId.get(current.machineId), true)
        merged.lastSyncedAt = liveMeta.syncedAt
        if (merged.phase !== current.phase || merged.machineName !== current.machineName) changed = true
        setTeamEntry(merged)
      }
      await flushQueuedMessages(byId)
      if (changed && !rt.readOnly?.()) await rt.save?.().catch(() => {})
    } catch (error) {
      liveMeta.controllerOnline = false
      loadCacheIntoLiveMeta()
      if (current.location === 'cloud') setTeamEntry(mergeMachineStatus(current, null, false))
      if (!quiet) rt.warn?.('ds-bot: cloud status refresh failed (using cache): %s', error?.message ?? error)
    }
    return cloudRuntimeView()
  }

  const parseKvLines = (stdout) => {
    const out = {}
    for (const line of String(stdout ?? '').split(/\r?\n/)) {
      const idx = line.indexOf('=')
      if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
    return out
  }

  const shellQuote = value => `'${String(value ?? '').replace(/'/g, "'\\''")}'`

  function readMacToken() {
    if (macTokenOverride) return String(macTokenOverride).trim()
    try { return readFileSync(macTokenFile, 'utf8').trim() } catch { return '' }
  }

  function hasMacBroker() {
    if (typeof config.macBrokerCall === 'function') return true
    return Boolean(readMacToken()) && existsSync(macBrokerSock)
  }

  async function callMacBroker(method, path, body) {
    if (typeof config.macBrokerCall === 'function') {
      return config.macBrokerCall(method, path, body)
    }
    const token = readMacToken()
    if (!token || !existsSync(macBrokerSock)) return null
    const payload = body === undefined ? null : JSON.stringify(body)
    return new Promise((resolve) => {
      const req = http.request({
        socketPath: macBrokerSock,
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 8000,
      }, (res) => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let data = {}
          try { data = JSON.parse(text) } catch { data = { raw: text } }
          resolve({ status: res.statusCode ?? 500, ok: (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300, data })
        })
      })
      req.on('timeout', () => { req.destroy(); resolve(null) })
      req.on('error', () => resolve(null))
      if (payload) req.write(payload)
      req.end()
    })
  }

  async function enqueueMacGitSync({ action = 'push', repo, branch, remoteUrl, createIfMissing = false, sessionId = '', waitMs = macSyncWaitMs }) {
    if (!repo && !remoteUrl) return null
    const res = await callMacBroker('POST', '/v1/jobs', {
      target: 'git_sync',
      task: JSON.stringify({
        action,
        repo: repo || deriveRepoName(remoteUrl, ''),
        branch: branch || undefined,
        remote_url: remoteUrl || undefined,
        create_if_missing: Boolean(createIfMissing),
      }),
      repo: repo || deriveRepoName(remoteUrl, '') || undefined,
      branch: branch || undefined,
      timeout_sec: 180,
      aws_session_id: sessionId || resolveTargetId(),
    })
    if (!res?.ok || !res.data?.job) return null
    let job = res.data.job
    const macOnline = Boolean(res.data.mac_online)
    if (waitMs > 0 && macOnline && job.job_id) {
      const deadline = Date.now() + waitMs
      while (Date.now() < deadline && (job.status === 'queued' || job.status === 'running')) {
        await new Promise(r => setTimeout(r, 150))
        const poll = await callMacBroker('GET', `/v1/jobs/${encodeURIComponent(job.job_id)}`)
        if (!poll?.ok || !poll.data?.job) break
        job = poll.data.job
      }
    }
    let syncResult = null
    if (job.status === 'succeeded' && job.result_summary) {
      try {
        const parsed = JSON.parse(job.result_summary)
        syncResult = {
          action: parsed.action ?? action,
          repo: parsed.repo ?? null,
          path: parsed.path ?? null,
          remoteUrl: parsed.remote_url ?? parsed.remoteUrl ?? null,
          branch: parsed.branch ?? null,
          commit: parsed.commit ?? null,
        }
      } catch { syncResult = null }
    }
    return { job, macOnline, syncResult }
  }

  async function ensureGitHubRemote({ workDir, repoName, push = false }) {
    if (!workDir || !ghRunner) return null
    const existing = await gitRunner(['remote', 'get-url', 'origin'], { cwd: workDir })
    if (existing.exitCode === 0 && existing.stdout.trim() !== '') {
      return { remoteUrl: existing.stdout.trim(), created: false }
    }
    const cleanName = deriveRepoName(repoName || workDir, 'dsbot-repo').replace(/[^A-Za-z0-9._-]+/g, '-')
    const args = ['repo', 'create', cleanName, '--private', '--source=.', '--remote=origin']
    if (push) args.push('--push')
    const created = await ghRunner(args, { cwd: workDir })
    if (created.exitCode !== 0) {
      throw invalid(`Failed to create GitHub remote for ${cleanName}: ${created.stderr || created.stdout}`)
    }
    const after = await gitRunner(['remote', 'get-url', 'origin'], { cwd: workDir })
    return {
      remoteUrl: after.exitCode === 0 ? after.stdout.trim() || null : null,
      created: true,
    }
  }

  async function execOnMachine(machineId, { script, cwd = '/workspace', timeoutSecs = 120 }) {
    const res = await controllerCall('POST', `/v1/machines/${encodeURIComponent(machineId)}/exec`, {
      script,
      cwd,
      timeoutSecs,
    })
    if (!res.ok) throw invalid(res.body?.error ?? `Cloud exec failed (HTTP ${res.status})`, 'bot/unavailable')
    return res.body?.result ?? res.body ?? {}
  }

  async function syncDaytonaWorkspace(machineId, { repoName, remoteUrl, branch }) {
    if (!machineId || !remoteUrl) return null
    const safeName = deriveRepoName(repoName || remoteUrl, 'repo').replace(/[^A-Za-z0-9._-]+/g, '-')
    const targetDir = `/workspace/${safeName}`
    const qUrl = shellQuote(remoteUrl)
    const qDir = shellQuote(targetDir)
    const qBranch = branch ? shellQuote(branch) : ''
    const lines = [
      'set -e',
      'mkdir -p /workspace',
      `if [ ! -d ${qDir}/.git ]; then`,
      `  git clone ${qUrl} ${qDir}`,
      'fi',
      `cd ${qDir}`,
      `git remote set-url origin ${qUrl} 2>/dev/null || git remote add origin ${qUrl}`,
      branch ? `git fetch origin ${qBranch}` : 'git fetch origin --prune',
    ]
    if (branch) {
      lines.push(`git checkout ${qBranch} 2>/dev/null || git checkout -B ${qBranch} "origin/"${qBranch}`)
      lines.push(`git pull --ff-only origin ${qBranch} 2>/dev/null || true`)
    }
    lines.push('printf "DSBOT_SYNC_DIR=%s\\nDSBOT_SYNC_BRANCH=%s\\nDSBOT_SYNC_COMMIT=%s\\nDSBOT_SYNC_REMOTE=%s\\n" "$PWD" "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)" "$(git rev-parse --short HEAD 2>/dev/null || true)" "$(git remote get-url origin 2>/dev/null || true)"')
    const result = await execOnMachine(machineId, { script: lines.join('\n'), cwd: '/workspace', timeoutSecs: 120 })
    if ((result.exitCode ?? 0) !== 0) {
      throw invalid(`Daytona workspace sync failed: ${result.stdout || 'non-zero exit'}`)
    }
    const kv = parseKvLines(result.stdout)
    return {
      cloudRepoDir: kv.DSBOT_SYNC_DIR || targetDir,
      branch: kv.DSBOT_SYNC_BRANCH || branch || null,
      commit: kv.DSBOT_SYNC_COMMIT || null,
      remoteUrl: kv.DSBOT_SYNC_REMOTE || remoteUrl,
      repoName: safeName,
    }
  }

  async function syncFromDaytonaWorkspace(machineId, { repoName, branch, createIfMissing = true } = {}) {
    if (!machineId) return null
    const safeName = repoName ? deriveRepoName(repoName).replace(/[^A-Za-z0-9._-]+/g, '-') : ''
    const qPreferred = safeName ? shellQuote(`/workspace/${safeName}`) : shellQuote('')
    const qReqBranch = branch ? shellQuote(branch) : shellQuote('')
    const lines = [
      'set -e',
      `PREF=${qPreferred}`,
      `REQ_BR=${qReqBranch}`,
      'TARGET=""',
      'if [ -n "$PREF" ] && [ -d "$PREF/.git" ]; then TARGET="$PREF";',
      'elif [ -d /workspace/.git ]; then TARGET=/workspace;',
      'else',
      '  for d in /workspace/*/.git; do',
      '    if [ -d "$d" ]; then TARGET="${d%/.git}"; break; fi',
      '  done',
      'fi',
      createIfMissing
        ? 'if [ -z "$TARGET" ] && [ -n "$PREF" ] && [ -d "$PREF" ]; then TARGET="$PREF"; fi'
        : 'true',
      'if [ -z "$TARGET" ]; then echo "DSBOT_PUSH_EMPTY=1"; exit 0; fi',
      'cd "$TARGET"',
      'git config user.name >/dev/null 2>&1 || git config user.name "ds-bot-cloud"',
      'git config user.email >/dev/null 2>&1 || git config user.email "ds-bot-cloud@users.noreply.github.com"',
      'REPO_NAME=$(basename "$PWD")',
      'if [ ! -d .git ]; then',
      `  git init -b "\${REQ_BR:-main}"`,
      '  if [ -z "$(ls -A 2>/dev/null | grep -v "^\\.git$" || true)" ]; then printf "# %s\\n" "$REPO_NAME" > README.md; fi',
      'fi',
      'if ! git rev-parse --verify HEAD >/dev/null 2>&1; then git add -A && git commit -m "chore: initial commit"; fi',
      'CUR_BR=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)',
      'TARGET_BR="${REQ_BR:-$CUR_BR}"',
      'DIRTY=0',
      'if [ -n "$(git status --porcelain)" ]; then',
      '  DIRTY=1',
      '  if [ -z "$REQ_BR" ] && { [ "$CUR_BR" = main ] || [ "$CUR_BR" = master ] || [ "$CUR_BR" = HEAD ]; }; then',
      '    TARGET_BR="wip/cloud-$(date +%s)"',
      '  fi',
      '  if [ "$TARGET_BR" != "$CUR_BR" ]; then git checkout -B "$TARGET_BR"; fi',
      '  git add -A && git commit -m "wip: sync cloud changes to local"',
      'fi',
      'CREATED_REMOTE=0',
      'if ! git remote get-url origin >/dev/null 2>&1; then',
      createIfMissing
        ? '  if command -v gh >/dev/null 2>&1; then gh repo create "$REPO_NAME" --private --source=. --remote=origin --push; CREATED_REMOTE=1; else echo "DSBOT_PUSH_NO_REMOTE=1"; fi'
        : '  echo "DSBOT_PUSH_NO_REMOTE=1"',
      'fi',
      'REMOTE_URL=$(git remote get-url origin 2>/dev/null || true)',
      'PUSHED=0',
      'if [ "$CREATED_REMOTE" = 0 ] && [ -n "$REMOTE_URL" ]; then git push -u origin "$TARGET_BR" && PUSHED=1; elif [ "$CREATED_REMOTE" = 1 ]; then PUSHED=1; fi',
      'printf "DSBOT_PUSH_DIR=%s\\nDSBOT_PUSH_REPO=%s\\nDSBOT_PUSH_BRANCH=%s\\nDSBOT_PUSH_COMMIT=%s\\nDSBOT_PUSH_REMOTE=%s\\nDSBOT_PUSH_DIRTY=%s\\nDSBOT_PUSH_DONE=%s\\n" "$PWD" "$REPO_NAME" "$TARGET_BR" "$(git rev-parse --short HEAD 2>/dev/null || true)" "$REMOTE_URL" "$DIRTY" "$PUSHED"',
    ]
    const result = await execOnMachine(machineId, { script: lines.join('\n'), cwd: '/workspace', timeoutSecs: 120 })
    const kv = parseKvLines(result.stdout)
    if (kv.DSBOT_PUSH_EMPTY === '1') return { empty: true }
    return {
      empty: false,
      cloudRepoDir: kv.DSBOT_PUSH_DIR || null,
      repoName: kv.DSBOT_PUSH_REPO || safeName || null,
      branch: kv.DSBOT_PUSH_BRANCH || branch || null,
      commit: kv.DSBOT_PUSH_COMMIT || null,
      remoteUrl: kv.DSBOT_PUSH_REMOTE || null,
      dirtyCommitted: kv.DSBOT_PUSH_DIRTY === '1',
      pushed: kv.DSBOT_PUSH_DONE === '1',
    }
  }

  async function preflight(sessionId) {
    const targetId = resolveTargetId(sessionId)
    const workDir = workDirForTarget(targetId)
    const git = await inspectGitWorkspace(workDir, gitRunner)
    await refreshStatus({ quiet: true, includeAuths: false })
    return {
      sessionId: sessionId || targetId,
      targetId,
      isGitRepo: git.isGitRepo,
      workDir: git.workDir,
      branch: git.branch,
      dirtyCount: git.dirtyCount,
      remoteUrl: git.remoteUrl,
      headSha: git.headSha,
      aheadCount: git.aheadCount,
      repoName: git.repoName,
      macBridgeAvailable: hasMacBroker(),
      defaultScope: git.isGitRepo ? 'branch' : 'summary',
      controllerOnline: liveMeta.controllerOnline,
      configured: liveMeta.configured,
      machines: liveMeta.machines,
    }
  }

  async function handoffToCloud({ sessionId = '', scope = 'auto', pushWip = false, machineId = null, note = '', repo = '', createRepoIfMissing = false }) {
    const targetId = resolveTargetId(sessionId)
    const effectiveSessionId = sessionId || targetId
    const entry = ensureTeamEntry()
    const prevPhase = entry.phase
    entry.phase = 'handing-off-to-cloud'
    entry.error = null
    setTeamEntry(entry)
    await rt.save()

    try {
      const pre = await preflight(sessionId)
      if (!pre.configured) throw invalid('Cloud controller credentials missing (~/.ds-bot/cloud-cache/operator.json)', 'bot/unavailable')
      if (!pre.controllerOnline) throw invalid('Cloud controller is unreachable; cannot hand off while offline', 'bot/unavailable')

      const effectiveScope = scope === 'auto' ? pre.defaultScope : scope
      if (effectiveScope !== 'branch' && effectiveScope !== 'summary') throw invalid(`Invalid handoff scope: ${effectiveScope}`)

      let branch = pre.branch
      let remoteUrl = pre.remoteUrl ?? entry.remoteUrl ?? null
      let repoName = (repo ? deriveRepoName(repo) : null) ?? pre.repoName ?? entry.repoName ?? null
      let cloudRepoDir = entry.cloudRepoDir ?? null
      let macSyncJobId = null

      if (effectiveScope === 'branch' && pre.isGitRepo) {
        let needsPush = pushWip || pre.aheadCount > 0 || createRepoIfMissing
        if (pre.dirtyCount > 0) {
          if (!pushWip) {
            throw invalid('Uncommitted local changes detected. Push a WIP branch or hand off summary only.')
          }
          const wipBranch = `wip/handoff-${Date.now()}`
          const co = await gitRunner(['checkout', '-b', wipBranch], { cwd: pre.workDir })
          if (co.exitCode !== 0) throw invalid(`git checkout -b ${wipBranch} failed: ${co.stderr || co.stdout}`)
          const add = await gitRunner(['add', '-A'], { cwd: pre.workDir })
          if (add.exitCode !== 0) throw invalid(`git add failed: ${add.stderr || add.stdout}`)
          const commit = await gitRunner(['commit', '-m', 'wip: handoff to cloud'], { cwd: pre.workDir })
          if (commit.exitCode !== 0) throw invalid(`git commit failed: ${commit.stderr || commit.stdout}`)
          branch = wipBranch
          needsPush = true
        }

        let pushedViaCreate = false
        if (!remoteUrl && needsPush) {
          const bootstrapped = await ensureGitHubRemote({ workDir: pre.workDir, repoName: repoName || pre.workDir, push: true })
          if (bootstrapped?.remoteUrl) {
            remoteUrl = bootstrapped.remoteUrl
            repoName = repoName || deriveRepoName(remoteUrl)
            pushedViaCreate = true
          }
        }
        if (!pushedViaCreate && needsPush && branch) {
          const push = await gitRunner(['push', '-u', 'origin', branch], { cwd: pre.workDir })
          if (push.exitCode !== 0) throw invalid(`git push failed: ${push.stderr || push.stdout}`)
        }
      } else if ((!pre.isGitRepo || repo) && hasMacBroker()) {
        const macRepoHint = String(repo || pre.workDir || repoName || '').trim()
        if (macRepoHint && (effectiveScope === 'branch' || repo || createRepoIfMissing)) {
          const macSync = await enqueueMacGitSync({
            action: 'push',
            repo: macRepoHint,
            branch: branch || undefined,
            createIfMissing: Boolean(createRepoIfMissing),
            sessionId: effectiveSessionId,
          })
          if (macSync?.syncResult) {
            remoteUrl = macSync.syncResult.remoteUrl ?? remoteUrl
            branch = macSync.syncResult.branch ?? branch
            repoName = macSync.syncResult.repo ?? repoName
          } else if (macSync?.job?.job_id) {
            macSyncJobId = macSync.job.job_id
          }
        }
      }

      const machines = liveMeta.machines
      let chosen = (machineId ? machines.find(m => m.id === machineId) : null)
        ?? (entry.machineId ? machines.find(m => m.id === entry.machineId) : null)
        ?? machines.find(m => m.snapshot === defaultSnapshot || m.labels?.targetId === targetId)
        ?? machines[0]

      if (!chosen) {
        const botName = (rt.botOf?.(targetId)?.name ?? rt.roomOf?.(targetId)?.name ?? targetId).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 24) || 'bot'
        const created = await controllerCall('POST', '/v1/machines', {
          name: `ds-${botName}-${randomUUID().slice(0, 6)}`,
          snapshot: defaultSnapshot,
          idleMinutes: 15,
          labels: { project: projectId, targetId },
        })
        if (!created.ok || !created.body?.machine) {
          throw invalid(created.body?.error ?? `Failed to provision cloud machine (HTTP ${created.status})`, 'bot/unavailable')
        }
        chosen = created.body.machine
      }

      const name = rt.botOf?.(targetId)?.name ?? rt.roomOf?.(targetId)?.name ?? targetId
      const voiceRecent = Array.isArray(rt.state?.voiceHistory?.[targetId]) ? rt.state.voiceHistory[targetId].slice(-6) : []
      const voiceSummary = voiceRecent.length > 0
        ? `Recent voice context:\n${voiceRecent.map(v => `- ${v.role === 'assistant' ? 'Assistant' : 'User'}: ${String(v.text ?? '').slice(0, 240)}`).join('\n')}`
        : null
      const pendingRepoDir = (!cloudRepoDir && effectiveScope === 'branch' && remoteUrl)
        ? `/workspace/${deriveRepoName(repoName || remoteUrl, 'repo').replace(/[^A-Za-z0-9._-]+/g, '-')}`
        : cloudRepoDir
      const handoffLines = [
        `[Cloud Handoff for ${name}]`,
        `Scope: ${effectiveScope}`,
        branch ? `Branch: ${branch}` : null,
        remoteUrl ? `Remote: ${remoteUrl}` : null,
        pendingRepoDir ? `Daytona Workspace: ${pendingRepoDir}` : null,
        macSyncJobId ? `Pending Mac Git Sync Job: ${macSyncJobId} (will auto-sync Daytona when finished)` : null,
        pre.workDir ? `Workspace: ${pre.workDir}` : null,
        String(note ?? '').trim() ? `Note: ${String(note).trim()}` : null,
        voiceSummary,
      ].filter(Boolean)

      const syncPromise = (effectiveScope === 'branch' && remoteUrl)
        ? syncDaytonaWorkspace(chosen.id, { repoName, remoteUrl, branch })
        : Promise.resolve(null)
      const [synced] = await Promise.all([
        syncPromise,
        postMachineMessage(chosen.id, { threadId: effectiveSessionId, botId: targetId, text: handoffLines.join('\n') }),
      ])
      if (synced) {
        cloudRepoDir = synced.cloudRepoDir
        branch = synced.branch ?? branch
        remoteUrl = synced.remoteUrl ?? remoteUrl
        repoName = synced.repoName ?? repoName
      }

      const transition = {
        id: randomUUID(),
        direction: 'to-cloud',
        at: new Date().toISOString(),
        branch: branch ?? null,
        machineId: chosen.id,
        machineName: chosen.name ?? chosen.id,
        scope: effectiveScope,
        summary: String(note ?? '').trim() || `Handed off ${name} to ${chosen.name ?? chosen.id}`,
        prUrl: null,
      }
      const next = {
        ...entry,
        location: 'cloud',
        phase: 'running',
        machineId: chosen.id,
        machineName: chosen.name ?? chosen.id,
        snapshot: chosen.snapshot ?? defaultSnapshot,
        branch: branch ?? null,
        workDir: pre.workDir,
        repoName: repoName ?? null,
        remoteUrl: remoteUrl ?? null,
        cloudRepoDir: cloudRepoDir ?? null,
        macSyncJobId,
        scope: effectiveScope,
        lastSyncedAt: new Date().toISOString(),
        lastTransition: transition,
        dismissedTransitionId: null,
        history: [...(entry.history ?? []), transition].slice(-MAX_HISTORY),
        error: null,
      }
      setTeamEntry(next)
      await rt.save()
      return { runtime: next, view: cloudRuntimeView() }
    } catch (error) {
      const current = ensureTeamEntry()
      current.phase = current.location === 'cloud' ? prevPhase : 'idle'
      current.error = error?.message ?? String(error)
      setTeamEntry(current)
      await rt.save().catch(() => {})
      throw error
    }
  }

  async function handoffToLocal({ sessionId = '', pullBranch = false, keepOfflineFork = false } = {}) {
    const targetId = resolveTargetId(sessionId)
    const effectiveSessionId = sessionId || targetId
    const entry = ensureTeamEntry()
    const prevPhase = entry.phase
    entry.phase = 'pulling-to-local'
    entry.error = null
    setTeamEntry(entry)
    await rt.save()

    try {
      await refreshStatus({ quiet: true, includeAuths: false })
      if (!liveMeta.controllerOnline && !keepOfflineFork) {
        entry.phase = entry.location === 'cloud' ? 'cached-offline' : prevPhase
        entry.error = 'Controller is offline; confirm continuing locally as an offline fork.'
        setTeamEntry(entry)
        await rt.save()
        throw invalid('Controller is offline; confirm continuing locally as an offline fork.', 'bot/unavailable')
      }

      let syncBranch = entry.branch ?? null
      let syncRemoteUrl = entry.remoteUrl ?? null
      let syncRepoName = entry.repoName ?? null
      let macPullJobId = null

      const shouldReverseSync = liveMeta.controllerOnline && entry.machineId
        && (pullBranch || entry.scope === 'branch' || entry.remoteUrl || entry.repoName || entry.cloudRepoDir)

      const threadPromise = (liveMeta.controllerOnline && entry.machineId)
        ? controllerCall('GET', `/v1/machines/${encodeURIComponent(entry.machineId)}/threads/${encodeURIComponent(effectiveSessionId)}`).catch(() => ({ ok: false }))
        : Promise.resolve({ ok: false })
      const pushPromise = shouldReverseSync
        ? syncFromDaytonaWorkspace(entry.machineId, { repoName: syncRepoName, branch: syncBranch, createIfMissing: true }).catch(() => null)
        : Promise.resolve(null)

      const [threadRes, cloudPush] = await Promise.all([threadPromise, pushPromise])
      const pulledSummary = (threadRes.ok && threadRes.body?.thread?.summary) ? String(threadRes.body.thread.summary) : ''
      if (cloudPush && !cloudPush.empty) {
        syncBranch = cloudPush.branch ?? syncBranch
        syncRemoteUrl = cloudPush.remoteUrl ?? syncRemoteUrl
        syncRepoName = cloudPush.repoName ?? syncRepoName
      }

      const workDir = entry.workDir ?? workDirForTarget(targetId)
      if ((pullBranch || syncBranch) && workDir) {
        const localGit = await inspectGitWorkspace(workDir, gitRunner)
        if (localGit.isGitRepo) {
          if (!localGit.remoteUrl && syncRemoteUrl) {
            await gitRunner(['remote', 'add', 'origin', syncRemoteUrl], { cwd: workDir })
          }
          if (syncBranch) {
            await gitRunner(['fetch', 'origin', syncBranch], { cwd: workDir })
            if (localGit.dirtyCount === 0) {
              const co = await gitRunner(['checkout', syncBranch], { cwd: workDir })
              if (co.exitCode !== 0) {
                await gitRunner(['checkout', '-B', syncBranch, `origin/${syncBranch}`], { cwd: workDir })
              }
              await gitRunner(['pull', '--ff-only', 'origin', syncBranch], { cwd: workDir })
            }
          }
        }
      }

      if (hasMacBroker() && (syncRepoName || syncRemoteUrl || syncBranch)) {
        const macPull = await enqueueMacGitSync({
          action: 'pull',
          repo: syncRepoName || workDir || syncRemoteUrl,
          branch: syncBranch || undefined,
          remoteUrl: syncRemoteUrl || undefined,
          sessionId: effectiveSessionId,
          waitMs: 0,
        }).catch(() => null)
        if (macPull?.job?.job_id) macPullJobId = macPull.job.job_id
      }

      const transition = {
        id: randomUUID(),
        direction: 'to-local',
        at: new Date().toISOString(),
        branch: syncBranch,
        machineId: entry.machineId ?? null,
        machineName: entry.machineName ?? null,
        scope: entry.scope ?? 'summary',
        summary: pulledSummary || (liveMeta.controllerOnline ? 'Returned control to Local (Mac)' : 'Continued locally from offline cache'),
        prUrl: null,
      }
      const next = {
        ...entry,
        location: 'local',
        phase: 'idle',
        branch: syncBranch,
        repoName: syncRepoName,
        remoteUrl: syncRemoteUrl,
        macSyncJobId: macPullJobId,
        lastSyncedAt: new Date().toISOString(),
        lastTransition: transition,
        dismissedTransitionId: null,
        history: [...(entry.history ?? []), transition].slice(-MAX_HISTORY),
        queuedMessages: [],
        error: null,
      }
      setTeamEntry(next)
      await rt.save()
      return { runtime: next, view: cloudRuntimeView() }
    } catch (error) {
      const current = ensureTeamEntry()
      if (current.phase === 'pulling-to-local') {
        current.phase = prevPhase
        current.error = error?.message ?? String(error)
        setTeamEntry(current)
        await rt.save().catch(() => {})
      }
      throw error
    }
  }

  async function sendToCloud(sessionId, text) {
    const targetId = resolveTargetId(sessionId)
    const effectiveSessionId = sessionId || targetId
    const trimmed = String(text ?? '').trim()
    if (!trimmed) throw invalid('Nothing to send')
    const entry = ensureTeamEntry()
    if (entry.location !== 'cloud' || !entry.machineId) throw invalid('Session is not handed off to a cloud machine')

    try {
      await postMachineMessage(entry.machineId, { threadId: effectiveSessionId, botId: targetId, text: trimmed })
      entry.phase = 'running'
      entry.lastSyncedAt = new Date().toISOString()
      entry.recentMessages = [...(entry.recentMessages ?? []), { text: trimmed, at: Date.now(), delivered: true }].slice(-MAX_RECENT_MESSAGES)
      entry.error = null
      liveMeta.controllerOnline = true
      setTeamEntry(entry)
      await rt.save()
      return { delivered: true, queued: false }
    } catch (error) {
      liveMeta.controllerOnline = false
      entry.phase = 'cached-offline'
      entry.queuedMessages = [...(entry.queuedMessages ?? []), { id: randomUUID(), sessionId: effectiveSessionId, text: trimmed, at: Date.now() }]
      entry.error = null
      setTeamEntry(entry)
      await rt.save()
      return { delivered: false, queued: true, reason: error?.message ?? String(error) }
    }
  }

  function cloudRuntimeView() {
    if (!liveMeta.syncedAt) loadCacheIntoLiveMeta()
    liveMeta.configured = readOperator() !== null
    const team = ensureTeamEntry()
    const sessions = { [TEAM_KEY]: team }
    for (const id of Object.keys(rt.state?.bots ?? {})) sessions[id] = team
    for (const id of Object.keys(rt.state?.rooms ?? {})) sessions[id] = team
    return {
      controllerOnline: liveMeta.controllerOnline,
      configured: liveMeta.configured,
      syncedAt: liveMeta.syncedAt,
      machines: liveMeta.machines,
      team,
      sessions,
    }
  }

  async function cloudEndpoint(endpoint, body = {}) {
    switch (endpoint) {
      case 'cloud-status':
        return refreshStatus({ quiet: true })
      case 'cloud-preflight':
        return preflight(String(body.sessionId ?? ''))
      case 'cloud-handoff-to-cloud':
        return handoffToCloud(body)
      case 'cloud-handoff-to-local':
        return handoffToLocal(body)
      case 'cloud-send':
        return sendToCloud(String(body.sessionId ?? ''), String(body.text ?? ''))
      case 'cloud-dismiss-handoff': {
        const entry = ensureTeamEntry()
        entry.dismissedTransitionId = entry.lastTransition?.id ?? null
        setTeamEntry(entry)
        await rt.save()
        return { ok: true, view: cloudRuntimeView() }
      }
      default:
        throw invalid(`Unknown cloud endpoint ${endpoint}`, 'bot/not-found')
    }
  }

  if (Array.isArray(rt.teamTools)) {
    rt.teamTools.push(defineTool({
      name: 'cloud_exec',
      description: 'Run a shell command or script inside this Bot\'s active Daytona cloud sandbox when handed off to Cloud. Use /workspace by default for repos, code edits, builds, and tests.',
      parameters: {
        script: { type: 'string', required: true, description: 'Shell command or script to run inside the Daytona cloud sandbox' },
        cwd: { type: 'string', description: 'Working directory inside the sandbox (default: /workspace)' },
        timeoutSecs: { type: 'number', description: 'Timeout in seconds (default: 120, max: 300)' },
      },
      output,
      async execute(args) {
        await rt.load()
        const entry = ensureTeamEntry()
        if (entry.location !== 'cloud' || !entry.machineId) {
          return 'This Bot is currently in Local mode, not handed off to a cloud sandbox. Use local tools or switch to Cloud first.'
        }
        const script = String(args?.script ?? '')
        if (script.trim() === '') return 'cloud_exec requires a non-empty script.'
        const cwd = typeof args?.cwd === 'string' && args.cwd.trim() !== '' ? args.cwd.trim() : '/workspace'
        const rawTimeout = Number(args?.timeoutSecs)
        const timeoutSecs = Number.isFinite(rawTimeout) ? Math.min(300, Math.max(5, Math.round(rawTimeout))) : 120
        try {
          const res = await controllerCall('POST', `/v1/machines/${encodeURIComponent(entry.machineId)}/exec`, { script, cwd, timeoutSecs })
          if (!res.ok) return `cloud_exec failed (HTTP ${res.status}): ${res.body?.error ?? 'unknown error'}`
          const result = res.body?.result ?? res.body ?? {}
          entry.phase = 'running'
          entry.lastSyncedAt = new Date().toISOString()
          liveMeta.controllerOnline = true
          const text = String(result.stdout ?? result.result ?? '').slice(0, 12_000)
          return `[cloud_exec on ${entry.machineName ?? entry.machineId} | exit=${result.exitCode ?? 0}${result.woke ? ' | woke' : ''}]\n${text}`
        } catch (error) {
          return `cloud_exec failed: ${error?.message ?? error}`
        }
      },
    }))
    rt.teamTools.push(defineTool({
      name: 'cloud_git_sync',
      description: 'Synchronize a repository between Local (Mac Mini) and the active Daytona Cloud sandbox (/workspace). Use "mac-to-cloud" when code is only on the Mac Mini or has unpushed local commits; use "cloud-to-mac" to commit/push Daytona changes to GitHub and pull them onto the Mac Mini. Set create_if_missing: true for brand-new repos without an origin remote.',
      parameters: {
        direction: { type: 'string', enum: ['mac-to-cloud', 'cloud-to-mac'], description: 'Sync direction (default: mac-to-cloud)' },
        repo: { type: 'string', description: 'Repository name, owner/repo, or local Mac path (optional if already tracked in session)' },
        branch: { type: 'string', description: 'Git branch name to push/checkout/pull' },
        create_if_missing: { type: 'boolean', description: 'If true, init git and create a private GitHub repo via gh when no origin remote exists' },
      },
      output,
      async execute(args, toolCtx) {
        await rt.load()
        const entry = ensureTeamEntry()
        const direction = args?.direction === 'cloud-to-mac' ? 'cloud-to-mac' : 'mac-to-cloud'
        const targetId = resolveTargetId(toolCtx?.agent?.id ?? '')
        const workDir = entry.workDir ?? workDirForTarget(targetId)
        const repoHint = String(args?.repo ?? entry.repoName ?? workDir ?? '').trim()
        const reqBranch = String(args?.branch ?? entry.branch ?? '').trim()
        const createIfMissing = Boolean(args?.create_if_missing)
        let repoName = (repoHint ? deriveRepoName(repoHint) : null) ?? entry.repoName ?? null

        if (direction === 'mac-to-cloud') {
          if (entry.location !== 'cloud' || !entry.machineId) {
            return 'Team is currently in Local mode; hand off to Cloud first before syncing into Daytona.'
          }
          let remoteUrl = entry.remoteUrl ?? null
          let branch = reqBranch || null
          const localGit = workDir ? await inspectGitWorkspace(workDir, gitRunner) : { isGitRepo: false }
          const matchesLocal = localGit.isGitRepo && (!repoHint || repoHint === workDir || deriveRepoName(repoHint) === localGit.repoName)

          if (matchesLocal) {
            branch = reqBranch || localGit.branch
            remoteUrl = localGit.remoteUrl ?? remoteUrl
            repoName = localGit.repoName ?? repoName
            if (localGit.dirtyCount > 0) {
              const targetBr = reqBranch || `wip/sync-${Date.now()}`
              if (targetBr !== localGit.branch) {
                const co = await gitRunner(['checkout', '-b', targetBr], { cwd: workDir })
                if (co.exitCode !== 0) return `cloud_git_sync failed: ${co.stderr || co.stdout}`
              }
              const add = await gitRunner(['add', '-A'], { cwd: workDir })
              if (add.exitCode !== 0) return `cloud_git_sync failed: ${add.stderr || add.stdout}`
              const cm = await gitRunner(['commit', '-m', 'wip: sync local changes to cloud'], { cwd: workDir })
              if (cm.exitCode !== 0) return `cloud_git_sync failed: ${cm.stderr || cm.stdout}`
              branch = targetBr
            }
            let pushedViaCreate = false
            if (!remoteUrl && (createIfMissing || ghRunner)) {
              const created = await ensureGitHubRemote({ workDir, repoName: repoName || workDir, push: true })
              if (created?.remoteUrl) {
                remoteUrl = created.remoteUrl
                pushedViaCreate = Boolean(created.created)
              }
            }
            if (!pushedViaCreate && branch) {
              const push = await gitRunner(['push', '-u', 'origin', branch], { cwd: workDir })
              if (push.exitCode !== 0) return `cloud_git_sync git push failed: ${push.stderr || push.stdout}`
            }
          } else if (hasMacBroker()) {
            const macSync = await enqueueMacGitSync({
              action: 'push',
              repo: repoHint,
              branch: branch || undefined,
              createIfMissing,
              sessionId: targetId,
            })
            if (!macSync) return 'Failed to enqueue git_sync job on Mac Mini broker.'
            if (!macSync.syncResult) {
              entry.macSyncJobId = macSync.job?.job_id ?? null
              setTeamEntry(entry)
              await rt.save().catch(() => {})
              return JSON.stringify({ status: macSync.job?.status ?? 'queued', job_id: macSync.job?.job_id, mac_online: macSync.macOnline, message: 'Enqueued Mac Mini git_sync job; Daytona /workspace will auto-sync as soon as [MAC_JOB_RESULT] returns.' })
            }
            remoteUrl = macSync.syncResult.remoteUrl ?? remoteUrl
            branch = macSync.syncResult.branch ?? branch
            repoName = macSync.syncResult.repo ?? repoName
          } else {
            return 'No local git repository found here and Mac Broker is unavailable.'
          }

          if (!remoteUrl) return 'No GitHub origin remote resolved; pass create_if_missing: true or configure origin.'
          const synced = await syncDaytonaWorkspace(entry.machineId, { repoName, remoteUrl, branch })
          Object.assign(entry, {
            branch: synced.branch ?? branch,
            repoName: synced.repoName ?? repoName,
            remoteUrl: synced.remoteUrl ?? remoteUrl,
            cloudRepoDir: synced.cloudRepoDir,
            lastSyncedAt: new Date().toISOString(),
          })
          setTeamEntry(entry)
          await rt.save().catch(() => {})
          return JSON.stringify({ ok: true, direction, ...synced })
        }

        // direction === 'cloud-to-mac'
        if (!entry.machineId) return 'No cloud machine associated with this team yet.'
        const cloudPush = await syncFromDaytonaWorkspace(entry.machineId, {
          repoName,
          branch: reqBranch || undefined,
          createIfMissing: true,
        })
        if (cloudPush.empty) return 'Daytona /workspace contains no git repository or project files to push.'
        const nextBranch = cloudPush.branch ?? reqBranch ?? entry.branch
        const nextRemote = cloudPush.remoteUrl ?? entry.remoteUrl
        const nextRepo = cloudPush.repoName ?? repoName
        Object.assign(entry, {
          branch: nextBranch,
          repoName: nextRepo,
          remoteUrl: nextRemote,
          cloudRepoDir: cloudPush.cloudRepoDir ?? entry.cloudRepoDir,
          lastSyncedAt: new Date().toISOString(),
        })
        setTeamEntry(entry)
        await rt.save().catch(() => {})

        let macPullJob = null
        if (hasMacBroker() && (nextRepo || nextRemote)) {
          const macPull = await enqueueMacGitSync({
            action: 'pull',
            repo: nextRepo || workDir || nextRemote,
            branch: nextBranch || undefined,
            remoteUrl: nextRemote || undefined,
            sessionId: targetId,
          }).catch(() => null)
          if (macPull) macPullJob = { job_id: macPull.job?.job_id, status: macPull.job?.status, mac_online: macPull.macOnline }
        }
        return JSON.stringify({ ok: true, direction, cloudPush, macPullJob })
      },
    }))
    // The Desktop-only read_browser stays the last tool, so the list every profile
    // shares comes first and only the profile's own tool differs at the end.
    const browserAt = rt.teamTools.findIndex(tool => tool.name === 'read_browser')
    if (browserAt !== -1) rt.teamTools.push(...rt.teamTools.splice(browserAt, 1))
  }

  if (typeof ctx.systemPrompt?.section === 'function') {
    ctx.effect?.(() => ctx.systemPrompt.section({
      name: 'bot-cloud-runtime',
      order: 645,
      interpolate: false,
      text: () => {
        const entry = rt.own?.(rt.state?.cloudRuntimes, TEAM_KEY) ?? ensureTeamEntry()
        if (entry?.location !== 'cloud' || !entry?.machineId) return ''
        const label = entry.machineName ?? entry.machineId
        return [
          '# Active Cloud Runtime (Daytona Sandbox)',
          `This conversation is handed off to cloud machine "${label}" (id: ${entry.machineId}, snapshot: ${entry.snapshot ?? defaultSnapshot}${entry.branch ? `, branch: ${entry.branch}` : ''}${entry.cloudRepoDir ? `, repoDir: ${entry.cloudRepoDir}` : ''}${entry.remoteUrl ? `, remote: ${entry.remoteUrl}` : ''}).`,
          '- Use `cloud_exec` to run shell commands, inspect/create/edit repos and files, and run git/tests inside `/workspace` on this Daytona cloud sandbox instead of local bash or local file tools.',
          '- If the user asks about unpushed local Mac Mini code or a repo missing in `/workspace`, call `cloud_git_sync` (`direction: "mac-to-cloud"`, and `create_if_missing: true` for a brand-new repo) to push from the Mac Mini to GitHub and clone/checkout into `/workspace`.',
          '- When finishing cloud edits or preparing to hand back to Mac Mini, you can call `cloud_git_sync` with `direction: "cloud-to-mac"` to commit/push Daytona changes and pull them on the Mac Mini.',
          `- State clearly in your reply when actions ran on cloud machine "${label}".`,
        ].join('\n')
      },
    }), 'ds-bot: cloud runtime prompt')
  }

  // Mirror user prompts to the cloud sandbox inbox while running live turns when online,
  // or queue them FIFO when offline so nothing is lost.
  ctx.effect?.(() => {
    const controller = ctx.sessionController
    const origPrompt = controller?.prompt
    if (typeof origPrompt !== 'function') return undefined
    const wrapped = async function (request, ...rest) {
      const sid = request?.sessionId
      const entry = rt.own?.(rt.state?.cloudRuntimes, TEAM_KEY) ?? ensureTeamEntry()
      if (entry?.location === 'cloud' && !request?.cloudBypass) {
        const text = extractTextFromContent(request?.content)
        if (!text) return origPrompt.call(this, request, ...rest)
        const macSync = parseMacSyncResult(text)
        let outboundText = text
        if (macSync?.remoteUrl && entry.machineId) {
          try {
            const synced = await syncDaytonaWorkspace(entry.machineId, {
              repoName: macSync.repo ?? entry.repoName,
              remoteUrl: macSync.remoteUrl,
              branch: macSync.branch ?? entry.branch,
            })
            if (synced) {
              Object.assign(entry, {
                branch: synced.branch ?? entry.branch,
                repoName: synced.repoName ?? entry.repoName,
                remoteUrl: synced.remoteUrl ?? entry.remoteUrl,
                cloudRepoDir: synced.cloudRepoDir,
                macSyncJobId: null,
                error: null,
                lastSyncedAt: new Date().toISOString(),
              })
              setTeamEntry(entry)
              await rt.save().catch(() => {})
              outboundText = `${text}\n\n[Daytona auto-synced: ${synced.cloudRepoDir} (${synced.branch ?? 'HEAD'})]`
            }
          } catch (error) {
            const msg = error?.message ?? String(error)
            rt.warn?.('ds-bot: Daytona auto-sync failed: %s', msg)
            entry.error = msg
            setTeamEntry(entry)
            await rt.save().catch(() => {})
            outboundText = `${text}\n\n[Daytona auto-sync error: ${msg}]`
          }
        }
        const outcome = await sendToCloud(sid, outboundText)
        if (outcome.delivered) return origPrompt.call(this, request, ...rest)
        return { accepted: true, routed: 'cloud', ...outcome }
      }
      return origPrompt.call(this, request, ...rest)
    }
    controller.prompt = wrapped
    return () => { if (controller.prompt === wrapped) controller.prompt = origPrompt }
  }, 'ds-bot: cloud prompt router')

  // Periodic background sync with controller / offline cache when operator creds exist.
  ctx.effect?.(() => {
    if (config.disableCloudPoll) return undefined
    liveMeta.configured = readOperator() !== null
    loadCacheIntoLiveMeta()
    if (!liveMeta.configured) return undefined
    const timer = setInterval(() => { void refreshStatus({ quiet: true }) }, POLL_INTERVAL_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'ds-bot: cloud runtime poll')

  Object.assign(rt, { cloudRuntimeView, cloudEndpoint })
}
