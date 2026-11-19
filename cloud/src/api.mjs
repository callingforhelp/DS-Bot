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

const ROLES = new Set(['user', 'human', 'worker', 'ingest'])
const READERS = new Set(['user', 'human'])
const DUMMY_SECRET = 'dummy-secret-for-unknown-principals'

// Checks a principals file before the controller starts. Errors name the principal and the
// rule broken, never the secret.
export function validatePrincipals(principals) {
  const errors = []
  if (principals === null || typeof principals !== 'object' || Array.isArray(principals)) return ['principals must be an object of id -> principal']
  const secrets = new Map()
  for (const [id, p] of Object.entries(principals)) {
    const bad = rule => errors.push(`${id}: ${rule}`)
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) bad('id must match ^[a-z0-9][a-z0-9-]{0,39}$')
    if (!ROLES.has(p?.role)) bad('role must be user, human, worker or ingest')
    if (!Array.isArray(p?.tenants) || p.tenants.length === 0 || !p.tenants.every(t => typeof t === 'string' && t !== '')) bad('tenants must be a non-empty array of strings')
    if (typeof p?.secret !== 'string' || p.secret.length < 32) bad('secret must be a string of at least 32 characters')
    else if (secrets.has(p.secret)) bad(`shares its secret with ${secrets.get(p.secret)}`)
    else secrets.set(p.secret, id)
    if (p?.role === 'ingest') {
      if (!Array.isArray(p.tenants) || p.tenants.length !== 1) bad('an ingest principal has exactly one tenant')
      if (!Array.isArray(p.sources) || p.sources.length === 0) bad('an ingest principal needs a sources array')
    }
  }
  return errors
}

