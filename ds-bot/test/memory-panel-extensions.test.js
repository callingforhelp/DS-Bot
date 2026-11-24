import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MEMORY_MODES, memoryModeLabel, provenanceBadges } from '../src/client/memory-panel.js'
import { EMPTY_ROSTER, createSource, indexRoster } from '../src/client/sources.js'
import { teamActions } from '../src/client/team-actions.js'

test('MEMORY_MODES covers all 4 privacy states and labels', () => {
  assert.deepEqual(MEMORY_MODES, ['on', 'silent', 'incognito', 'off'])
  assert.equal(memoryModeLabel('on'), 'On')
  assert.equal(memoryModeLabel('silent'), 'Silent')
  assert.equal(memoryModeLabel('incognito'), 'Incognito')
  assert.equal(memoryModeLabel('off'), 'Off')
})

test('provenanceBadges extracts short commit SHA, PR number, and file fallback', () => {
  assert.deepEqual(
    provenanceBadges({ commitSha: 'abcdef1234567', prNumber: 42 }),
    [
      { kind: 'commit', label: 'abcdef1', value: 'abcdef1234567' },
      { kind: 'pr', label: '#42', value: '42' },
    ],
  )
  assert.deepEqual(
    provenanceBadges({ provenance: { filePath: 'src/host/memory.js' } }),
    [{ kind: 'file', label: 'memory.js', value: 'src/host/memory.js' }],
  )
  assert.deepEqual(provenanceBadges({ text: 'plain' }), [])
})

test('indexRoster preserves swarms and artifacts and teamActions routes memory & artifact endpoints', async () => {
  const indexed = indexRoster({
    ...EMPTY_ROSTER,
    bots: [{ id: 'b1', name: 'Chief', sessionId: 'dm-1' }],
    rooms: [{ id: 'r1', name: 'Core', sessionId: 'rm-1', members: ['b1'] }],
    swarms: { sw1: { id: 'sw1', title: 'Build' } },
    artifacts: { a1: { id: 'a1', title: 'Architecture' } },
  })
  assert.equal(indexed.swarms.sw1.title, 'Build')
  assert.equal(indexed.artifacts.a1.title, 'Architecture')

  const calls = []
  const roster = createSource(indexed)
  const ui = createSource({ details: null, view: 'details' })
  const actions = teamActions({
    call: async (endpoint, body) => { calls.push([endpoint, body]); return { ok: true } },
    after: p => p,
    partFor: id => id,
    roster,
    ui,
  })
  await actions.memorySearch('b1', 'sqlite', { limit: 5 })
  await actions.memoryProvenance('b1', { kind: 'commit', value: 'abc1234' })
  await actions.setMemoryMode('dm-1', 'incognito')
  await actions.memoryImport('b1', { path: '/tmp/chat.jsonl' })
  await actions.memoryTakeover('r1', { sourceSessionId: 'old-1' })
  await actions.artifactSave({ title: 'Spec', content: 'v1' })
  await actions.artifactDelete('a1')

  assert.deepEqual(calls, [
    ['memory-search', { botId: 'b1', query: 'sqlite', limit: 5 }],
    ['memory-provenance', { botId: 'b1', kind: 'commit', value: 'abc1234' }],
    ['memory-mode', { sessionId: 'dm-1', mode: 'incognito' }],
    ['memory-import', { botId: 'b1', path: '/tmp/chat.jsonl' }],
    ['memory-takeover', { roomId: 'r1', sourceSessionId: 'old-1' }],
    ['artifact-save', { title: 'Spec', content: 'v1' }],
    ['artifact-delete', { id: 'a1' }],
  ])
})
