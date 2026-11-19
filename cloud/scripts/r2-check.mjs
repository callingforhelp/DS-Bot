// Verifies the R2 object store against the REAL bucket: write, read back, digest, immutability,
// the conditional-write guard, token rules. Uses one tiny object under a unique prefix and deletes
// it at the end. Prints PASS/FAIL lines only; never prints credentials.
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { ROOT } from './pg.mjs'
import { r2ClientFromEnv, r2ObjectStore } from '../src/r2store.mjs'
import { loadEnv } from '../src/remote.mjs'

const env = loadEnv(join(ROOT, '.env'))
const client = r2ClientFromEnv(env)
const store = r2ObjectStore({ client, bucket: env.R2_BUCKET, secret: randomBytes(16).toString('hex') })
const key = `r2-check/${randomBytes(4).toString('hex')}/result.json`
const out = []
const check = (name, ok, extra = '') => { out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!ok) process.exitCode = 1 }
const rejects = async (fn, pattern) => { try { await fn(); return false } catch (e) { return pattern.test(String(e.message)) } }
const bytes = Buffer.from(JSON.stringify({ words: 3, check: randomBytes(4).toString('hex') }))
const digest = createHash('sha256').update(bytes).digest('hex')

try {
  const put = await store.put({ key, token: store.presign({ key }), bytes })
  check('write to the real bucket', put.sha256 === digest && put.bytes === bytes.length, `${put.bytes} bytes`)
  const head = await store.head({ key })
  check('digest recomputed from the stored bytes matches', head?.sha256 === digest)
  check('read back identical bytes', (await store.get({ key })).equals(bytes))
  const again = await store.put({ key, token: store.presign({ key }), bytes })
  check('writing the same bytes again is a no-op', again.sha256 === digest)
  check('writing different bytes to the same key is refused', await rejects(() => store.put({ key, token: store.presign({ key }), bytes: Buffer.from('different') }), /immutable/))
  // Does R2 itself honour the conditional write, so two racing writers cannot overwrite?
  let status
  try { await client.send(new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key, Body: Buffer.from('overwrite attempt'), IfNoneMatch: '*' })) } catch (e) { status = e?.$metadata?.httpStatusCode ?? e?.name }
  check('R2 enforces If-None-Match on writes (a raw overwrite is refused)', status === 412, `status ${status}`)
  check('the object is unchanged after the attempted overwrite', (await store.head({ key }))?.sha256 === digest)
  check('a token for another key is refused', await rejects(() => store.put({ key: `${key}.other`, token: store.presign({ key }), bytes }), /token/))
  check('a path-escaping key is refused', await rejects(async () => store.presign({ key: '../escape' }), /escapes/))
  check('a missing object reads as absent', (await store.head({ key: `${key}.missing` })) === undefined)
} catch (error) {
  check('R2 check completed without error', false, `${error.name}: ${String(error.message).slice(0, 140)}`)
} finally {
  let removed = false
  try { await client.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key })); removed = (await store.head({ key })) === undefined } catch { removed = false }
  out.push(`${removed ? 'PASS' : 'FAIL'}  test object removed  (${key})`)
  if (!removed) process.exitCode = 1
  console.log(out.join('\n'))
}
