import { randomUUID } from 'node:crypto'
import { posix as pathPosix } from 'node:path'
import { Daytona } from '@daytonaio/sdk'

const ALLOWED_CLI_DIRS = {
  codex: '.codex',
  claude: '.claude',
  agy: '.gemini',
  liftgate: '.liftgate',
}

const SIGNIN_COMMANDS = {
  codex: { login: 'codex login', status: 'codex login status' },
  claude: { login: 'claude auth login', status: 'claude auth status' },
  agy: { login: 'agy acp --login', status: 'agy --version' },
}

const SIZE_RESOURCES = {
  small: { cpu: 2, memory: 4, disk: 20 },
  medium: { cpu: 4, memory: 8, disk: 30 },
  large: { cpu: 8, memory: 16, disk: 50 },
}

const shellQuote = value => `'${String(value).replace(/'/g, "'\\''")}'`

function resolveUnder(root, relOrAbs) {
  if (typeof relOrAbs !== 'string' || relOrAbs.trim() === '' || relOrAbs.includes('\0')) {
    throw new Error('path must be a non-empty string')
  }
  const parts = relOrAbs.split(/[\\/]+/)
  if (parts.includes('..')) throw new Error(`path traversal is not allowed: ${relOrAbs}`)
  const normalizedRoot = pathPosix.resolve(root)
  const resolved = pathPosix.resolve(normalizedRoot, relOrAbs)
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}/`)) {
    throw new Error(`path escapes ${normalizedRoot}: ${relOrAbs}`)
  }
  return resolved
}

function normalizeRemotePath(path, homeDir) {
  if (path.startsWith('/')) return pathPosix.resolve(path)
  return pathPosix.resolve(homeDir, path)
}

function defaultMockExec(sandbox, command) {
  if (command.includes('/data/state.json')) {
    const raw = sandbox.files.get('/data/state.json')
    return { exitCode: raw ? 0 : 1, result: raw ? raw.toString('utf8') : 'not found' }
  }
  if (command.startsWith('chmod ') || command.startsWith('mkdir ')) {
    return { exitCode: 0, result: '' }
  }
  if (command.includes('git clone') || command.includes('git -C')) {
    return { exitCode: 0, result: 'ok' }
  }
  if (command === 'codex login' || command === 'claude auth login' || command === 'agy acp --login') {
    return { exitCode: 0, result: JSON.stringify({ url: `https://auth.mock/${command.split(' ')[0]}`, userCode: 'MOCK-1234' }) }
  }
  if (command === 'codex login status' || command === 'claude auth status' || command === 'agy --version') {
    return { exitCode: 0, result: 'signed-in' }
  }
  return { exitCode: 0, result: '' }
}

/**
 * In-memory stand-in matching the `@daytonaio/sdk` Daytona and Sandbox surface
 * used by persistent auto-sleep/wake machines.
 */
