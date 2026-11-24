import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install as installLedger } from '../src/host/ledger.js'
import { createBoard, parseDoorbells, channelProblem } from '../src/host/swarm-board.js'

const host = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-swarm-board-'))
  const warnings = []
  const rt = { home, readOnly: () => undefined, warn: (...args) => warnings.push(args) }
  installLedger(rt)
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  return { rt, home }
}

test('parseDoorbells extracts names, prefixes, channels, and all', () => {
  const members = [
    { name: 'coordinator' },
    { name: 'worker-1' },
    { name: 'worker-2' },
    { name: 'verifier' },
    { name: 'reviewer' },
  ]
  const channels = ['dev', 'triage']

  // Direct name
  const r1 = parseDoorbells('@verifier check this please', members, channels)
  assert.deepEqual(r1.names, ['verifier'])
  assert.equal(r1.all, false)

  // Prefix matching
  const r2 = parseDoorbells('@worker please run your slices', members, channels)
  assert.ok(r2.names.includes('worker-1'))
  assert.ok(r2.names.includes('worker-2'))
  assert.deepEqual(r2.prefixes, ['worker'])

  // All
  const r3 = parseDoorbells('hello @all team', members, channels)
  assert.equal(r3.all, true)

  // Channel & rejected #main
  const r4 = parseDoorbells('notice for @#dev and @#main', members, channels)
  assert.deepEqual(r4.channels, ['dev'])
  assert.deepEqual(r4.rejected, ['@#main'])

  // Code blocks are ignored
  const r5 = parseDoorbells('```\n@verifier inside code\n```\n@reviewer outside', members, channels)
  assert.deepEqual(r5.names, ['reviewer'])
})

test('channelProblem validates names and reserves main', () => {
  assert.ok(channelProblem('main')?.includes('Channel "main" always exists'))
  assert.ok(channelProblem('#main')?.includes('Channel "main" always exists'))
  assert.equal(channelProblem('dev-team'), undefined)
  assert.ok(channelProblem('!')?.includes('A channel name is 1-32 letters'))
})

test('board appends posts monotonically and filters readBoard', () => {
  const { rt } = host(test)
  const board = createBoard(rt.ledger, 'test-swarm-1')

  const members = [{ name: 'coordinator' }, { name: 'worker' }]
  const p1 = board.post({ agent: 'coordinator', text: '@worker start work', members })
  assert.equal(p1.seq, 1)
  assert.deepEqual(p1.wake, ['worker'])

  const p2 = board.post({ agent: 'worker', text: '@coordinator [done] ready', members })
  assert.equal(p2.seq, 2)
  assert.deepEqual(p2.wake, ['coordinator'])

  assert.equal(board.lastSeq(), 2)

  // readBoard default limit
  const rAll = board.readBoard()
  assert.equal(rAll.messages.length, 2)
  assert.equal(rAll.head, 2)

  // readBoard since
  const rSince = board.readBoard({ since: 1 })
  assert.equal(rSince.messages.length, 1)
  assert.equal(rSince.messages[0].seq, 2)

  // readBoard exact seqs
  const rSeqs = board.readBoard({ seqs: [1] })
  assert.equal(rSeqs.messages.length, 1)
  assert.equal(rSeqs.messages[0].seq, 1)
})

test('channel operations and channel-scoped visibility', () => {
  const { rt } = host(test)
  const board = createBoard(rt.ledger, 'test-swarm-ch')

  board.channelOp({ op: 'create', name: 'private-ch', by: 'coordinator', members: ['worker-1'] })
  assert.ok(board.channelNames().includes('private-ch'))
  assert.deepEqual(board.membersOf('private-ch'), ['coordinator', 'worker-1'])

  const members = [{ name: 'coordinator' }, { name: 'worker-1' }, { name: 'worker-2' }]
  board.post({ agent: 'worker-1', text: 'secret message', channel: 'private-ch', members })

  // worker-2 cannot view private-ch messages
  const v2 = board.readBoard({ viewer: 'worker-2' })
  assert.equal(v2.messages.length, 0)

  // worker-1 can view
  const v1 = board.readBoard({ viewer: 'worker-1' })
  assert.equal(v1.messages.length, 1)

  // Coordinator can always view
  const vCoord = board.readBoard({ viewer: 'coordinator', coordinator: 'coordinator' })
  assert.equal(vCoord.messages.length, 1)
})
