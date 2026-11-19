import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../scripts/pg.mjs'
import { adminUrl, makePool } from './db.mjs'

// Applies migrations/NNN_*.sql in order, once each. Files ending .optional.sql apply only
// when `optional` names them (pgvector needs the extension); .down.sql never auto-run.
//
// Local (default): creates the database and the dsbot_app role on the throwaway Postgres.
// Remote: pass `adminPool` (a pool already connected to the existing database as its owner) and
// `appRole` (an existing restricted login). Nothing is created outside that database, and the
// app role is only granted rights on the tables this schema creates.
export async function migrate(db, { optional = [], adminPool, appRole = 'dsbot_app' } = {}) {
  if (!/^[a-z0-9_]+$/.test(db)) throw new Error('bad database name')
  if (!/^[a-z0-9_]+$/.test(appRole)) throw new Error('bad role name')
  if (!adminPool) {
    const admin = makePool(adminUrl(), 1)
    const exists = await admin.query('select 1 from pg_database where datname = $1', [db])
    if (exists.rowCount === 0) await admin.query(`create database ${db}`)
    await admin.end()
  }
  const pool = adminPool ?? makePool(adminUrl(db), 1)
  try {
    await pool.query('create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())')
    const files = readdirSync(join(ROOT, 'migrations')).filter(f => f.endsWith('.sql') && !f.endsWith('.down.sql')).sort()
    const applied = []
    for (const file of files) {
      if (file.endsWith('.optional.sql') && !optional.includes(file)) continue
      if ((await pool.query('select 1 from schema_migrations where id = $1', [file])).rowCount > 0) continue
      const sql = readFileSync(join(ROOT, 'migrations', file), 'utf8').replace(/^create table schema_migrations .*$/m, '')
      const client = await pool.connect()
      try {
        await client.query('begin')
        await client.query(sql)
        await client.query('insert into schema_migrations (id) values ($1)', [file])
        await client.query('commit')
        applied.push(file)
      } catch (error) {
        await client.query('rollback').catch(() => {})
        throw new Error(`migration ${file} failed: ${error.message}`)
      } finally { client.release() }
    }
    // The application role owns nothing and is not a superuser: RLS binds it.
    if (!adminPool) {
      await pool.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${appRole}') then create role ${appRole} login password '${appRole}' nosuperuser nobypassrls; end if; end $$`)
    }
    await pool.query(`grant usage on schema public to ${appRole}; grant select, insert, update, delete on all tables in schema public to ${appRole}; revoke all on schema_migrations from ${appRole}`)
    return applied
  } finally { if (!adminPool) await pool.end() }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { pgStart } = await import('../scripts/pg.mjs')
  pgStart()
  console.log('applied:', await migrate(process.argv[2] ?? 'dsbot_mvp'))
}
