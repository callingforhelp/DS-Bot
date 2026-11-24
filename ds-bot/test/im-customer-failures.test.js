import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CustomerFailures } from '../src/host/im/customer-failures.js'

test('customer failures evict oldest-first independently for each connection', () => {
  const failures = new CustomerFailures(2)
  assert.equal(failures.fail('one', 'oldest', true), false)
  assert.equal(failures.fail('one', 'second', true), false)
  failures.fail('two', 'oldest', true)
  failures.fail('two', 'second', true)
  assert.equal(failures.fail('one', 'newest'), true)
  assert.deepEqual([...failures.entries.get('one').keys()], ['second', 'newest'])
  assert.deepEqual([...failures.entries.get('two').keys()], ['oldest', 'second'])
  assert.equal(failures.fail('one', 'newest'), true)
  assert.equal(failures.fail('one', 'newest'), false)
  assert.equal(failures.exhausted('one', 'newest'), true)
  failures.success('one', 'newest')
  assert.equal(failures.exhausted('one', 'newest'), false)
})

test('customer failure cleanup drops only the stopped connection', () => {
  const failures = new CustomerFailures(2)
  assert.equal(failures.exhausted('one', 'missing'), false)
  assert.equal(failures.fail('one', undefined), false)
  assert.equal(failures.entries.size, 0)
  failures.fail('one', 'first', true)
  failures.fail('two', 'second', true)
  failures.clear('one')
  assert.equal(failures.entries.has('one'), false)
  assert.equal(failures.exhausted('two', 'second'), true)
  failures.success('two', 'second')
  assert.equal(failures.entries.size, 0)
  failures.clear('missing')
})
