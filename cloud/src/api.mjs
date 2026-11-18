import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { canonical } from './client.mjs'
import { withScope } from './db.mjs'
import { IngestError, ingestEvent } from './ingest.mjs'
import { recordDecision, recordHumanApproval } from './authz.mjs'
import { search } from './search.mjs'

const MVP_SCOPES = new Set(['read-only'])

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

// principals: { id: { secret, tenants: [...], scopes: [...], role: 'user'|'worker'|'human', agent? } }
// The API never runs a model. A rejected request therefore starts nothing: authentication,
// replay and scope checks all happen before the task is admitted or anything is dispatched.
export function createApi({ pool, embedder, principals, now = Date.now, skewMs = 5 * 60_000, ready = async () => true, objectStore }) {
  const body = async (req) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 1_000_000) throw new HttpError(413, 'body too large')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  async function authenticate(req, raw, path) {
    const id = req.headers['x-principal']
    const principal = principals[id]
    const ts = Number(req.headers['x-timestamp'])
    const nonce = String(req.headers['x-nonce'] ?? '')
    const signature = String(req.headers['x-signature'] ?? '')
    if (!principal || !Number.isFinite(ts) || nonce === '' || signature === '') throw new HttpError(401, 'unauthenticated')
    const expected = createHmac('sha256', principal.secret).update(canonical({ ts, nonce, method: req.method, path, raw })).digest('hex')
    const a = Buffer.from(expected)
    const b = Buffer.from(signature.padEnd(expected.length, ' ').slice(0, expected.length))
    if (!timingSafeEqual(a, b) || signature.length !== expected.length) throw new HttpError(401, 'bad signature')
    if (Math.abs(now() - ts) > skewMs) throw new HttpError(401, 'stale timestamp')
    // Only a validly signed request may spend a nonce, so junk cannot fill the table.
    const fresh = await pool.query('insert into request_nonces (nonce) values ($1) on conflict do nothing', [`${id}:${nonce}`])
    if (fresh.rowCount === 0) throw new HttpError(409, 'replayed request')
    const tenant = String(req.headers['x-tenant'] ?? '')
    if (!principal.tenants.includes(tenant)) throw new HttpError(403, 'principal is not a member of this tenant')
    return { id, tenant, ...principal }
  }

  const scoped = (p, fn, extra = {}) => withScope(pool, { tenant: p.tenant, agent: p.agent ?? '', ...extra }, fn)
  const need = (value, name) => { if (typeof value !== 'string' || value === '') throw new HttpError(400, `missing ${name}`); return value }

  const routes = {
    // Admit a scoped task. The idempotency key makes a client retry return the same run.
    async 'POST /v1/tasks'(p, input) {
      if (p.role !== 'user' && p.role !== 'human') throw new HttpError(403, 'this principal cannot submit tasks')
      const project = need(input.project_id, 'project_id')
      const key = need(input.idempotency_key, 'idempotency_key')
      const scope = need(input.scope, 'scope')
      if (!p.scopes.includes(scope)) throw new HttpError(403, 'scope not permitted for this principal')
      if (!MVP_SCOPES.has(scope)) throw new HttpError(403, 'only read-only tasks are enabled in this MVP')
      return scoped(p, async (c) => {
        const run = `run-${randomUUID()}`
        const ins = await c.query(
          `insert into tasks_admitted (tenant_id, project_id, idempotency_key, run_id, scope, principal, job) values ($1,$2,$3,$4,$5,$6,$7)
           on conflict do nothing returning run_id`, [p.tenant, project, key, run, scope, p.id, input.job ?? {}])
        if (ins.rowCount === 0) {
          const prior = await c.query('select run_id, dispatched from tasks_admitted where tenant_id = $1 and idempotency_key = $2', [p.tenant, key])
          return { status: 200, json: { run_id: prior.rows[0].run_id, duplicate: true } }
        }
        await c.query('insert into runs (tenant_id, project_id, run_id, owner) values ($1,$2,$3,$4)', [p.tenant, project, run, p.id])
        await recordDecision(c, { tenant: p.tenant, project, run, actor: p.id, action: 'task.admit', scope, verdict: 'allow', reason: 'authenticated principal with permitted scope' })
        return { status: 202, json: { run_id: run, duplicate: false } }
      })
    },

    async 'POST /v1/events'(p, input) {
      if (p.role !== 'worker') throw new HttpError(403, 'only workers ingest events')
      // The tenant comes from the authenticated principal, never from the payload.
      if (input.tenant_id !== p.tenant) throw new HttpError(403, 'event tenant does not match the authenticated tenant')
      try {
        return { status: 200, json: await scoped(p, c => ingestEvent(c, input), { role: 'ingest' }) }
      } catch (error) {
        if (error instanceof IngestError) throw new HttpError(422, error.message)
        throw error
      }
    },

    async 'POST /v1/artifacts/register'(p, input) {
      if (p.role !== 'worker') throw new HttpError(403, 'only workers register artifacts')
      const head = objectStore?.head({ bucket: need(input.bucket, 'bucket'), key: need(input.key, 'key') })
      if (!head || head.sha256 !== input.sha256 || head.bytes !== input.bytes) throw new HttpError(422, 'the object is missing or does not match the declared sha256 and size')
      return scoped(p, async (c) => {
        await c.query(
          `insert into artifacts (tenant_id, project_id, artifact_id, run_id, bucket, object_key, sha256, bytes, media_type, provenance)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict do nothing`,
          [p.tenant, need(input.project_id, 'project_id'), need(input.artifact_id, 'artifact_id'), input.run_id ?? null, input.bucket, input.key, input.sha256, input.bytes, input.media_type ?? 'application/octet-stream', input.provenance ?? {}])
        return { status: 200, json: { registered: true } }
      })
    },

    // A human approval for one protected action. Nothing else can create one.
    async 'POST /v1/approvals'(p, input) {
      if (p.role !== 'human') throw new HttpError(403, 'only a human principal can approve')
      return scoped(p, async (c) => ({
        status: 201,
        json: { approval_ref: await recordHumanApproval(c, { tenant: p.tenant, project: need(input.project_id, 'project_id'), run: need(input.run_id, 'run_id'), human: p.id, action: need(input.action, 'action'), scope: need(input.scope, 'scope') }) },
      }))
    },

    async 'POST /v1/search'(p, input) {
      const project = need(input.project_id, 'project_id')
      const result = await search(pool, { tenant: p.tenant, project, agent: p.agent ?? '', principal: p.id, query: need(input.query, 'query'), mode: input.mode ?? 'hybrid', limit: Math.min(Number(input.limit ?? 10), 50), from: input.from, to: input.to, botId: input.bot_id }, embedder)
      return { status: 200, json: result }
    },
  }

  async function getRun(p, runId, project) {
    return scoped(p, async (c) => {
      const run = (await c.query('select * from runs where tenant_id = $1 and run_id = $2', [p.tenant, runId])).rows[0]
      if (!run || run.project_id !== project) throw new HttpError(404, 'no such run')
      const events = (await c.query('select event_id, kind, agent_id, occurred_at, claimed_outcome, verified_outcome, source_system, source_id, source_seq, source_sha256, trace_id from events where tenant_id = $1 and run_id = $2 order by occurred_at, source_seq', [p.tenant, runId])).rows
      const authorizations = (await c.query('select auth_id, actor, action, scope, verdict, reason, approval_ref, decided_at from authorizations where tenant_id = $1 and run_id = $2 order by decided_at', [p.tenant, runId])).rows
      const artifacts = (await c.query('select artifact_id, bucket, object_key, sha256, bytes, media_type from artifacts where tenant_id = $1 and run_id = $2', [p.tenant, runId])).rows
      return { status: 200, json: { run, events, authorizations, artifacts } }
    })
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x')
    const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)) }
    try {
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true })
      if (req.method === 'GET' && url.pathname === '/ready') return send(await ready() ? 200 : 503, { ready: await ready() })
      const raw = await body(req)
      const p = await authenticate(req, raw, url.pathname + url.search)
      const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname)
      if (req.method === 'GET' && runMatch) {
        const out = await getRun(p, decodeURIComponent(runMatch[1]), url.searchParams.get('project_id') ?? '')
        return send(out.status, out.json)
      }
      const route = routes[`${req.method} ${url.pathname}`]
      if (!route) throw new HttpError(404, 'not found')
      let input = {}
      try { input = raw === '' ? {} : JSON.parse(raw) } catch { throw new HttpError(400, 'invalid JSON') }
      const out = await route(p, input)
      return send(out.status, out.json)
    } catch (error) {
      if (error instanceof HttpError) return send(error.status, { error: error.message })
      return send(500, { error: 'internal error' })
    }
  }

  return { handle, listen: (port = 0) => new Promise(resolve => { const server = createServer(handle); server.listen(port, '127.0.0.1', () => resolve(server)) }) }
}
