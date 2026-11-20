import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDaytonaMachineManager, mockDaytonaClient } from '../src/daytona-machine.mjs'

function makeClock(initial = 1_795_000_000_000) {
  let current = initial
  return {
    now: () => current,
    advance(ms) { current += ms; return current },
  }
}

test('Idea 1: read-while-asleep serves fresh captured state and wakes on writes, uncaptured threads, unclean stops, or stale epochs', async () => {
  const clock = makeClock()
  const client = mockDaytonaClient({ now: clock.now })
  const mgr = createDaytonaMachineManager({ client, now: clock.now })

  const machine = await mgr.createMachine({ name: 'mac-offload', idleMinutes: 15 })
  assert.equal(machine.sandbox.ephemeral, false)
  assert.equal(machine.sandbox.networkBlockAll, false)
  assert.equal(machine.sandbox.autoStopInterval, 15)
  assert.equal(machine.sandbox.autoDeleteInterval, -1)
  const initialStarts = machine.sandbox.startCount

  await mgr.captureState(machine.id, {
    roster: { planner: 'argon', coder: 'neon', reviewer: 'gpt-6.2-sol' },
    threads: {
      t1: { threadId: 't1', seq: 1, messages: [{ role: 'user', text: 'check README' }] },
    },
    projects: [{ projectId: 'ds-bot', workDir: '/home/daytona/ds-bot', envFileNames: ['.env'] }],
  })

  let diffReads = 0
  const r1 = await mgr.readFileOrDiff(machine.id, 'diff:HEAD', async () => {
    diffReads += 1
    return `diff-v${diffReads}`
  })
  assert.deepEqual(r1, { value: 'diff-v1', fromCache: false, woke: false, epoch: 1 })
  assert.equal(diffReads, 1)

  const slept = await mgr.sleep(machine.id, { saveSnapshot: true })
  assert.equal(slept.slept, true)
  assert.equal(machine.sandbox.state, 'stopped')
  assert.match(slept.snapshotName, /^ds-bot-mac-offload-/)
  assert.equal(client.snapshots.has(slept.snapshotName), true)

  // Reading roster, captured thread, projects, and same-epoch diff stays asleep.
  const roster = await mgr.readRoster(machine.id)
  assert.equal(roster.fromCache, true)
  assert.equal(roster.woke, false)
  assert.equal(roster.value.reviewer, 'gpt-6.2-sol')

  const projects = await mgr.readProjects(machine.id)
  assert.equal(projects.fromCache, true)
  assert.equal(projects.woke, false)
  assert.equal(projects.value[0].projectId, 'ds-bot')

  const t1 = await mgr.readThread(machine.id, 't1')
  assert.equal(t1.fromCache, true)
  assert.equal(t1.woke, false)
  assert.equal(t1.value.messages[0].text, 'check README')

  const cachedDiff = await mgr.readFileOrDiff(machine.id, 'diff:HEAD', async () => {
    diffReads += 1
    return `diff-v${diffReads}`
  })
  assert.deepEqual(cachedDiff, { value: 'diff-v1', fromCache: true, woke: false, epoch: 1 })
  assert.equal(diffReads, 1)
  assert.equal(machine.sandbox.state, 'stopped')
  assert.equal(machine.sandbox.startCount, initialStarts)

  // Requesting an uncaptured thread wakes the machine and resyncs live.
  const t2 = await mgr.readThread(machine.id, 't2', async () => ({
    threadId: 't2', seq: 4, messages: [{ role: 'user', text: 'uncaptured thread' }],
  }))
  assert.equal(t2.fromCache, false)
  assert.equal(t2.woke, true)
  assert.equal(t2.value.messages[0].text, 'uncaptured thread')
  assert.equal(machine.sandbox.state, 'started')
  assert.equal(machine.sandbox.startCount, initialStarts + 1)

  // External / unclean stop (without clean drain): cache.fresh is false, so reads wake to resync.
  await machine.sandbox.stop()
  assert.equal(machine.sandbox.state, 'stopped')
  const rosterAfterUnclean = await mgr.readRoster(machine.id)
  assert.equal(rosterAfterUnclean.fromCache, false)
  assert.equal(rosterAfterUnclean.woke, true)
  assert.equal(machine.sandbox.startCount, initialStarts + 2)

  // Writing advances the epoch, invalidating prior file/diff reads even after a clean sleep.
  const sent = await mgr.sendMessage(machine.id, {
    threadId: 't1',
    botId: 'coder',
    text: 'edit input.txt',
    handler: async () => ({ reply: 'edited input.txt' }),
  })
  assert.equal(sent.epoch, 2)
  await mgr.sleep(machine.id)
  assert.equal(machine.sandbox.state, 'stopped')

  const staleDiff = await mgr.readFileOrDiff(machine.id, 'diff:HEAD', async () => {
    diffReads += 1
    return `diff-v${diffReads}`
  })
  assert.deepEqual(staleDiff, { value: 'diff-v2', fromCache: false, woke: true, epoch: 2 })
  assert.equal(diffReads, 2)
  assert.equal(machine.sandbox.startCount, initialStarts + 3)
})

