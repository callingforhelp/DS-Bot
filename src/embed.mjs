import { createHash } from 'node:crypto'

// Embedding providers share one shape: { model, dim, embed(texts) -> number[][] }.

// Deterministic, offline, and NOT semantic: hashed word and character-trigram counts. It
// exists so the pipeline, the fallback and the fusion can be tested without a network. Any
// relevance number measured with it says nothing about text-embedding-3-small.
export function mockEmbedder({ dim = 256, fail = () => false } = {}) {
  const slot = (token) => createHash('sha256').update(token).digest().readUInt32BE(0) % dim
  const vectorOf = (text) => {
    const v = new Array(dim).fill(0)
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      v[slot(`w:${word}`)] += 2
      for (let i = 0; i + 3 <= word.length; i += 1) v[slot(`t:${word.slice(i, i + 3)}`)] += 1
    }
    const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1
    return v.map(x => x / norm)
  }
  return {
    model: 'mock-hash-256',
    dim,
    async embed(texts) {
      if (fail()) throw new Error('embedding provider unavailable')
      return texts.map(vectorOf)
    },
  }
}

// The real provider. UNVERIFIED here: no key or network was available. It refuses to run
// without an explicit consent flag, because the text leaves the controller.
export function openaiEmbedder({ apiKey, consentExternalTransfer, model = 'text-embedding-3-small', dim = 1536, fetchImpl = fetch } = {}) {
  if (consentExternalTransfer !== true) throw new Error('OpenAI embeddings need explicit consent for external transfer of redacted text')
  if (!apiKey) throw new Error('an API key from the secret manager is required')
  return {
    model,
    dim,
    async embed(texts) {
      const res = await fetchImpl('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: texts }),
      })
      if (!res.ok) throw new Error(`embedding request failed: ${res.status}`)
      return (await res.json()).data.map(item => item.embedding)
    },
  }
}
