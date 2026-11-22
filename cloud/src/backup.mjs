// Encrypted, off-machine backup of the Mac's DS Bot data: ~/.ds-bot (the only copy of every Session
// log, Bot, room, ledger and diagnostics line that RDS references point back to), the lineage
// archive, and the git-ignored notes that hold the real AWS IDs and the full risk register.
//
// Format: "DSBKP1\n" | scrypt salt (16) | AES-256-GCM IV (12) | ciphertext of a tar.gz | GCM tag (16).
// The tar carries backup-manifest.json with a SHA-256 per file, checked again after a restore.
import { spawnSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import { chmodSync, copyFileSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, closeSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'

const MAGIC = Buffer.from('DSBKP1\n')
const SALT = 16
const IV = 12
const TAG = 16
const HEADER = MAGIC.length + SALT + IV
const MANIFEST = 'backup-manifest.json'
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
export const MIN_PASSPHRASE = 20

const deriveKey = (passphrase, salt) => {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) throw new Error(`backup passphrase must be at least ${MIN_PASSPHRASE} characters`)
  return scryptSync(passphrase, salt, 32, SCRYPT)
}
const fileSha = async (path) => {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(path)) h.update(chunk)
  return h.digest('hex')
}
const inside = (parent, child) => {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// Regular files only: sockets, FIFOs and symlinks are skipped (a symlink could point anywhere).
function walk(root) {
  const out = []
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const st = lstatSync(path)
      if (st.isDirectory()) visit(path)
      else if (st.isFile()) out.push(path)
    }
  }
  if (lstatSync(root).isDirectory()) visit(root)
  else if (lstatSync(root).isFile()) out.push(root)
  return out
}

// sources: [{ name, path }]; `name` is the top-level folder the source gets inside the backup.
// A missing optional source is reported, not an error; a missing required one is.
export async function buildManifest(sources) {
  const entries = []
  const summary = []
  for (const s of sources) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(s.name)) throw new Error(`invalid source name ${s.name}`)
    if (!existsSync(s.path)) {
      if (s.required) throw new Error(`required source ${s.name} is missing`)
      summary.push({ name: s.name, present: false, files: 0, bytes: 0 })
      continue
    }
    const root = statSync(s.path).isDirectory() ? s.path : dirname(s.path)
    let bytes = 0
    const files = walk(s.path)
    for (const f of files) {
      const size = statSync(f).size
      bytes += size
      entries.push({ path: `${s.name}/${relative(root, f).split(sep).join('/')}`, bytes: size, sha256: await fileSha(f) })
    }
    summary.push({ name: s.name, present: true, files: files.length, bytes })
  }
  return { format: 1, created_at: new Date().toISOString(), sources: summary, files: entries }
}

