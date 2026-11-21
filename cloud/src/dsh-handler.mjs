// Delivers a user message to the DS-Bot host plugin running inside a Daytona sandbox via DSH's
// `POST /api/bot` route (`{ endpoint: 'send', payload: { sessionId, text } }`).
// Authenticates through Daytona's preview link (`x-daytona-preview-token`) and obtains a DSH
// session cookie via `GET /?token=<authToken>` (matching `ds-bot/dev/smoke.mjs`).
export function createDshMessageHandler({ port, authToken, timeoutMs = 30_000, fetchImpl = fetch, allowSandboxInboxFallback = false } = {}) {
  const portNum = Number(port)
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new Error(`invalid DSH port: ${port}`)
  }
  if (typeof authToken !== 'string' || authToken.trim() === '') {
    throw new Error('DSH authToken is required to obtain a session cookie')
  }

  const cookieCache = new Map()

  async function deliverViaSandboxInbox(sandbox, { sessionId, botId, text }) {
    const safeId = sessionId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'default'
    const inboxPath = `/workspace/.ds-bot/inbox/${safeId}.jsonl`
    const at = new Date().toISOString()
    const lineB64 = Buffer.from(JSON.stringify({ sessionId, botId: botId ?? null, text, at }) + '\n', 'utf8').toString('base64')
    const mdB64 = Buffer.from(`# Latest Handoff (${at})\n- Session: ${sessionId}\n- Bot: ${botId ?? '-'}\n\n${text}\n`, 'utf8').toString('base64')
    const cmd = `mkdir -p /workspace/.ds-bot/inbox && printf '%s' '${mdB64}' | base64 -d > /workspace/.ds-bot/HANDOFF.md && printf '%s' '${lineB64}' | base64 -d >> '${inboxPath}'`
    const execRes = await sandbox.process.executeCommand(cmd, undefined, undefined, Math.ceil(timeoutMs / 1000))
    if (execRes?.exitCode !== 0) {
      throw new Error(`Sandbox inbox fallback failed (exit ${execRes?.exitCode}): ${execRes?.result ?? ''}`)
    }
    return { delivered: true, sessionId, mode: 'sandbox-inbox', endpoint: 'sandbox-inbox', inboxPath }
  }

  async function loginForCookie(baseUrl, previewToken) {
    const loginUrl = `${baseUrl}/?token=${encodeURIComponent(authToken)}`
    const headers = {}
    if (previewToken) headers['x-daytona-preview-token'] = previewToken
    const res = await fetchImpl(loginUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const rawCookies = typeof res.headers?.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers?.get?.('set-cookie') ? [res.headers.get('set-cookie')] : [])
    const cookies = rawCookies.map(c => String(c).split(';')[0].trim()).filter(Boolean)
    if (cookies.length === 0) {
      throw new Error(`DSH login returned no session cookie (HTTP ${res.status})`)
    }
    return cookies.join('; ')
  }

  return async (machine, sandbox, message) => {
    const sessionId = typeof message.threadId === 'string' && message.threadId !== ''
      ? message.threadId
      : (typeof message.botId === 'string' && message.botId !== '' ? message.botId : '')
    if (!sessionId) throw new Error('sessionId (threadId or botId) is required for DSH delivery')
    const text = String(message.text ?? '').trim()
    if (!text) throw new Error('message text is required for DSH delivery')
    if (typeof sandbox?.getPreviewLink !== 'function') {
      throw new Error('sandbox does not support getPreviewLink()')
    }

    const preview = await sandbox.getPreviewLink(portNum)
    if (!preview?.url) throw new Error(`sandbox did not return a preview URL for port ${portNum}`)

    const baseUrl = String(preview.url).replace(/\/+$/, '')
    const cacheKey = `${machine?.id ?? ''}:${baseUrl}`

    const postSend = async (cookie) => {
      const headers = { 'content-type': 'application/json', cookie }
      if (preview.token) headers['x-daytona-preview-token'] = preview.token
      return fetchImpl(`${baseUrl}/api/bot`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          endpoint: 'send',
          payload: { sessionId, text },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    }

    const login = async () => {
      const fresh = await loginForCookie(baseUrl, preview.token)
      cookieCache.set(cacheKey, fresh)
      return fresh
    }
    const fallbackOrThrow = (err) => {
      if (allowSandboxInboxFallback && typeof sandbox?.process?.executeCommand === 'function') {
        return deliverViaSandboxInbox(sandbox, { sessionId, botId: message.botId, text })
      }
      throw err
    }

    let cookie = cookieCache.get(cacheKey)
    if (!cookie) {
      try {
        cookie = await login()
      } catch (loginError) {
        return fallbackOrThrow(loginError)
      }
    }

    let res = await postSend(cookie)
    if (res.status === 401 || res.status === 403) {
      cookieCache.delete(cacheKey)
      try {
        cookie = await login()
      } catch (loginError) {
        return fallbackOrThrow(loginError)
      }
      res = await postSend(cookie)
    }

    let json
    try {
      json = await res.json()
    } catch {
      throw new Error(`DSH /api/bot returned non-JSON response (HTTP ${res.status})`)
    }
    if (!res.ok || json?.ok !== true) {
      const msg = json?.error?.message ?? json?.error ?? `HTTP ${res.status}`
      throw new Error(`DSH /api/bot send failed: ${msg}`)
    }
    return { delivered: true, sessionId, endpoint: 'send', value: json.value }
  }
}
