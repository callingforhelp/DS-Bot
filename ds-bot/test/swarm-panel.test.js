import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  channelsOf,
  inChannel,
  mergePosts,
  postBadge,
  postParts,
  swarmCounts,
  swarmPodLabel,
  swarmsForSession,
} from '../src/client/swarm-model.js'
import { panelHasStrip } from '../src/client/side-model.js'
import { EMPTY_ROSTER, createSource, indexRoster } from '../src/client/sources.js'
import { teamActions } from '../src/client/team-actions.js'

test('swarmCounts and swarmPodLabel summarize working, waiting, and quota workers', () => {
  const swarm = {
    id: 'sw-1',
    status: 'active',
    workers: [
      { name: 'a', state: 'working' },
      { name: 'b', state: 'waiting' },
      { name: 'c', state: 'working', quota: true },
      { name: 'd', state: 'killed' },
    ],
  }
  const counts = swarmCounts(swarm)
  assert.deepEqual(counts, { working: 1, waiting: 1, quota: 1 })
  assert.equal(swarmPodLabel(counts), '1 working · 1 waiting · 1 quota')
})

test('swarmsForSession filters closed swarms and matches owner session or bot', () => {
  const swarms = {
    s1: { id: 's1', ownerSessionId: 'sess-1', status: 'active', updatedAt: 10 },
    s2: { id: 's2', ownerSessionId: 'sess-1', status: 'closed', updatedAt: 20 },
    s3: { id: 's3', ownerBotId: 'sess-1', status: 'active', updatedAt: 30 },
    s4: { id: 's4', ownerSessionId: 'sess-2', status: 'active', updatedAt: 40 },
  }
  const result = swarmsForSession(swarms, 'sess-1')
  assert.deepEqual(result.map(s => s.id), ['s3', 's1'])
})

test('postParts splits @mentions, @#channels, and #seq refs and postBadge extracts status', () => {
  const parts = postParts('@integrator @#ui [done] See #12 and #4')
  assert.deepEqual(parts, [
    { type: 'mention', value: '@integrator' },
    { type: 'text', value: ' ' },
    { type: 'mention', value: '@#ui' },
    { type: 'text', value: ' [done] See ' },
    { type: 'seq', value: '#12' },
    { type: 'text', value: ' and ' },
    { type: 'seq', value: '#4' },
  ])
  assert.equal(postBadge('@integrator [done] all good'), 'done')
  assert.equal(postBadge('@all [stall] stuck on #3'), 'stall')
  assert.equal(postBadge('[quota] 429 hit'), 'quota')
  assert.equal(postBadge('@integrator normal message'), null)
})

test('channelsOf, inChannel, and mergePosts keep monotonic seq order without duplicates', () => {
  const posts = mergePosts(
    [{ seq: 2, channel: 'ui', text: 'b' }, { seq: 1, text: 'a' }],
    [{ seq: 2, channel: 'ui', text: 'b2' }, { seq: 3, channel: 'api', text: 'c' }],
  )
  assert.deepEqual(posts.map(p => p.seq), [1, 2, 3])
  assert.equal(posts[1].text, 'b2')
  assert.deepEqual(channelsOf({ channels: ['main', 'docs'] }, posts), ['main', 'docs', 'ui', 'api'])
  assert.deepEqual(inChannel(posts, 'all').map(p => p.seq), [1, 2, 3])
  assert.deepEqual(inChannel(posts, 'main').map(p => p.seq), [1])
  assert.deepEqual(inChannel(posts, 'ui').map(p => p.seq), [2])
})

test('panelHasStrip, SWARM_CSS tokens, and teamActions swarm endpoints work cleanly', async () => {
  assert.equal(panelHasStrip(false, 0, 0, false, false), false)
  assert.equal(panelHasStrip(false, 0, 0, false, true), true)
  const swarmCss = readFileSync(new URL('../src/client/swarm-panel.js', import.meta.url), 'utf8').split('export const SWARM_CSS = `')[1] ?? ''
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(swarmCss), false, 'SWARM_CSS must use --bt-* variables only')

  const calls = []
  const roster = createSource(indexRoster({ ...EMPTY_ROSTER, bots: [{ id: 'b1', name: 'Bot', sessionId: 's1' }], swarms: { sw1: { id: 'sw1', title: 'Test' } } }))
  const ui = createSource({ details: null, view: 'details', swarm: null, task: null, side: null, tab: null, renaming: false })
  const actions = teamActions({
    call: async (endpoint, body) => { calls.push([endpoint, body]); return { ok: true } },
    after: p => p,
    partFor: id => id,
    roster,
    ui,
  })
  actions.openSwarm('s1', 'sw1')
  assert.equal(ui.getSnapshot().view, 'swarm')
  assert.equal(ui.getSnapshot().swarm, 'sw1')
  await actions.swarmRead('sw1', { since: 2 })
  await actions.swarmPost('sw1', { text: '@a hi' })
  await actions.swarmModels('sw1')
  await actions.swarmSwitchModel('sw1', 'a', 'gpt-5')
  await actions.closeSwarm('sw1')
  assert.deepEqual(calls.map(c => c[0]), ['swarm-read', 'swarm-post', 'swarm-models', 'swarm-switch-model', 'swarm-close'])
  actions.closeSwarmView()
  assert.equal(ui.getSnapshot().view, 'details')
  assert.equal(ui.getSnapshot().swarm, null)
})
