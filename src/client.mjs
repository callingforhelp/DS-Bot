import { createHash, createHmac, randomUUID } from 'node:crypto'

export const bodyHash = raw => createHash('sha256').update(raw).digest('hex')
export const canonical = ({ ts, nonce, method, path, raw }) => [ts, nonce, method.toUpperCase(), path, bodyHash(raw)].join('\n')

// Signs one request: timestamp + nonce + method + path + body hash. The server rejects a
// stale timestamp, a bad signature and any nonce it has already seen.
export function sign({ principal, secret, tenant, method, path, body, ts = Date.now(), nonce = randomUUID() }) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  const signature = createHmac('sha256', secret).update(canonical({ ts, nonce, method, path, raw })).digest('hex')
  return { raw, headers: { 'content-type': 'application/json', 'x-principal': principal, 'x-tenant': tenant, 'x-timestamp': String(ts), 'x-nonce': nonce, 'x-signature': signature } }
}

export function apiClient({ baseUrl, principal, secret, tenant }) {
  return async (method, path, body, over = {}) => {
    const { raw, headers } = sign({ principal, secret, tenant, method, path, body, ...over })
    const res = await fetch(baseUrl + path, { method, headers, body: method === 'GET' ? undefined : raw })
    return { status: res.status, body: await res.json().catch(() => ({})) }
  }
}
