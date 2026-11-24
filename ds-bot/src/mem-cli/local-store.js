// Offline memory store for dsbot-mem: node:sqlite (WAL + FTS5), a sync outbox and cursors.
// Node built-ins only. State lives under <DS_BOT_HOME>/mem/ (default ~/.ds-bot/mem/).
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const MODES = ['on', 'silent', 'incognito', 'off']
export const MEM_LIMITS = { text: 4000, topic: 48 }

export function memHome(env = process.env) {
  const root = env.DS_BOT_HOME || join(env.HOME || homedir(), '.ds-bot')
  return join(root, 'mem')
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJsonAtomic(file, value, mode = 0o600) {
  ensureDir(join(file, '..'))
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode })
  renameSync(tmp, file)
  try { chmodSync(file, mode) } catch { /* best effort */ }
}

const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk|dsb|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|secret|token|passwd|password)\b\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{12,}/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
]

export function looksSecret(text) {
  const s = String(text ?? '')
  return SECRET_PATTERNS.some(re => re.test(s))
}

export function redact(text) {
  return String(text ?? '').split('\n').map(line => (looksSecret(line) ? '[redacted line]' : line)).join('\n')
}

export function cleanTopic(value) {
  const t = String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '')
  return t.slice(0, MEM_LIMITS.topic)
}

export function readMode(dir) {
  const mode = readJson(join(dir, 'mode.json'), {}).mode
  return MODES.includes(mode) ? mode : 'on'
}

export function writeMode(dir, mode) {
  if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`)
  writeJsonAtomic(join(dir, 'mode.json'), { mode, updatedAt: new Date().toISOString() })
  return mode
}

export function ftsQuery(text) {
  const tokens = String(text ?? '').match(/[\p{L}\p{N}_]+/gu) ?? []
  return tokens.slice(0, 12).map(t => `"${t}"`).join(' OR ')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories(
  id INTEGER PRIMARY KEY, hash TEXT UNIQUE NOT NULL, scope TEXT NOT NULL DEFAULT 'workspace',
  topic TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'note',
  source TEXT NOT NULL DEFAULT '', repo TEXT NOT NULL DEFAULT '', commit_sha TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE INDEX IF NOT EXISTS memories_session ON memories(session_id, id);
CREATE INDEX IF NOT EXISTS memories_repo ON memories(repo, id);
CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(text, topic, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS embeddings(memory_id INTEGER PRIMARY KEY, model TEXT NOT NULL, vec TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS provenance(
  id INTEGER PRIMARY KEY, commit_sha TEXT NOT NULL DEFAULT '', pr_url TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '', repo TEXT NOT NULL DEFAULT '', files TEXT NOT NULL DEFAULT '',
  transcript_path TEXT NOT NULL DEFAULT '', step_idx INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS library(
  kind TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  PRIMARY KEY(kind, name));
CREATE TABLE IF NOT EXISTS swarm_notes(
  id INTEGER PRIMARY KEY, swarm TEXT NOT NULL, author TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sync_outbox(
  id INTEGER PRIMARY KEY, op TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER);
CREATE TABLE IF NOT EXISTS sync_cursors(name TEXT PRIMARY KEY, cursor TEXT NOT NULL, updated_at INTEGER NOT NULL);
`

export async function openStore(dir = memHome()) {
  ensureDir(dir)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(dir, 'local-mem.sqlite'))
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=2000;')
  db.exec(SCHEMA)
  return makeStore(db, dir)
}

