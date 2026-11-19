// Text is redacted before it is chunked, indexed or sent to an embedding provider. This is
// a floor, not a guarantee: the external-transfer consent flag still gates any provider call.
const RULES = [
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted:key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted:aws-key]'],
  [/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g, '[redacted:token]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [redacted]'],
  [/\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted:private-key]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted:email]'],
]
export const redact = (text) => RULES.reduce((out, [re, to]) => out.replace(re, to), String(text ?? ''))

// Chunks end at a line or sentence boundary where one exists; none is longer than max.
export function chunk(text, max = 800) {
  const out = []
  let rest = text.trim()
  while (rest.length > max) {
    let cut = Math.max(rest.lastIndexOf('\n', max), rest.lastIndexOf('. ', max))
    if (cut < max / 2) cut = max
    out.push(rest.slice(0, cut + 1).trim())
    rest = rest.slice(cut + 1).trim()
  }
  if (rest) out.push(rest)
  return out
}