export function mockDaytonaClient({ now = Date.now, onCommand } = {}) {
  const sandboxes = new Map()
  const snapshots = new Map()
  let seq = 0

  function wrapSandbox(record) {
    const homeDir = '/home/daytona'
    const sandbox = {
      get id() { return record.id },
      get name() { return record.name },
      get state() { return record.state },
      get autoStopInterval() { return record.autoStopInterval },
      get autoDeleteInterval() { return record.autoDeleteInterval },
      get autoArchiveInterval() { return record.autoArchiveInterval },
      get ephemeral() { return record.ephemeral },
      get networkBlockAll() { return record.networkBlockAll },
      get snapshot() { return record.snapshot },
      get labels() { return { ...record.labels } },
      get env() { return { ...record.env } },
      get cpu() { return record.resources.cpu },
      get memory() { return record.resources.memory },
      get disk() { return record.resources.disk },
      get commands() { return record.commands },
      get startCount() { return record.startCount },
      get stopCount() { return record.stopCount },
      get files() { return record.files },
      getUserHomeDir: async () => homeDir,
      fs: {
        async uploadFile(source, remotePath) {
          if (record.destroyed) throw new Error(`sandbox ${record.id} was deleted`)
          const key = normalizeRemotePath(remotePath, homeDir)
          const buf = Buffer.isBuffer(source) ? Buffer.from(source) : Buffer.from(String(source), 'utf8')
          record.files.set(key, buf)
        },
        async downloadFile(remotePath) {
          if (record.destroyed) throw new Error(`sandbox ${record.id} was deleted`)
          const key = normalizeRemotePath(remotePath, homeDir)
          if (!record.files.has(key)) throw new Error(`file not found: ${key}`)
          return Buffer.from(record.files.get(key))
        },
      },
      process: {
        async executeCommand(command, cwd, env, timeout) {
          if (record.destroyed) throw new Error(`sandbox ${record.id} was deleted`)
          if (record.state !== 'started') throw new Error(`sandbox ${record.id} is ${record.state}`)
          const call = { command, cwd, env: env ? { ...env } : undefined, timeout }
          record.commands.push(call)
          record.lastActivityAt = now()
          if (onCommand) return onCommand(sandbox, call, record)
          return defaultMockExec(record, command)
        },
      },
      async start() {
        if (record.destroyed) throw new Error(`sandbox ${record.id} was deleted`)
        if (record.state !== 'started') {
          record.state = 'started'
          record.startCount += 1
        }
        record.lastActivityAt = now()
      },
      async stop() {
        if (record.destroyed) throw new Error(`sandbox ${record.id} was deleted`)
        if (record.state !== 'stopped') {
          record.state = 'stopped'
          record.stopCount += 1
        }
      },
      async setAutostopInterval(minutes) {
        if (!Number.isInteger(minutes) || minutes < 0) throw new Error('autoStopInterval must be a non-negative integer')
        record.autoStopInterval = minutes
      },
      async updateEnv(env, options = {}) {
        for (const key of options.unset ?? []) delete record.env[key]
        Object.assign(record.env, env)
      },
      async getPreviewLink(port) {
        return { url: `https://${port}-${record.id}.daytona.mock`, token: `tok-${record.id}-${port}` }
      },
      async refreshActivity() {
        record.lastActivityAt = now()
      },
      async createSnapshot(name) {
        snapshots.set(name, {
          name,
          createdAt: now(),
          files: new Map([...record.files.entries()].map(([k, v]) => [k, Buffer.from(v)])),
          env: { ...record.env },
          resources: { ...record.resources },
        })
      },
      async resize(resources = {}) {
        const keys = ['cpu', 'memory', 'disk'].filter(k => resources[k] !== undefined)
        if (keys.length === 0) throw new Error('resize requires at least one of cpu, memory, disk')
        if (resources.disk !== undefined) {
          if (record.state !== 'stopped') throw new Error('disk resize requires a stopped sandbox')
          if (resources.disk < record.resources.disk) throw new Error('disk size cannot decrease')
        }
        for (const key of keys) record.resources[key] = resources[key]
      },
    }
    return sandbox
  }

  return {
    sandboxes,
    snapshots,
    async create(params = {}) {
      const id = `sbx-${++seq}-${randomUUID().slice(0, 8)}`
      const baseSnap = params.snapshot ? snapshots.get(params.snapshot) : undefined
      const record = {
        id,
        name: params.name ?? id,
        state: 'started',
        ephemeral: params.ephemeral ?? false,
        networkBlockAll: params.networkBlockAll ?? false,
        autoStopInterval: params.autoStopInterval ?? 15,
        autoDeleteInterval: params.autoDeleteInterval,
        autoArchiveInterval: params.autoArchiveInterval,
        snapshot: params.snapshot,
        labels: { ...(params.labels ?? {}) },
        env: { ...(baseSnap?.env ?? {}), ...(params.envVars ?? params.env ?? {}) },
        resources: { ...(baseSnap?.resources ?? SIZE_RESOURCES[params.labels?.size] ?? SIZE_RESOURCES.small), ...(params.resources ?? {}) },
        files: baseSnap ? new Map([...baseSnap.files.entries()].map(([k, v]) => [k, Buffer.from(v)])) : new Map(),
        commands: [],
        startCount: 1,
        stopCount: 0,
        lastActivityAt: now(),
        destroyed: false,
      }
      const sandbox = wrapSandbox(record)
      sandboxes.set(id, { record, sandbox })
      return sandbox
    },
    async get(idOrName) {
      for (const entry of sandboxes.values()) {
        if (!entry.record.destroyed && (entry.record.id === idOrName || entry.record.name === idOrName)) {
          return entry.sandbox
        }
      }
      throw new Error(`sandbox not found: ${idOrName}`)
    },
    async *list(query = {}) {
      const wantedLabels = query?.labels ? Object.entries(query.labels) : []
      for (const entry of sandboxes.values()) {
        if (entry.record.destroyed) continue
        if (wantedLabels.every(([k, v]) => entry.record.labels[k] === v)) yield entry.sandbox
      }
    },
    async start(sandbox, timeout) {
      await sandbox.start(timeout)
    },
    async stop(sandbox) {
      await sandbox.stop()
    },
    async delete(sandbox) {
      const entry = sandboxes.get(sandbox.id)
      if (entry) {
        entry.record.destroyed = true
        sandboxes.delete(sandbox.id)
      }
    },
  }
}

