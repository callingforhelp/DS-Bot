// Delivers a user message to the DS-Bot host plugin running inside a Daytona sandbox via DSH's
// `POST /api/bot` route (`{ endpoint: 'send', payload: { sessionId, text } }`).
// Uses Daytona's authenticated preview link (`sandbox.getPreviewLink(port)`) so raw chat text is
// never passed to a shell command.
export function createDshMessageHandler({ port, authToken, timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  const portNum = Number(port)
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new Error(`invalid DSH port: ${port}`)
  }

  return async (_machine, sandbox, message) => {
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

    const url = `${String(preview.url).replace(/\/+$/, '')}/api/bot`
    const headers = { 'content-type': 'application/json' }
    if (preview.token) headers['x-daytona-preview-token'] = preview.token
    if (authToken) headers.authorization = `Bearer ${authToken}`

    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        endpoint: 'send',
        payload: { sessionId, text },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })

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
