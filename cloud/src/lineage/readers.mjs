// Read-only readers over a DS Bot home (DSH_HOME; /data in the image). They return
// structured facts only: message text is hashed on read and never kept, and the project
// folder name (it embeds the workspace path) never leaves `file`, which stays in memory.
// Nothing here throws on a missing, half-written or torn file.
import { createHash, createHmac } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createZstdDecompress } from 'node:zlib'
import { buildOwners } from './owners.mjs'

const readText = file => { try { return readFileSync(file, 'utf8') } catch { return undefined } }
const dirs = dir => { try { return readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort() } catch { return [] } }
const files = dir => { try { return readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile()).map(d => d.name).sort() } catch { return [] } }

// Complete JSON lines only: a line cut by an interruption is not a record.
function jsonLines(text) {
  const rows = []
  let badLines = 0
  const parts = String(text ?? '').split('\n')
  const torn = parts.at(-1) !== ''
  if (torn) parts.pop()
  for (const line of parts) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line)
      if (row !== null && typeof row === 'object') rows.push(row)
      else badLines += 1
    } catch { badLines += 1 }
  }
  return { rows, badLines, torn }
}

export function readState(home) {
  const text = readText(join(home, 'bot', 'state.json'))
  let state
  try { state = JSON.parse(text) } catch { return { bots: [], rooms: [], owners: new Map(), stateError: true } }
  if (state === null || typeof state !== 'object') return { bots: [], rooms: [], owners: new Map(), stateError: true }
  const bots = Object.entries(state.bots ?? {}).map(([key, b]) => ({
    id: String(b?.id ?? key), name: typeof b?.name === 'string' ? b.name : null, private: b?.private === true,
    model: typeof b?.model === 'string' ? b.model : null, sessionId: typeof b?.sessionId === 'string' ? b.sessionId : String(b?.id ?? key),
  }))
  const rooms = Object.entries(state.rooms ?? {}).map(([key, r]) => ({
    id: String(r?.id ?? key), name: typeof r?.name === 'string' ? r.name : null, members: Array.isArray(r?.members) ? r.members.map(String) : [],
  }))
  return { bots, rooms, owners: buildOwners(state) }
}

// DSH encodeSegment: '~XXXX' is one UTF-16 code unit in hex.
export const decodeSegment = s => s.replace(/~([0-9A-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))

// One log per Session directory: the highest format generation, zstd first.
// Names: session.jsonl(.zstd) is generation 0; session.vN.jsonl(.zstd) is generation N.
export function listSessionLogs(home) {
  const root = join(home, 'sessions')
  const out = []
  for (const project of dirs(root)) {
    for (const dir of dirs(join(root, project))) {
      let best
      for (const name of files(join(root, project, dir))) {
        const m = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/.exec(name)
        if (!m) continue
        const rank = [Number(m[1] ?? 0), m[2] ? 1 : 0]
        if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && rank[1] > best.rank[1])) best = { rank, name }
      }
      if (best) out.push({ sessionId: decodeSegment(dir), file: join(root, project, dir, best.name) })
    }
  }
  return out
}

// Streaming decode keeps every complete zstd frame of a log whose tail was cut mid-write
// (zstdDecompressSync throws on the whole file instead).
function unzstd(buf) {
  return new Promise(resolve => {
    const z = createZstdDecompress()
    const out = []
    let torn = false
    z.on('data', c => out.push(c))
    z.on('error', () => { torn = true; resolve({ buf: Buffer.concat(out), torn }) })
    z.on('end', () => resolve({ buf: Buffer.concat(out), torn }))
    z.end(buf)
  })
}

export async function readSessionEvents(file) {
  let raw
  try { raw = readFileSync(file) } catch { return { events: [], torn: false, badLines: 0, missing: true } }
  let text = raw
  let tornFrame = false
  if (file.endsWith('.zstd')) ({ buf: text, torn: tornFrame } = await unzstd(raw))
  const { rows, badLines, torn } = jsonLines(text.toString('utf8'))
  // The physical header line (type 'session', no time) is not an event.
  const events = rows.filter(r => typeof r.type === 'string' && r.time !== undefined && !(r.type === 'session' && r.version !== undefined && r.seq === undefined))
    .map(r => ({ type: r.type, time: r.time, seq: r.seq, data: r.data }))
  return { events, torn: tornFrame || torn, badLines }
}

const PAIR_ROLES = new Set(['request', 'reply', 'stopped', 'report'])
export function readLedger(home, { textKey } = {}) {
  const dir = join(home, 'bot', 'ledger')
  const hash = text => (textKey ? createHmac('sha256', textKey) : createHash('sha256')).update(String(text ?? '')).digest('hex')
  const records = []
  const deliveries = []
  const groupNotices = []
  for (const name of files(dir).filter(n => n.endsWith('.jsonl'))) {
    const book = name.slice(0, -'.jsonl'.length)
    const { rows } = jsonLines(readText(join(dir, name)))
    const roomId = book.startsWith('group-') ? book.slice('group-'.length) : null
    for (const row of rows) {
      if (row.event === 'delivered') {
        deliveries.push({ book, id: row.id ?? null, sessionId: row.sessionId ?? null, time: row.time ?? null, passive: row.passive === true })
      } else if (roomId !== null) {
        if (row.kind === 'notice' && row.reason === 'category') {
          groupNotices.push({ roomId, seq: row.seq ?? null, time: row.time ?? null, from: row.from ?? null, about: row.about ?? null, refused: row.refused ?? null, category: row.category ?? null })
        }
      } else if (PAIR_ROLES.has(row.role)) {
        const text = typeof row.text === 'string' ? row.text : JSON.stringify(row.text ?? '')
        records.push({
          book, id: row.id ?? null, from: row.from ?? null, to: row.to ?? null, role: row.role, time: row.time ?? null,
          roomId: row.roomId ?? null, replyTo: row.replyTo ?? null, textSha256: hash(text), bytes: Buffer.byteLength(text, 'utf8'),
        })
      }
    }
  }
  return { records, deliveries, groupNotices }
}

// diagnostics.jsonl rotates to .1 at 1 MiB (one generation kept) and can be cleared from the
// app. The cursor notes each file's inode and size so the caller can tell either happened.
export function readDiagnostics(home, prevCursor) {
  const dir = join(home, 'bot', 'logs')
  const lines = []
  const cursor = {}
  for (const name of ['diagnostics.jsonl.1', 'diagnostics.jsonl']) {
    const file = join(dir, name)
    let st
    try { st = statSync(file) } catch { continue }
    cursor[name] = { ino: st.ino, size: st.size }
    for (const row of jsonLines(readText(file)).rows) {
      if (row.level === 'warn' || row.level === 'error') lines.push({ time: row.time ?? null, text: String(row.text ?? ''), file: name })
    }
  }
  const prev = prevCursor?.['diagnostics.jsonl']
  const now = cursor['diagnostics.jsonl']
  const rotated = Boolean(prev && now && prev.ino !== now.ino)
  const cleared = Boolean(prev && now && prev.ino === now.ino && now.size < prev.size)
  return { lines, cursor, rotated, cleared }
}

export const readers = { readState, listSessionLogs, readSessionEvents, readLedger, readDiagnostics }
