import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'

// Connection to the remote database through the local SSM tunnel. The TCP connection goes to
// 127.0.0.1 (the tunnel) while TLS is verified against the real RDS host name (`servername`),
// so a wrong or intercepted endpoint fails the handshake. Secrets stay in memory: nothing here
// prints, logs or writes a password.

export function loadEnv(file) {
  const out = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m && m[2] !== '') out[m[1]] = m[2]
  }
  return out
}

const expand = p => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

function sslFor(env) {
  const ca = expand(env.DS_BOT_DB_SSLROOTCERT ?? '')
  if (!existsSync(ca)) throw new Error('RDS CA bundle not found; refusing to connect without certificate verification')
  return { ca: readFileSync(ca, 'utf8'), servername: env.DS_BOT_DB_HOST, rejectUnauthorized: true }
}

const config = (env, user, password, max) => ({
  host: env.DS_BOT_DB_HOSTADDR, port: Number(env.DS_BOT_DB_PORT), database: env.DS_BOT_DB_NAME,
  user, password, ssl: sslFor(env), max, connectionTimeoutMillis: 10_000,
})

// The restricted application login from .env.
export const appPool = (env, max = 4) => new pg.Pool(config(env, env.DS_BOT_DB_USER, env.DS_BOT_DB_PASSWORD, max))

// The instance owner, only for migrations. Its password is the RDS-managed secret, read through
// the AWS API at the moment it is needed (never copied into .env or any file).
export function adminPool(env, { profile = 'flinter', region = 'us-east-2', secretId, user = 'flinter_admin' } = {}) {
  const raw = execFileSync('/opt/homebrew/bin/aws', ['secretsmanager', 'get-secret-value', '--profile', profile, '--region', region, '--secret-id', secretId, '--query', 'SecretString', '--output', 'text'], { encoding: 'utf8' })
  const secret = JSON.parse(raw)
  if (secret.username !== user) throw new Error('the managed secret belongs to a different login than expected')
  return new pg.Pool(config(env, user, secret.password, 1))
}
