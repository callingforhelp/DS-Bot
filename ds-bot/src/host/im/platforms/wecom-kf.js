const BASE = 'https://qyapi.weixin.qq.com/cgi-bin/'
const expired = code => [40014, 42001].includes(Number(code))
const failure = body => Object.assign(new Error([95018, 95007].includes(Number(body.errcode))
  ? 'WeCom Customer Service reply window or quota exhausted (5 replies within 48 hours)'
  : `WeCom Customer Service: ${body.errmsg ?? 'request failed'} (${body.errcode})`), { permanent: true })

export function chunks(text) {
  const result = []
  let part = ''
  let bytes = 0
  for (const char of String(text ?? '')) {
    const size = Buffer.byteLength(char)
    if (bytes + size > 2048) { result.push(part); part = ''; bytes = 0 }
    part += char
    bytes += size
  }
  if (part) result.push(part)
  return result
}

function client(fields, env, signal) {
  let token
  let until = 0
  const fetch = (path, options = {}) => env.fetch(`${BASE}${path}`, { ...options, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) })
  const access = async () => {
    if (token && Date.now() < until) return token
    const answer = await (await fetch(`gettoken?${new URLSearchParams({ corpid: fields.corpId, corpsecret: fields.secret })}`)).json()
    if (!answer.access_token) throw failure(answer)
    token = answer.access_token
    until = Date.now() + Math.max(0, Number(answer.expires_in ?? 7200) - 120) * 1000
    return token
  }
  const call = async (path, body, retry = true) => {
    const response = await fetch(`${path}?access_token=${encodeURIComponent(await access())}`, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`WeCom Customer Service HTTP ${response.status}`)
    const answer = await response.json()
    if (expired(answer.errcode) && retry) { token = undefined; return call(path, body, false) }
    if (Number(answer.errcode ?? 0) !== 0) throw failure(answer)
    return answer
  }
  const account = async () => {
    const answer = await call('kf/account/list', { offset: 0, limit: 100 })
    const selected = fields.openKfId ? answer.account_list?.find(item => item.open_kfid === fields.openKfId) : answer.account_list?.[0]
    if (!selected) throw new Error('WeCom Customer Service account not found')
    return selected
  }
  const media = async (id, limit, retry = true) => {
    const response = await fetch(`media/get?${new URLSearchParams({ access_token: await access(), media_id: id })}`)
    const type = response.headers.get('content-type') ?? 'application/octet-stream'
    if (type.includes('json')) {
      const answer = await response.json()
      if (expired(answer.errcode) && retry) { token = undefined; return media(id, limit, false) }
      throw failure(answer)
    }
    if (!response.ok) throw new Error(`WeCom media HTTP ${response.status}`)
    const parts = []
    let size = 0
    for await (const part of response.body) {
      size += part.length
      if (size > limit) throw Object.assign(new Error('WeCom attachment exceeds size limit'), { overLimit: true })
      parts.push(Buffer.from(part))
    }
    const disposition = response.headers.get('content-disposition') ?? ''
    return { data: Buffer.concat(parts), mediaType: type.split(';')[0], name: disposition.match(/filename="([^"]+)"/i)?.[1] }
  }
  return { call, account, media }
}

export default {
  id: 'wecom_kf',
  async check(fields, env) {
    const account = await client(fields, env).account()
    return { account: { id: account.open_kfid, name: account.name } }
  },
  connect(fields, env, handlers) {
    const stopping = new AbortController()
    const api = client(fields, env, stopping.signal)
    let stopped = false
    let timer
    let delay = 3000
    const cutoff = env.runtime.get().cursor === undefined ? Date.now() / 1000 - 86400 : 0
    let selected
    const select = () => {
      selected ??= api.account().catch(error => { selected = undefined; throw error })
      return selected
    }
    const poll = async () => {
      try {
        const account = await select()
        const answer = await api.call('kf/sync_msg', { cursor: env.runtime.get().cursor ?? '', open_kfid: account.open_kfid, limit: 1000 })
        if (!Array.isArray(answer.msg_list) || typeof answer.next_cursor !== 'string') throw new Error('WeCom Customer Service returned an unreadable sync response')
        for (const msg of answer.msg_list ?? []) {
          if (stopped) return
          if (Number(msg.origin) !== 3 || Number(msg.send_time ?? 0) < cutoff || msg.msgtype === 'event') continue
          const user = String(msg.external_userid ?? '')
          if (!user) continue
          const images = []
          const files = []
          let text = msg.text?.content ?? ''
          if (['image', 'file', 'voice', 'video'].includes(msg.msgtype) && msg[msg.msgtype]?.media_id) {
            const got = await api.media(msg[msg.msgtype].media_id, (msg.msgtype === 'image' ? 20 : 100) * 1024 * 1024).catch(error => {
              if (!error.overLimit && !error.permanent) throw error
              text = [text, '[Attachment could not be fetched.]'].filter(Boolean).join('\n')
              return undefined
            })
            if (got && msg.msgtype === 'image') images.push({ mediaType: got.mediaType, data: got.data.toString('base64') })
            else if (got) files.push({ name: msg[msg.msgtype].filename || got.name || `wecom-${msg.msgid}.${{ voice: 'amr', video: 'mp4' }[msg.msgtype] ?? 'bin'}`, data: got.data })
          }
          await handlers.onMessage({ messageId: msg.msgid, chat: { key: user, kind: 'direct' }, sender: { id: user, name: user }, text, images, files })
        }
        if (stopped) return
        if (answer.next_cursor !== undefined) env.runtime.set({ cursor: answer.next_cursor })
        handlers.onStatus({ state: 'ready' })
        delay = answer.has_more ? 0 : (answer.msg_list?.length ? 3000 : Math.min(15000, Math.max(3000, delay * 2)))
      } catch (error) {
        if (stopped) return
        handlers.onStatus({ state: 'error', error: error.message })
        delay = Math.min(60000, Math.max(3000, delay * 2))
      }
      if (!stopped) { timer = setTimeout(poll, delay); timer.unref?.() }
    }
    handlers.onStatus({ state: 'connecting' })
    void poll()
    return {
      async send(chat, { text }) {
        const account = await select()
        let messageId
        let delivered = false
        for (const content of chunks(text)) {
          const answer = await api.call('kf/send_msg', { touser: chat.key, open_kfid: account.open_kfid, msgtype: 'text', text: { content } }).catch(error => {
            if (!delivered) throw error
            throw Object.assign(new Error(`WeCom Customer Service reply partially delivered; not retrying earlier chunks: ${error.message}`), { permanent: true })
          })
          delivered = true
          messageId = answer.msgid
        }
        return { messageId }
      },
      stop() { stopped = true; clearTimeout(timer); stopping.abort() },
    }
  },
}