function makeStore(db, dir) {
  const now = () => Date.now()
  const outbox = (op, payload) => db.prepare('INSERT INTO sync_outbox(op,payload,created_at) VALUES(?,?,?)').run(op, JSON.stringify(payload), now())
  const row = (id) => db.prepare('SELECT * FROM memories WHERE id=?').get(id)

  const store = {
    dir,
    db,
    close() { db.close() },

    save({ text, topic = '', scope = 'workspace', kind = 'note', source = '', repo = '', commit = '', session = '' }) {
      const body = String(text ?? '').trim().slice(0, MEM_LIMITS.text)
      if (!body) throw new Error('text is empty')
      if (looksSecret(body)) throw new Error('text looks like a secret and was not saved')
      const t = cleanTopic(topic)
      const hash = createHash('sha256').update([scope, t, body].join('\n')).digest('hex')
      const found = db.prepare('SELECT id, deleted_at FROM memories WHERE hash=?').get(hash)
      if (found) {
        if (found.deleted_at) store.restore(found.id)
        return { id: Number(found.id), created: false }
      }
      const r = db.prepare(
        'INSERT INTO memories(hash,scope,topic,text,kind,source,repo,commit_sha,session_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      ).run(hash, scope, t, body, kind, source, repo, commit, session, now())
      const id = Number(r.lastInsertRowid)
      db.prepare('INSERT INTO mem_fts(rowid,text,topic) VALUES(?,?,?)').run(id, body, t)
      outbox('memory.save', { id, hash, scope, topic: t, text: body, kind, source, repo, commit, session })
      return { id, created: true }
    },

    get: row,

    search(query, { limit = 8, scope, repo, kind } = {}) {
      const q = ftsQuery(query)
      if (!q) return []
      const where = ['m.deleted_at IS NULL']
      const args = [q]
      if (scope) { where.push('m.scope=?'); args.push(scope) }
      if (repo) { where.push('m.repo=?'); args.push(repo) }
      if (kind) { where.push('m.kind=?'); args.push(kind) }
      args.push(Math.min(Math.max(Number(limit) || 8, 1), 50))
      return db.prepare(
        `SELECT m.* FROM mem_fts f JOIN memories m ON m.id=f.rowid WHERE mem_fts MATCH ? AND ${where.join(' AND ')} ORDER BY bm25(mem_fts) LIMIT ?`,
      ).all(...args).map(plain)
    },

    recent({ limit = 8, repo, kind } = {}) {
      const where = ['deleted_at IS NULL']
      const args = []
      if (repo) { where.push('repo=?'); args.push(repo) }
      if (kind) { where.push('kind=?'); args.push(kind) }
      args.push(Math.min(Math.max(Number(limit) || 8, 1), 100))
      return db.prepare(`SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...args).map(plain)
    },

    forget(ids) {
      let n = 0
      for (const id of ids) {
        const r = db.prepare('UPDATE memories SET deleted_at=? WHERE id=? AND deleted_at IS NULL').run(now(), id)
        if (r.changes) { n++; db.prepare('DELETE FROM mem_fts WHERE rowid=?').run(id); outbox('memory.forget', { id }) }
      }
      return n
    },

    restore(id) {
      const m = row(id)
      if (!m || !m.deleted_at) return false
      db.prepare('UPDATE memories SET deleted_at=NULL WHERE id=?').run(id)
      db.prepare('INSERT INTO mem_fts(rowid,text,topic) VALUES(?,?,?)').run(id, m.text, m.topic)
      outbox('memory.restore', { id })
      return true
    },

    deleted({ limit = 20 } = {}) {
      return db.prepare('SELECT * FROM memories WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?').all(limit).map(plain)
    },

    session(sessionId, { limit = 200 } = {}) {
      return db.prepare('SELECT * FROM memories WHERE session_id=? AND deleted_at IS NULL ORDER BY id LIMIT ?').all(sessionId, limit).map(plain)
    },

    linkProvenance({ commit = '', pr = '', session = '', repo = '', files = [], transcript = '', step = null }) {
      if (!commit && !pr) throw new Error('commit or pr is required')
      const r = db.prepare(
        'INSERT INTO provenance(commit_sha,pr_url,session_id,repo,files,transcript_path,step_idx,created_at) VALUES(?,?,?,?,?,?,?,?)',
      ).run(commit, pr, session, repo, JSON.stringify(files), transcript, step, now())
      outbox('provenance.link', { commit, pr, session, repo, files })
      return Number(r.lastInsertRowid)
    },

    codeSearch(term, { limit = 10 } = {}) {
      const t = String(term ?? '').trim()
      if (!t) return []
      const like = `%${t.replace(/[%_]/g, c => `\\${c}`)}%`
      const rows = db.prepare(
        `SELECT * FROM provenance WHERE commit_sha LIKE ? ESCAPE '\\' OR pr_url LIKE ? ESCAPE '\\' OR files LIKE ? ESCAPE '\\' OR repo LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?`,
      ).all(like, like, like, like, limit)
      return rows.map(r => ({
        ...plain(r),
        files: safeParse(r.files, []),
        turns: r.session_id ? store.session(r.session_id, { limit: 3 }).map(m => m.text.slice(0, 300)) : [],
      }))
    },

    libraryPut(kind, name, body) {
      const n = cleanTopic(name)
      if (!n) throw new Error('name is empty')
      if (looksSecret(body)) throw new Error('body looks like a secret and was not saved')
      db.prepare(
        'INSERT INTO library(kind,name,body,updated_at,deleted_at) VALUES(?,?,?,?,NULL) ON CONFLICT(kind,name) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at, deleted_at=NULL',
      ).run(kind, n, String(body), now())
      outbox(`${kind}.save`, { name: n, body: String(body) })
      return n
    },
    libraryGet(kind, name) {
      return db.prepare('SELECT kind,name,body,updated_at FROM library WHERE kind=? AND name=? AND deleted_at IS NULL').get(kind, cleanTopic(name)) ?? null
    },
    libraryList(kind) {
      return db.prepare('SELECT name, updated_at, length(body) AS bytes FROM library WHERE kind=? AND deleted_at IS NULL ORDER BY name').all(kind).map(plain)
    },
    libraryDelete(kind, name) {
      const r = db.prepare('UPDATE library SET deleted_at=? WHERE kind=? AND name=? AND deleted_at IS NULL').run(now(), kind, cleanTopic(name))
      if (r.changes) outbox(`${kind}.delete`, { name: cleanTopic(name) })
      return r.changes > 0
    },

    swarmPost(swarm, text, author = '') {
      const body = String(text ?? '').trim().slice(0, MEM_LIMITS.text)
      if (!swarm || !body) throw new Error('swarm and text are required')
      if (looksSecret(body)) throw new Error('text looks like a secret and was not saved')
      const r = db.prepare('INSERT INTO swarm_notes(swarm,author,text,created_at) VALUES(?,?,?,?)').run(swarm, author, body, now())
      outbox('swarm.post', { swarm, author, text: body })
      return Number(r.lastInsertRowid)
    },
    swarmRead(swarm, { since = 0, limit = 50 } = {}) {
      return db.prepare('SELECT id,author,text,created_at FROM swarm_notes WHERE swarm=? AND id>? ORDER BY id LIMIT ?').all(swarm, since, limit).map(plain)
    },
    swarmList() {
      return db.prepare('SELECT swarm, count(*) AS notes, max(id) AS last FROM swarm_notes GROUP BY swarm ORDER BY last DESC').all().map(plain)
    },

    pendingOutbox(limit = 100) {
      return db.prepare('SELECT * FROM sync_outbox WHERE sent_at IS NULL ORDER BY id LIMIT ?').all(limit).map(plain)
    },
    markSent(ids) {
      const st = db.prepare('UPDATE sync_outbox SET sent_at=? WHERE id=?')
      for (const id of ids) st.run(now(), id)
    },
    setCursor(name, cursor) {
      db.prepare('INSERT INTO sync_cursors(name,cursor,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at').run(name, String(cursor), now())
    },
    getCursor(name) {
      return db.prepare('SELECT cursor FROM sync_cursors WHERE name=?').get(name)?.cursor ?? null
    },

    putEmbedding(id, model, vec) {
      db.prepare('INSERT OR REPLACE INTO embeddings(memory_id,model,vec) VALUES(?,?,?)').run(id, model, JSON.stringify(vec))
    },
    vectorSearch(vec, { limit = 8, model } = {}) {
      const rows = db.prepare(
        'SELECT m.*, e.vec FROM embeddings e JOIN memories m ON m.id=e.memory_id WHERE m.deleted_at IS NULL' + (model ? ' AND e.model=?' : ''),
      ).all(...(model ? [model] : []))
      return rows
        .map(r => ({ ...plain(r), vec: undefined, score: cosine(vec, safeParse(r.vec, [])) }))
        .filter(r => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
    },

    stats() {
      const n = (sql) => Number(db.prepare(sql).get().n)
      return {
        memories: n('SELECT count(*) AS n FROM memories WHERE deleted_at IS NULL'),
        forgotten: n('SELECT count(*) AS n FROM memories WHERE deleted_at IS NOT NULL'),
        embeddings: n('SELECT count(*) AS n FROM embeddings'),
        provenance: n('SELECT count(*) AS n FROM provenance'),
        skills: n("SELECT count(*) AS n FROM library WHERE kind='skill' AND deleted_at IS NULL"),
        artifacts: n("SELECT count(*) AS n FROM library WHERE kind='artifact' AND deleted_at IS NULL"),
        outboxPending: n('SELECT count(*) AS n FROM sync_outbox WHERE sent_at IS NULL'),
      }
    },
    integrity() {
      return db.prepare('PRAGMA integrity_check').get().integrity_check
    },
  }
  return store
}

function plain(r) {
  return r ? { ...r, id: r.id === undefined ? undefined : Number(r.id) } : r
}

function safeParse(s, fallback) {
  try { return JSON.parse(s) } catch { return fallback }
}

export function cosine(a, b) {
  if (!a.length || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

export const OLLAMA_URL = 'http://127.0.0.1:11434/api/embed'
export const OLLAMA_MODEL = 'nomic-embed-text'

// Returns one vector, or null when Ollama is not running or the model is missing.
export async function embedText(text, { url = OLLAMA_URL, model = OLLAMA_MODEL, timeoutMs = 1500 } = {}) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: String(text).slice(0, 2000) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const body = await res.json()
    const vec = body.embeddings?.[0]
    return Array.isArray(vec) ? vec : null
  } catch { return null }
}

export function fileExists(p) { return existsSync(p) }
