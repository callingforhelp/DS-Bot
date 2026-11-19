import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const missingObject = error => error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404
const maxUploadTtlSec = 300

// Object store on Cloudflare R2 (S3-compatible). Same contract as localObjectStore, but every
// call is async: objects are immutable (a key can only ever hold the same bytes), uploads need a
// short-lived token scoped to one key, and `head` re-reads the object and hashes it, so a digest is
// never taken on trust from stored metadata.
//
// Uploads are made by the trusted worker process, not by the sandbox (sandboxes have no network).
export function r2ObjectStore({ client, bucket, secret, now = Date.now }) {
  if (!bucket) throw new Error('R2 bucket name is required')
  const mac = (key, exp) => createHmac('sha256', secret).update(`${bucket}\n${key}\n${exp}`).digest('hex')
  const guard = (key, requestedBucket) => {
    if (requestedBucket !== bucket) throw new Error('bucket does not match the configured R2 bucket')
    if (typeof key !== 'string' || key === '' || key.startsWith('/') || key.split('/').includes('..')) throw new Error('key escapes the bucket')
  }
  const read = async (key) => {
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      return Buffer.from(await res.Body.transformToByteArray())
    } catch (error) {
      if (missingObject(error)) return undefined
      throw error
    }
  }
  return {
    bucket,
    presign({ bucket: requestedBucket = bucket, key, ttlSec = maxUploadTtlSec }) {
      guard(key, requestedBucket)
      if (!Number.isInteger(ttlSec) || ttlSec < 1 || ttlSec > maxUploadTtlSec) throw new Error('upload token TTL must be between 1 and 300 seconds')
      const exp = Math.floor(now() / 1000) + ttlSec
      return `${exp}.${mac(key, exp)}`
    },
    async put({ bucket: requestedBucket = bucket, key, token, bytes }) {
      guard(key, requestedBucket)
      const match = typeof token === 'string' && /^(\d{1,15})\.([a-f0-9]{64})$/.exec(token)
      if (!match || match[0] !== token || Number(match[1]) <= Math.floor(now() / 1000)
        || !timingSafeEqual(Buffer.from(mac(key, match[1]), 'hex'), Buffer.from(match[2], 'hex'))) {
        throw new Error('upload token is invalid or expired for this key')
      }
      const digest = sha(bytes)
      try {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, IfNoneMatch: '*', Metadata: { sha256: digest } }))
      } catch (error) {
        if (error?.name !== 'PreconditionFailed' && error?.$metadata?.httpStatusCode !== 412) throw error
        const existing = await read(key)
        if (existing === undefined) throw error
        if (sha(existing) !== digest) throw new Error('object is immutable: the key already holds different bytes')
      }
      return { sha256: digest, bytes: bytes.length }
    },
    async head({ bucket: requestedBucket = bucket, key }) {
      if (requestedBucket !== bucket) return undefined
      guard(key, requestedBucket)
      const body = await read(key)
      return body === undefined ? undefined : { sha256: sha(body), bytes: body.length }
    },
    async get({ bucket: requestedBucket = bucket, key }) {
      guard(key, requestedBucket)
      const body = await read(key)
      if (body === undefined) throw new Error('no such object')
      return body
    },
    async exists({ bucket: requestedBucket = bucket, key }) {
      if (requestedBucket !== bucket) return false
      guard(key, requestedBucket)
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
        return true
      } catch (error) {
        if (missingObject(error)) return false
        throw error
      }
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
    // The SDK's default CRC32 is not supported by R2 as a full-object checksum.
    requestChecksumCalculation: 'WHEN_REQUIRED',
  })
}
