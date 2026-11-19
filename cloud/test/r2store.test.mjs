import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createApi } from '../src/api.mjs'
import { apiClient } from '../src/client.mjs'
import { mockEmbedder } from '../src/embed.mjs'
import { r2ObjectStore } from '../src/r2store.mjs'
import { mockDaytona, runJob } from '../src/worker.mjs'
import { freshDb } from './helpers.mjs'

// An in-memory stand-in for the S3 client R2 speaks to. It honours the one conditional the store
// relies on (IfNoneMatch '*') the way S3 and R2 document it. NOT a substitute for the real bucket.
function fakeS3() {
  const objects = new Map()
  const sent = []
  return {
    objects,
    sent,
    async send(cmd) {
      const { Key, Body, IfNoneMatch } = cmd.input
      const kind = cmd.constructor.name
      sent.push([kind, Key, IfNoneMatch])
      if (kind === 'PutObjectCommand') {
        if (IfNoneMatch === '*' && objects.has(Key)) throw Object.assign(new Error('precondition failed'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } })
        objects.set(Key, Buffer.from(Body))
        return {}
      }
      if (!objects.has(Key)) throw Object.assign(new Error('missing'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } })
      if (kind === 'HeadObjectCommand') return { ContentLength: objects.get(Key).length }
      return { Body: { transformToByteArray: async () => new Uint8Array(objects.get(Key)) } }
    },
  }
}

test('R2 store: tokens, immutability and key safety', async () => {
  const s3 = fakeS3()
  const store = r2ObjectStore({ client: s3, bucket: 'b', secret: 's' })
  const token = store.presign({ key: 't1/p/r/file' })
  const put = await store.put({ key: 't1/p/r/file', token, bytes: Buffer.from('hello') })
  assert.equal(put.bytes, 5)
  assert.deepEqual(s3.sent.at(-1).slice(0, 3), ['PutObjectCommand', 't1/p/r/file', '*'], 'the write is conditional: a racing writer cannot overwrite')
  assert.deepEqual(await store.put({ key: 't1/p/r/file', token, bytes: Buffer.from('hello') }), put, 'the same bytes again is a no-op')
  await assert.rejects(store.put({ key: 't1/p/r/file', token, bytes: Buffer.from('different') }), /immutable/)
  await assert.rejects(store.put({ key: 't1/p/other', token, bytes: Buffer.from('x') }), /token/, 'a token is good for one key only')
  assert.throws(() => store.presign({ key: '../escape' }), /escapes/)
  assert.throws(() => store.presign({ key: '/abs' }), /escapes/)
  const expired = r2ObjectStore({ client: s3, bucket: 'b', secret: 's', now: () => 0 }).presign({ key: 'k', ttlSec: 1 })
  await assert.rejects(store.put({ key: 'k', token: expired, bytes: Buffer.from('x') }), /expired|invalid/)
  assert.equal(await store.head({ key: 'nope' }), undefined)
})

test('R2 store: a digest is recomputed from the bytes, never taken from metadata', async () => {
  const s3 = fakeS3()
  const store = r2ObjectStore({ client: s3, bucket: 'b', secret: 's' })
  const put = await store.put({ key: 'k', token: store.presign({ key: 'k' }), bytes: Buffer.from('original') })
  assert.equal((await store.head({ key: 'k' })).sha256, put.sha256)
  s3.objects.set('k', Buffer.from('tampered'))
  assert.notEqual((await store.head({ key: 'k' })).sha256, put.sha256, 'tampering with the stored object changes the digest the API sees')
})

test('R2 store: concurrent writes of identical bytes succeed and different bytes remain immutable', async () => {
  const s3 = fakeS3()
  const store = r2ObjectStore({ client: s3, bucket: 'b', secret: 's' })
  const key = 'concurrent'
  const token = store.presign({ key })
  const bytes = Buffer.from('first')
  const [first, duplicate, conflicting] = await Promise.allSettled([
    store.put({ key, token, bytes }),
    store.put({ key, token, bytes }),
    store.put({ key, token, bytes: Buffer.from('other') }),
  ])
  assert.equal(first.status, 'fulfilled')
  assert.deepEqual(duplicate, first)
  assert.equal(conflicting.status, 'rejected')
  assert.match(conflicting.reason.message, /immutable/)
  assert.deepEqual(await store.get({ key }), bytes)
})

test('R2 store: only intact tokens within their TTL and bucket can write', async () => {
  const s3 = fakeS3()
  let clock = 0
  const store = r2ObjectStore({ client: s3, bucket: 'b', secret: 's', now: () => clock })
  const key = 'test'
  const token = store.presign({ key, ttlSec: 1 })
  const bytes = Buffer.from('test')
  for (const ttlSec of [0, 301, 1.5, Infinity, '1']) assert.throws(() => store.presign({ key, ttlSec }), /TTL/)
  for (const suffix of ['f', '.extra', '\n', 'é']) {
    await assert.rejects(store.put({ key, token: token + suffix, bytes }), /token/)
  }
  await assert.rejects(store.put({ bucket: 'other', key, token, bytes }), /bucket/)
  await store.put({ key, token, bytes })
  clock = 1000
  await assert.rejects(store.put({ key, token, bytes }), /expired/)
})

let db
let server
let base
before(async () => { db = await freshDb() })
after(async () => { server?.close(); await db.drop() })

test('the full task flow works on the R2 store, and a tampered object is refused at registration', async () => {
  const s3 = fakeS3()
  const store = r2ObjectStore({ client: s3, bucket: 'artifacts-bucket', secret: 's' })
  const principals = {
    alice: { secret: 'a', tenants: ['t1'], scopes: ['read-only'], role: 'user' },
    worker: { secret: 'w', tenants: ['t1'], scopes: [], role: 'worker' },
  }
  server = await createApi({ pool: db.pool, embedder: mockEmbedder(), principals, objectStore: store }).listen(0)
  base = `http://127.0.0.1:${server.address().port}`
  const as = who => apiClient({ baseUrl: base, principal: who, secret: principals[who].secret, tenant: 't1' })
  const done = await runJob({
    provider: mockDaytona(), objectStore: store, api: as('worker'), bucket: store.bucket,
    task: { tenant: 't1', project: 'p', run_id: 'run-r2', job: { kind: 'readonly.summarize', payload: { text: 'a b c' } } },
  })
  assert.equal(done.artifact.bucket, 'artifacts-bucket')
  const timeline = await as('alice')('GET', '/v1/runs/run-r2?project_id=p')
  assert.equal(timeline.status, 200)
  const [artifact] = timeline.body.artifacts
  assert.equal(artifact.sha256, (await store.head({ key: artifact.object_key })).sha256)
  const register = {
    project_id: 'p', run_id: 'run-r2', artifact_id: 'second', bucket: artifact.bucket,
    key: artifact.object_key, sha256: artifact.sha256, bytes: artifact.bytes,
  }
  const wrongBucket = await as('worker')('POST', '/v1/artifacts/register', { ...register, bucket: 'other' })
  assert.equal(wrongBucket.status, 422, 'an object in R2 cannot be registered under a different bucket')
  s3.objects.set(artifact.object_key, Buffer.from('swapped after the fact'))
  const again = await as('worker')('POST', '/v1/artifacts/register', register)
  assert.equal(again.status, 422, 'registration re-reads the object, so a swapped object is refused')
})
