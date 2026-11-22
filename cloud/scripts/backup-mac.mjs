#!/usr/bin/env node
// Encrypted backup of the Mac's DS Bot data, off the laptop. Run on the Mac.
//   node scripts/backup-mac.mjs backup [--to-dir <folder>] [--r2] [--keep <n>] [--include-env]
//   node scripts/backup-mac.mjs restore (--from <file> | --r2-key <key>) --to <empty folder>
// Backs up ~/.ds-bot, ~/.config/ds-bot-cloud and the git-ignored infra/*.local.md notes (plus cloud/.env
// with --include-env). The passphrase comes from DSBOT_BACKUP_PASSPHRASE (environment or cloud/.env);
// keep a copy of it off this Mac, or the backup cannot be opened when the Mac is gone.
// Reads ~/.ds-bot only; prints counts, sizes and destinations, never file names or contents.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { ROOT } from './pg.mjs'
import { backupName, createBackup, downloadBackup, pruneDir, restoreBackup, uploadBackup } from '../src/backup.mjs'
import { r2ClientFromEnv } from '../src/r2store.mjs'
import { loadEnv } from '../src/remote.mjs'

const expand = p => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

export function parseArgs(argv) {
  const [command, ...rest] = argv
  const o = { command, r2: false, includeEnv: false, keep: 14, home: '~/.ds-bot' }
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]
    if (a === '--to-dir') o.toDir = rest[++i]
    else if (a === '--r2') o.r2 = true
    else if (a === '--keep') o.keep = Number(rest[++i])
    else if (a === '--include-env') o.includeEnv = true
    else if (a === '--home') o.home = rest[++i]
    else if (a === '--from') o.from = rest[++i]
    else if (a === '--r2-key') o.r2Key = rest[++i]
    else if (a === '--to') o.to = rest[++i]
    else throw new Error(`unknown argument ${a}`)
  }
  if (command === 'backup') {
    if (!o.toDir && !o.r2) throw new Error('backup needs a destination off this Mac: --to-dir <folder> and/or --r2')
    if (!Number.isInteger(o.keep) || o.keep < 1) throw new Error('--keep must be a positive integer')
  } else if (command === 'restore') {
    if (!o.to) throw new Error('restore needs --to <empty folder>')
    if (!o.from === !o.r2Key) throw new Error('restore needs exactly one of --from <file> or --r2-key <key>')
  } else {
    throw new Error('usage: backup-mac.mjs backup|restore [options]')
  }
  return o
}

export function sourcesFor({ home, includeEnv, root = ROOT, config = join(homedir(), '.config', 'ds-bot-cloud') }) {
  const notes = join(root, 'infra')
  const local = existsSync(notes) ? readdirSync(notes).filter(f => f.endsWith('.local.md')).map(f => join(notes, f)) : []
  return [
    { name: 'ds-bot', path: expand(home), required: true },
    { name: 'ds-bot-cloud', path: config },
    // Listed even when absent, so a backup made without the notes says so.
    ...(local.length ? local : [join(notes, 'RISKS.local.md')]).map(path => ({ name: 'infra-notes', path })),
    ...(includeEnv ? [{ name: 'cloud-env', path: join(root, '.env') }] : []),
  ]
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  const envFile = join(ROOT, '.env')
  const env = existsSync(envFile) ? loadEnv(envFile) : {}
  const passphrase = process.env.DSBOT_BACKUP_PASSPHRASE ?? env.DSBOT_BACKUP_PASSPHRASE
  const live = [expand(o.home), join(homedir(), '.config', 'ds-bot-cloud')]

  if (o.command === 'backup') {
    const work = mkdtempSync(join(tmpdir(), 'dsbot-backup-'))
    try {
      const file = join(o.toDir ? resolve(expand(o.toDir)) : work, backupName())
      if (o.toDir) mkdirSync(resolve(expand(o.toDir)), { recursive: true, mode: 0o700 })
      const made = await createBackup({ sources: sourcesFor(o), passphrase, out: file, workDir: work })
      for (const s of made.sources) console.log(`${s.present ? 'included' : 'absent  '}  ${s.name}: ${s.files} files, ${s.bytes} bytes`)
      console.log(`encrypted backup: ${made.bytes} bytes, sha256 ${made.sha256}`)
      if (o.toDir) console.log(`saved to folder; pruned ${pruneDir(resolve(expand(o.toDir)), o.keep).length} older backup(s), keeping ${o.keep}`)
      if (o.r2) {
        const up = await uploadBackup({ client: r2ClientFromEnv(env), bucket: env.R2_BUCKET, file })
        console.log(`uploaded to R2 and read back: ${up.key}`)
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
    return
  }

  const work = mkdtempSync(join(tmpdir(), 'dsbot-restore-'))
  try {
    const file = o.from ? resolve(expand(o.from)) : await downloadBackup({ client: r2ClientFromEnv(env), bucket: env.R2_BUCKET, key: o.r2Key, out: join(work, 'backup.dsbkp') })
    const result = await restoreBackup({ file, passphrase, to: resolve(expand(o.to)), refuse: live })
    console.log(`restored ${result.files} files from a backup made ${result.created_at}: ${result.ok ? 'every digest matches' : `${result.problems.length} problem(s)`}`)
    if (!result.ok) process.exitCode = 1
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`backup-mac: ${error.message}`); process.exit(1) })
}