/**
 * Manages persistent auto-sleeping Daytona machines for DS Bot:
 * - read-while-asleep via epoch-stamped state capture, waking on writes or stale/uncaptured reads
 * - persistent CLI logins (codex/claude/agy/liftgate) and project .env sync
 * - idle auto-stop with clean drain and scheduled pre-wake
 */
export function createDaytonaMachineManager({
  client: providedClient,
  apiKey,
  defaultIdleMinutes = 15,
  scheduleHorizonMs = 5 * 60_000,
  preWakeLeadMs = 2 * 60_000,
  now = Date.now,
} = {}) {
  const client = providedClient ?? (() => {
    if (!apiKey) throw new Error('DAYTONA_API_KEY is required')
    return new Daytona({ apiKey })
  })()

  const machines = new Map()

  function requireMachine(machineId) {
    const machine = machines.get(machineId)
    if (!machine) throw new Error(`unknown machine: ${machineId}`)
    return machine
  }

  function currentState(machine) {
    return machine.sandbox?.state ?? machine.state
  }

  function validateCli(cli) {
    if (!(cli in ALLOWED_CLI_DIRS)) throw new Error(`unsupported CLI: ${cli}`)
  }

  async function safeStart(sandbox) {
    if (typeof client.start === 'function') await client.start(sandbox)
    else await sandbox.start()
  }

  async function safeStop(sandbox) {
    if (typeof client.stop === 'function') await client.stop(sandbox)
    else await sandbox.stop()
  }

  async function homeDirOf(sandbox) {
    return (await sandbox.getUserHomeDir?.()) ?? '/home/daytona'
  }

  async function ensureDirectory(sandbox, filePath) {
    const dir = pathPosix.dirname(filePath)
    if (dir && dir !== '.' && dir !== '/') {
      const res = await sandbox.process.executeCommand(`mkdir -p ${shellQuote(dir)}`, undefined, undefined, 30)
      if (res.exitCode !== 0) throw new Error(`mkdir failed for ${dir} (exit ${res.exitCode})`)
    }
  }

  async function runShellOrFail(sandbox, command, label, { cwd, env, timeout = 60 } = {}) {
    const res = await sandbox.process.executeCommand(command, cwd, env, timeout)
    if (res.exitCode !== 0) throw new Error(`${label} failed (exit ${res.exitCode}): ${String(res.result ?? '').slice(0, 160)}`)
    return res
  }

  async function ensureAwake(machineId, reason = 'write') {
    const machine = requireMachine(machineId)
    const state = currentState(machine)
    if (state === 'stopped') {
      if (machine.pendingResize) {
        const { size, ...resources } = machine.pendingResize
        if (Object.keys(resources).length > 0) await machine.sandbox.resize?.(resources)
        machine.size = size ?? machine.size
        machine.pendingResize = null
      }
      await safeStart(machine.sandbox)
      machine.state = 'started'
      machine.cache.fresh = false
      machine.lastActivityAt = now()
      return { woke: true, reason }
    }
    machine.state = state
    machine.lastActivityAt = now()
    return { woke: false, reason }
  }

  async function captureState(machineId, { roster, threads, projects } = {}) {
    const machine = requireMachine(machineId)
    if (currentState(machine) !== 'started') {
      throw new Error(`cannot capture live state while machine ${machineId} is ${currentState(machine)}`)
    }
    if (roster === undefined && threads === undefined && projects === undefined) {
      try {
        const buf = await machine.sandbox.fs.downloadFile('/data/state.json')
        const parsed = JSON.parse(buf.toString('utf8'))
        if (parsed.bots !== undefined) machine.cache.roster = structuredClone(parsed.bots)
        if (parsed.projects !== undefined) machine.cache.projects = structuredClone(parsed.projects)
      } catch { /* sandboxes without a serialized state file still capture in-memory turn snapshots */ }
    }
    if (roster !== undefined) machine.cache.roster = structuredClone(roster)
    if (projects !== undefined) machine.cache.projects = structuredClone(projects)
    if (threads !== undefined) {
      const entries = threads instanceof Map ? threads.entries()
        : Array.isArray(threads) ? threads.map(t => [t.threadId, t])
          : Object.entries(threads)
      for (const [id, thread] of entries) {
        machine.cache.threads.set(id, structuredClone(thread))
      }
    }
    machine.cache.capturedSeq = machine.seq
    machine.cache.capturedEpoch = machine.epoch
    return {
      capturedSeq: machine.cache.capturedSeq,
      capturedEpoch: machine.cache.capturedEpoch,
      threadCount: machine.cache.threads.size,
    }
  }

  async function readCachedOrWake(machine, reason, { cacheHit, readCache, readLive }) {
    if (currentState(machine) === 'stopped') {
      if (machine.cache.fresh && cacheHit()) {
        return { value: structuredClone(readCache()), fromCache: true, woke: false, epoch: machine.cache.capturedEpoch }
      }
      await ensureAwake(machine.id, reason)
      const value = await readLive(machine.sandbox)
      return { value: structuredClone(value), fromCache: false, woke: true, epoch: machine.epoch }
    }
    const value = await readLive(machine.sandbox)
    return { value: structuredClone(value), fromCache: false, woke: false, epoch: machine.epoch }
  }

  const fetcherOf = opt => (typeof opt === 'function' ? opt : opt?.fetcher)

  return {
    client,
    machines,

    async createMachine({ name, size = 'small', snapshot, idleMinutes = defaultIdleMinutes, labels = {}, envVars } = {}) {
      if (!Number.isInteger(idleMinutes) || idleMinutes < 0) {
        throw new Error('idleMinutes must be a non-negative integer')
      }
      const sandbox = await client.create({
        name,
        language: 'typescript',
        ephemeral: false,
        networkBlockAll: false,
        autoStopInterval: idleMinutes,
        autoDeleteInterval: -1,
        ...(snapshot ? { snapshot } : {}),
        ...(envVars ? { envVars } : {}),
        labels: { app: 'ds-bot-machine', ...(name ? { machine: name } : {}), size, ...labels },
      }, { timeout: 300 })

      const record = {
        id: sandbox.id,
        name: name ?? sandbox.name ?? sandbox.id,
        size,
        state: sandbox.state ?? 'started',
        sandbox,
        idleMinutes,
        keepAwake: false,
        activeJobs: 0,
        lastActivityAt: now(),
        epoch: 1,
        seq: 0,
        nextScheduledAt: null,
        pendingResize: null,
        cache: {
          fresh: false,
          capturedSeq: 0,
          capturedEpoch: 0,
          stoppedAt: null,
          roster: null,
          threads: new Map(),
          readings: new Map(),
          projects: [],
        },
        clis: {
          codex: { signedIn: false },
          claude: { signedIn: false },
          agy: { signedIn: false },
          liftgate: { signedIn: false },
        },
      }
      machines.set(record.id, record)
      return record
    },

    getMachine: requireMachine,
    listMachines: () => [...machines.values()],
    ensureAwake,
    captureState,

    async readRoster(machineId, opts = {}) {
      const machine = requireMachine(machineId)
      const fetcher = fetcherOf(opts)
      return readCachedOrWake(machine, 'read-roster', {
        cacheHit: () => machine.cache.roster !== null,
        readCache: () => machine.cache.roster,
        readLive: async (sandbox) => {
          if (fetcher) machine.cache.roster = structuredClone(await fetcher(sandbox))
          return machine.cache.roster
        },
      })
    },

    async readProjects(machineId, opts = {}) {
      const machine = requireMachine(machineId)
      const fetcher = fetcherOf(opts)
      return readCachedOrWake(machine, 'read-projects', {
        cacheHit: () => true,
        readCache: () => machine.cache.projects,
        readLive: async (sandbox) => {
          if (fetcher) machine.cache.projects = structuredClone(await fetcher(sandbox))
          return machine.cache.projects
        },
      })
    },

    async readThread(machineId, threadId, opts = {}) {
      const machine = requireMachine(machineId)
      const fetcher = fetcherOf(opts)
      return readCachedOrWake(machine, 'uncaptured-thread', {
        cacheHit: () => machine.cache.threads.has(threadId),
        readCache: () => machine.cache.threads.get(threadId),
        readLive: async (sandbox) => {
          const thread = fetcher ? await fetcher(sandbox, threadId) : (machine.cache.threads.get(threadId) ?? null)
          if (thread !== null) machine.cache.threads.set(threadId, structuredClone(thread))
          return thread
        },
      })
    },

    async readFileOrDiff(machineId, key, fetcher) {
      if (typeof fetcher !== 'function') throw new Error('fetcher is required for readFileOrDiff')
      const machine = requireMachine(machineId)
      return readCachedOrWake(machine, 'stale-or-missing-read', {
        cacheHit: () => {
          const entry = machine.cache.readings.get(key)
          return entry !== undefined && entry.epoch === machine.epoch
        },
        readCache: () => machine.cache.readings.get(key).value,
        readLive: async (sandbox) => {
          const value = await fetcher(sandbox)
          machine.cache.readings.set(key, { value: structuredClone(value), epoch: machine.epoch })
          return value
        },
      })
    },

    async sendMessage(machineId, { threadId, botId, text, handler } = {}) {
      const machine = requireMachine(machineId)
      const { woke } = await ensureAwake(machineId, 'send-message')
      machine.activeJobs += 1
      machine.epoch += 1
      machine.seq += 1
      const message = { role: 'user', botId, text, seq: machine.seq, at: now() }
      const existing = machine.cache.threads.get(threadId) ?? { threadId, seq: 0, messages: [] }
      existing.messages.push(message)
      existing.seq = machine.seq
      machine.cache.threads.set(threadId, existing)

      let result
      try {
        if (typeof handler === 'function') result = await handler(machine.sandbox, message)
        else result = await machine.sandbox.process.executeCommand(String(text ?? ''), undefined, undefined, 120)
        if (result?.reply !== undefined) {
          machine.seq += 1
          existing.messages.push({ role: 'assistant', botId, text: result.reply, seq: machine.seq, at: now() })
          existing.seq = machine.seq
        }
        return { woke, seq: machine.seq, epoch: machine.epoch, result }
      } finally {
        machine.activeJobs -= 1
        machine.lastActivityAt = now()
      }
    },

    async execCommand(machineId, script, { cwd, env, timeoutSecs = 120 } = {}) {
      const machine = requireMachine(machineId)
      const { woke } = await ensureAwake(machineId, 'exec-command')
      machine.activeJobs += 1
      machine.epoch += 1
      try {
        const res = await machine.sandbox.process.executeCommand(script, cwd, env, timeoutSecs)
        return { woke, exitCode: res.exitCode, stdout: res.result, epoch: machine.epoch }
      } finally {
        machine.activeJobs -= 1
        machine.lastActivityAt = now()
      }
    },

    async syncCliCredentials(machineId, { cli, files = {}, env = {} } = {}) {
      validateCli(cli)
      const machine = requireMachine(machineId)
      const { woke } = await ensureAwake(machineId, `sync-cli-${cli}`)
      const homeDir = await homeDirOf(machine.sandbox)
      const cliRoot = pathPosix.join(homeDir, ALLOWED_CLI_DIRS[cli])
      const uploaded = []

      for (const [rawPath, content] of Object.entries(files)) {
        const target = resolveUnder(cliRoot, rawPath)
        await ensureDirectory(machine.sandbox, target)
        const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
        await machine.sandbox.fs.uploadFile(buf, target)
        await runShellOrFail(machine.sandbox, `chmod 600 ${shellQuote(target)}`, `chmod ${target}`)
        uploaded.push(target)
      }
      if (Object.keys(env).length > 0) await machine.sandbox.updateEnv(env)
      machine.clis[cli] = { signedIn: true, method: 'synced', files: uploaded, updatedAt: now() }
      machine.lastActivityAt = now()
      return { woke, cli, files: uploaded }
    },

    async startCliSignIn(machineId, { cli, callbackPort = 1455 } = {}) {
      const spec = SIGNIN_COMMANDS[cli]
      if (!spec) throw new Error(`interactive sign-in is not defined for ${cli}`)
      const machine = requireMachine(machineId)
      const { woke } = await ensureAwake(machineId, `cli-signin-${cli}`)
      const preview = await machine.sandbox.getPreviewLink?.(callbackPort)
      const res = await runShellOrFail(machine.sandbox, spec.login, `${cli} sign-in`, { timeout: 60 })
      const text = String(res.result ?? '')
      let parsed = {}
      try { parsed = JSON.parse(text.trim().split('\n').at(-1)) } catch { /* plain text output */ }
      const urlMatch = /https?:\/\/\S+/.exec(text)
      const codeMatch = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/.exec(text)
      const url = parsed.url ?? urlMatch?.[0] ?? preview?.url
      const userCode = parsed.userCode ?? codeMatch?.[0] ?? null
      machine.clis[cli] = { signedIn: false, pending: true, previewUrl: preview?.url, callbackPort }
      machine.lastActivityAt = now()
      return {
        cli,
        woke,
        url,
        userCode,
        previewUrl: preview?.url ?? null,
        previewToken: preview?.token ?? null,
        callbackPort,
        completeSignIn: () => this.completeCliSignIn(machineId, cli),
      }
    },

    async completeCliSignIn(machineId, cli) {
      const spec = SIGNIN_COMMANDS[cli]
      if (!spec) throw new Error(`interactive sign-in is not defined for ${cli}`)
      const machine = requireMachine(machineId)
      const { woke } = await ensureAwake(machineId, `cli-verify-${cli}`)
      const res = await runShellOrFail(machine.sandbox, spec.status, `${cli} sign-in status`, { timeout: 30 })
      machine.clis[cli] = { signedIn: true, method: 'oauth', verifiedAt: now() }
      machine.lastActivityAt = now()
      return { cli, woke, signedIn: true, output: String(res.result ?? '').trim() }
    },

    async syncProjectEnv(machineId, { projectId, repoUrl, workDir, envFiles = {} } = {}) {
      if (typeof projectId !== 'string' || projectId.trim() === '') throw new Error('projectId is required')
      const machine = requireMachine(machineId)
      const { woke } = await ensureAwake(machineId, 'sync-project-env')
      const homeDir = await homeDirOf(machine.sandbox)
      if (typeof workDir !== 'string' || workDir.trim() === '' || workDir.includes('\0')) {
        throw new Error('workDir must be a non-empty string')
      }
      if (workDir.split(/[\\/]+/).includes('..')) throw new Error(`path traversal is not allowed: ${workDir}`)
      const targetDir = workDir.startsWith('/') ? pathPosix.resolve(workDir) : resolveUnder(homeDir, workDir)

      if (repoUrl) {
        const quotedDir = shellQuote(targetDir)
        const quotedUrl = shellQuote(repoUrl)
        const cmd = `if [ -d ${quotedDir}/.git ]; then git -C ${quotedDir} fetch --all --prune; else mkdir -p ${shellQuote(pathPosix.dirname(targetDir))} && git clone ${quotedUrl} ${quotedDir}; fi`
        await runShellOrFail(machine.sandbox, cmd, `sync repo ${projectId}`, { timeout: 120 })
      } else {
        await runShellOrFail(machine.sandbox, `mkdir -p ${shellQuote(targetDir)}`, `mkdir ${targetDir}`, { timeout: 30 })
      }

      const written = []
      for (const [relPath, content] of Object.entries(envFiles)) {
        if (!pathPosix.basename(relPath).startsWith('.env')) {
          throw new Error(`only .env* files may be synced via syncProjectEnv: ${relPath}`)
        }
        const envPath = resolveUnder(targetDir, relPath)
        await ensureDirectory(machine.sandbox, envPath)
        await machine.sandbox.fs.uploadFile(Buffer.from(String(content), 'utf8'), envPath)
        await runShellOrFail(machine.sandbox, `chmod 600 ${shellQuote(envPath)}`, `chmod ${envPath}`)
        written.push(relPath)
      }

      machine.epoch += 1
      machine.lastActivityAt = now()
      const record = { projectId, repoUrl: repoUrl ?? null, workDir: targetDir, envFileNames: written, syncedAt: now() }
      const existing = machine.cache.projects.findIndex(p => p.projectId === projectId)
      if (existing === -1) machine.cache.projects.push(record)
      else machine.cache.projects[existing] = record
      return { woke, ...record, epoch: machine.epoch }
    },

    async setIdlePolicy(machineId, { idleMinutes, keepAwake, nextScheduledAt } = {}) {
      const machine = requireMachine(machineId)
      if (idleMinutes !== undefined) {
        if (!Number.isInteger(idleMinutes) || idleMinutes < 0) throw new Error('idleMinutes must be a non-negative integer')
        if (idleMinutes !== machine.idleMinutes) {
          await machine.sandbox.setAutostopInterval?.(idleMinutes)
          machine.idleMinutes = idleMinutes
        }
      }
      if (keepAwake !== undefined) machine.keepAwake = Boolean(keepAwake)
      if (nextScheduledAt !== undefined) machine.nextScheduledAt = nextScheduledAt
      return { idleMinutes: machine.idleMinutes, keepAwake: machine.keepAwake, nextScheduledAt: machine.nextScheduledAt }
    },

    async resizeMachine(machineId, resources = {}) {
      const machine = requireMachine(machineId)
      const { size, ...hw } = resources
      if (machine.activeJobs > 0 || (hw.disk !== undefined && currentState(machine) === 'started')) {
        machine.pendingResize = { ...resources }
        return { applied: false, pending: true }
      }
      if (Object.keys(hw).length > 0) await machine.sandbox.resize(hw)
      if (size) machine.size = size
      return { applied: true, pending: false }
    },

    async sleep(machineId, { saveSnapshot = false, snapshotName } = {}) {
      const machine = requireMachine(machineId)
      if (machine.activeJobs > 0) return { slept: false, reason: 'busy', activeJobs: machine.activeJobs }
      if (currentState(machine) === 'stopped') {
        return {
          slept: true,
          alreadyStopped: true,
          capturedSeq: machine.cache.capturedSeq,
          capturedEpoch: machine.cache.capturedEpoch,
        }
      }
      await captureState(machineId)
      machine.cache.fresh = true
      const resolvedSnap = saveSnapshot ? (snapshotName ?? `ds-bot-${machine.name}-${machine.id}`) : undefined
      if (resolvedSnap) await machine.sandbox.createSnapshot?.(resolvedSnap)
      await safeStop(machine.sandbox)
      machine.state = 'stopped'
      machine.cache.stoppedAt = now()
      return {
        slept: true,
        capturedSeq: machine.cache.capturedSeq,
        capturedEpoch: machine.cache.capturedEpoch,
        ...(resolvedSnap ? { snapshotName: resolvedSnap } : {}),
      }
    },

    async checkIdleAndSchedule(machineId) {
      const machine = requireMachine(machineId)
      const state = currentState(machine)
      if (state === 'stopped') {
        if (machine.nextScheduledAt !== null && machine.nextScheduledAt - now() <= preWakeLeadMs) {
          await ensureAwake(machineId, 'scheduled-work')
          return { action: 'pre-woke', reason: 'scheduled-work' }
        }
        return { action: 'none', state: 'stopped' }
      }
      if (machine.keepAwake) return { action: 'none', reason: 'keep-awake' }
      if (machine.activeJobs > 0) return { action: 'none', reason: 'active-jobs' }
      if (machine.nextScheduledAt !== null && machine.nextScheduledAt - now() <= scheduleHorizonMs) {
        return { action: 'none', reason: 'schedule-due-soon' }
      }
      if (machine.idleMinutes <= 0) return { action: 'none', reason: 'autostop-disabled' }
      if (now() - machine.lastActivityAt < machine.idleMinutes * 60_000) {
        return { action: 'none', reason: 'not-idle-yet' }
      }
      const res = await this.sleep(machineId)
      return { action: 'slept', capturedSeq: res.capturedSeq, capturedEpoch: res.capturedEpoch }
    },

    async deleteMachine(machineId) {
      const machine = requireMachine(machineId)
      await client.delete(machine.sandbox)
      machines.delete(machineId)
    },
  }
}
