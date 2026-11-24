import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as artifacts from '../src/host/artifacts.js'
import * as ingest from '../src/host/ingest.js'
import * as memoryEmbeddings from '../src/host/memory-embeddings.js'
import * as memoryIndex from '../src/host/memory-index.js'
import * as memoryPrivacy from '../src/host/memory-privacy.js'
import * as privacy from '../src/host/privacy.js'
import * as takeover from '../src/host/takeover.js'

function createTestRuntime(t, { memoryMode = 'on' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-ingest-priv-test-'))
  const disposers = []
  const rt = {
    home,
    state: {
      prefs: { memoryMode },
      bots: {
        b1: { id: 'b1', name: 'Public Bot' },
        'b-priv': { id: 'b-priv', name: 'Private Bot', private: true },
      },
      rooms: {},
      capabilities: { items: {} },
      artifacts: {},
    },
    teamTools: [],
    botOf: (id) => rt.state.bots[id],
    isPrivate: (id) => rt.state.bots[id]?.private === true,
    isMain: () => false,
    redactSecrets: (text) => String(text).replace(/sk-[a-zA-Z0-9]{20,}/g, '[REDACTED_KEY]'),
    ctx: {
      on: () => () => {},
      effect: (fn) => {
        const cleanup = fn()
        if (typeof cleanup === 'function') disposers.push(cleanup)
      },
    },
    load: async () => {},
    save: async () => {},
    warn: () => {},
  }

  privacy.install(rt)
  memoryPrivacy.install(rt)
  memoryEmbeddings.install(rt)
  memoryIndex.install(rt)
  ingest.install(rt)
  artifacts.install(rt)
  takeover.install(rt)

  t.after(async () => {
    for (const d of disposers) await d()
    rmSync(home, { recursive: true, force: true })
  })
  return rt
}

test('stripPrivateSpans and sanitizeText remove private spans and secrets', () => {
  const raw = 'Public prefix <private>secret auth token: 12345</private> and public suffix'
  const stripped = ingest.stripPrivateSpans(raw)
  assert.equal(stripped, 'Public prefix  and public suffix')

  const unclosed = 'Note before <private>sensitive trailing data'
  assert.equal(ingest.stripPrivateSpans(unclosed), 'Note before ')

  // Line with secret password given is dropped by sanitizeText
  const secretText = 'Task update:\npassword is SuperSecretPassword123!\nFinished step 1.'
  const clean = ingest.sanitizeText(secretText)
  assert.ok(!clean.includes('SuperSecretPassword123'))
  assert.ok(clean.includes('Task update:'))
  assert.ok(clean.includes('Finished step 1.'))
})

test('memory modes govern read, inject, and write permissions', async t => {
  const rt = createTestRuntime(t)

  // Default 'on': all allowed
  assert.equal(rt.resolveMemoryMode({ botId: 'b1' }), 'on')
  assert.equal(rt.canReadMemory({ botId: 'b1' }), true)
  assert.equal(rt.canInjectMemory({ botId: 'b1' }), true)
  assert.equal(rt.canWriteMemory({ botId: 'b1' }), true)

  // Set mode to 'incognito': read + inject allowed, write blocked
  await rt.setMemoryMode({ scope: 'bot', id: 'b1', mode: 'incognito' })
  assert.equal(rt.resolveMemoryMode({ botId: 'b1' }), 'incognito')
  assert.equal(rt.canReadMemory({ botId: 'b1' }), true)
  assert.equal(rt.canInjectMemory({ botId: 'b1' }), true)
  assert.equal(rt.canWriteMemory({ botId: 'b1' }), false)

  // Ingest observation respects write restriction
  const resIncognito = rt.ingestObservation({
    botId: 'b1',
    title: 'Secret discovery',
    summary: 'Should not be stored',
  })
  assert.equal(resIncognito.inserted, false)
  assert.equal(resIncognito.skipped, 'mode')

  // Set mode to 'silent': read + write allowed, inject blocked
  await rt.setMemoryMode({ scope: 'bot', id: 'b1', mode: 'silent' })
  assert.equal(rt.resolveMemoryMode({ botId: 'b1' }), 'silent')
  assert.equal(rt.canReadMemory({ botId: 'b1' }), true)
  assert.equal(rt.canInjectMemory({ botId: 'b1' }), false)
  assert.equal(rt.canWriteMemory({ botId: 'b1' }), true)

  // Set mode to 'off': all blocked
  await rt.setMemoryMode({ scope: 'bot', id: 'b1', mode: 'off' })
  assert.equal(rt.resolveMemoryMode({ botId: 'b1' }), 'off')
  assert.equal(rt.canReadMemory({ botId: 'b1' }), false)
  assert.equal(rt.canInjectMemory({ botId: 'b1' }), false)
  assert.equal(rt.canWriteMemory({ botId: 'b1' }), false)
})

test('ingestObservation sanitizes text and deduplicates idempotently', async t => {
  const rt = createTestRuntime(t)

  const res = rt.ingestObservation({
    botId: 'b1',
    sessionId: 'sess-1',
    idempotencyKey: 'idem-obs-1',
    title: 'Deploy to prod <private>admin_token</private>',
    summary: 'Deployed release v1.0.0 with key sk-1234567890123456789012345',
    facts: ['Zero downtime achieved'],
  })
  assert.equal(res.inserted, true)
  assert.equal(res.skipped, undefined)

  // Search doc created by observation: private span stripped and secret redacted
  const doc = rt.memoryIndexGet(res.id)
  assert.ok(doc)
  assert.ok(!doc.title.includes('admin_token'))
  assert.ok(!doc.body.includes('sk-1234567890123456789012345'))

  // Second ingest with same idempotencyKey is recognized as duplicate
  const dup = rt.ingestObservation({
    botId: 'b1',
    sessionId: 'sess-1',
    idempotencyKey: 'idem-obs-1',
    title: 'Duplicate deploy',
    summary: 'Duplicate content',
  })
  assert.equal(dup.inserted, false)
  assert.equal(dup.duplicate, true)
})

test('takeover and artifacts respect privacy isolation', async t => {
  const rt = createTestRuntime(t)

  // Save an artifact
  const art = await rt.saveArtifact({
    slug: 'api-spec',
    title: 'API Specification',
    kind: 'spec',
    content: 'Public REST endpoints for the service',
  }, { botId: 'b1' })
  assert.equal(art.slug, 'api-spec')

  // Ingest an observation for private bot
  rt.ingestObservation({
    botId: 'b-priv',
    title: 'Private bot notes',
    summary: 'Confidential insight',
  })

  // Export takeover bundle without private bot leaks
  const bundle = await rt.exportTakeoverBundle({ botId: 'b1' })
  assert.ok(Array.isArray(bundle.artifacts))
  assert.ok(bundle.artifacts.some(a => a.slug === 'api-spec'))

  // Observations in public bundle do not contain b-priv observations
  const obsTitles = bundle.observations.map(o => o.title)
  assert.ok(!obsTitles.includes('Private bot notes'))
})
