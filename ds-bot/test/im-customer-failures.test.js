import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CustomerFailures } from '../src/host/im/customer-failures.js'

test('customer failure eviction is oldest-first and cannot renew an evicted retry budget', () => {
  const failures = new CustomerFailures(2)
  assert.equal(failures.fail('one', 'oldest'), true)
  assert.equal(failures.fail('two', 'second'), true)
  assert.equal(failures.fail('two', 'newest'), true)
  assert.deepEqual([...failures.entries.keys()], ['second', 'newest'])
  for (let page = 0; page < 5; page++) {
    assert.equal(failures.fail('one', 'oldest'), false)
    assert.equal(failures.fail('one', `other-${page}`), false)
    assert.equal(failures.entries.size, 2)
  }
  failures.success('second')
  assert.equal(failures.fail('one', 'oldest'), false, 'free space does not renew evicted budgets')
  failures.clear('one')
  assert.equal(failures.fail('one', 'oldest'), true, 'stopping the connection resets its retry state')
})

test('customer failure cleanup drops only the stopped connection and its overflow marker', () => {
  const failures = new CustomerFailures(2)
  assert.equal(failures.exhausted('missing'), false)
  assert.equal(failures.fail('one', undefined), false)
  assert.equal(failures.entries.size, 0)
  assert.equal(failures.fail('one', 'first', true), false)
  assert.equal(failures.exhausted('first'), true)
  failures.fail('two', 'second')
  failures.fail('two', 'third')
  assert.equal(failures.limited.has('one'), true)
  failures.clear('one')
  assert.equal(failures.limited.has('one'), false)
  assert.deepEqual([...failures.entries.keys()], ['second', 'third'])
  failures.clear('two')
  assert.equal(failures.entries.size, 0)
  assert.equal(failures.limited.size, 0)
  failures.clear('missing')
})
