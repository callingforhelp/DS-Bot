// A throwaway local Postgres for tests: its own data dir, a high port, no ~/.dsh or live data.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const PG_DIR = process.env.MVP_PG_DIR ?? join(ROOT, '.pg')
export const PG_PORT = Number(process.env.MVP_PG_PORT ?? 54329)
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' })

export function pgStatus() { return run('pg_ctl', ['-D', PG_DIR, 'status']).status === 0 }
export function pgStart() {
  if (!existsSync(join(PG_DIR, 'PG_VERSION'))) {
    mkdirSync(PG_DIR, { recursive: true })
    execFileSync('initdb', ['-D', PG_DIR, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C'], { stdio: 'ignore' })
  }
  if (!pgStatus()) execFileSync('pg_ctl', ['-D', PG_DIR, '-o', `-p ${PG_PORT} -k ${PG_DIR} -c listen_addresses=127.0.0.1`, '-l', join(PG_DIR, 'server.log'), '-w', 'start'], { stdio: 'ignore' })
}
export function pgStop() { if (pgStatus()) execFileSync('pg_ctl', ['-D', PG_DIR, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' }) }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [action] = process.argv.slice(2)
  if (action === 'start') { pgStart(); console.log(`postgres on 127.0.0.1:${PG_PORT}`) }
  else if (action === 'stop') { pgStop(); console.log('stopped') }
  else console.log(pgStatus() ? 'running' : 'stopped')
}
