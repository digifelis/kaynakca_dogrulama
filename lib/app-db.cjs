// Accounts, sessions, plans, settings, the operation log (with tokens) and the audit trail: one SQLite file (app.db).
// The writing assistant's own data stays in writer.db and is keyed by the user ids defined here.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_DIR = () => process.env.WRITER_DATA_DIR || path.join(__dirname, '..', 'data', 'writer');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, display_name TEXT NOT NULL DEFAULT '',
  email TEXT COLLATE NOCASE, email_verified INTEGER NOT NULL DEFAULT 0, password_hash TEXT,
  source TEXT NOT NULL DEFAULT 'local', ldap_dn TEXT, role TEXT NOT NULL DEFAULT 'user',
  plan_id TEXT NOT NULL DEFAULT 'basic', plan_expires_at INTEGER, status TEXT NOT NULL DEFAULT 'active',
  must_change_password INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_login_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS users_verified_email ON users(email) WHERE email IS NOT NULL AND email_verified = 1;
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL, ip TEXT, ua TEXT);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, email TEXT, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, fails INTEGER NOT NULL, locked_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL,
  projects INTEGER NOT NULL, documents_per_project INTEGER NOT NULL, document_bytes INTEGER NOT NULL,
  questions_per_day INTEGER NOT NULL, monthly_tokens INTEGER NOT NULL DEFAULT 0, references_per_document INTEGER NOT NULL DEFAULT 0,
  monthly_references INTEGER NOT NULL DEFAULT 0, word_documents INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY, user_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, project_id TEXT, detail TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER, duration_ms INTEGER,
  prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE INDEX IF NOT EXISTS operations_user_time ON operations(user_id, started_at);
CREATE INDEX IF NOT EXISTS operations_time ON operations(started_at);
CREATE INDEX IF NOT EXISTS operations_kind ON operations(kind, started_at);
CREATE TABLE IF NOT EXISTS operation_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL, kind TEXT NOT NULL, provider TEXT, model TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS operation_calls_op ON operation_calls(operation_id);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor_id TEXT, actor_name TEXT, action TEXT NOT NULL,
  target_type TEXT, target_id TEXT, detail TEXT, ip TEXT);
CREATE INDEX IF NOT EXISTS audit_time ON audit_log(at);
CREATE INDEX IF NOT EXISTS audit_action ON audit_log(action, at);
`;

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');

function openDatabase(dir = DEFAULT_DIR()) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'app.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // Databases created before these limits existed get the columns (0 = unlimited, so nothing changes until an administrator sets them).
  const planColumns = db.prepare('PRAGMA table_info(plans)').all().map(c => c.name);
  for (const column of ['references_per_document', 'monthly_references', 'word_documents']) if (!planColumns.includes(column)) db.exec(`ALTER TABLE plans ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  return {
    dir, db,
    q: sql => db.prepare(sql),
    transaction(fn) { db.exec('BEGIN'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; } },
    close() { db.close(); },
  };
}

let shared = null, sharedDir = null;
function defaultDatabase() {
  const dir = DEFAULT_DIR();
  if (!shared || sharedDir !== dir) { shared?.close(); shared = openDatabase(dir); sharedDir = dir; }
  return shared;
}

module.exports = { openDatabase, defaultDatabase, sha256, SCHEMA };
