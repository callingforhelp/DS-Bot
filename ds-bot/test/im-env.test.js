import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readWecomEnv } from '../src/host/im/env.js'

test('WeCom env seeds require corporation and secret, allow an optional account, and never write', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'ds-im-env-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const path = join(home, '.env')
  const previous = process.env.DSBOT_ENV_FILE
  process.env.DSBOT_ENV_FILE = path
  t.after(() => { process.env.DSBOT_ENV_FILE = previous })
  assert.equal(await readWecomEnv(), undefined)
  for (const content of ['', 'WECOM_CORP_ID=fake-corp', 'WECOM_KF_SECRET=fake-secret', 'WECOM_CORP_ID=""\nWECOM_KF_SECRET=fake-secret']) {
    await writeFile(path, content)
    assert.equal(await readWecomEnv(), undefined)
    assert.equal(await readFile(path, 'utf8'), content)
  }
  const content = '# local seed\nOTHER=value\nexport WECOM_CORP_ID="fake-corp"\nWECOM_KF_SECRET="fake#secret"\n'
  await writeFile(path, content)
  assert.deepEqual(await readWecomEnv(), { corpId: 'fake-corp', secret: 'fake#secret', openKfId: '' })
  await writeFile(path, content + 'WECOM_KF_OPEN_KFID=fake-account\n')
  assert.equal((await readWecomEnv()).openKfId, 'fake-account')
  assert.equal(await readFile(path, 'utf8'), content + 'WECOM_KF_OPEN_KFID=fake-account\n')
  await assert.rejects(readWecomEnv(home), /Cannot read/)
})
