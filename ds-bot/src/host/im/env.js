import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

export async function readWecomEnv(path = process.env.DSBOT_ENV_FILE ?? fileURLToPath(new URL('../../../../.env', import.meta.url))) {
  try {
    if ((await stat(path)).size > 1024 * 1024) throw new Error('Environment seed file is too large')
    const values = parseEnv(await readFile(path, 'utf8'))
    const corpId = values.WECOM_CORP_ID?.trim()
    const secret = values.WECOM_KF_SECRET?.trim()
    if (!corpId || !secret) return undefined
    return { corpId, secret, openKfId: values.WECOM_KF_OPEN_KFID?.trim() ?? '' }
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw new Error('Cannot read WeCom environment seed')
  }
}
