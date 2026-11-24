// Derived SQLite FTS5 + optional vector hybrid memory & provenance index.
// Durable Markdown files (`memory/*.md`), `journal.jsonl`, and session logs remain
// the source of truth; deleting `memory-index.sqlite` only costs a rebuild.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { wordsOf } from './memory-entries.js'
import { cosineSimilarity, packVector, unpackVector } from './memory-embeddings.js'

const RRF_K = 60
const DEFAULT_LIMIT = 15
const MAX_LIMIT = 50
const VECTOR_SCAN_MAX = 400

const likePattern = term => `%${String(term).toLowerCase().replace(/[\\%_]/g, ch => `\\${ch}`)}%`

export function tokenizeForFts(text) {
  const tokens = new Set()
  for (const w of wordsOf(String(text ?? ''))) tokens.add(w)
  for (const raw of String(text ?? '').toLowerCase().match(/[a-z0-9_./:-]{2,}/g) ?? []) tokens.add(raw)
  return [...tokens].join(' ')
}

export function buildFtsMatch(query) {
  const raw = String(query ?? '').trim()
  if (raw === '') return null
  const terms = new Set()
  for (const w of wordsOf(raw)) terms.add(w)
  for (const word of raw.toLowerCase().match(/[a-z0-9_-]{2,}/g) ?? []) terms.add(word)
  if (terms.size === 0) return null
  return [...terms].slice(0, 16).map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ')
}

function rrfFuse(ftsIds, vecIds, likeIds, metaById) {
  const scores = new Map()
  const addRank = (list, weight) => {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + weight / (RRF_K + index + 1))
    })
  }
  addRank(ftsIds, 1.4)
  addRank(vecIds, 1.2)
  addRank(likeIds, 0.7)

  const now = Date.now()
  for (const [id, score] of scores.entries()) {
    const updatedAt = metaById.get(id)?.updated_at ?? now
    const ageDays = Math.max(0, (now - updatedAt) / 86_400_000)
    const recency = 0.05 / (1 + ageDays / 30)
    scores.set(id, score + recency)
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1])
}

