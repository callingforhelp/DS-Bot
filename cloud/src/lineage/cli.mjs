#!/usr/bin/env node
// DS Bot lineage bridge.
//   node src/lineage/cli.mjs --home <DSH_HOME> --db <path> [--once | --watch [--interval <ms>]] [--json] [--text-key-file <path>]
//   node src/lineage/cli.mjs --db <path> --verify
// Reads the home read-only and writes only the archive at --db, which must be outside the
// home. Prints counts only: never names, references, paths or text.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { relative, resolve, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ArchiveError, openArchive } from './archive.mjs'
import { runPass } from './pass.mjs'
import { readers } from './readers.mjs'
import * as classify from './refusals.mjs'

export function parseCli(argv) {
  const o = { once: false, watch: false, verify: false, json: false, interval: 15_000 }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--home') o.home = argv[++i]
    else if (a === '--db') o.db = argv[++i]
    else if (a === '--once') o.once = true
    else if (a === '--watch') o.watch = true
    else if (a === '--verify') o.verify = true
    else if (a === '--json') o.json = true
    else if (a === '--interval') o.interval = Number(argv[++i])
    else if (a === '--text-key-file') o.textKeyFile = argv[++i]
    else throw new Error(`unknown argument ${a}`)
  }
  if (!o.db) throw new Error('--db is required')
  o.db = resolve(o.db)
  if (o.verify) return o
  if (!o.home) throw new Error('--home is required')
  o.home = resolve(o.home)
  const rel = relative(o.home, o.db)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('--db must be outside --home: the bridge never writes into the DS Bot home')
  if (!Number.isInteger(o.interval) || o.interval < 5000) throw new Error('--interval must be an integer of at least 5000 (ms)')
  if (!o.once && !o.watch) o.once = true
  return o
}

export function verifyArchive(path) {
  const a = openArchive(path, { readOnly: true })
  try {
    const db = a.db
    const problems = []
    const n = sql => db.prepare(sql).get().n
    const orphan = n("SELECT COUNT(*) AS n FROM events e WHERE e.task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = e.task_id)")
      + n("SELECT COUNT(*) AS n FROM authorizations x WHERE x.task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = x.task_id)")
    if (orphan) problems.push(`${orphan} rows reference a missing task`)
    const noTime = n('SELECT COUNT(*) AS n FROM events WHERE at IS NULL') + n('SELECT COUNT(*) AS n FROM authorizations WHERE at IS NULL')
    if (noTime) problems.push(`${noTime} rows have no time`)
    const counts = Object.fromEntries(['tasks', 'runs', 'events', 'authorizations', 'artifacts'].map(t => [t, a.count(t)]))
    const digest = createHash('sha256')
    for (const [table, cols] of Object.entries({
      tasks: 'id,category,assigned_by,assigned_to,exchange_id,created_at,status,completed_at,ref',
      runs: 'id,task_id,bot_id,session_id,turn,role,started_at,ended_at,outcome,ref',
      events: 'id,rev,kind,task_id,run_id,actor,target,room_id,at,session_id,seq,ref,meta',
      authorizations: 'id,rev,at,actor,target,room_id,action,outcome,reason,source,task_id,run_id,session_id,seq,ref',
    })) for (const row of db.prepare(`SELECT ${cols} FROM ${table} ORDER BY id`).all()) digest.update(`${table}:${JSON.stringify(row)}\n`)
    return { ok: problems.length === 0, problems, counts, digest: digest.digest('hex') }
  } finally { a.close() }
}

async function main() {
  const o = parseCli(process.argv.slice(2))
  if (o.verify) {
    const v = verifyArchive(o.db)
    console.log(JSON.stringify(v, null, o.json ? 0 : 2))
    process.exitCode = v.ok ? 0 : 1
    return
  }
  const textKey = o.textKeyFile ? readFileSync(o.textKeyFile) : undefined
  const archive = openArchive(o.db)
  const once = async () => {
    const r = await runPass({ home: o.home, archive, readers, classify, textKey })
    console.log(JSON.stringify(r.counts))
  }
  if (o.once) { try { await once() } finally { archive.close() } return }
  let stopping = false
  const stop = () => { stopping = true; archive.close(); process.exit(0) }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  while (!stopping) {
    // One short line per failure; never a path.
    try { await once() } catch (error) { console.error(`lineage pass failed: ${error instanceof ArchiveError ? error.message : (error?.code ?? error?.name ?? 'error')}`) }
    await new Promise(r => setTimeout(r, o.interval))
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { console.error(`lineage: ${error.code ?? error.message}`); process.exit(2) })
}
