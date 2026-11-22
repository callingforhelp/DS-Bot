import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { summarizeStep } from '../src/host/im/step.js'

test('STEP extracts header, product, units, point bounds and counts', async () => {
  const bytes = await readFile(new URL('./fixtures/triage-part.step', import.meta.url))
  const summary = summarizeStep('PART.STP', bytes)
  for (const expected of ['FILE_NAME', 'FILE_DESCRIPTION', 'AUTOMOTIVE_DESIGN', 'Test bracket', 'MILLI.', '[-1, 2, 3] to [10, 20, 30]', 'CYLINDRICAL_SURFACE: 1', 'ADVANCED_FACE: 1']) assert.ok(summary.includes(expected), expected)
})
test('STEP ignores other files, tolerates missing and invalid data', () => {
  assert.equal(summarizeStep('a.txt', Buffer.from('text')), '')
  assert.equal(summarizeStep('a.step'), '')
  assert.match(summarizeStep('a.step', Buffer.alloc(0)), /not an ISO/)
  assert.match(summarizeStep('a.step', {}), /unavailable/)
  assert.match(summarizeStep('a.step', Buffer.from('ISO-10303-21;')), /unspecified/)
})