export function install(rt) {
  const { ctx, home, state } = rt
  const dbPath = join(home, 'memory-index.sqlite')
  let db = null
  let closed = false
  let embedQueue = Promise.resolve()

  function openDb() {
    if (closed) return null
    if (db !== null) return db
    mkdirSync(home, { recursive: true })
    const instance = new DatabaseSync(dbPath)
    instance.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        bot_id TEXT,
        room_id TEXT,
        repo_key TEXT,
        topic TEXT,
        title TEXT,
        body TEXT NOT NULL,
        tokens TEXT NOT NULL,
        meta_json TEXT NOT NULL,
        is_private INTEGER NOT NULL DEFAULT 0,
        privacy_mode TEXT NOT NULL DEFAULT 'on',
        deleted_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS docs_kind_scope_idx ON docs (kind, scope_key, deleted_at, updated_at DESC);
      CREATE INDEX IF NOT EXISTS docs_repo_idx ON docs (repo_key, deleted_at, updated_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        id UNINDEXED,
        title,
        topic,
        body,
        tokens,
        tokenize = 'unicode61'
      );

      CREATE TABLE IF NOT EXISTS doc_vectors (
        doc_id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vec BLOB NOT NULL,
        norm REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        session_id TEXT,
        agent_source TEXT NOT NULL,
        bot_id TEXT,
        room_id TEXT,
        repo_key TEXT,
        branch TEXT,
        turn INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL,
        title TEXT,
        summary TEXT NOT NULL,
        facts_json TEXT NOT NULL,
        files_json TEXT NOT NULL,
        is_private INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS observations_session_idx ON observations (session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS observations_repo_idx ON observations (repo_key, created_at DESC);

      CREATE TABLE IF NOT EXISTS code_provenance (
        id TEXT PRIMARY KEY,
        repo_root TEXT,
        repo_remote TEXT,
        branch TEXT,
        commit_sha TEXT,
        pr_url TEXT,
        pr_number INTEGER,
        session_id TEXT,
        bot_id TEXT,
        room_id TEXT,
        turn INTEGER NOT NULL DEFAULT 0,
        event_seq INTEGER NOT NULL DEFAULT 0,
        files_json TEXT NOT NULL,
        files_text TEXT NOT NULL,
        diff_summary TEXT NOT NULL,
        meta_json TEXT NOT NULL,
        is_private INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS code_prov_sha_idx ON code_provenance (commit_sha);
      CREATE INDEX IF NOT EXISTS code_prov_pr_idx ON code_provenance (pr_number);
      CREATE INDEX IF NOT EXISTS code_prov_session_idx ON code_provenance (session_id, created_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS code_provenance_fts USING fts5(
        id UNINDEXED,
        repo_remote,
        branch,
        commit_sha,
        pr_url,
        files_text,
        diff_summary,
        tokenize = 'unicode61'
      );
    `)
    db = instance
    return db
  }

  function queueEmbedding(docId, text) {
    if (closed || typeof rt.embedText !== 'function') return
    embedQueue = embedQueue.then(async () => {
      if (closed) return
      const res = await rt.embedText(text, { role: 'document' })
      if (!res || closed) return
      const conn = openDb()
      if (!conn) return
      conn.prepare(`
        INSERT INTO doc_vectors (doc_id, model, dim, vec, norm)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(doc_id) DO UPDATE SET
          model = excluded.model,
          dim = excluded.dim,
          vec = excluded.vec,
          norm = excluded.norm
      `).run(docId, res.model, res.dim, packVector(res.vec), res.norm)
    }).catch(() => {})
  }

  function upsertDoc(input) {
    const conn = openDb()
    if (!conn) return null
    const now = Date.now()
    const id = String(input.id)
    const title = String(input.title ?? '')
    const topic = String(input.topic ?? '')
    const body = String(input.body ?? '')
    const tokens = tokenizeForFts(`${title} ${topic} ${body}`)
    const isPrivate = input.isPrivate === true || (input.botId && rt.botOf?.(input.botId)?.private === true) ? 1 : 0
    const createdAt = Number.isFinite(input.createdAt) ? input.createdAt : now
    const updatedAt = Number.isFinite(input.updatedAt) ? input.updatedAt : now

    conn.prepare(`
      INSERT INTO docs (id, kind, scope_key, bot_id, room_id, repo_key, topic, title, body, tokens, meta_json, is_private, privacy_mode, deleted_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        scope_key = excluded.scope_key,
        bot_id = excluded.bot_id,
        room_id = excluded.room_id,
        repo_key = excluded.repo_key,
        topic = excluded.topic,
        title = excluded.title,
        body = excluded.body,
        tokens = excluded.tokens,
        meta_json = excluded.meta_json,
        is_private = excluded.is_private,
        privacy_mode = excluded.privacy_mode,
        deleted_at = NULL,
        updated_at = excluded.updated_at
    `).run(
      id,
      String(input.kind ?? 'memory'),
      String(input.scopeKey ?? 'team'),
      input.botId ?? null,
      input.roomId ?? null,
      input.repoKey ?? null,
      topic,
      title,
      body,
      tokens,
      JSON.stringify(input.meta ?? {}),
      isPrivate,
      String(input.privacyMode ?? 'on'),
      createdAt,
      updatedAt,
    )

    conn.prepare('DELETE FROM docs_fts WHERE id = ?').run(id)
    conn.prepare('INSERT INTO docs_fts (id, title, topic, body, tokens) VALUES (?, ?, ?, ?, ?)').run(id, title, topic, body, tokens)

    if (input.skipEmbed !== true) queueEmbedding(id, `${title}\n${topic}\n${body}`)
    return id
  }

  function softDeleteDoc(id, { soft = true } = {}) {
    const conn = openDb()
    if (!conn) return false
    const key = String(id)
    if (soft) {
      const res = conn.prepare('UPDATE docs SET deleted_at = ? WHERE id = ?').run(Date.now(), key)
      conn.prepare('UPDATE observations SET deleted_at = ? WHERE id = ?').run(Date.now(), key)
      return res.changes > 0
    }
    const res = conn.prepare('DELETE FROM docs WHERE id = ?').run(key)
    conn.prepare('DELETE FROM docs_fts WHERE id = ?').run(key)
    conn.prepare('DELETE FROM doc_vectors WHERE doc_id = ?').run(key)
    conn.prepare('DELETE FROM observations WHERE id = ?').run(key)
    return res.changes > 0
  }

  function restoreDoc(id) {
    const conn = openDb()
    if (!conn) return false
    const key = String(id)
    const res = conn.prepare('UPDATE docs SET deleted_at = NULL WHERE id = ?').run(key)
    conn.prepare('UPDATE observations SET deleted_at = NULL WHERE id = ?').run(key)
    return res.changes > 0
  }

  function insertObservationRow(row) {
    const conn = openDb()
    if (!conn) return { inserted: false, row: null }
    if (row.idempotencyKey) {
      const existing = conn.prepare('SELECT id, kind, title, summary, created_at FROM observations WHERE idempotency_key = ?').get(row.idempotencyKey)
      if (existing !== undefined) return { inserted: false, duplicate: true, row: existing }
    }
    const isPrivate = row.isPrivate === true || (row.botId && rt.botOf?.(row.botId)?.private === true) ? 1 : 0
    const createdAt = Number.isFinite(row.createdAt) ? row.createdAt : Date.now()
    conn.prepare(`
      INSERT INTO observations (id, idempotency_key, session_id, agent_source, bot_id, room_id, repo_key, branch, turn, kind, title, summary, facts_json, files_json, is_private, deleted_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      row.id,
      row.idempotencyKey ?? null,
      row.sessionId ?? null,
      String(row.agentSource ?? 'dsbot'),
      row.botId ?? null,
      row.roomId ?? null,
      row.repoKey ?? null,
      row.branch ?? null,
      Number.isInteger(row.turn) ? row.turn : 0,
      String(row.kind ?? 'observation'),
      String(row.title ?? ''),
      String(row.summary ?? ''),
      JSON.stringify(row.facts ?? []),
      JSON.stringify(row.files ?? []),
      isPrivate,
      createdAt,
    )
    upsertDoc({
      id: row.id,
      kind: 'observation',
      scopeKey: row.scopeKey ?? (row.roomId ? `group:${row.roomId}` : row.botId ? `bot:${row.botId}` : 'team'),
      botId: row.botId ?? null,
      roomId: row.roomId ?? null,
      repoKey: row.repoKey ?? null,
      topic: row.kind ?? 'observation',
      title: row.title ?? '',
      body: [row.summary, ...(Array.isArray(row.facts) ? row.facts : []), ...(Array.isArray(row.files) ? row.files : [])].filter(Boolean).join('\n'),
      meta: { sessionId: row.sessionId ?? null, agentSource: row.agentSource ?? 'dsbot', branch: row.branch ?? null, obsKind: row.kind ?? 'observation', files: row.files ?? [] },
      isPrivate: isPrivate === 1,
      createdAt,
      updatedAt: createdAt,
    })
    return { inserted: true, duplicate: false, row: { id: row.id, createdAt } }
  }

  function insertProvenanceRow(row) {
    const conn = openDb()
    if (!conn) return null
    const isPrivate = row.isPrivate === true || (row.botId && rt.botOf?.(row.botId)?.private === true) ? 1 : 0
    const createdAt = Number.isFinite(row.createdAt) ? row.createdAt : Date.now()
    const files = Array.isArray(row.files) ? row.files.map(String) : []
    const filesText = files.join(' ')
    conn.prepare(`
      INSERT INTO code_provenance (id, repo_root, repo_remote, branch, commit_sha, pr_url, pr_number, session_id, bot_id, room_id, turn, event_seq, files_json, files_text, diff_summary, meta_json, is_private, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        branch = COALESCE(excluded.branch, code_provenance.branch),
        commit_sha = COALESCE(excluded.commit_sha, code_provenance.commit_sha),
        pr_url = COALESCE(excluded.pr_url, code_provenance.pr_url),
        pr_number = COALESCE(excluded.pr_number, code_provenance.pr_number),
        files_json = excluded.files_json,
        files_text = excluded.files_text,
        diff_summary = excluded.diff_summary,
        meta_json = excluded.meta_json
    `).run(
      row.id,
      row.repoRoot ?? null,
      row.repoRemote ?? null,
      row.branch ?? null,
      row.commitSha ?? null,
      row.prUrl ?? null,
      Number.isInteger(row.prNumber) ? row.prNumber : null,
      row.sessionId ?? null,
      row.botId ?? null,
      row.roomId ?? null,
      Number.isInteger(row.turn) ? row.turn : 0,
      Number.isInteger(row.eventSeq) ? row.eventSeq : 0,
      JSON.stringify(files),
      filesText,
      String(row.diffSummary ?? ''),
      JSON.stringify(row.meta ?? {}),
      isPrivate,
      createdAt,
    )
    conn.prepare('DELETE FROM code_provenance_fts WHERE id = ?').run(row.id)
    conn.prepare('INSERT INTO code_provenance_fts (id, repo_remote, branch, commit_sha, pr_url, files_text, diff_summary) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      row.id,
      row.repoRemote ?? '',
      row.branch ?? '',
      row.commitSha ?? '',
      row.prUrl ?? '',
      filesText,
      String(row.diffSummary ?? ''),
    )
    return row.id
  }

  function buildFilterSql({ kinds, scopeKey, botId, roomId, repoKey, allowPrivateBotId = null, includeDeleted = false }) {
    const where = []
    const args = []
    if (!includeDeleted) where.push('d.deleted_at IS NULL')
    if (allowPrivateBotId === null || allowPrivateBotId === undefined) {
      where.push('d.is_private = 0')
    } else {
      where.push('(d.is_private = 0 OR d.bot_id = ?)')
      args.push(allowPrivateBotId)
    }
    if (Array.isArray(kinds) && kinds.length > 0) {
      where.push(`d.kind IN (${kinds.map(() => '?').join(',')})`)
      args.push(...kinds.map(String))
    }
    if (scopeKey) {
      where.push('d.scope_key = ?')
      args.push(String(scopeKey))
    }
    if (botId) {
      where.push('d.bot_id = ?')
      args.push(String(botId))
    }
    if (roomId) {
      where.push('d.room_id = ?')
      args.push(String(roomId))
    }
    if (repoKey) {
      where.push('d.repo_key = ?')
      args.push(String(repoKey))
    }
    return { whereSql: where.join(' AND '), args }
  }

  async function hybridSearch(query, options = {}) {
    const conn = openDb()
    if (!conn) return { hits: [], mode: 'unavailable' }
    const limit = Math.min(Math.max(Number(options.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
    const q = String(query ?? '').trim()
    const { whereSql, args } = buildFilterSql(options)

    if (q === '') {
      const rows = conn.prepare(`
        SELECT d.id, d.kind, d.scope_key, d.bot_id, d.room_id, d.repo_key, d.topic, d.title, d.body, d.meta_json, d.updated_at
        FROM docs d
        WHERE ${whereSql}
        ORDER BY d.updated_at DESC
        LIMIT ?
      `).all(...args, limit)
      return { hits: rows.map(formatDocHit(0)), mode: 'recent' }
    }

    const metaById = new Map()
    const ftsIds = []
    const ftsMatch = buildFtsMatch(q)
    if (ftsMatch !== null) {
      try {
        const ftsRows = conn.prepare(`
          SELECT d.id, d.updated_at
          FROM docs_fts f
          JOIN docs d ON d.id = f.id
          WHERE docs_fts MATCH ? AND ${whereSql}
          ORDER BY rank
          LIMIT ?
        `).all(ftsMatch, ...args, limit * 3)
        for (const r of ftsRows) {
          ftsIds.push(r.id)
          metaById.set(r.id, r)
        }
      } catch { /* malformed fts query falls back to LIKE */ }
    }

    const likeIds = []
    const like = likePattern(q)
    const likeRows = conn.prepare(`
      SELECT d.id, d.updated_at
      FROM docs d
      WHERE ${whereSql} AND (lower(d.body) LIKE ? ESCAPE '\\' OR lower(d.title) LIKE ? ESCAPE '\\' OR lower(d.topic) LIKE ? ESCAPE '\\')
      ORDER BY d.updated_at DESC
      LIMIT ?
    `).all(...args, like, like, like, limit * 2)
    for (const r of likeRows) {
      likeIds.push(r.id)
      if (!metaById.has(r.id)) metaById.set(r.id, r)
    }

    const vecIds = []
    const queryVec = typeof rt.embedText === 'function' ? await rt.embedText(q, { role: 'query' }) : null
    if (queryVec !== null) {
      const vecRows = conn.prepare(`
        SELECT d.id, d.updated_at, v.vec
        FROM doc_vectors v
        JOIN docs d ON d.id = v.doc_id
        WHERE ${whereSql} AND v.model = ?
        ORDER BY d.updated_at DESC
        LIMIT ?
      `).all(...args, queryVec.model, VECTOR_SCAN_MAX)
      const scored = []
      for (const r of vecRows) {
        const vec = unpackVector(r.vec)
        const sim = cosineSimilarity(queryVec.vec, vec)
        if (sim > 0.05) {
          scored.push({ id: r.id, sim })
          if (!metaById.has(r.id)) metaById.set(r.id, r)
        }
      }
      scored.sort((a, b) => b.sim - a.sim)
      for (const item of scored.slice(0, limit * 3)) vecIds.push(item.id)
    }

    const fused = rrfFuse(ftsIds, vecIds, likeIds, metaById).slice(0, limit)
    if (fused.length === 0) return { hits: [], mode: queryVec ? 'hybrid' : 'lexical' }

    const placeholders = fused.map(() => '?').join(',')
    const rowsById = new Map(
      conn.prepare(`
        SELECT id, kind, scope_key, bot_id, room_id, repo_key, topic, title, body, meta_json, updated_at, deleted_at
        FROM docs WHERE id IN (${placeholders})
      `).all(...fused.map(([id]) => id)).map(r => [r.id, r]),
    )
    const hits = fused
      .map(([id, score]) => {
        const row = rowsById.get(id)
        return row ? formatDocHit(score)(row) : null
      })
      .filter(Boolean)

    return { hits, mode: queryVec ? 'hybrid' : 'lexical' }
  }

  function formatDocHit(score) {
    return (row) => {
      let meta = {}
      try { meta = JSON.parse(row.meta_json) } catch { /* ignore */ }
      const body = String(row.body ?? '')
      return {
        id: row.id,
        kind: row.kind,
        scopeKey: row.scope_key,
        botId: row.bot_id,
        roomId: row.room_id,
        repoKey: row.repo_key,
        topic: row.topic,
        title: row.title,
        snippet: body.length > 260 ? `${body.slice(0, 260)}…` : body,
        meta,
        score: Number(score.toFixed(6)),
        updatedAt: row.updated_at,
        ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
      }
    }
  }

  function memoryIndexGet(id, { allowPrivateBotId = null } = {}) {
    const conn = openDb()
    if (!conn) return null
    const row = conn.prepare(`
      SELECT id, kind, scope_key, bot_id, room_id, repo_key, topic, title, body, meta_json, is_private, deleted_at, created_at, updated_at
      FROM docs WHERE id = ?
    `).get(String(id))
    if (row === undefined) return null
    if (row.is_private === 1 && (allowPrivateBotId === null || row.bot_id !== allowPrivateBotId)) return null
    let meta = {}
    try { meta = JSON.parse(row.meta_json) } catch { /* ignore */ }
    return {
      id: row.id,
      kind: row.kind,
      scopeKey: row.scope_key,
      botId: row.bot_id,
      roomId: row.room_id,
      repoKey: row.repo_key,
      topic: row.topic,
      title: row.title,
      body: row.body,
      meta,
      deletedAt: row.deleted_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  function queryCodeProvenance({ query, commitSha, prUrl, prNumber, filePath, repo, branch, allowPrivateBotId = null, limit = DEFAULT_LIMIT } = {}) {
    const conn = openDb()
    if (!conn) return []
    const cap = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
    const where = []
    const args = []
    if (allowPrivateBotId === null || allowPrivateBotId === undefined) {
      where.push('p.is_private = 0')
    } else {
      where.push('(p.is_private = 0 OR p.bot_id = ?)')
      args.push(allowPrivateBotId)
    }
    if (commitSha) {
      where.push('p.commit_sha LIKE ?')
      args.push(`${String(commitSha).trim()}%`)
    }
    if (prUrl) {
      where.push('p.pr_url = ?')
      args.push(String(prUrl).trim())
    }
    if (Number.isInteger(Number(prNumber)) && Number(prNumber) > 0) {
      where.push('p.pr_number = ?')
      args.push(Number(prNumber))
    }
    if (repo) {
      where.push('(p.repo_remote LIKE ? ESCAPE \'\\\' OR p.repo_root LIKE ? ESCAPE \'\\\')')
      const pat = likePattern(repo)
      args.push(pat, pat)
    }
    if (branch) {
      where.push('p.branch = ?')
      args.push(String(branch).trim())
    }
    if (filePath) {
      where.push("lower(p.files_text) LIKE ? ESCAPE '\\'")
      args.push(likePattern(filePath))
    }

    const q = String(query ?? '').trim()
    const ftsMatch = q !== '' ? buildFtsMatch(q) : null
    if (ftsMatch !== null) {
      try {
        const rows = conn.prepare(`
          SELECT p.*
          FROM code_provenance_fts f
          JOIN code_provenance p ON p.id = f.id
          WHERE code_provenance_fts MATCH ? AND ${where.join(' AND ')}
          ORDER BY rank
          LIMIT ?
        `).all(ftsMatch, ...args, cap)
        if (rows.length > 0) return rows.map(formatProvenanceRow)
      } catch { /* fall through to structured/LIKE query */ }
    }

    if (q !== '') {
      const pat = likePattern(q)
      where.push("(lower(p.diff_summary) LIKE ? ESCAPE '\\' OR lower(p.files_text) LIKE ? ESCAPE '\\' OR lower(COALESCE(p.commit_sha,'')) LIKE ? ESCAPE '\\' OR lower(COALESCE(p.branch,'')) LIKE ? ESCAPE '\\')")
      args.push(pat, pat, pat, pat)
    }

    return conn.prepare(`
      SELECT p.*
      FROM code_provenance p
      WHERE ${where.join(' AND ')}
      ORDER BY p.created_at DESC
      LIMIT ?
    `).all(...args, cap).map(formatProvenanceRow)
  }

  function formatProvenanceRow(row) {
    let files = []
    let meta = {}
    try { files = JSON.parse(row.files_json) } catch { /* ignore */ }
    try { meta = JSON.parse(row.meta_json) } catch { /* ignore */ }
    return {
      id: row.id,
      repoRoot: row.repo_root,
      repoRemote: row.repo_remote,
      branch: row.branch,
      commitSha: row.commit_sha,
      prUrl: row.pr_url,
      prNumber: row.pr_number,
      sessionId: row.session_id,
      botId: row.bot_id,
      roomId: row.room_id,
      turn: row.turn,
      eventSeq: row.event_seq,
      files,
      diffSummary: row.diff_summary,
      meta,
      createdAt: row.created_at,
    }
  }

  function listRecentObservations({ repoKey, sessionId, allowPrivateBotId = null, limit = 10 } = {}) {
    const conn = openDb()
    if (!conn) return []
    const where = ['deleted_at IS NULL']
    const args = []
    if (allowPrivateBotId === null || allowPrivateBotId === undefined) where.push('is_private = 0')
    else { where.push('(is_private = 0 OR bot_id = ?)'); args.push(allowPrivateBotId) }
    if (repoKey) { where.push('repo_key = ?'); args.push(String(repoKey)) }
    if (sessionId) { where.push('session_id = ?'); args.push(String(sessionId)) }
    return conn.prepare(`SELECT * FROM observations WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`).all(...args, limit)
  }

  async function memoryIndexSyncMarkdown() {
    if (typeof rt.memoryExportEntries !== 'function') return 0
    const entries = await rt.memoryExportEntries({ includePrivate: true })
    let count = 0
    for (const item of entries) {
      upsertDoc({
        id: item.id,
        kind: 'memory',
        scopeKey: item.scopeKey,
        botId: item.botId ?? null,
        roomId: item.roomId ?? null,
        topic: item.topic ?? '',
        title: item.topic ? `[[${item.topic}]]` : 'MEMORY.md',
        body: item.text,
        meta: item.meta ?? {},
        isPrivate: item.isPrivate === true,
      })
      count += 1
    }
    for (const cap of Object.values(state.capabilities?.items ?? {})) {
      if (cap?.kind !== 'skill') continue
      upsertDoc({
        id: `skill:${cap.name}`,
        kind: 'skill',
        scopeKey: 'team',
        botId: cap.createdBy ?? null,
        topic: cap.name,
        title: cap.name,
        body: [cap.description ?? '', cap.content ?? ''].filter(Boolean).join('\n'),
        meta: { kind: 'skill', createdBy: cap.createdBy ?? null },
        isPrivate: false,
        createdAt: cap.createdAt,
        updatedAt: cap.updatedAt,
      })
      count += 1
    }
    for (const art of Object.values(state.artifacts ?? {})) {
      if (!art?.slug) continue
      upsertDoc({
        id: `artifact:${art.slug}`,
        kind: 'artifact',
        scopeKey: art.scope ?? 'team',
        botId: art.createdBy ?? null,
        repoKey: art.repo ?? null,
        topic: art.kind ?? 'spec',
        title: art.title ?? art.slug,
        body: art.content ?? art.summary ?? '',
        meta: { slug: art.slug, kind: art.kind, tags: art.tags ?? [], version: art.version ?? 1, provenance: art.provenance ?? null },
        isPrivate: false,
        createdAt: art.createdAt,
        updatedAt: art.updatedAt,
      })
      count += 1
    }
    return count
  }

  ctx.effect(() => () => {
    closed = true
    return embedQueue.finally(() => {
      if (db !== null) {
        try { db.close() } catch { /* already closed */ }
        db = null
      }
    })
  }, 'ds-bot: memory index')

  Object.assign(rt, {
    memoryIndexUpsert: upsertDoc,
    memoryIndexDelete: softDeleteDoc,
    memoryIndexRestore: restoreDoc,
    memoryIndexGet,
    memoryIndexSyncMarkdown,
    hybridSearch,
    insertObservationRow,
    insertProvenanceRow,
    queryCodeProvenance,
    listRecentObservations,
    memoryIndexFlushEmbeddings: () => embedQueue,
  })
}
