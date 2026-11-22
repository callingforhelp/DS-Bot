import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, symlinkSync, statSync, openSync, writeSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { backupName, createBackup, pruneDir, restoreBackup, uploadBackup, verifyRestore } from '../src/backup.mjs'
import { parseArgs, sourcesFor } from '../scripts/backup-mac.mjs'

const passphrase = 'correct horse battery staple 42'
const tmp = prefix => mkdtempSync(join(tmpdir(), prefix))

// A synthetic DS Bot home in the shapes the lineage readers use; no real data.
function fakeHome() {
  const root = tmp('dsbkp-src-')
  const home = join(root, '.ds-bot')
  mkdirSync(join(home, 'sessions', 'p1', 's1'), { recursive: true })
  mkdirSync(join(home, 'bot', 'logs'), { recursive: true })
  mkdirSync(join(home, 'bot', 'ledger'), { recursive: true })
  writeFileSync(join(home, 'sessions', 'p1', 's1', 'session.v1.jsonl'), '{"seq":1,"type":"message"}\n{"seq":2}\n')
  writeFileSync(join(home, 'bot', 'state.json'), JSON.stringify({ bots: [{ id: 'b1' }] }))
  writeFileSync(join(home, 'bot', 'ledger', 'pair-a-b.jsonl'), '{"kind":"request"}\n')
  writeFileSync(join(home, 'bot', 'logs', 'diagnostics.jsonl'), Buffer.from([0, 1, 2, 255]))
  symlinkSync('/etc/passwd', join(home, 'bot', 'outside-link'))
  const infra = join(root, 'repo', 'infra')
  mkdirSync(infra, { recursive: true })
  writeFileSync(join(infra, 'RISKS.local.md'), '# R14 detail\n')
  writeFileSync(join(infra, 'aws-staging.local.md'), 'i-0123456789abcdef0\n')
  writeFileSync(join(infra, 'RISKS.md'), 'public\n')
  writeFileSync(join(root, 'repo', '.env'), 'R2_BUCKET=x\n')
  return { root, home, repo: join(root, 'repo'), config: join(root, 'config-missing') }
}

test('backup and restore round-trip every file with matching digests; symlinks are skipped', async () => {
  const f = fakeHome()
  const sources = sourcesFor({ home: f.home, includeEnv: false, root: f.repo, config: f.config })
  const out = join(tmp('dsbkp-out-'), backupName())
  const made = await createBackup({ sources, passphrase, out })
  assert.equal(made.files, 6)
  assert.deepEqual(made.sources.map(s => [s.name, s.present, s.files]), [['ds-bot', true, 4], ['ds-bot-cloud', false, 0], ['infra-notes', true, 1], ['infra-notes', true, 1]])
  const bytes = readFileSync(out)
  assert.ok(!bytes.includes('i-0123456789abcdef0') && !bytes.includes('state.json'), 'nothing readable in the encrypted file')
  assert.equal(statSync(out).mode & 0o777, 0o600)

  const to = join(tmp('dsbkp-restore-'), 'r')
  const restored = await restoreBackup({ file: out, passphrase, to })
  assert.equal(restored.ok, true)
  assert.equal(restored.files, 6)
  assert.equal(readFileSync(join(to, 'ds-bot', 'sessions', 'p1', 's1', 'session.v1.jsonl'), 'utf8'), '{"seq":1,"type":"message"}\n{"seq":2}\n')
  assert.deepEqual(readFileSync(join(to, 'ds-bot', 'bot', 'logs', 'diagnostics.jsonl')), Buffer.from([0, 1, 2, 255]))
  assert.equal(readFileSync(join(to, 'infra-notes', 'aws-staging.local.md'), 'utf8'), 'i-0123456789abcdef0\n')
  assert.deepEqual(readdirSync(join(to, 'infra-notes')).sort(), ['RISKS.local.md', 'aws-staging.local.md'])
  assert.ok(!readdirSync(join(to, 'ds-bot', 'bot')).includes('outside-link'))
  assert.ok(!readdirSync(to).includes('cloud-env'), '.env stays out unless asked for')

  writeFileSync(join(to, 'ds-bot', 'bot', 'state.json'), 'tampered')
  const check = await verifyRestore(to)
  assert.equal(check.ok, false)
  assert.deepEqual(check.problems, [{ path: 'ds-bot/bot/state.json', problem: 'digest mismatch' }])
})