// Copies the files into a staging folder under their backup names, then tars that folder, so a
// file changing mid-backup only ever differs from the manifest (caught on restore), never splits.
export async function createBackup({ sources, passphrase, out, workDir = tmpdir() }) {
  const salt = randomBytes(SALT)
  const key = deriveKey(passphrase, salt)
  const stage = mkdtempSync(join(workDir, 'dsbkp-stage-'))
  try {
    const manifest = await buildManifest(sources)
    for (const s of sources) {
      if (!existsSync(s.path)) continue
      const root = statSync(s.path).isDirectory() ? s.path : dirname(s.path)
      for (const f of walk(s.path)) {
        const dest = join(stage, s.name, relative(root, f))
        mkdirSync(dirname(dest), { recursive: true })
        copyFileSync(f, dest)
        chmodSync(dest, 0o600)
      }
    }
    // Re-hash the staged copies: those are what the archive holds.
    for (const e of manifest.files) {
      const staged = join(stage, ...e.path.split('/'))
      e.sha256 = await fileSha(staged)
      e.bytes = statSync(staged).size
    }
    writeFileSync(join(stage, MANIFEST), JSON.stringify(manifest, null, 2), { mode: 0o600 })
    const tarPath = join(workDir, `dsbkp-${randomBytes(6).toString('hex')}.tar.gz`)
    const tar = spawnSync('tar', ['-czf', tarPath, '-C', stage, '.'], { encoding: 'utf8' })
    if (tar.status !== 0) throw new Error(`tar failed: ${(tar.stderr || '').slice(0, 200)}`)
    try {
      const iv = randomBytes(IV)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const partial = `${out}.partial`
      await pipeline(createReadStream(tarPath), cipher, async function* (body) {
        yield Buffer.concat([MAGIC, salt, iv])
        for await (const chunk of body) yield chunk
        yield cipher.getAuthTag()
      }, createWriteStream(partial, { mode: 0o600 }))
      renameSync(partial, out)
    } finally {
      rmSync(tarPath, { force: true })
    }
    return { file: out, bytes: statSync(out).size, sha256: await fileSha(out), sources: manifest.sources, files: manifest.files.length }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

// Decrypts into a temporary tar, and only extracts once the GCM tag has checked out, into an empty
// folder that is never the live DS Bot home. Then every file is compared with the manifest.
export async function restoreBackup({ file, passphrase, to, refuse = [] }) {
  const target = resolve(to)
  for (const live of refuse) if (inside(live, target) || inside(target, live)) throw new Error('refusing to restore into or over a live data folder')
  if (existsSync(target) && readdirSync(target).length > 0) throw new Error('restore target must be empty')
  const size = statSync(file).size
  if (size <= HEADER + TAG) throw new Error('not a DS Bot backup (too short)')
  const fd = openSync(file, 'r')
  const head = Buffer.alloc(HEADER)
  const tag = Buffer.alloc(TAG)
  try {
    readSync(fd, head, 0, HEADER, 0)
    readSync(fd, tag, 0, TAG, size - TAG)
  } finally { closeSync(fd) }
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a DS Bot backup (bad header)')
  const salt = head.subarray(MAGIC.length, MAGIC.length + SALT)
  const iv = head.subarray(MAGIC.length + SALT)
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv)
  decipher.setAuthTag(tag)
  const tarPath = join(tmpdir(), `dsbkp-restore-${randomBytes(6).toString('hex')}.tar.gz`)
  try {
    try {
      await pipeline(createReadStream(file, { start: HEADER, end: size - TAG - 1 }), decipher, createWriteStream(tarPath, { mode: 0o600 }))
    } catch (error) {
      if (/authenticate/i.test(String(error?.message))) throw new Error('backup could not be decrypted: wrong passphrase or the file was altered')
      throw error
    }
    mkdirSync(target, { recursive: true, mode: 0o700 })
    const list = spawnSync('tar', ['-tzf', tarPath], { encoding: 'utf8' })
    if (list.status !== 0) throw new Error('backup archive is unreadable')
    for (const member of list.stdout.split('\n').filter(Boolean)) {
      if (member.startsWith('/') || member.split('/').includes('..')) throw new Error('backup archive has an unsafe path')
    }
    const tar = spawnSync('tar', ['-xzf', tarPath, '-C', target], { encoding: 'utf8' })
    if (tar.status !== 0) throw new Error(`tar extract failed: ${(tar.stderr || '').slice(0, 200)}`)
  } finally {
    rmSync(tarPath, { force: true })
  }
  return verifyRestore(target)
}

export async function verifyRestore(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'))
  const problems = []
  for (const e of manifest.files) {
    const path = join(dir, ...e.path.split('/'))
    if (!existsSync(path)) problems.push({ path: e.path, problem: 'missing' })
    else if (await fileSha(path) !== e.sha256) problems.push({ path: e.path, problem: 'digest mismatch' })
  }
  return { ok: problems.length === 0, files: manifest.files.length, sources: manifest.sources, created_at: manifest.created_at, problems }
}

// Keeps the newest `keep` backups in a folder (names sort by time); returns what was removed.
export function pruneDir(dir, keep) {
  const all = readdirSync(dir).filter(f => /^dsbot-mac-.*\.dsbkp$/.test(f)).sort()
  const drop = all.slice(0, Math.max(0, all.length - keep))
  for (const f of drop) rmSync(join(dir, f))
  return drop
}

export const backupName = (now = new Date()) => `dsbot-mac-${now.toISOString().replace(/[:.]/g, '-')}.dsbkp`

// Uploads to R2 under a never-overwritten key, then reads the object back and compares digests.
export async function uploadBackup({ client, bucket, prefix = 'backups/mac', file }) {
  const key = `${prefix}/${basename(file)}`
  const sha256 = await fileSha(file)
  const bytes = statSync(file).size
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: createReadStream(file), ContentLength: bytes, IfNoneMatch: '*', Metadata: { sha256 } }))
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const h = createHash('sha256')
  let got = 0
  for await (const chunk of res.Body) { h.update(chunk); got += chunk.length }
  if (h.digest('hex') !== sha256 || got !== bytes) throw new Error('uploaded backup does not match the local file')
  return { key, bytes, sha256 }
}

export async function downloadBackup({ client, bucket, key, out }) {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  await pipeline(res.Body, createWriteStream(out, { mode: 0o600 }))
  return out
}
