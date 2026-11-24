// Observation ingest: the one door through which session facts enter the memory index.
// Private spans are cut, secrets are redacted or dropped, and the memory mode of the
// Bot, group or Session decides whether anything is written at all.
import { createHash } from 'node:crypto'
import { looksLikeKey, looksSecret } from './memory-entries.js'

const PRIVATE_SPAN = /<private>[\s\S]*?<\/private>/gi
const PRIVATE_OPEN = /<private>[\s\S]*$/i
const TITLE_MAX = 200
const SUMMARY_MAX = 4_000
const FACT_MAX = 500
const FACTS_MAX = 20
const FILES_MAX = 50

/** Removes every `<private>…</private>` span; an unclosed tag hides the rest of the text. */
export function stripPrivateSpans(text) {
  return String(text ?? '').replace(PRIVATE_SPAN, '').replace(PRIVATE_OPEN, '')
}

/**
 * Cleans text for storage: private spans out, known secret shapes redacted, and any
 * line that still looks like a secret dropped. `redact` is `rt.redactSecrets` when given.
 */
export function sanitizeText(text, redact) {
  let clean = stripPrivateSpans(text)
  if (typeof redact === 'function') {
    try { clean = String(redact(clean) ?? '') } catch { clean = '' }
  }
  return clean
    .split('\n')
    .filter(line => !(looksLikeKey(line) || looksSecret(line)))
    .join('\n')
    .trim()
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export function install(rt) {
  const redact = text => (typeof rt.redactSecrets === 'function' ? rt.redactSecrets(text) : text)
  const clean = (text, max) => clip(sanitizeText(text, redact), max)

  /**
   * Stores one observation. Returns `{ inserted, duplicate?, skipped?, id }`:
   * `skipped` names why nothing was written ('mode', 'empty', 'unavailable').
   */
  function ingestObservation(input = {}) {
    const ids = { botId: input.botId, roomId: input.roomId, sessionId: input.sessionId }
    if (typeof rt.canWriteMemory === 'function' && !rt.canWriteMemory(ids)) return { inserted: false, skipped: 'mode' }
    if (typeof rt.insertObservationRow !== 'function') return { inserted: false, skipped: 'unavailable' }

    const title = clean(input.title, TITLE_MAX)
    const summary = clean(input.summary, SUMMARY_MAX)
    const facts = (Array.isArray(input.facts) ? input.facts : [])
      .map(fact => clean(fact, FACT_MAX))
      .filter(Boolean)
      .slice(0, FACTS_MAX)
    const files = (Array.isArray(input.files) ? input.files : []).map(String).filter(Boolean).slice(0, FILES_MAX)
    if (title === '' && summary === '' && facts.length === 0) return { inserted: false, skipped: 'empty' }

    const kind = String(input.kind ?? 'observation')
    const key = typeof input.idempotencyKey === 'string' && input.idempotencyKey !== ''
      ? input.idempotencyKey
      : createHash('sha256').update([input.sessionId ?? '', input.turn ?? '', kind, title, summary].join('\u0000')).digest('hex')
    const id = `obs:${createHash('sha256').update(key).digest('hex').slice(0, 20)}`

    const result = rt.insertObservationRow({
      id,
      idempotencyKey: key,
      sessionId: input.sessionId ?? null,
      agentSource: input.agentSource ?? 'dsbot',
      botId: input.botId ?? null,
      roomId: input.roomId ?? null,
      repoKey: input.repoKey ?? null,
      branch: input.branch ?? null,
      turn: input.turn,
      kind,
      title,
      summary,
      facts,
      files,
    })
    return { ...result, id: result.row?.id ?? id, skipped: result.inserted || result.duplicate ? undefined : 'unavailable' }
  }

  Object.assign(rt, { ingestObservation, stripPrivateSpans, sanitizeIngestText: text => clean(text, SUMMARY_MAX) })
}
