// Daytona Volume persistence and isolation, on the real account, with a throwaway volume:
//   A writes a file under tenant-a's subpath and is deleted; B (same subpath) reads it back;
//   C (another subpath) must not see it. Sandboxes are ephemeral, networkless and TTL-limited.
// The volume is deleted at the end. Volumes are FUSE-backed: this tests plain files only, never
// SQLite, PostgreSQL or DSH session locks (the spec forbids those on a volume).
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { Daytona } from '@daytonaio/sdk'
import { ROOT } from './pg.mjs'
import { loadEnv } from '../src/remote.mjs'

const env = loadEnv(join(ROOT, '.env'))
const client = new Daytona({ apiKey: env.DAYTONA_API_KEY })
const name = `ds-bot-mvp-test-${randomBytes(3).toString('hex')}`
const out = []
const check = (label, ok, extra = '') => { out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`); if (!ok) process.exitCode = 1 }
const live = []
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function sandboxWith(volume, subpath) {
  const sb = await client.create({
    language: 'python', ephemeral: true, networkBlockAll: true, ttlMinutes: 10, autoStopInterval: 10,
    labels: { app: 'ds-bot-cloud-mvp', purpose: 'volume-test' }, volumes: [{ volumeId: volume.id, mountPath: '/data', subpath }],
  }, { timeout: 120 })
  live.push(sb)
  return sb
}
const run = async (sb, code) => {
  const r = await sb.process.executeCommand(`python3 -c "${code}"`, undefined, undefined, 60)
  return { exit: r.exitCode, out: r.result.trim() }
}

let volume
try {
  volume = await client.volume.create(name)
  for (let i = 0; i < 60 && volume.state !== 'ready'; i += 1) { await sleep(1000); volume = await client.volume.get(name) }
  check('volume created and ready', volume.state === 'ready', `${name}, state=${volume.state}`)

  const payload = `evidence-${randomBytes(4).toString('hex')}`
  const digest = createHash('sha256').update(payload).digest('hex')
  const a = await sandboxWith(volume, 'tenant-a/proj')
  const w = await run(a, `import os;os.makedirs('/data/run1',exist_ok=True);open('/data/run1/result.txt','w').write('${payload}');print('written')`)
  check('sandbox A wrote a file on the volume subpath', w.exit === 0 && w.out.endsWith('written'))
  await client.delete(a)
  live.splice(live.indexOf(a), 1)
  check('sandbox A deleted', true)

  const b = await sandboxWith(volume, 'tenant-a/proj')
  const r = await run(b, "import hashlib;t=open('/data/run1/result.txt').read();print(hashlib.sha256(t.encode()).hexdigest())")
  check('sandbox B (new) reads the same file back: the volume outlives the sandbox', r.exit === 0 && r.out.endsWith(digest), r.out.slice(-12))

  const c = await sandboxWith(volume, 'tenant-b/proj')
  const x = await run(c, "import os;print(os.path.exists('/data/run1/result.txt'), os.listdir('/data'))")
  check('sandbox C on another tenant subpath cannot see it', x.exit === 0 && x.out.includes('False'), x.out.slice(-40))
} catch (error) {
  check('volume test completed without error', false, String(error.message).slice(0, 160))
} finally {
  for (const sb of live) await client.delete(sb).catch(() => {})
  await sleep(8000) // sandboxes release the volume asynchronously
  if (volume) {
    let removed = false
    for (let i = 0; i < 12 && !removed; i += 1) {
      try { await client.volume.delete(volume); removed = true } catch { await sleep(5000) }
    }
    out.push(`${removed ? 'PASS' : 'FAIL'}  throwaway volume deleted  (${name})`)
    if (!removed) process.exitCode = 1
  }
  console.log(out.join('\n'))
}
