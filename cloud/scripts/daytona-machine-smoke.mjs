// Live Daytona persistent auto-sleep/wake smoke test using DAYTONA_API_KEY from cloud/.env:
//   1. Creates one persistent sandbox (ephemeral: false, networkBlockAll: false).
//   2. Syncs CLI credentials (.codex/config.toml) and a project .env file.
//   3. Captures state and sleeps the real sandbox.
//   4. Reads roster, thread, and projects while asleep (no wake).
//   5. Executes a command that wakes the sandbox and verifies persisted files survived sleep/wake.
//   6. Deletes the sandbox in finally and confirms deletion.
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createDaytonaMachineManager } from '../src/daytona-machine.mjs'
import { loadEnv } from '../src/remote.mjs'
import { ROOT } from './pg.mjs'

const env = loadEnv(join(ROOT, '.env'))
if (!env.DAYTONA_API_KEY) {
  console.error('DAYTONA_API_KEY missing from cloud/.env')
  process.exit(2)
}

const mgr = createDaytonaMachineManager({ apiKey: env.DAYTONA_API_KEY, defaultIdleMinutes: 15 })
const name = `ds-bot-machine-smoke-${randomBytes(3).toString('hex')}`
const marker = `smoke-${randomBytes(4).toString('hex')}`
const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`)
  if (!ok) process.exitCode = 1
}

let machine
let sandboxId
try {
  machine = await mgr.createMachine({ name, size: 'medium', idleMinutes: 15 })
  sandboxId = machine.id
  check(
    'persistent sandbox created with medium size snapshot resources',
    Boolean(sandboxId) && machine.sandbox.autoDeleteInterval !== 0 && machine.sandbox.autoStopInterval === 15 && machine.sandbox.networkBlockAll === false && machine.sandbox.cpu === 2 && machine.sandbox.memory === 4 && machine.sandbox.disk === 8,
    `${name} (${sandboxId}, cpu=${machine.sandbox.cpu}, mem=${machine.sandbox.memory}, disk=${machine.sandbox.disk}, autoDelete=${machine.sandbox.autoDeleteInterval})`,
  )

  await mgr.syncCliCredentials(sandboxId, {
    cli: 'codex',
    files: { 'config.toml': 'model = "gpt-6.2-sol"\n' },
  })
  check('CLI credentials synced', machine.clis.codex.signedIn === true)

  const synced = await mgr.syncProjectEnv(sandboxId, {
    projectId: 'smoke-proj',
    workDir: 'smoke-work',
    envFiles: { '.env': `SMOKE_MARKER=${marker}\n` },
  })
  check('project .env synced', synced.envFileNames.join(',') === '.env', synced.workDir)

  const homeDir = (await machine.sandbox.getUserHomeDir?.()) ?? '/home/daytona'
  const stateDir = `${homeDir}/.ds-bot/bot`
  const mk = await machine.sandbox.process.executeCommand(`mkdir -p '${stateDir.replace(/'/g, "'\\''")}'`, undefined, undefined, 30)
  if (mk.exitCode !== 0) throw new Error(`mkdir ${stateDir} failed (exit ${mk.exitCode}): ${mk.result}`)
  await machine.sandbox.fs.uploadFile(
    Buffer.from(JSON.stringify({ version: 1, bots: { planner: { name: 'Planner', model: 'argon' }, reviewer: { name: 'Reviewer', model: 'gpt-6.2-sol' } } })),
    `${stateDir}/state.json`,
  )
  await mgr.captureState(sandboxId, {
    threads: { 't-smoke': { threadId: 't-smoke', seq: 1, messages: [{ role: 'user', text: 'smoke check' }] } },
  })

  const slept = await mgr.sleep(sandboxId)
  check('sandbox slept after automatic bot state drain', slept.slept === true && machine.sandbox.state === 'stopped', `state=${machine.sandbox.state}`)

  const rRoster = await mgr.readRoster(sandboxId)
  const rThread = await mgr.readThread(sandboxId, 't-smoke')
  const rProjects = await mgr.readProjects(sandboxId)
  check(
    'asleep reads served from cache without waking',
    rRoster.fromCache && !rRoster.woke && rRoster.value?.reviewer?.model === 'gpt-6.2-sol' && rThread.fromCache && !rThread.woke && rProjects.fromCache && !rProjects.woke && machine.sandbox.state === 'stopped',
    rRoster.value?.reviewer?.model,
  )

  const wokeExec = await mgr.execCommand(sandboxId, 'cat ~/.codex/config.toml ~/smoke-work/.env')
  check(
    'command woke sandbox and preserved persisted files across sleep/wake',
    wokeExec.woke === true && wokeExec.exitCode === 0 && wokeExec.stdout.includes('gpt-6.2-sol') && wokeExec.stdout.includes(`SMOKE_MARKER=${marker}`),
    `exit=${wokeExec.exitCode}`,
  )
} catch (error) {
  check('live Daytona machine smoke completed without error', false, String(error.message).slice(0, 200))
} finally {
  if (machine) {
    await mgr.deleteMachine(machine.id).catch(async () => {
      await mgr.client.delete(machine.sandbox).catch(() => {})
    })
  }
  if (sandboxId) {
    let gone = false
    for (let i = 0; i < 30 && !gone; i += 1) {
      try {
        await mgr.client.get(sandboxId)
        await new Promise(r => setTimeout(r, 1000))
      } catch {
        gone = true
      }
    }
    check('persistent smoke sandbox deleted', gone, sandboxId)
  }
  console.log(out.join('\n'))
}
