// Optional async embedding adapter for hybrid memory retrieval.
// Defaults to `provider: 'none'` (zero external keys, pure local SQLite FTS5 + BM25).

const DEFAULT_TIMEOUT_MS = 5_000
const MAX_TEXT_CHARS = 8_000

export function normalizeVector(values) {
  if (!Array.isArray(values) && !(values instanceof Float32Array)) return null
  if (values.length === 0) return null
  const out = new Float32Array(values.length)
  let sumSq = 0
  for (let i = 0; i < values.length; i += 1) {
    const num = Number(values[i])
    if (!Number.isFinite(num)) return null
    out[i] = num
    sumSq += num * num
  }
  const norm = Math.sqrt(sumSq)
  if (norm === 0) return null
  for (let i = 0; i < out.length; i += 1) out[i] /= norm
  return { vec: out, norm: 1, dim: out.length }
}

export function packVector(vec) {
  const f32 = vec instanceof Float32Array ? vec : new Float32Array(vec)
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)
}

export function unpackVector(blob) {
  if (!blob || blob.byteLength === 0 || blob.byteLength % 4 !== 0) return null
  const copy = new Uint8Array(blob.byteLength)
  copy.set(new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength))
  return new Float32Array(copy.buffer)
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

export function install(rt) {
  const { state } = rt

  function embeddingConfig() {
    const raw = state.prefs?.memoryEmbeddings ?? {}
    const provider = typeof raw.provider === 'string' ? raw.provider.trim().toLowerCase() : 'auto'
    return {
      provider: ['auto', 'none', 'ollama', 'openai-compat'].includes(provider) ? provider : 'auto',
      model: typeof raw.model === 'string' ? raw.model.trim() : '',
      endpoint: typeof raw.endpoint === 'string' ? raw.endpoint.trim() : '',
      secretName: typeof raw.secretName === 'string' ? raw.secretName.trim() : '',
      timeoutMs: Number.isInteger(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : DEFAULT_TIMEOUT_MS,
    }
  }

  let autoProbe = null
  function autoModel() {
    if (rt.config?.disableAutoEmbed === true || process.env.NODE_ENV === 'test') return Promise.resolve(null)
    if (!autoProbe) {
      autoProbe = (async () => {
        try {
          const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(300) })
          if (!res.ok) return null
          const data = await res.json()
          const hit = (data?.models ?? []).find((m) => /^nomic-embed-text(:|$)/.test(String(m?.name ?? m?.model ?? '')))
          return hit ? String(hit.name ?? hit.model) : null
        } catch {
          return null
        }
      })()
    }
    return autoProbe
  }

  function withPrefix(text, role) {
    if (role === 'document') return `search_document: ${text}`
    if (role === 'query') return `search_query: ${text}`
    return text
  }

  async function ollamaEmbed(base, model, input, timeoutMs) {
    const post = (path, body) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    const res = await post('/api/embed', { model, input })
    if (res.ok) {
      const data = await res.json()
      const n = normalizeVector(data?.embeddings?.[0])
      if (n) return n
    }
    const legacy = await post('/api/embeddings', { model, prompt: input })
    if (!legacy.ok) return null
    const data = await legacy.json()
    return normalizeVector(data?.embedding ?? data?.embeddings?.[0])
  }

  async function embedText(text, opts = {}) {
    const clean = String(text ?? '').trim().slice(0, MAX_TEXT_CHARS)
    if (clean === '') return null

    if (typeof rt.config?.embedder === 'function') {
      try {
        const res = await rt.config.embedder(clean)
        const normalized = normalizeVector(res?.vector ?? res)
        if (!normalized) return null
        return { ...normalized, model: String(res?.model ?? 'custom') }
      } catch {
        return null
      }
    }

    const cfg = embeddingConfig()
    if (cfg.provider === 'none') return null
    if (cfg.provider === 'auto') {
      const model = await autoModel()
      if (!model) return null
      try {
        const n = await ollamaEmbed('http://127.0.0.1:11434', model, withPrefix(clean, opts.role), cfg.timeoutMs)
        return n ? { ...n, model } : null
      } catch {
        return null
      }
    }

    try {
      if (cfg.provider === 'ollama') {
        const base = (cfg.endpoint || 'http://127.0.0.1:11434').replace(/\/+$/, '')
        const model = cfg.model || 'nomic-embed-text'
        const n = await ollamaEmbed(base, model, withPrefix(clean, opts.role), cfg.timeoutMs)
        return n ? { ...n, model } : null
      }

      if (cfg.provider === 'openai-compat') {
        if (!cfg.endpoint) return null
        const model = cfg.model || 'text-embedding-3-small'
        const apiKey = cfg.secretName ? rt.secretValue?.(cfg.secretName) : undefined
        const headers = { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }
        const url = cfg.endpoint.endsWith('/embeddings') ? cfg.endpoint : `${cfg.endpoint.replace(/\/+$/, '')}/embeddings`
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model, input: clean }),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        })
        if (!res.ok) return null
        const data = await res.json()
        const normalized = normalizeVector(data?.data?.[0]?.embedding)
        return normalized ? { ...normalized, model } : null
      }
    } catch {
      return null
    }
    return null
  }

  Object.assign(rt, {
    embedText,
    embeddingConfig,
    cosineSimilarity,
  })
}
