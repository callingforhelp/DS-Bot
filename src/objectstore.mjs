import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')

// A local stand-in for S3/R2 with the properties the design relies on: objects are
// immutable (the same key can only ever hold the same bytes), uploads are authorized by a
// short-lived token scoped to one key, and the sandbox never sees the store's root or secret.
// UNVERIFIED against real S3/R2: pre-signed URLs and bucket policy are replaced by this.
export function localObjectStore({ root, secret, now = Date.now }) {
  const pathOf = (bucket, key) => {
    const full = resolve(root, bucket, key)
    if (!full.startsWith(resolve(root, bucket) + sep)) throw new Error('key escapes the bucket')
    return full
  }
  const mac = (bucket, key, exp) => createHmac('sha256', secret).update(`${bucket}\n${key}\n${exp}`).digest('hex')
  return {
    presign({ bucket, key, ttlSec = 300 }) {
      const exp = Math.floor(now() / 1000) + ttlSec
      return `${exp}.${mac(bucket, key, exp)}`
    },
    put({ bucket, key, token, bytes }) {
      const [exp, signature] = String(token ?? '').split('.')
      const expected = Buffer.from(mac(bucket, key, exp))
      const given = Buffer.from(String(signature ?? '').padEnd(expected.length, ' ').slice(0, expected.length))
      if (!timingSafeEqual(expected, given) || Number(exp) < now() / 1000) throw new Error('upload token is invalid or expired for this key')
      const file = pathOf(bucket, key)
      if (existsSync(file) && sha(readFileSync(file)) !== sha(bytes)) throw new Error('object is immutable: the key already holds different bytes')
      mkdirSync(dirname(file), { recursive: true })
      if (!existsSync(file)) writeFileSync(file, bytes)
      return { sha256: sha(bytes), bytes: bytes.length }
    },
    head({ bucket, key }) {
      const file = pathOf(bucket, key)
      if (!existsSync(file)) return undefined
      return { sha256: sha(readFileSync(file)), bytes: statSync(file).size }
    },
    get({ bucket, key }) { return readFileSync(pathOf(bucket, key)) },
  }
}
