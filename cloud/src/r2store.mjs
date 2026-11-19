import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')

// Object store on Cloudflare R2 (S3-compatible). Same contract as localObjectStore, but every
// call is async: objects are immutable (a key can only ever hold the same bytes), uploads need a
// short-lived token scoped to one key, and `head` re-reads the object and hashes it, so a digest is
// never taken on trust from stored metadata.
//
// UNVERIFIED against a real R2 bucket until R2 credentials exist; the tests use a fake client.
// Uploads are made by the trusted worker process, not by the sandbox (sandboxes have no network).
export function r2ObjectStore({ client, bucket, secret, now = Date.now }) {
  if (!bucket) throw new Error('R2 bucket name is required')
  const mac = (key, exp) => createHmac('sha256', secret).update(`${bucket}\n${key}\n${exp}`).digest('hex')
  const guard = (key) => {
    if (typeof key !== 'string' || key === '' || key.startsWith('/') || key.split('/').includes('..')) throw new Error('key escapes the bucket')
  }
  const read = async (key) => {
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      return Buffer.from(await res.Body.transformToByteArray())
    } catch (error) {
      if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return undefined
      throw error
    }
  }
  return {
    bucket,
    presign({ key, ttlSec = 300 }) {
      guard(key)
      const exp = Math.floor(now() / 1000) + ttlSec
      return `${exp}.${mac(key, exp)}`
    },
    async put({ key, token, bytes }) {
      guard(key)
      const [exp, signature] = String(token ?? '').split('.')
      const expected = Buffer.from(mac(key, exp))
      const given = Buffer.from(String(signature ?? '').padEnd(expected.length, ' ').slice(0, expected.length))
      if (!timingSafeEqual(expected, given) || Number(exp) < now() / 1000) throw new Error('upload token is invalid or expired for this key')
      const existing = await read(key)
      if (existing !== undefined) {
        if (sha(existing) !== sha(bytes)) throw new Error('object is immutable: the key already holds different bytes')
        return { sha256: sha(bytes), bytes: bytes.length }
      }
      // IfNoneMatch makes the store itself refuse an overwrite if two writers race.
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, IfNoneMatch: '*', Metadata: { sha256: sha(bytes) } }))
      return { sha256: sha(bytes), bytes: bytes.length }
    },
    async head({ key }) {
      guard(key)
      const body = await read(key)
      return body === undefined ? undefined : { sha256: sha(body), bytes: body.length }
    },
    async get({ key }) {
      guard(key)
      const body = await read(key)
      if (body === undefined) throw new Error('no such object')
      return body
    },
    async exists({ key }) {
      try { await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true } catch { return false }
    },
  }
}

// Builds the real client from the R2_* values in .env.
export function r2ClientFromEnv(env) {
  for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) if (!env[k]) throw new Error(`missing ${k}`)
  return new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  })
}
