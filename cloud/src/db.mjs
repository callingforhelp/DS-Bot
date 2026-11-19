import pg from 'pg'
// The local throwaway Postgres's port (tests only). Kept here, not imported from scripts/, because
// the container image ships src/ alone.
const PG_PORT = Number(process.env.MVP_PG_PORT ?? 54329)

export const adminUrl = (db = 'postgres') => `postgres://postgres@127.0.0.1:${PG_PORT}/${db}`
export const appUrl = (db) => `postgres://dsbot_app:dsbot_app@127.0.0.1:${PG_PORT}/${db}`
export const makePool = (url, max = 5) => new pg.Pool({ connectionString: url, max })

// Every request-scoped query runs in a transaction that pins the tenant (and the agent
// whose private rows it may read) for row-level security. The setting dies with the
// transaction ('ingest' is the service role that may write and index private rows; search
// never has it), so a pooled connection never carries one request's tenant into the next.
// Whether this database has the pgvector column (migration 002). Checked once per pool.
const vectorSeen = new WeakMap()
export async function hasPgvector(pool) {
  if (!vectorSeen.has(pool)) {
    const { rowCount } = await pool.query("select 1 from information_schema.columns where table_name = 'retrieval_chunks' and column_name = 'embedding_v'")
    vectorSeen.set(pool, rowCount > 0)
  }
  return vectorSeen.get(pool)
}
export const vectorLiteral = v => `[${v.join(',')}]`

export async function withScope(pool, { tenant, agent = '', role = '' }, fn) {
  if (typeof tenant !== 'string' || tenant === '') throw new Error('tenant is required')
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('app.tenant_id', $1, true), set_config('app.agent_id', $2, true), set_config('app.role', $3, true)", [tenant, agent, role])
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