test('Idea 2: persistent CLI credentials, OAuth preview sign-in, and project .env sync survive sleep/wake', async () => {
  const clock = makeClock()
  const client = mockDaytonaClient({ now: clock.now })
  const mgr = createDaytonaMachineManager({ client, now: clock.now })

  const machine = await mgr.createMachine({ name: 'cli-persist' })

  // Path traversal and out-of-scope CLI paths are rejected before touching the sandbox.
  await assert.rejects(
    mgr.syncCliCredentials(machine.id, { cli: 'codex', files: { '../.ssh/id_rsa': 'bad' } }),
    /path traversal/,
  )
  await assert.rejects(
    mgr.syncCliCredentials(machine.id, { cli: 'codex', files: { '/etc/passwd': 'bad' } }),
    /escapes/,
  )

  await mgr.syncCliCredentials(machine.id, {
    cli: 'codex',
    files: {
      'config.toml': 'model = "gpt-6.2-sol"\nmodel_reasoning_effort = "xhigh"\n',
      'auth.json': '{"tokens":{"access_token":"tok"}}\n',
    },
    env: { CODEX_HOME: '/home/daytona/.codex' },
  })
  await mgr.syncCliCredentials(machine.id, {
    cli: 'claude',
    files: { 'settings.json': '{"model":"gemini-4-carbon-high"}\n' },
  })
  await mgr.syncCliCredentials(machine.id, {
    cli: 'agy',
    files: { 'oauth_creds.json': '{"refresh_token":"agy-ok"}\n' },
  })

  // Preview-tunnel OAuth sign-in flow marks CLI signed in after verification.
  const signIn = await mgr.startCliSignIn(machine.id, { cli: 'codex', callbackPort: 1455 })
  assert.match(signIn.previewUrl, /^https:\/\/1455-sbx-/)
  assert.equal(signIn.userCode, 'MOCK-1234')
  const verified = await signIn.completeSignIn()
  assert.equal(verified.signedIn, true)
  assert.equal(machine.clis.codex.signedIn, true)

  // Project sync with .env files rejects non-.env files and traversal.
  await assert.rejects(
    mgr.syncProjectEnv(machine.id, { projectId: 'bad', workDir: 'proj', envFiles: { 'src/index.js': 'hack' } }),
    /only \.env\* files/,
  )
  const synced = await mgr.syncProjectEnv(machine.id, {
    projectId: 'ds-bot',
    repoUrl: 'https://github.com/callingforhelp/DS-Bot.git',
    workDir: 'repos/ds-bot',
    envFiles: { '.env': 'OPENAI_API_KEY=sk-test\n', 'cloud/.env.local': 'DAYTONA_API_KEY=dtn\n' },
  })
  assert.equal(synced.workDir, '/home/daytona/repos/ds-bot')
  assert.deepEqual(synced.envFileNames, ['.env', 'cloud/.env.local'])

  // Sleep then wake via sendMessage: credentials, env vars, and .env files remain on disk.
  await mgr.sleep(machine.id)
  assert.equal(machine.sandbox.state, 'stopped')
  const projectsWhileAsleep = await mgr.readProjects(machine.id)
  assert.equal(projectsWhileAsleep.fromCache, true)
  assert.equal(projectsWhileAsleep.value[0].envFileNames.length, 2)

  const runRes = await mgr.sendMessage(machine.id, {
    threadId: 'review-1',
    botId: 'reviewer',
    text: 'run review',
    handler: async sb => ({ reply: (await sb.fs.downloadFile('.codex/config.toml')).toString('utf8') }),
  })
  assert.equal(runRes.woke, true)
  assert.match(runRes.result.reply, /gpt-6\.2-sol/)
  assert.equal(machine.sandbox.env.CODEX_HOME, '/home/daytona/.codex')
  assert.equal(
    (await machine.sandbox.fs.downloadFile('repos/ds-bot/.env')).toString('utf8'),
    'OPENAI_API_KEY=sk-test\n',
  )
  assert.equal(
    (await machine.sandbox.fs.downloadFile('.gemini/oauth_creds.json')).toString('utf8'),
    '{"refresh_token":"agy-ok"}\n',
  )
})

