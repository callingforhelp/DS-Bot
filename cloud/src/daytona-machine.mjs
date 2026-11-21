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

const SIZE_SNAPSHOTS = {
  small: 'daytona-small',
  medium: 'daytona-medium',
  large: 'daytona-large',
}

const SIZE_RESOURCES = {
  small: { cpu: 1, memory: 1, disk: 3 },
  medium: { cpu: 2, memory: 4, disk: 8 },
  large: { cpu: 4, memory: 8, disk: 10 },
}

const DEFAULT_BOT_STATE_PATH = '/data/bot/state.json'

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
  if (command.includes('/data/bot/state.json')) {
    const raw = sandbox.files.get('/data/bot/state.json')
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
  const snapshots = new Map(
    Object.entries(SIZE_SNAPSHOTS).map(([sz, snapName]) => [
      snapName,
      { name: snapName, createdAt: now(), files: new Map(), env: {}, resources: { ...SIZE_RESOURCES[sz] } },
    ]),
  )
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
      get refreshCount() { return record.refreshCount },
      get createParams() { return record.createParams },
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
        record.refreshCount += 1
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
        if (record.state === 'started') {
          if (resources.disk !== undefined) throw new Error('disk resize requires a stopped sandbox')
          if (resources.cpu !== undefined && resources.cpu < record.resources.cpu) throw new Error('hot cpu decrease requires a stopped sandbox')
          if (resources.memory !== undefined && resources.memory < record.resources.memory) throw new Error('hot memory decrease requires a stopped sandbox')
        }
        if (resources.disk !== undefined && resources.disk < record.resources.disk) throw new Error('disk size cannot decrease')
        for (const key of keys) record.resources[key] = resources[key]
      },
    }
    return sandbox
  }

  return {
    sandboxes,
    snapshots,
    async create(params = {}) {
      if (!params.image && params.resources !== undefined) {
        throw new Error('Cannot specify Sandbox resources when using a snapshot')
      }
      if (params.snapshot && !snapshots.has(params.snapshot)) {
        throw new Error(`snapshot not found: ${params.snapshot}`)
      }
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
        resources: { ...(baseSnap?.resources ?? { cpu: 1, memory: 1, disk: 3 }), ...(params.resources ?? {}) },
        createParams: structuredClone(params),
        files: baseSnap ? new Map([...baseSnap.files.entries()].map(([k, v]) => [k, Buffer.from(v)])) : new Map(),
        commands: [],
        startCount: 1,
        stopCount: 0,
        refreshCount: 0,
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
  jobLeaseMs = 5 * 60_000,
  stateRefreshTtlMs = 15_000,
  botStatePath,
  store,
  now = Date.now,
} = {}) {
  const client = providedClient ?? (() => {
    if (!apiKey) throw new Error('DAYTONA_API_KEY is required')
    return new Daytona({ apiKey })
  })()

  const machines = new Map()
  let createOrder = 0
  let rehydrateInFlight = null

  function serializeMachine(machine) {
    const labels = machine.sandbox?.labels ?? machine.labels ?? {}
    return {
      tenantId: labels.tenant_id ?? 'default',
      id: machine.id,
      name: machine.name,
      size: machine.size,
      state: machine.sandbox?.state ?? machine.state,
      idleMinutes: machine.idleMinutes,
      keepAwake: Boolean(machine.keepAwake),
      nextScheduledAt: machine.nextScheduledAt,
      labels,
      pendingResize: machine.pendingResize,
      cache: {
        fresh: machine.cache.fresh,
        capturedSeq: machine.cache.capturedSeq,
        capturedEpoch: machine.cache.capturedEpoch,
        stoppedAt: machine.cache.stoppedAt,
        roster: machine.cache.roster,
        projects: machine.cache.projects,
        threads: Object.fromEntries(machine.cache.threads.entries()),
        readings: Object.fromEntries(machine.cache.readings.entries()),
      },
      epoch: machine.epoch,
      seq: machine.seq,
      version: machine.version ?? null,
      lastActivityAt: machine.lastActivityAt,
    }
  }

  async function persist(machine) {
    if (!store) return
    const queue = machine.saveQueue ?? Promise.resolve()
    const run = queue.then(async () => {
      const saved = await store.save(serializeMachine(machine))
      if (saved?.version !== undefined) machine.version = saved.version
    })
    machine.saveQueue = run.catch(() => {})
    return run
  }

  async function syncFromStore(machine) {
    if (!store?.loadOne) return machine
    const busy = () => machine.activeMutations > 0 || machine.activeJobs > 0 || machine.sleepLock || machine.startLock
    if (busy()) return machine
    const tenantId = machine.sandbox?.labels?.tenant_id ?? machine.labels?.tenant_id ?? 'default'
    const latest = await store.loadOne(machine.id, tenantId)
    if (busy()) return machine
    if (!latest) {
      if (machine.version !== undefined && machine.version !== null && !machine.persisting) {
        machines.delete(machine.id)
        return null
      }
      return machine
    }
    machine.remoteBusyUntil = latest.busyUntil ?? null
    machine.lastActivityAt = Math.max(machine.lastActivityAt, latest.lastActivityAt ?? 0)
    if (latest.version === machine.version) return machine
    machine.name = latest.name
    machine.size = latest.size ?? machine.size
    machine.state = latest.state ?? machine.state
    if (machine.sandbox && latest.state && machine.sandbox.state !== latest.state) {
      machine.sandbox = null
    }
    machine.idleMinutes = latest.idleMinutes ?? machine.idleMinutes
    machine.keepAwake = Boolean(latest.keepAwake)
    machine.nextScheduledAt = latest.nextScheduledAt ?? null
    machine.pendingResize = latest.pendingResize ?? null
    machine.epoch = latest.epoch ?? machine.epoch
    machine.seq = latest.seq ?? machine.seq
    machine.version = latest.version
    machine.cache.fresh = Boolean(latest.cache?.fresh)
    machine.cache.capturedSeq = latest.cache?.capturedSeq ?? 0
    machine.cache.capturedEpoch = latest.cache?.capturedEpoch ?? 0
    machine.cache.stoppedAt = latest.cache?.stoppedAt ?? null
    machine.cache.roster = latest.cache?.roster ?? null
    machine.cache.threads = new Map(Object.entries(latest.cache?.threads ?? {}))
    machine.cache.readings = new Map(Object.entries(latest.cache?.readings ?? {}))
    machine.cache.projects = Array.isArray(latest.cache?.projects) ? latest.cache.projects : []
    return machine
  }

  async function resolveSandbox(machine) {
    if (machine.sandbox) return machine.sandbox
    const sandbox = await client.get(machine.id)
    if (!sandbox) throw new Error(`sandbox ${machine.id} not found`)
    machine.sandbox = sandbox
    machine.state = sandbox.state ?? machine.state
    machine.sandboxRefreshedAt = now()
    return sandbox
  }

  // A refresh costs a Daytona API round-trip. Hot paths (each turn, the 2s idle
  // tick) share one refresh per stateRefreshTtlMs; a stale 'started' handle that
  // fails anyway is woken and retried by withWakeRetry. Transitions force it.
  async function refreshSandbox(machine, { force = false } = {}) {
    if (!machine.sandbox) return resolveSandbox(machine)
    if (!force && now() - (machine.sandboxRefreshedAt ?? -Infinity) < stateRefreshTtlMs) {
      return machine.sandbox
    }
    if (typeof machine.sandbox.refreshData === 'function') {
      await machine.sandbox.refreshData()
      machine.state = machine.sandbox.state ?? machine.state
      machine.sandboxRefreshedAt = now()
      return machine.sandbox
    }
    if (typeof client.get === 'function') {
      const fresh = await client.get(machine.id)
      if (fresh) {
        machine.sandbox = fresh
        machine.state = fresh.state ?? machine.state
      }
      machine.sandboxRefreshedAt = now()
    }
    return machine.sandbox
  }

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
    if ((await syncFromStore(machine)) === null) throw new Error(`unknown machine: ${machineId}`)
    let woke = false
    let stoppingWaits = 0
    let justResolved = false
    while (true) {
      if (!machine.sandbox) {
        await resolveSandbox(machine)
        justResolved = true
        continue
      }
      if (machine.sleepLock) {
        machine.sleepAborted = true
        await machine.sleepLock
        justResolved = false
        continue
      }
      if (machine.startLock) {
        await machine.startLock
        woke = true
        justResolved = false
        continue
      }
      // resolveSandbox already returned fresh state; forcing another API refresh
      // right after it would pay a second Daytona round-trip for the same answer.
      await refreshSandbox(machine, { force: !justResolved })
      justResolved = false
      const state = currentState(machine)
      if (state === 'stopping' && stoppingWaits < 60) {
        stoppingWaits += 1
        await new Promise(resolve => setTimeout(resolve, 500))
        continue
      }
      if (state !== 'stopped' && state !== 'archived') {
        machine.state = state
        machine.lastActivityAt = now()
        return { woke, reason }
      }
      let startPromise
      startPromise = (async () => {
        try {
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
          await persist(machine)
        } finally {
          if (machine.startLock === startPromise) machine.startLock = null
        }
      })()
      machine.startLock = startPromise
      await startPromise
      woke = true
    }
  }

  async function beginActiveJob(machineId, reason) {
    const machine = requireMachine(machineId)
    if ((await syncFromStore(machine)) === null) throw new Error(`unknown machine: ${machineId}`)
    let woke = false
    while (true) {
      if (!machine.sandbox) {
        await resolveSandbox(machine)
        continue
      }
      if (machine.sleepLock) {
        machine.sleepAborted = true
        await machine.sleepLock
        continue
      }
      await refreshSandbox(machine)
      const state = currentState(machine)
      if (state === 'stopped' || state === 'archived' || state === 'stopping' || machine.startLock) {
        const res = await ensureAwake(machineId, reason)
        woke ||= res.woke
        continue
      }
      machine.activeJobs += 1
      machine.lastActivityAt = now()
      const jobId = randomUUID()
      if (store?.beginJob) {
        const tenantId = machine.sandbox?.labels?.tenant_id ?? machine.labels?.tenant_id ?? 'default'
        try {
          await store.beginJob(machine.id, tenantId, jobId, machine.lastActivityAt, jobLeaseMs)
        } catch (err) {
          machine.activeJobs -= 1
          if (err?.code === 'MACHINE_SLEEPING') {
            await new Promise(r => setTimeout(r, 20))
            await syncFromStore(machine)
            continue
          }
          throw err
        }
      }
      return { machine, woke, jobId }
    }
  }

  async function readBotStateFile(sandbox, filePath) {
    try {
      const buf = await sandbox.fs.downloadFile(filePath)
      const parsed = JSON.parse(buf.toString('utf8'))
      return {
        roster: parsed.bots ?? null,
        projects: Array.isArray(parsed.projects) ? parsed.projects : undefined,
      }
    } catch {
      return null
    }
  }

  async function loadBotState(sandbox) {
    const primary = await readBotStateFile(sandbox, botStatePath ?? DEFAULT_BOT_STATE_PATH)
    if (primary || botStatePath !== undefined) return primary
    const home = await homeDirOf(sandbox)
    return readBotStateFile(sandbox, pathPosix.join(home, '.ds-bot', 'bot', 'state.json'))
  }

  async function captureState(machineId, { roster, threads, projects, skipPersist = false } = {}) {
    const machine = requireMachine(machineId)
    if (currentState(machine) !== 'started') {
      throw new Error(`cannot capture live state while machine ${machineId} is ${currentState(machine)}`)
    }
    if (roster === undefined || projects === undefined) {
      const loaded = await loadBotState(machine.sandbox)
      if (roster === undefined && loaded?.roster !== null && loaded?.roster !== undefined) {
        machine.cache.roster = structuredClone(loaded.roster)
      }
      if (projects === undefined && loaded?.projects !== undefined) {
        machine.cache.projects = structuredClone(loaded.projects)
      }
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
    if (!skipPersist) await persist(machine)
    return {
      capturedSeq: machine.cache.capturedSeq,
      capturedEpoch: machine.cache.capturedEpoch,
      threadCount: machine.cache.threads.size,
    }
  }

  async function readCachedOrWake(machine, reason, { cacheHit, readCache, readLive }) {
    if (machine.sleepLock) await machine.sleepLock
    if (machine.startLock) await machine.startLock
    await syncFromStore(machine)
    // A stale 'started' handle (provider-side autostop) must not wake a machine
    // whose captured cache can answer the read.
    if (machine.sandbox) await refreshSandbox(machine).catch(() => {})
    if (currentState(machine) === 'stopped' && machine.cache.fresh && cacheHit()) {
      return { value: structuredClone(readCache()), fromCache: true, woke: false, epoch: machine.cache.capturedEpoch }
    }
    return withActiveJob(machine.id, reason, async (activeMachine, woke) => {
      const value = await readLive(activeMachine.sandbox)
      return { value: structuredClone(value), fromCache: false, woke, epoch: activeMachine.epoch }
    })
  }

  const fetcherOf = opt => (typeof opt === 'function' ? opt : opt?.fetcher)

  async function withActiveJob(machineId, reason, fn) {
    const { machine, woke, jobId } = await beginActiveJob(machineId, reason)
    const tenantId = machine.sandbox?.labels?.tenant_id ?? machine.labels?.tenant_id ?? 'default'
    let renewTimer = null
    if (store?.renewJob && jobLeaseMs > 0) {
      const intervalMs = Math.max(50, Math.floor(jobLeaseMs / 2))
      renewTimer = setInterval(() => {
        void store.renewJob(machine.id, tenantId, jobId, now(), jobLeaseMs).catch(() => {})
      }, intervalMs)
      renewTimer.unref?.()
    }
    try {
      return await fn(machine, woke)
    } finally {
      if (renewTimer) clearInterval(renewTimer)
      machine.activeJobs -= 1
      machine.lastActivityAt = now()
      if (store?.endJob) {
        await store.endJob(machine.id, tenantId, jobId, machine.lastActivityAt).catch(() => {})
      }
    }
  }

  async function withMutation(machineId, reason, fn) {
    return withActiveJob(machineId, reason, async (machine, woke) => {
      machine.activeMutations += 1
      machine.mutationSeq += 1
      try {
        const res = await fn(machine, woke)
        await persist(machine)
        return res
      } catch (err) {
        await persist(machine).catch(() => {})
        throw err
      } finally {
        machine.activeMutations -= 1
      }
    })
  }

  // A handle may carry a stale 'started' state past the refresh TTL: run the
  // sandbox op, and only when it reports a not-running sandbox wake and retry.
  const notRunning = err => /stop|archiv|delet|not.{0,12}(start|running)|not.{0,12}found|ECONN|fetch failed|socket hang ?up/i.test(String(err?.message ?? err))

  async function withWakeRetry(machineId, run) {
    try {
      return await run()
    } catch (err) {
      if (!notRunning(err)) throw err
      await ensureAwake(machineId, 'wake-retry')
      return run()
    }
  }

  return {
    client,
    machines,

    async createMachine({ name, size = 'small', resources, image, snapshot, idleMinutes = defaultIdleMinutes, keepAwake = false, labels = {}, envVars } = {}) {
      if (image && snapshot) throw new Error('Cannot specify both image and snapshot')
      if (!(size in SIZE_RESOURCES)) throw new Error(`unsupported machine size: ${size}`)
      if (!image && resources !== undefined) {
        throw new Error('Cannot specify custom resources without an image (use size or pass an image)')
      }
      if (!Number.isInteger(idleMinutes) || idleMinutes < 0) {
        throw new Error('idleMinutes must be a non-negative integer')
      }
      const targetResources = image ? { ...SIZE_RESOURCES[size], ...(resources ?? {}) } : undefined
      const selectedSnapshot = image ? undefined : (snapshot ?? SIZE_SNAPSHOTS[size])
      const sandbox = await client.create({
        name,
        language: 'typescript',
        ephemeral: false,
        networkBlockAll: false,
        autoStopInterval: keepAwake ? 0 : idleMinutes,
        autoDeleteInterval: -1,
        ...(image ? { image, resources: targetResources } : { snapshot: selectedSnapshot }),
        ...(envVars ? { envVars } : {}),
        labels: { app: 'ds-bot-machine', ...(name ? { machine: name } : {}), size, ...labels },
      }, { timeout: 300 })

      const record = {
        id: sandbox.id,
        name: name ?? sandbox.name ?? sandbox.id,
        size,
        state: sandbox.state ?? 'started',
        sandbox,
        labels: sandbox.labels ?? labels,
        idleMinutes,
        keepAwake: Boolean(keepAwake),
        activeJobs: 0,
        activeMutations: 0,
        mutationSeq: 0,
        lastActivityAt: now(),
        sandboxRefreshedAt: now(),
        epoch: 1,
        seq: 0,
        nextScheduledAt: null,
        pendingResize: null,
        sleepLock: null,
        sleepAborted: false,
        startLock: null,
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
      record.persisting = true
      record.createOrder = ++createOrder
      record.saveQueue = Promise.resolve()
      record.remoteBusyUntil = null
      machines.set(record.id, record)
      try {
        await persist(record)
      } catch (err) {
        machines.delete(record.id)
        await client.delete(sandbox).catch(() => {})
        throw err
      } finally {
        record.persisting = false
      }
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
          if (fetcher) {
            machine.cache.roster = structuredClone(await fetcher(sandbox))
          } else {
            const loaded = await loadBotState(sandbox)
            if (loaded?.roster !== null && loaded?.roster !== undefined) {
              machine.cache.roster = structuredClone(loaded.roster)
            }
          }
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
          const hadActiveMutation = machine.activeMutations > 0
          const startMutationSeq = machine.mutationSeq
          const startEpoch = machine.epoch
          const value = await fetcher(sandbox)
          if (!hadActiveMutation && machine.activeMutations === 0 && machine.mutationSeq === startMutationSeq && machine.epoch === startEpoch) {
            machine.cache.readings.set(key, { value: structuredClone(value), epoch: startEpoch })
          }
          return value
        },
      })
    },

    async sendMessage(machineId, { threadId, botId, text, handler } = {}) {
      return withMutation(machineId, 'send-message', async (machine, woke) => {
        machine.epoch += 1
        machine.seq += 1
        const message = { role: 'user', botId, text, seq: machine.seq, at: now() }
        const existing = machine.cache.threads.get(threadId) ?? { threadId, seq: 0, messages: [] }
        existing.messages.push(message)
        existing.seq = machine.seq
        machine.cache.threads.set(threadId, existing)

        const result = await withWakeRetry(machineId, () => typeof handler === 'function'
          ? handler(machine.sandbox, message)
          : machine.sandbox.process.executeCommand(String(text ?? ''), undefined, undefined, 120))
        if (result?.reply !== undefined) {
          machine.seq += 1
          existing.messages.push({ role: 'assistant', botId, text: result.reply, seq: machine.seq, at: now() })
          existing.seq = machine.seq
        }
        return { woke, seq: machine.seq, epoch: machine.epoch, result }
      })
    },

    async execCommand(machineId, script, { cwd, env, timeoutSecs = 120 } = {}) {
      return withMutation(machineId, 'exec-command', async (machine, woke) => {
        machine.epoch += 1
        const res = await withWakeRetry(machineId, () => machine.sandbox.process.executeCommand(script, cwd, env, timeoutSecs))
        return { woke, exitCode: res.exitCode, stdout: res.result, epoch: machine.epoch }
      })
    },

    async syncCliCredentials(machineId, { cli, files = {}, env = {} } = {}) {
      validateCli(cli)
      const entries = Object.entries(files)
      const cliDir = ALLOWED_CLI_DIRS[cli]
      for (const [rawPath] of entries) {
        if (typeof rawPath !== 'string' || rawPath.trim() === '' || rawPath.includes('\0') || rawPath.split(/[\\/]+/).includes('..') || (rawPath.startsWith('/') && !rawPath.includes(`/${cliDir}/`))) {
          resolveUnder(`/home/placeholder/${cliDir}`, rawPath)
        }
      }
      return withMutation(machineId, `sync-cli-${cli}`, async (machine, woke) => {
        const homeDir = await homeDirOf(machine.sandbox)
        const cliRoot = pathPosix.join(homeDir, ALLOWED_CLI_DIRS[cli])
        const targets = entries.map(([rawPath, content]) => [resolveUnder(cliRoot, rawPath), content])
        const envKeys = Object.keys(env)
        if (targets.length > 0 || envKeys.length > 0) machine.epoch += 1

        const uploaded = []
        for (const [target, content] of targets) {
          await ensureDirectory(machine.sandbox, target)
          const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
          await machine.sandbox.fs.uploadFile(buf, target)
          await runShellOrFail(machine.sandbox, `chmod 600 ${shellQuote(target)}`, `chmod ${target}`)
          uploaded.push(target)
        }
        if (envKeys.length > 0) await machine.sandbox.updateEnv(env)
        machine.clis[cli] = { signedIn: true, method: 'synced', files: uploaded, updatedAt: now() }
        return { woke, cli, files: uploaded, epoch: machine.epoch }
      })
    },

    async startCliSignIn(machineId, { cli, callbackPort = 1455 } = {}) {
      const spec = SIGNIN_COMMANDS[cli]
      if (!spec) throw new Error(`interactive sign-in is not defined for ${cli}`)
      return withActiveJob(machineId, `cli-signin-${cli}`, async (machine, woke) => {
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
      })
    },

    async completeCliSignIn(machineId, cli) {
      const spec = SIGNIN_COMMANDS[cli]
      if (!spec) throw new Error(`interactive sign-in is not defined for ${cli}`)
      return withActiveJob(machineId, `cli-verify-${cli}`, async (machine, woke) => {
        const res = await runShellOrFail(machine.sandbox, spec.status, `${cli} sign-in status`, { timeout: 30 })
        machine.clis[cli] = { signedIn: true, method: 'oauth', verifiedAt: now() }
        return { cli, woke, signedIn: true, output: String(res.result ?? '').trim() }
      })
    },

    async syncProjectEnv(machineId, { projectId, repoUrl, workDir, envFiles = {} } = {}) {
      if (typeof projectId !== 'string' || projectId.trim() === '') throw new Error('projectId is required')
      if (typeof workDir !== 'string' || workDir.trim() === '' || workDir.includes('\0')) {
        throw new Error('workDir must be a non-empty string')
      }
      if (workDir.split(/[\\/]+/).includes('..')) throw new Error(`path traversal is not allowed: ${workDir}`)
      const envEntries = Object.entries(envFiles)
      for (const [relPath] of envEntries) {
        if (!pathPosix.basename(relPath).startsWith('.env')) {
          throw new Error(`only .env* files may be synced via syncProjectEnv: ${relPath}`)
        }
      }

      return withMutation(machineId, 'sync-project-env', async (machine, woke) => {
        const homeDir = await homeDirOf(machine.sandbox)
        const targetDir = workDir.startsWith('/') ? pathPosix.resolve(workDir) : resolveUnder(homeDir, workDir)
        const targets = envEntries.map(([relPath, content]) => [relPath, resolveUnder(targetDir, relPath), content])
        machine.epoch += 1

        if (repoUrl) {
          const quotedDir = shellQuote(targetDir)
          const quotedUrl = shellQuote(repoUrl)
          const cmd = `if [ -d ${quotedDir}/.git ]; then git -C ${quotedDir} fetch --all --prune; else mkdir -p ${shellQuote(pathPosix.dirname(targetDir))} && git clone ${quotedUrl} ${quotedDir}; fi`
          await runShellOrFail(machine.sandbox, cmd, `sync repo ${projectId}`, { timeout: 120 })
        } else {
          await runShellOrFail(machine.sandbox, `mkdir -p ${shellQuote(targetDir)}`, `mkdir ${targetDir}`, { timeout: 30 })
        }

        const written = []
        for (const [relPath, envPath, content] of targets) {
          await ensureDirectory(machine.sandbox, envPath)
          await machine.sandbox.fs.uploadFile(Buffer.from(String(content), 'utf8'), envPath)
          await runShellOrFail(machine.sandbox, `chmod 600 ${shellQuote(envPath)}`, `chmod ${envPath}`)
          written.push(relPath)
        }

        const record = { projectId, repoUrl: repoUrl ?? null, workDir: targetDir, envFileNames: written, syncedAt: now() }
        const existing = machine.cache.projects.findIndex(p => p.projectId === projectId)
        if (existing === -1) machine.cache.projects.push(record)
        else machine.cache.projects[existing] = record
        return { woke, ...record, epoch: machine.epoch }
      })
    },

    async setIdlePolicy(machineId, { idleMinutes, keepAwake, nextScheduledAt } = {}) {
      const machine = requireMachine(machineId)
      await syncFromStore(machine)
      await resolveSandbox(machine)
      if (idleMinutes !== undefined && (!Number.isInteger(idleMinutes) || idleMinutes < 0)) {
        throw new Error('idleMinutes must be a non-negative integer')
      }
      const prevEffective = machine.keepAwake ? 0 : machine.idleMinutes
      const nextIdle = idleMinutes !== undefined ? idleMinutes : machine.idleMinutes
      const nextPin = keepAwake !== undefined ? Boolean(keepAwake) : machine.keepAwake
      const nextEffective = nextPin ? 0 : nextIdle
      if (nextEffective !== prevEffective) {
        await machine.sandbox.setAutostopInterval?.(nextEffective)
      }
      machine.idleMinutes = nextIdle
      machine.keepAwake = nextPin
      if (nextScheduledAt !== undefined) machine.nextScheduledAt = nextScheduledAt
      await persist(machine)
      return { idleMinutes: machine.idleMinutes, keepAwake: machine.keepAwake, nextScheduledAt: machine.nextScheduledAt }
    },

    async resizeMachine(machineId, resources = {}) {
      const machine = requireMachine(machineId)
      await syncFromStore(machine)
      await resolveSandbox(machine)
      const { size, ...hw } = resources
      if (machine.activeJobs > 0 || machine.sleepLock || (hw.disk !== undefined && currentState(machine) === 'started')) {
        machine.pendingResize = { ...resources }
        await persist(machine)
        return { applied: false, pending: true }
      }
      if (Object.keys(hw).length > 0) await machine.sandbox.resize(hw)
      if (size) machine.size = size
      if (machine.pendingResize) {
        for (const key of Object.keys(resources)) {
          if (resources[key] !== undefined) delete machine.pendingResize[key]
        }
        if (Object.keys(machine.pendingResize).length === 0) machine.pendingResize = null
      }
      await persist(machine)
      return { applied: true, pending: false }
    },

    async sleep(machineId, { saveSnapshot = false, snapshotName } = {}) {
      const machine = requireMachine(machineId)
      if ((await syncFromStore(machine)) === null) return { slept: false, reason: 'deleted' }
      if (machine.sleepLock) return machine.sleepLock
      const remoteBusy = (machine.remoteBusyUntil ?? 0) > now()
      if (machine.activeJobs > 0 || remoteBusy || machine.startLock) {
        return { slept: false, reason: 'busy', activeJobs: machine.activeJobs + (remoteBusy ? 1 : 0) }
      }
      await refreshSandbox(machine, { force: true })
      const state = currentState(machine)
      if (state === 'stopped' || state === 'archived') {
        machine.state = state
        await persist(machine).catch(() => {})
        return {
          slept: true,
          alreadyStopped: true,
          capturedSeq: machine.cache.capturedSeq,
          capturedEpoch: machine.cache.capturedEpoch,
        }
      }
      if (state === 'stopping') {
        machine.state = state
        return { slept: false, reason: 'stopping' }
      }
      machine.sleepAborted = false
      const aborted = () => ({ slept: false, reason: 'aborted' })
      const tenantId = machine.sandbox?.labels?.tenant_id ?? machine.labels?.tenant_id ?? 'default'
      const sleepToken = randomUUID()
      let sleepPromise
      sleepPromise = (async () => {
        try {
          if (store?.beginSleep) {
            const started = await store.beginSleep(machineId, tenantId, sleepToken, now())
            if (!started.ok) return { slept: false, reason: started.reason }
          }
          await captureState(machineId, { skipPersist: true })
          if (machine.sleepAborted || machine.activeJobs > 0) {
            machine.cache.fresh = false
            return aborted()
          }
          const resolvedSnap = saveSnapshot ? (snapshotName ?? `ds-bot-${machine.name}-${machine.id}`) : undefined
          if (resolvedSnap) {
            await machine.sandbox.createSnapshot?.(resolvedSnap)
            if (machine.sleepAborted || machine.activeJobs > 0) {
              machine.cache.fresh = false
              return aborted()
            }
          }
          if (store?.commitSleep) {
            const committed = await store.commitSleep(machineId, tenantId, sleepToken, now())
            if (!committed.ok) {
              machine.cache.fresh = false
              return { slept: false, reason: committed.reason }
            }
          }
          await safeStop(machine.sandbox)
          machine.state = 'stopped'
          machine.cache.fresh = true
          machine.cache.stoppedAt = now()
          await persist(machine)
          return {
            slept: true,
            capturedSeq: machine.cache.capturedSeq,
            capturedEpoch: machine.cache.capturedEpoch,
            ...(resolvedSnap ? { snapshotName: resolvedSnap } : {}),
          }
        } finally {
          if (store?.endSleep) await store.endSleep(machineId, tenantId, sleepToken).catch(() => {})
          if (machine.sleepLock === sleepPromise) {
            machine.sleepLock = null
            machine.sleepAborted = false
          }
        }
      })()
      machine.sleepLock = sleepPromise
      return sleepPromise
    },

    async checkIdleAndSchedule(machineId) {
      const machine = requireMachine(machineId)
      if ((await syncFromStore(machine)) === null) return { action: 'none', reason: 'deleted' }
      await refreshSandbox(machine)
      const state = currentState(machine)
      if (state === 'stopped' || state === 'archived') {
        machine.state = state
        if (machine.nextScheduledAt !== null && machine.nextScheduledAt - now() <= preWakeLeadMs) {
          await ensureAwake(machineId, 'scheduled-work')
          return { action: 'pre-woke', reason: 'scheduled-work' }
        }
        return { action: 'none', state }
      }
      if (state === 'stopping') {
        machine.state = state
        return { action: 'none', state: 'stopping' }
      }
      if (machine.keepAwake) {
        await resolveSandbox(machine)
        await machine.sandbox.refreshActivity?.()
        return { action: 'none', reason: 'keep-awake' }
      }
      if (machine.activeJobs > 0 || (machine.remoteBusyUntil ?? 0) > now()) return { action: 'none', reason: 'active-jobs' }
      if (machine.nextScheduledAt !== null && machine.nextScheduledAt - now() <= scheduleHorizonMs) {
        return { action: 'none', reason: 'schedule-due-soon' }
      }
      if (machine.idleMinutes <= 0) return { action: 'none', reason: 'autostop-disabled' }
      if (now() - machine.lastActivityAt < machine.idleMinutes * 60_000) {
        return { action: 'none', reason: 'not-idle-yet' }
      }
      const res = await this.sleep(machineId)
      if (!res.slept) return { action: 'none', reason: res.reason }
      return { action: 'slept', capturedSeq: res.capturedSeq, capturedEpoch: res.capturedEpoch }
    },

    async deleteMachine(machineId) {
      const machine = requireMachine(machineId)
      const tenantId = machine.sandbox?.labels?.tenant_id ?? machine.labels?.tenant_id ?? 'default'
      try {
        await resolveSandbox(machine)
        await client.delete(machine.sandbox)
        machine.sandbox = null
      } catch (err) {
        const isNotFound = err?.status === 404 || err?.statusCode === 404 || /not found|404|does not exist/i.test(String(err?.message ?? ''))
        if (!isNotFound) throw err
        machine.sandbox = null
      }
      if (store) await store.remove(machineId, tenantId)
      machines.delete(machineId)
    },

    async rehydrate() {
      if (!store) return []
      if (rehydrateInFlight) return rehydrateInFlight
      rehydrateInFlight = (async () => {
        try {
          const startOrder = createOrder
          const rows = await store.loadAll()
          const seenIds = new Set(rows.map(r => r.id))
          for (const [id, existing] of machines.entries()) {
            if (!seenIds.has(id) && !existing.persisting && existing.activeJobs === 0 && (existing.createOrder ?? 0) <= startOrder) {
              machines.delete(id)
            }
          }
          const loaded = []
          for (const row of rows) {
            const existing = machines.get(row.id)
            if (existing) {
              if (!existing.sandbox) {
                try {
                  const fetched = await client.get(row.id)
                  const cur = machines.get(row.id)
                  if (cur && !cur.sandbox) {
                    cur.sandbox = fetched
                    cur.state = fetched?.state ?? cur.state
                    cur.sandboxRefreshedAt = now()
                  }
                } catch {
                  // Keep sandbox null so the next operation retries client.get().
                }
              }
              continue
            }
            let sandbox = null
            try {
              sandbox = await client.get(row.id)
            } catch {
              sandbox = null
            }
            const concurrent = machines.get(row.id)
            if (concurrent) {
              if (!concurrent.sandbox && sandbox) {
                concurrent.sandbox = sandbox
                concurrent.state = sandbox.state ?? concurrent.state
                concurrent.sandboxRefreshedAt = now()
              }
              continue
            }
            const record = {
              id: row.id,
              name: row.name,
              size: row.size ?? 'small',
              state: sandbox?.state ?? row.state ?? 'stopped',
              sandbox,
              labels: row.labels ?? {},
              idleMinutes: row.idleMinutes ?? defaultIdleMinutes,
              keepAwake: Boolean(row.keepAwake),
              activeJobs: 0,
              remoteBusyUntil: row.busyUntil ?? null,
              saveQueue: Promise.resolve(),
              activeMutations: 0,
              mutationSeq: 0,
              lastActivityAt: row.lastActivityAt ?? now(),
              epoch: row.epoch ?? 1,
              seq: row.seq ?? 0,
              version: row.version ?? 1,
              nextScheduledAt: row.nextScheduledAt ?? null,
              pendingResize: row.pendingResize ?? null,
              sleepLock: null,
              sleepAborted: false,
              startLock: null,
              sandboxRefreshedAt: sandbox ? now() : null,
              cache: {
                fresh: Boolean(row.cache?.fresh),
                capturedSeq: row.cache?.capturedSeq ?? 0,
                capturedEpoch: row.cache?.capturedEpoch ?? 0,
                stoppedAt: row.cache?.stoppedAt ?? null,
                roster: row.cache?.roster ?? null,
                threads: new Map(Object.entries(row.cache?.threads ?? {})),
                readings: new Map(Object.entries(row.cache?.readings ?? {})),
                projects: Array.isArray(row.cache?.projects) ? row.cache.projects : [],
              },
              clis: {
                codex: { signedIn: false },
                claude: { signedIn: false },
                agy: { signedIn: false },
                liftgate: { signedIn: false },
              },
            }
            machines.set(record.id, record)
            loaded.push(record)
          }
          return loaded
        } finally {
          rehydrateInFlight = null
        }
      })()
      return rehydrateInFlight
    },
  }
}
