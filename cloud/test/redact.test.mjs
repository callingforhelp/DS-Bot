import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { chunk, redact } from '../src/redact.mjs'

// All values below are synthetic.
const hex = n => '0123456789abcdef'.repeat(Math.ceil(n / 16)).slice(0, n)

test('redaction stays fast on hostile input (no quadratic rules)', () => {
  const cases = {
    'a.': 'a.'.repeat(100_000),
    'a+': 'a+'.repeat(100_000),
    'a@': 'a@'.repeat(100_000),
    'pem without END': `-----BEGIN RSA PRIVATE KEY-----${'a'.repeat(200_000)}`,
    'A1b': 'A1b'.repeat(70_000),
    'PASSWORDx': 'PASSWORDX'.repeat(20_000),
    'eyJ.': 'eyJaaaaaaaaa.'.repeat(20_000),
    'x://': 'ab://'.repeat(40_000),
  }
  for (const [name, input] of Object.entries(cases)) {
    const t0 = performance.now()
    redact(input)
    const ms = performance.now() - t0
    assert.ok(ms < 150, `${name} took ${ms.toFixed(1)} ms`)
  }
})

test('secret shapes are redacted', () => {
  const aws40 = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12'
  const positives = {
    PGPASSWORD: 'PGPASSWORD=s3cretvalue',
    DS_BOT_DB_PASSWORD: 'DS_BOT_DB_PASSWORD=s3cretvalue',
    R2_SECRET: `R2_SECRET_ACCESS_KEY=${hex(64)}`,
    DAYTONA: 'DAYTONA_API_KEY=dtn_s3cretvalue',
    client_secret: 'client_secret: s3cretvalue',
    access_token: 'access_token=s3cretvalue',
    json_password: '{"password": "s3cretvalue"}',
    json_token: '{"access_token":"s3cretvalue"}',
    aws_secret: `aws_secret_access_key = ${aws40}`,
    asia: 'key ASIAABCDEFGHIJKLMNOP used',
    ghu: `token ghu_${'Ab1'.repeat(12)}`,
    ghr: `ghr_${'Ab1'.repeat(12)}`,
    slack: 'xoxb-1234567890-abcdefghij',
    google: `AIza${'A1b_c-D2e3'.repeat(4).slice(0, 35)}`,
    stripe: 'sk_live_abcdefgh12345678',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJlc2lnbmF0dXJl',
    basic: 'Authorization: Basic dXNlcjpzM2NyZXR2YWx1ZQ==',
    pg_url: 'postgres://appuser:s3cretvalue@127.0.0.1:5432/db',
    pgp: '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF s3cretvalue\n-----END PGP PRIVATE KEY BLOCK-----',
    pem_no_end: '-----BEGIN PRIVATE KEY-----\nMIIEvQ s3cretvalue',
    base64url: 'link token Q2xhdWRlU3ludGhldGljVG9rZW4xMjM0NTY3ODkwX3h5eg',
  }
  const leaks = { aws_secret: aws40, asia: 'ASIAABCDEFGHIJKLMNOP', ghu: 'ghu_', ghr: 'ghr_', slack: 'xoxb-', google: 'AIza', stripe: 'sk_live_', jwt: 'eyJ', basic: 'dXNlcjpzM2NyZXR2YWx1ZQ', base64url: 'Q2xhdWRl', R2_SECRET: hex(64) }
  for (const [name, input] of Object.entries(positives)) {
    const out = redact(input)
    assert.doesNotMatch(out, /s3cretvalue/, `${name}: ${out}`)
    if (leaks[name]) assert.ok(!out.includes(leaks[name]), `${name} leaked: ${out}`)
    assert.match(out, /redacted/, name)
  }
})

test('audit text, reason codes, digests and ids are left alone', () => {
  const negatives = [
    'authorization denied message_bot by Chief to Writer in Desk: recipient-not-selected',
    'commit 9f8e7d6c',
    `commit ${hex(40)}`,
    '3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f',
    `dsbot:aws-staging:auth:${hex(40)}:r2`,
    'task-turn-limit',
    'the token was refused',
    'the secret is out',
  ]
  for (const text of negatives) assert.equal(redact(text), text)
})

test('a multi-word value is only partly redacted (documented floor)', () => {
  const out = redact('password: correct horse battery staple')
  assert.doesNotMatch(out, /correct/)
  assert.match(out, /^password=\[redacted\]/)
})

test('emails are redacted, including subdomains, and chunking is unchanged', () => {
  assert.equal(redact('mail a.b+c@mail.example.co.uk now'), 'mail [redacted:email] now')
  assert.deepEqual(chunk('one. two', 800), ['one. two'])
})
