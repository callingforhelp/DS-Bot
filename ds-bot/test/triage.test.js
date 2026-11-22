import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { triageBank } from '../src/host/triage.js'

test('triage ranks Chinese cases, learns misroutes and reviews once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ds-triage-'))
  const bank = triageBank(dir)
  const call = async args => JSON.parse(await bank(args))
  try {
    assert.deepEqual((await call({ action: 'recall', query: '退款' })).cases, [])
    const entry = { action: 'log', customer: '客户', routed_to: '售后', reason: '专业处理' }
    const first = await call({ ...entry, summary: '退款申请发票' })
    await call({ ...entry, summary: '机械零件加工报价' })
    const recalled = await call({ action: 'recall', query: '退款申请' })
    assert.equal(recalled.cases[0].id, first.id)
    await call({ action: 'outcome', id: first.id, result: 'misrouted', lesson: '退款申请交给财务', correct_route: '财务' })
    assert.equal((await call({ action: 'recall', query: '退款申请' })).rules.length, 1)
    const review = await call({ action: 'review' })
    assert.equal(review.cases.length, 2)
    assert.equal(review.misroutes.length, 1)
    assert.equal(review.rules[0].hits, 1)
    assert.equal((await call({ action: 'review' })).cases.length, 0)
    const persisted = triageBank(dir)
    assert.equal(JSON.parse(await persisted({ action: 'rules', rule_action: 'list' })).length, 1)
    await call({ action: 'rules', rule_action: 'remove', id: review.rules[0].id })
    assert.deepEqual(await call({ action: 'rules', rule_action: 'list' }), [])
    await assert.rejects(bank({ action: 'outcome', id: 'missing', result: 'correct' }), /not found/)
    await assert.rejects(bank({ action: 'log' }), /required/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('triage evicts oldest cases when a new case reaches the byte limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ds-triage-'))
  try {
    const limit = 16 * 1024 * 1024
    const entry = { customer: 'c'.repeat(4000), summary: 's'.repeat(4000), attachments_summary: 'a'.repeat(4000), routed_to: 'r'.repeat(4000), reason: 'w'.repeat(4000) }
    const line = JSON.stringify({ ...entry, id: 'oldest' }) + '\n'
    const count = Math.floor(limit / Buffer.byteLength(line))
    const path = join(dir, 'triage', 'cases.jsonl')
    await mkdir(join(dir, 'triage'))
    await writeFile(path, line.repeat(count))
    const bank = triageBank(dir)
    const result = JSON.parse(await bank({ action: 'log', ...entry }))
    const cases = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(cases.length, count)
    assert.equal(cases.at(-1).id, result.id)
    assert.ok((await stat(path)).size <= limit)
    assert.equal(cases.filter(item => item.id === 'oldest').length, count - 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('triage review retains misroutes that were subsequently resolved', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  const dir = await mkdtemp(join(tmpdir(), 'ds-triage-'))
  const bank = triageBank(dir)
  const call = async args => JSON.parse(await bank(args))
  try {
    const { id } = await call({ action: 'log', customer: 'c', summary: 'part', routed_to: 'sales', reason: 'quote' })
    t.mock.timers.setTime(1500)
    await call({ action: 'review' })
    t.mock.timers.setTime(2000)
    await call({ action: 'outcome', id, result: 'misrouted', correct_route: 'engineering', lesson: 'Check the drawing' })
    t.mock.timers.setTime(3000)
    await call({ action: 'outcome', id, result: 'resolved' })
    t.mock.timers.setTime(4000)
    const review = JSON.parse(await triageBank(dir)({ action: 'review' }))
    assert.deepEqual(review.cases, [])
    assert.equal(review.misroutes.length, 1)
    assert.equal(review.misroutes[0].outcome.result, 'resolved')
    assert.equal(review.misroutes[0].misrouted_at, 2000)
    assert.deepEqual(review.misroutes[0].misroute, { at: 2000, correct_route: 'engineering', lesson: 'Check the drawing' })
    const stored = JSON.parse((await readFile(join(dir, 'triage', 'cases.jsonl'), 'utf8')).trim())
    assert.deepEqual(stored.misroute, review.misroutes[0].misroute)
    assert.equal(stored.misroute.result, undefined)
    assert.deepEqual((await call({ action: 'review' })).misroutes, [])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('triage outcome writes evict oldest cases and compact legacy misroute records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ds-triage-'))
  try {
    const limit = 16 * 1024 * 1024
    const line = JSON.stringify({ id: 'oldest', summary: 's'.repeat(4000), customer: 'c'.repeat(4000), attachments_summary: 'a'.repeat(4000), routed_to: 'r'.repeat(4000), reason: 'w'.repeat(4000) }) + '\n'
    const target = JSON.stringify({ id: 'target', summary: 'recent', misroute: { at: 100, lesson: 'legacy lesson' } }) + '\n'
    const count = Math.floor((limit - 1000 - Buffer.byteLength(target)) / Buffer.byteLength(line))
    const padding = limit - 1000 - Buffer.byteLength(target) - count * Buffer.byteLength(line)
    const path = join(dir, 'triage', 'cases.jsonl')
    await mkdir(join(dir, 'triage'))
    await writeFile(path, line.repeat(count) + JSON.stringify({ id: 'padding', summary: 'x'.repeat(padding) }) + '\n' + target)
    await triageBank(dir)({ action: 'outcome', id: 'target', result: 'misrouted', correct_route: 'r'.repeat(4000), lesson: 'l'.repeat(4000) })
    const stored = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok((await stat(path)).size <= limit)
    assert.equal(stored.filter(item => item.id === 'oldest').length, count - 1)
    assert.equal(stored.at(-1).id, 'target')
    assert.equal(stored.at(-1).misroute, undefined)
    assert.equal(typeof stored.at(-1).misrouted_at, 'number')
    assert.equal(stored.at(-1).outcome.result, 'misrouted')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