test('Idea 3: idle watchdog refuses busy/pinned/due-soon machines, drains on idle, and pre-wakes before scheduled tasks', async () => {
  const clock = makeClock(1_000_000)
  const client = mockDaytonaClient({ now: clock.now })
  const mgr = createDaytonaMachineManager({
    client,
    now: clock.now,
    defaultIdleMinutes: 5,
    scheduleHorizonMs: 5 * 60_000,
    preWakeLeadMs: 2 * 60_000,
  })

  const machine = await mgr.createMachine({ name: 'watchdog-box', idleMinutes: 5 })
  assert.equal((await mgr.checkIdleAndSchedule(machine.id)).reason, 'not-idle-yet')

  // Deferred disk resize while running is applied automatically on next wake while stopped.
  const resizePending = await mgr.resizeMachine(machine.id, { size: 'medium', cpu: 4, memory: 8, disk: 40 })
  assert.deepEqual(resizePending, { applied: false, pending: true })

  // keepAwake blocks idle sleep even well past idleMinutes.
  clock.advance(6 * 60_000)
  await mgr.setIdlePolicy(machine.id, { keepAwake: true })
  assert.equal((await mgr.checkIdleAndSchedule(machine.id)).reason, 'keep-awake')

  // Active jobs block sleep.
  await mgr.setIdlePolicy(machine.id, { keepAwake: false })
  machine.activeJobs = 1
  assert.equal((await mgr.sleep(machine.id)).reason, 'busy')
  assert.equal((await mgr.checkIdleAndSchedule(machine.id)).reason, 'active-jobs')
  machine.activeJobs = 0

  // Upcoming scheduled task within 5-minute horizon blocks sleep.
  await mgr.setIdlePolicy(machine.id, { nextScheduledAt: clock.now() + 4 * 60_000 })
  assert.equal((await mgr.checkIdleAndSchedule(machine.id)).reason, 'schedule-due-soon')

  // Scheduled task far out (10 min away) lets the idle machine drain & sleep cleanly.
  await mgr.setIdlePolicy(machine.id, { nextScheduledAt: clock.now() + 10 * 60_000 })
  const slept = await mgr.checkIdleAndSchedule(machine.id)
  assert.equal(slept.action, 'slept')
  assert.equal(machine.sandbox.state, 'stopped')
  assert.equal(machine.cache.fresh, true)

  // Still 3 minutes before due time: remains stopped.
  clock.advance(7 * 60_000)
  assert.deepEqual(await mgr.checkIdleAndSchedule(machine.id), { action: 'none', state: 'stopped' })

  // Enters 2-minute pre-wake lead window: pre-wakes and applies queued disk/cpu/memory resize.
  clock.advance(90_000)
  const preWoke = await mgr.checkIdleAndSchedule(machine.id)
  assert.deepEqual(preWoke, { action: 'pre-woke', reason: 'scheduled-work' })
  assert.equal(machine.sandbox.state, 'started')
  assert.equal(machine.sandbox.cpu, 4)
  assert.equal(machine.sandbox.memory, 8)
  assert.equal(machine.sandbox.disk, 40)
  assert.equal(machine.size, 'medium')

  await mgr.deleteMachine(machine.id)
  assert.equal(client.sandboxes.size, 0)
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('Review P1: incoming writes abort sleep during captureState and serialize cleanly around in-flight stop()', async () => {
  const clock = makeClock()
  const client = mockDaytonaClient({ now: clock.now })
  const mgr = createDaytonaMachineManager({ client, now: clock.now })
  const machine = await mgr.createMachine({ name: 'race-box' })

  // 1) Write arrives while captureState() awaits downloadFile.
  const origDownload = machine.sandbox.fs.downloadFile
  const dlGate = deferred()
  let captureStarted = false
  machine.sandbox.fs.downloadFile = async (p) => {
    captureStarted = true
    await dlGate.promise
    return origDownload(p)
  }

  const sleepPromise = mgr.sleep(machine.id)
  while (!captureStarted) await Promise.resolve()
  const writeDuringCapture = mgr.sendMessage(machine.id, {
    threadId: 't-race',
    botId: 'coder',
    text: 'keep running',
    handler: async () => ({ reply: 'wrote during capture' }),
  })
  dlGate.resolve()

  const [sleepRes, writeRes] = await Promise.all([sleepPromise, writeDuringCapture])
  assert.deepEqual(sleepRes, { slept: false, reason: 'aborted' })
  assert.equal(machine.sandbox.state, 'started')
  assert.equal(machine.cache.fresh, false)
  assert.equal(machine.activeJobs, 0)
  assert.equal(writeRes.woke, false)
  assert.equal(writeRes.result.reply, 'wrote during capture')

  // 2) Write arrives while sandbox.stop() is already in flight: waits for stop, then wakes cleanly.
  machine.sandbox.fs.downloadFile = origDownload
  const origStop = machine.sandbox.stop
  const stopGate = deferred()
  let stopStarted = false
  machine.sandbox.stop = async (...args) => {
    stopStarted = true
    await stopGate.promise
    return origStop.apply(machine.sandbox, args)
  }

  const sleepPromise2 = mgr.sleep(machine.id)
  while (!stopStarted) await Promise.resolve()
  const writeDuringStop = mgr.sendMessage(machine.id, {
    threadId: 't-race',
    botId: 'coder',
    text: 'wake after stop',
    handler: async () => ({ reply: 'ran after wake' }),
  })
  stopGate.resolve()

  const [sleepRes2, writeRes2] = await Promise.all([sleepPromise2, writeDuringStop])
  assert.equal(sleepRes2.slept, true)
  assert.equal(writeRes2.woke, true)
  assert.equal(machine.sandbox.state, 'started')
  assert.equal(machine.activeJobs, 0)
  assert.equal(writeRes2.result.reply, 'ran after wake')
})

test('Review P2: keepAwake disables provider autoStopInterval, refreshes activity, and restores idleMinutes on unpin', async () => {
  const clock = makeClock()
  const client = mockDaytonaClient({ now: clock.now })
  const mgr = createDaytonaMachineManager({ client, now: clock.now, defaultIdleMinutes: 15 })

  const pinned = await mgr.createMachine({ name: 'pinned-start', idleMinutes: 15, keepAwake: true })
  assert.equal(pinned.sandbox.autoStopInterval, 0)

  const machine = await mgr.createMachine({ name: 'pin-toggle', idleMinutes: 15 })
  assert.equal(machine.sandbox.autoStopInterval, 15)

  await mgr.setIdlePolicy(machine.id, { keepAwake: true })
  assert.equal(machine.sandbox.autoStopInterval, 0)

  clock.advance(20 * 60_000)
  const checkPinned = await mgr.checkIdleAndSchedule(machine.id)
  assert.deepEqual(checkPinned, { action: 'none', reason: 'keep-awake' })
  assert.equal(machine.sandbox.refreshCount, 1)

  await mgr.setIdlePolicy(machine.id, { keepAwake: false })
  assert.equal(machine.sandbox.autoStopInterval, 15)
})

test('Review P2: requested size selects sized snapshots or sets image resources', async () => {
  const client = mockDaytonaClient()
  const mgr = createDaytonaMachineManager({ client })

  // Snapshot-based creation selects built-in sized snapshots and omits resources.
  const med = await mgr.createMachine({ name: 'box-med', size: 'medium' })
  assert.equal(med.sandbox.createParams.snapshot, 'daytona-medium')
  assert.equal(med.sandbox.createParams.resources, undefined)
  assert.equal(med.sandbox.state, 'started')
  assert.equal(med.sandbox.stopCount, 0)
  assert.equal(med.sandbox.startCount, 1)
  assert.equal(med.sandbox.cpu, 2)
  assert.equal(med.sandbox.memory, 4)
  assert.equal(med.sandbox.disk, 8)

  const lg = await mgr.createMachine({ name: 'box-lg', size: 'large' })
  assert.equal(lg.sandbox.createParams.snapshot, 'daytona-large')
  assert.equal(lg.sandbox.createParams.resources, undefined)
  assert.equal(lg.sandbox.cpu, 4)
  assert.equal(lg.sandbox.memory, 8)
  assert.equal(lg.sandbox.disk, 10)

  // Image-based creation passes resources directly at create() without snapshot.
  const custom = await mgr.createMachine({ name: 'box-img', image: 'node:22', size: 'large', resources: { disk: 25 } })
  assert.equal(custom.sandbox.createParams.image, 'node:22')
  assert.equal(custom.sandbox.createParams.snapshot, undefined)
  assert.deepEqual(custom.sandbox.createParams.resources, { cpu: 4, memory: 8, disk: 25 })
  assert.equal(custom.sandbox.stopCount, 0)
  assert.equal(custom.sandbox.startCount, 1)
  assert.equal(custom.sandbox.cpu, 4)
  assert.equal(custom.sandbox.memory, 8)
  assert.equal(custom.sandbox.disk, 25)

  await assert.rejects(mgr.createMachine({ name: 'bad', size: 'xl' }), /unsupported machine size/)
  await assert.rejects(mgr.createMachine({ name: 'both', image: 'node:22', snapshot: 'snap' }), /both image and snapshot/)
  await assert.rejects(mgr.createMachine({ name: 'no-img-res', resources: { cpu: 2 } }), /without an image/)
})

test('Review P2: automatic roster capture reads /data/bot/state.json for both live and asleep reads', async () => {
  const clock = makeClock()
  const client = mockDaytonaClient({ now: clock.now })
  const mgr = createDaytonaMachineManager({ client, now: clock.now })
  const machine = await mgr.createMachine({ name: 'state-path-box' })

  const botState = {
    version: 1,
    bots: {
      p1: { id: 'p1', name: 'Planner', model: 'liftgate/gemini-pro-orchestrator-g1-pro' },
      r1: { id: 'r1', name: 'Reviewer', model: 'local-codex-cli/gpt-6.2-sol' },
    },
  }
  await machine.sandbox.fs.uploadFile(Buffer.from(JSON.stringify(botState)), '/data/bot/state.json')

  const liveRoster = await mgr.readRoster(machine.id)
  assert.equal(liveRoster.fromCache, false)
  assert.equal(liveRoster.value.r1.model, 'local-codex-cli/gpt-6.2-sol')

  // Clear local cache and sleep without passing manual captureState args: auto-capture reads /data/bot/state.json.
  machine.cache.roster = null
  await mgr.sleep(machine.id)
  assert.equal(machine.sandbox.state, 'stopped')

  const asleepRoster = await mgr.readRoster(machine.id)
  assert.equal(asleepRoster.fromCache, true)
  assert.equal(asleepRoster.woke, false)
  assert.equal(asleepRoster.value.p1.name, 'Planner')

  // Fallback to ~/.ds-bot/bot/state.json when /data/bot/state.json is absent and botStatePath was omitted.
  const fallbackMachine = await mgr.createMachine({ name: 'home-state-box' })
  await fallbackMachine.sandbox.fs.uploadFile(
    Buffer.from(JSON.stringify({ version: 1, bots: { h1: { id: 'h1', name: 'HomeBot' } } })),
    '/home/daytona/.ds-bot/bot/state.json',
  )
  await mgr.sleep(fallbackMachine.id)
  const fallbackRoster = await mgr.readRoster(fallbackMachine.id)
  assert.equal(fallbackRoster.fromCache, true)
  assert.equal(fallbackRoster.woke, false)
  assert.equal(fallbackRoster.value.h1.name, 'HomeBot')

  // Explicit botStatePath does not fall back to ~/.ds-bot/bot/state.json.
  const customMgr = createDaytonaMachineManager({
    client,
    now: clock.now,
    botStatePath: '/custom/missing/state.json',
  })
  const customMachine = await customMgr.createMachine({ name: 'custom-state-box' })
  await customMachine.sandbox.fs.uploadFile(
    Buffer.from(JSON.stringify({ version: 1, bots: { h2: { id: 'h2', name: 'Ignored' } } })),
    '/home/daytona/.ds-bot/bot/state.json',
  )
  const customRoster = await customMgr.readRoster(customMachine.id)
  assert.equal(customRoster.value, null)
})

test('Review P2: syncCliCredentials advances epoch before mutating disk, including on partial failure', async () => {
  const clock = makeClock()
  const client = mockDaytonaClient({ now: clock.now })
  const mgr = createDaytonaMachineManager({ client, now: clock.now })
  const machine = await mgr.createMachine({ name: 'cli-epoch-box' })

  await mgr.syncCliCredentials(machine.id, {
    cli: 'codex',
    files: { 'config.toml': 'model = "gpt-6.1-sol"\n' },
  })

  let reads = 0
  const initialRead = await mgr.readFileOrDiff(machine.id, 'codex-config', async (sb) => {
    reads += 1
    return (await sb.fs.downloadFile('.codex/config.toml')).toString('utf8')
  })
  assert.match(initialRead.value, /gpt-6\.1-sol/)
  assert.equal(reads, 1)

  // Successful update must invalidate prior cached reading even after a clean sleep.
  await mgr.syncCliCredentials(machine.id, {
    cli: 'codex',
    files: { 'config.toml': 'model = "gpt-6.2-sol"\n' },
  })
  await mgr.sleep(machine.id)
  const freshAfterSync = await mgr.readFileOrDiff(machine.id, 'codex-config', async (sb) => {
    reads += 1
    return (await sb.fs.downloadFile('.codex/config.toml')).toString('utf8')
  })
  assert.equal(freshAfterSync.fromCache, false)
  assert.equal(freshAfterSync.woke, true)
  assert.match(freshAfterSync.value, /gpt-6\.2-sol/)
  assert.equal(reads, 2)

  // Partial failure (2nd file fails after 1st file was written) still invalidates stale cache across sleep.
  const origUpload = machine.sandbox.fs.uploadFile
  let uploadCount = 0
  machine.sandbox.fs.uploadFile = async (...args) => {
    uploadCount += 1
    if (uploadCount === 2) throw new Error('simulated second upload failure')
    return origUpload(...args)
  }
  await assert.rejects(
    mgr.syncCliCredentials(machine.id, {
      cli: 'codex',
      files: { 'config.toml': 'model = "gpt-6.3-sol"\n', 'auth.json': '{}' },
    }),
    /simulated second upload failure/,
  )
  machine.sandbox.fs.uploadFile = origUpload
  await mgr.sleep(machine.id)

  const freshAfterPartial = await mgr.readFileOrDiff(machine.id, 'codex-config', async (sb) => {
    reads += 1
    return (await sb.fs.downloadFile('.codex/config.toml')).toString('utf8')
  })
  assert.equal(freshAfterPartial.fromCache, false)
  assert.equal(freshAfterPartial.woke, true)
  assert.match(freshAfterPartial.value, /gpt-6\.3-sol/)
  assert.equal(reads, 3)
})
