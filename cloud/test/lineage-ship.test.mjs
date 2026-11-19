import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { shipOnce } from '../src/lineage/ship.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'ship-'))
const envs = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ event_id: `dsbot:test:auth:${from + i}:r1`, source_sha256: 'a'.repeat(64), body: { summary: `secret summary Writer ${from + i}`, ref: 'session:s#seq:1' } }))
function fakeApi({ conflictAt, batch404 = false } = {}) {
  const calls = []
  const stored = new Set()
  const post = async (method, path, body) => {
    calls.push({ path, n: body.events?.length ?? 1 })
    if (path === '/v1/events/batch') {
      if (batch404) return { status: 404, body: { error: 'not found' } }
      const results = []
      let stop = false
      for (const e of body.events) {
        if (stop) { results.push({ event_id: e.event_id, inserted: false, skipped: true }); continue }
        if (e.event_id === conflictAt) { results.push({ event_id: e.event_id, inserted: false, conflict: true }); stop = true; continue }
        results.push({ event_id: e.event_id, inserted: !stored.has(e.event_id) }); stored.add(e.event_id)
      }
      return { status: 200, body: { results } }
    }
    if (body.event_id === conflictAt) return { status: 409, body: { error: 'conflict' } }
    const inserted = !stored.has(body.event_id); stored.add(body.event_id)
    return { status: 200, body: { inserted } }
  }
  return { post, calls }
}

test('a second pass sends nothing new', async () => {
  const statePath = join(tmp(), 'shipped.sqlite')
  const api = fakeApi()
  const first = await shipOnce({ envelopes: envs(3), statePath, post: api.post })
  assert.deepEqual([first.sent, first.inserted], [3, 3])
  const second = await shipOnce({ envelopes: envs(3), statePath, post: api.post })
  assert.equal(second.sent, 0)
})

test('a conflict stops the pass; the next pass resumes from the conflicting item', async () => {
  const statePath = join(tmp(), 'shipped.sqlite')
  const items = envs(3)
  const api = fakeApi({ conflictAt: items[1].event_id })
  const first = await shipOnce({ envelopes: items, statePath, post: api.post })
  assert.deepEqual([first.inserted, first.conflicts], [1, 1])
  const fixed = fakeApi()
  const second = await shipOnce({ envelopes: items, statePath, post: fixed.post })
  assert.equal(second.sent, 2, 'items 2 and 3 are sent again')
})

test('without the batch route it falls back to one event per request', async () => {
  const statePath = join(tmp(), 'shipped.sqlite')
  const api = fakeApi({ batch404: true })
  const r = await shipOnce({ envelopes: envs(3), statePath, post: api.post })
  assert.deepEqual([r.sent, r.inserted], [3, 3])
  assert.deepEqual(api.calls.map(c => c.path), ['/v1/events/batch', '/v1/events', '/v1/events', '/v1/events'])
})

test('250 envelopes go out as batches of 100, 100 and 50, and logs carry no content', async () => {
  const statePath = join(tmp(), 'shipped.sqlite')
  const api = fakeApi()
  const lines = []
  await shipOnce({ envelopes: envs(250), statePath, post: api.post, log: l => lines.push(l) })
  assert.deepEqual(api.calls.map(c => c.n), [100, 100, 50])
  const conflict = fakeApi({ conflictAt: envs(1, 300)[0].event_id })
  await shipOnce({ envelopes: envs(2, 300), statePath, post: conflict.post, log: l => lines.push(l) })
  assert.ok(lines.length > 0)
  for (const l of lines) assert.doesNotMatch(l, /secret|Writer|session:|dsbot:/)
})

test('the sidecar refuses an archive inside the DS Bot home before reading any secret', () => {
  const dir = tmp()
  const sidecar = fileURLToPath(new URL('../src/lineage-sidecar.mjs', import.meta.url))
  const r = spawnSync(process.execPath, [sidecar], { encoding: 'utf8', env: { ...process.env, LINEAGE_HOME: dir, LINEAGE_DB: join(dir, 'l.sqlite'), LINEAGE_PRINCIPAL_FILE: join(dir, 'does-not-exist.json'), INSTALL_ID: 'test', TENANT: 't', PROJECT: 'p' } })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /LINEAGE_DB must be outside LINEAGE_HOME/)
  writeFileSync(join(dir, 'unused'), '')
})