// principals: { id: { secret, tenants: [...], scopes: [...], role: 'user'|'human'|'worker'|'ingest', agent?, sources?, projects? } }
// The API never runs a model. A rejected request therefore starts nothing: authentication,
// replay and scope checks all happen before the task is admitted or anything is dispatched.
// embedderFor(tenant) picks the embedder per tenant (some tenants may be kept off external providers).
export function createApi({ pool, embedder, embedderFor = () => embedder, principals, now = Date.now, skewMs = 5 * 60_000, ready = async () => true, objectStore }) {
  // /ready is unauthenticated: its database check runs at most once a second.
  let readyCache = { at: -Infinity, value: false }
  const readyOnce = async () => {
    if (now() - readyCache.at < 1000) return readyCache.value
    let value = false
    try { value = (await ready()) === true } catch { value = false }
    readyCache = { at: now(), value }
    return value
  }
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
    const id = String(req.headers['x-principal'] ?? '')
    const principal = Object.hasOwn(principals, id) ? principals[id] : undefined
    const ts = Number(req.headers['x-timestamp'])
    const nonce = String(req.headers['x-nonce'] ?? '')
    const signature = String(req.headers['x-signature'] ?? '')
    // One answer for every failure, and the same work for an unknown principal.
    const fail = () => new HttpError(401, 'unauthenticated')
    if (!Number.isFinite(ts) || !/^[A-Za-z0-9-]{16,64}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(signature)) throw fail()
    const expected = createHmac('sha256', principal?.secret ?? DUMMY_SECRET).update(canonical({ ts, nonce, method: req.method, path, raw })).digest()
    const matches = timingSafeEqual(expected, Buffer.from(signature, 'hex'))
    if (!principal || !matches) throw fail()
    if (Math.abs(now() - ts) > skewMs) throw new HttpError(401, 'stale timestamp')
    // Only a validly signed request may spend a nonce, so junk cannot fill the table.
    const fresh = await pool.query('insert into request_nonces (nonce) values ($1) on conflict do nothing', [`${id}:${nonce}`])
    if (fresh.rowCount === 0) throw new HttpError(409, 'replayed request')
    const tenant = String(req.headers['x-tenant'] ?? '')
    if (!Array.isArray(principal.tenants) || !principal.tenants.includes(tenant)) throw new HttpError(403, 'principal is not a member of this tenant')
    // The authenticated id and tenant come last, so nothing in the config can override them.
    const p = { ...principal, id, tenant }
    delete p.secret
    return p
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
      const out = await ingestOne(p, input)
      if (out.conflict) throw new HttpError(409, 'conflict')
      return { status: 200, json: out }
    },

    // A shipper's batch: in order, each in its own transaction, stopping at the first failure.
    async 'POST /v1/events/batch'(p, input) {
      if (p.role !== 'ingest') throw new HttpError(403, 'only an ingest principal sends batches')
      const events = input.events
      if (!Array.isArray(events) || events.length < 1 || events.length > 100) throw new HttpError(400, 'events must be an array of 1 to 100 envelopes')
      const results = []
      let stopped = false
      for (const env of events) {
        const event_id = typeof env?.event_id === 'string' ? env.event_id : null
        if (stopped) { results.push({ event_id, inserted: false, skipped: true }); continue }
        try {
          const out = await ingestOne(p, env ?? {})
          results.push({ event_id, inserted: out.inserted === true, ...(out.conflict ? { conflict: true } : {}) })
          if (out.conflict) stopped = true
        } catch (error) {
          if (!(error instanceof HttpError)) throw error
          results.push({ event_id, inserted: false, ...(error.status === 409 ? { conflict: true } : {}), error: error.message })
          stopped = true
        }
      }
      return { status: 200, json: { results } }
    },

    async 'POST /v1/artifacts/register'(p, input) {
      if (p.role !== 'worker') throw new HttpError(403, 'only workers register artifacts')
      const head = await objectStore?.head({ bucket: need(input.bucket, 'bucket'), key: need(input.key, 'key') })
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
      readerOnly(p)
      const project = need(input.project_id, 'project_id')
      const query = need(input.query, 'query')
      if (query.length > 2000) throw new HttpError(400, 'query is longer than 2000 characters')
      const limit = input.limit === undefined ? 10 : input.limit
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new HttpError(400, 'limit must be an integer from 1 to 50')
      const mode = input.mode ?? 'hybrid'
      if (!['lexical', 'vector', 'hybrid'].includes(mode)) throw new HttpError(400, 'mode must be lexical, vector or hybrid')
      for (const k of ['from', 'to']) if (input[k] !== undefined && (typeof input[k] !== 'string' || Number.isNaN(Date.parse(input[k])))) throw new HttpError(400, `${k} must be an ISO date`)
      const result = await search(pool, { tenant: p.tenant, project, agent: p.agent ?? '', principal: p.id, query, mode, limit, from: input.from, to: input.to, botId: input.bot_id }, embedderFor(p.tenant))
      return { status: 200, json: result }
    },
  }

  const readerOnly = p => { if (!READERS.has(p.role)) throw new HttpError(403, 'this principal cannot read the audit trail') }

  // POST /v1/events for a worker (its own runs) or an ingest principal (its listed sources).
  async function ingestOne(p, input) {
    if (p.role !== 'worker' && p.role !== 'ingest') throw new HttpError(403, 'only workers and ingest principals send events')
    // The tenant comes from the authenticated principal, never from the payload.
    if (input.tenant_id !== p.tenant) throw new HttpError(403, 'event tenant does not match the authenticated tenant')
    if (p.role === 'ingest') {
      if (!Array.isArray(p.sources) || !p.sources.includes(input.source_system)) throw new HttpError(403, 'source not permitted for this principal')
      if (Array.isArray(p.projects) && !p.projects.includes(input.project_id)) throw new HttpError(403, 'project not permitted for this principal')
    } else if (input.source_system === 'ds-bot-lineage' || String(input.event_id ?? '').startsWith('dsbot:') || input.authorization !== undefined) {
      throw new HttpError(403, 'workers cannot send DS Bot lineage events')
    }
    try {
      return await scoped(p, c => ingestEvent(c, input, { allowAuthorization: p.role === 'ingest' }), { role: 'ingest' })
    } catch (error) {
      if (error?.code === 'conflict') throw new HttpError(409, 'conflict')
      if (error instanceof IngestError) throw new HttpError(422, error.message)
      throw error
    }
  }

  // Refusals and allowances, newest first. Optional columns are read through to_jsonb so the
  // query also works on a database without migration 003.
  async function listAuthorizations(p, q) {
    readerOnly(p)
    const project = need(q.get('project_id') ?? '', 'project_id')
    const where = ['tenant_id = $1', 'project_id = $2']
    const args = [p.tenant, project]
    const add = (sql, v) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)) }
    const verdict = q.get('verdict')
    if (verdict !== null) { if (verdict !== 'allow' && verdict !== 'deny') throw new HttpError(400, 'verdict must be allow or deny'); add('verdict = ?', verdict) }
    for (const k of ['actor', 'action', 'reason']) { const v = q.get(k); if (v !== null) { if (v.length > 200) throw new HttpError(400, `${k} is too long`); add(`${k} = ?`, v) } }
    for (const [k, op] of [['from', '>='], ['to', '<=']]) {
      const v = q.get(k)
      if (v !== null) { if (Number.isNaN(Date.parse(v))) throw new HttpError(400, `${k} must be an ISO date`); add(`decided_at ${op} ?`, new Date(v).toISOString()) }
    }
    const limitRaw = q.get('limit') ?? '50'
    const limit = Number(limitRaw)
    if (!/^[0-9]+$/.test(limitRaw) || limit < 1 || limit > 200) throw new HttpError(400, 'limit must be an integer from 1 to 200')
    args.push(limit)
    return scoped(p, async c => {
      const { rows } = await c.query(
        `select auth_id, run_id, actor, action, scope, verdict, reason, decided_at,
                to_jsonb(a)->>'target' as target, to_jsonb(a)->>'room_id' as room_id, to_jsonb(a)->>'source_event_id' as source_event_id
           from authorizations a where ${where.join(' and ')} order by decided_at desc, auth_id limit $${args.length}`, args)
      return { status: 200, json: { authorizations: rows } }
    })
  }

  async function getRun(p, runId, project) {
    readerOnly(p)
    return scoped(p, async (c) => {
      const run = (await c.query('select * from runs where tenant_id = $1 and run_id = $2', [p.tenant, runId])).rows[0]
      if (!run || run.project_id !== project) throw new HttpError(404, 'no such run')
      const events = (await c.query('select event_id, kind, agent_id, occurred_at, claimed_outcome, verified_outcome, source_system, source_id, source_seq, source_sha256, trace_id, body from events where tenant_id = $1 and run_id = $2 order by occurred_at, source_seq', [p.tenant, runId])).rows
      const authorizations = (await c.query(`select auth_id, actor, action, scope, verdict, reason, approval_ref, decided_at, to_jsonb(a)->>'target' as target,
         to_jsonb(a)->>'room_id' as room_id, to_jsonb(a)->>'source_event_id' as source_event_id
         from authorizations a where tenant_id = $1 and run_id = $2 order by decided_at`, [p.tenant, runId])).rows
      const artifacts = (await c.query('select artifact_id, bucket, object_key, sha256, bytes, media_type from artifacts where tenant_id = $1 and run_id = $2', [p.tenant, runId])).rows
      return { status: 200, json: { run, events, authorizations, artifacts } }
    })
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x')
    const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)) }
    try {
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true })
      if (req.method === 'GET' && url.pathname === '/ready') { const ok = await readyOnce(); return send(ok ? 200 : 503, { ready: ok }) }
      const raw = await body(req)
      const p = await authenticate(req, raw, url.pathname + url.search)
      const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname)
      if (req.method === 'GET' && runMatch) {
        let runId
        try { runId = decodeURIComponent(runMatch[1]) } catch { throw new HttpError(400, 'bad run id') }
        const out = await getRun(p, runId, url.searchParams.get('project_id') ?? '')
        return send(out.status, out.json)
      }
      if (req.method === 'GET' && url.pathname === '/v1/authorizations') {
        const out = await listAuthorizations(p, url.searchParams)
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

  return { handle, listen: (port = 0, host = '127.0.0.1') => new Promise(resolve => { const server = createServer(handle); server.listen(port, host, () => resolve(server)) }) }
}
