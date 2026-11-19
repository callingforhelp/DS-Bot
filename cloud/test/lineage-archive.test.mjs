import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openArchive } from '../src/lineage/archive.mjs'

const file = () => join(mkdtempSync(join(tmpdir(), 'lineage-archive-')), 'lineage.sqlite')

test('a new archive gets schema version 1; a newer version is refused', () => {
  const path = file()
  const a = openArchive(path)
  assert.equal(a.db.prepare('PRAGMA user_version').get().user_version, 1)
  assert.equal(a.db.prepare("SELECT value FROM meta WHERE key = 'format'").get().value, 'dsbot-lineage')
  a.close()
  const raw = new DatabaseSync(path)
  raw.exec('PRAGMA user_version = 2')
  raw.close()
  assert.throws(() => openArchive(path), /schema version 2/)
})

test('rev grows only on a tracked change, and a decided outcome never goes back to pending', () => {
  const a = openArchive(file())
  const row = { id: 'x', at: 1_763_500_000_000, actor: 'bot-a', target: 'bot-b', room_id: null, action: 'message_bot', outcome: 'denied', reason: 'recipient-off', source: 'tool', task_id: null, run_id: null, session_id: 's', seq: 3, ref: 'session:s#seq:3' }
  const rev = () => a.db.prepare("SELECT rev, outcome, reason FROM authorizations WHERE id = 'x'").get()
  assert.equal(a.upsert('authorizations', row), 'inserted')
  assert.equal(a.upsert('authorizations', row), 'unchanged')
  assert.equal(rev().rev, 1)
  a.upsert('authorizations', { ...row, reason: 'group-off' })
  assert.deepEqual({ ...rev() }, { rev: 2, outcome: 'denied', reason: 'group-off' })
  a.upsert('authorizations', { ...row, outcome: 'pending', reason: null })
  assert.deepEqual({ ...rev() }, { rev: 2, outcome: 'denied', reason: 'group-off' }, 'a later pending view does not erase the decision')
  a.upsert('authorizations', { ...row, id: 'y', outcome: 'pending', reason: null })
  a.upsert('authorizations', { ...row, id: 'y' })
  assert.deepEqual({ ...a.db.prepare("SELECT rev, outcome FROM authorizations WHERE id = 'y'").get() }, { rev: 2, outcome: 'denied' })
  a.upsert('authorizations', { ...row, id: 'y', task_id: 'task-1' })
  a.upsert('authorizations', { ...row, id: 'y', task_id: null })
  assert.equal(a.db.prepare("SELECT task_id FROM authorizations WHERE id = 'y'").get().task_id, 'task-1', 'a known link is never erased')
  a.close()
})

test('a failed transaction leaves nothing behind', () => {
  const a = openArchive(file())
  assert.throws(() => a.tx(() => { a.put('rooms', { id: 'r', name: 'Desk', updated_at: 1 }); throw new Error('boom') }), /boom/)
  assert.equal(a.count('rooms'), 0)
  a.close()
})