test('--include-env adds cloud/.env', async () => {
  const f = fakeHome()
  const out = join(tmp('dsbkp-out-'), backupName())
  await createBackup({ sources: sourcesFor({ home: f.home, includeEnv: true, root: f.repo, config: f.config }), passphrase, out })
  const to = join(tmp('dsbkp-restore-'), 'r')
  await restoreBackup({ file: out, passphrase, to })
  assert.equal(readFileSync(join(to, 'cloud-env', '.env'), 'utf8'), 'R2_BUCKET=x\n')
})

test('a wrong passphrase, an altered file, a short passphrase and a missing home all fail', async () => {
  const f = fakeHome()
  const sources = sourcesFor({ home: f.home, includeEnv: false, root: f.repo, config: f.config })
  const out = join(tmp('dsbkp-out-'), backupName())
  await createBackup({ sources, passphrase, out })
  await assert.rejects(restoreBackup({ file: out, passphrase: `${passphrase}x`, to: join(tmp('dsbkp-r-'), 'r') }), /wrong passphrase or the file was altered/)
  const fd = openSync(out, 'r+')
  writeSync(fd, Buffer.from([0x55]), 0, 1, 60)
  closeSync(fd)
  const to = join(tmp('dsbkp-r-'), 'r')
  await assert.rejects(restoreBackup({ file: out, passphrase, to }), /wrong passphrase or the file was altered/)
  assert.throws(() => readdirSync(to), /ENOENT/, 'nothing is extracted from a backup that failed to authenticate')
  await assert.rejects(createBackup({ sources, passphrase: 'short', out: `${out}.2` }), /at least 20 characters/)
  await assert.rejects(createBackup({ sources: [{ name: 'ds-bot', path: join(f.root, 'nope'), required: true }], passphrase, out: `${out}.3` }), /required source ds-bot is missing/)
})

test('restore refuses a non-empty target and the live DS Bot home', async () => {
  const f = fakeHome()
  const out = join(tmp('dsbkp-out-'), backupName())
  await createBackup({ sources: sourcesFor({ home: f.home, includeEnv: false, root: f.repo, config: f.config }), passphrase, out })
  await assert.rejects(restoreBackup({ file: out, passphrase, to: f.home, refuse: [f.home] }), /live data folder/)
  await assert.rejects(restoreBackup({ file: out, passphrase, to: join(f.home, 'restore'), refuse: [f.home] }), /live data folder/)
  await assert.rejects(restoreBackup({ file: out, passphrase, to: f.repo }), /must be empty/)
})

test('pruneDir keeps the newest backups only', () => {
  const dir = tmp('dsbkp-prune-')
  const names = [0, 1, 2, 3].map(i => backupName(new Date(Date.UTC(2026, 10, 20 + i))))
  for (const n of names) writeFileSync(join(dir, n), 'x')
  writeFileSync(join(dir, 'unrelated.txt'), 'x')
  assert.deepEqual(pruneDir(dir, 2), names.slice(0, 2))
  assert.deepEqual(readdirSync(dir).sort(), [...names.slice(2), 'unrelated.txt'].sort())
})

test('uploadBackup writes once under backups/mac and reads the object back', async () => {
  const objects = new Map()
  const client = {
    async send(cmd) {
      const { Key, Body, IfNoneMatch } = cmd.input
      if (cmd.constructor.name === 'PutObjectCommand') {
        if (IfNoneMatch === '*' && objects.has(Key)) throw Object.assign(new Error('precondition failed'), { $metadata: { httpStatusCode: 412 } })
        const parts = []
        for await (const c of Body) parts.push(c)
        objects.set(Key, Buffer.concat(parts))
        return {}
      }
      return { Body: Readable.from([objects.get(Key)]) }
    },
  }
  const f = fakeHome()
  const out = join(tmp('dsbkp-out-'), backupName())
  await createBackup({ sources: sourcesFor({ home: f.home, includeEnv: false, root: f.repo, config: f.config }), passphrase, out })
  const up = await uploadBackup({ client, bucket: 'b', file: out })
  assert.match(up.key, /^backups\/mac\/dsbot-mac-.*\.dsbkp$/)
  assert.deepEqual(objects.get(up.key), readFileSync(out))
  await assert.rejects(uploadBackup({ client, bucket: 'b', file: out }), /precondition/)
})

test('the CLI needs a destination off the Mac and one restore source', () => {
  assert.throws(() => parseArgs(['backup']), /destination off this Mac/)
  assert.equal(parseArgs(['backup', '--r2']).r2, true)
  assert.throws(() => parseArgs(['restore', '--to', 'x']), /exactly one/)
  assert.throws(() => parseArgs(['restore', '--from', 'a', '--r2-key', 'b', '--to', 'x']), /exactly one/)
  assert.throws(() => parseArgs(['backup', '--r2', '--keep', '0']), /positive integer/)
})
