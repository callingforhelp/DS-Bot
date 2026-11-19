// Contract C1: the lineage archive, schema version 1 (PRAGMA user_version = 1).
// Times are Unix epoch milliseconds. actor/target are DS Bot ids, 'system:goal-check' or
// 'unresolved:<12 hex>'. ref is 'session:<id>#seq:<n>', 'ledger:<book>#<id>',
// 'diagnostics:<time>' or 'group:<roomId>#<seq>': never a path, cwd or title. Rows are never
// deleted; rev starts at 1 and grows by one when a tracked field changes.
export const SCHEMA_VERSION = 1
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, name TEXT, private INTEGER NOT NULL DEFAULT 0, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS session_owners (session_id TEXT PRIMARY KEY, bot_id TEXT, room_id TEXT, kind TEXT NOT NULL CHECK (kind IN ('chat','segment','part','group','room')));
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, category TEXT, assigned_by TEXT, assigned_to TEXT, exchange_id TEXT, created_at INTEGER, status TEXT, completed_at INTEGER, ref TEXT, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT, bot_id TEXT, session_id TEXT, turn INTEGER, role TEXT, started_at INTEGER, ended_at INTEGER, outcome TEXT, ref TEXT);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, rev INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL, task_id TEXT, run_id TEXT, actor TEXT, target TEXT, room_id TEXT, at INTEGER NOT NULL, session_id TEXT, seq INTEGER, ref TEXT, meta TEXT, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS authorizations (id TEXT PRIMARY KEY, rev INTEGER NOT NULL DEFAULT 1, at INTEGER NOT NULL, actor TEXT, target TEXT, room_id TEXT, action TEXT NOT NULL, outcome TEXT NOT NULL CHECK (outcome IN ('allowed','denied','pending','policy')), reason TEXT, source TEXT NOT NULL CHECK (source IN ('tool','diagnostics','ledger','group-notice','session-policy')), task_id TEXT, run_id TEXT, session_id TEXT, seq INTEGER, ref TEXT, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, task_id TEXT, kind TEXT, ref TEXT, sha256 TEXT, bytes INTEGER, at INTEGER);
CREATE TABLE IF NOT EXISTS sync (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER, counts TEXT);
CREATE TABLE IF NOT EXISTS cursors (source TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS events_task ON events (task_id, at);
CREATE INDEX IF NOT EXISTS auth_time ON authorizations (at);
`

export const TRACKED = ['kind', 'outcome', 'reason', 'actor', 'target', 'room_id', 'action', 'task_id', 'run_id']
export const EVENT_KINDS = Object.freeze(new Set(['task.assigned', 'message.requested', 'message.delivered', 'message.replied', 'review.verdict', 'task.completed']))
