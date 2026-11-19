// Text is redacted before it is chunked, indexed or sent to an embedding provider. This is
// a floor, not a guarantee: the external-transfer consent flag still gates any provider call.
//
// Every rule runs in linear time, because redact() sees untrusted input (search queries and
// event summaries from any signed principal) on a single-threaded controller. The reasoning per rule:
// - Each rule either starts at a fixed literal ('-----BEGIN', 'eyJ', 'AKIA', a quoted key name) or
//   is anchored by a lookbehind so that it can only start at the beginning of a run of its own
//   characters; that keeps the number of start positions, or the work per start, bounded.
// - Quantifiers that could overlap with what follows are bounded ({0,40}, {1,64}, {1,256}, ...), and
//   no quantified group contains another unbounded quantifier over the same characters.
// - The one unbounded scan ([\s\S]*? in the private-key rule) starts only at '-----BEGIN' and
//   ends at the matching END line or the end of the text, so it consumes what it scans.
// Multi-word values are only partly redacted ('password: correct horse' loses 'correct'), and
// the high-entropy rule can over-redact mixed-case ids that are not secrets.
const TOKEN_RUN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g
const looksRandom = s => /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s)

const RULES = [
  // PEM and PGP private keys, to the matching END line or, when it is missing, the end of the text.
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$(?![\s\S]))/g, '[redacted:private-key]'],
  // Credentials inside connection URLs: scheme://user:password@host (IP hosts included).
  [/\b([a-z][a-z0-9+.-]{1,20}):\/\/[^\s:@/]{1,256}:[^\s@/]{1,256}@/gi, '$1://[redacted]@'],
  // JSON-quoted secrets: "password": "...".
  [/"(password|passwd|secret|token|api[_-]?key|access[_-]?token|client[_-]?secret|refresh[_-]?token)"\s{0,16}:\s{0,16}"[^"]{0,4096}"/gi, '"$1":"[redacted]"'],
  [/\b(Authorization:\s{0,16}Basic)\s{1,16}[A-Za-z0-9+/=]{8,4096}/gi, '$1 [redacted]'],
  [/\bBearer\s{1,16}[A-Za-z0-9._~+/=-]{12,4096}/gi, 'Bearer [redacted]'],
  // Provider key shapes.
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted:aws-key]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})/g, '[redacted:token]'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,255}/g, '[redacted:token]'],
  [/\bAIza[0-9A-Za-z_-]{35}/g, '[redacted:key]'],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,255}/g, '[redacted:key]'],
  [/\bsk-[A-Za-z0-9_-]{8,255}/g, '[redacted:key]'],
  [/\beyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}/g, '[redacted:jwt]'],
  // key=value and key: value, in env style (PGPASSWORD=, R2_SECRET_ACCESS_KEY=) and in prose
  // (password: x, client_secret: x, access_token=x). The name parts are bounded.
  [/\b([A-Za-z0-9_]{0,40}(?:password|passwd|secret|token|api_key|apikey|api-key|access_key|private_key)[A-Za-z0-9_]{0,40})\s{0,16}[:=]\s{0,16}\S{1,4096}/gi, '$1=[redacted]'],
  [/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/g, '[redacted:email]'],
  // Random-looking base64url tokens (DS Bot link tokens, the DSH login token). Lowercase hex
  // (digests, commit SHAs, lineage ids) and UUIDs have no uppercase, so they stay searchable.
  [TOKEN_RUN, s => looksRandom(s) ? '[redacted:token]' : s],
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
