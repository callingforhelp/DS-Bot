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
  assert.equal(machine.sandbox.startCount, 1)

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
  assert.equal(machine.sandbox.startCount, 1)

  // Requesting an uncaptured thread wakes the machine and resyncs live.
  const t2 = await mgr.readThread(machine.id, 't2', async () => ({
    threadId: 't2', seq: 4, messages: [{ role: 'user', text: 'uncaptured thread' }],
  }))
  assert.equal(t2.fromCache, false)
  assert.equal(t2.woke, true)
  assert.equal(t2.value.messages[0].text, 'uncaptured thread')
  assert.equal(machine.sandbox.state, 'started')
  assert.equal(machine.sandbox.startCount, 2)

  // External / unclean stop (without clean drain): cache.fresh is false, so reads wake to resync.
  await machine.sandbox.stop()
  assert.equal(machine.sandbox.state, 'stopped')
  const rosterAfterUnclean = await mgr.readRoster(machine.id)
  assert.equal(rosterAfterUnclean.fromCache, false)
  assert.equal(rosterAfterUnclean.woke, true)
  assert.equal(machine.sandbox.startCount, 3)

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
  assert.equal(machine.sandbox.startCount, 4)
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
