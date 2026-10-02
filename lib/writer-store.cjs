// Writing assistant storage: SQLite (node:sqlite, no dependency) with one hard rule.
// Every method takes the owner's userId and puts it in the WHERE clause; there is no query that reads a
// project, document, chunk or message without it, so one user's data can never reach another's.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_DIR = () => process.env.WRITER_DATA_DIR || path.join(__dirname, '..', 'data', 'writer');
const now = () => Date.now();
const uuid = () => crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);
const json = (value, fallback) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
const toBlob = vector => { const f = Float32Array.from(vector); return Buffer.from(f.buffer, f.byteOffset, f.byteLength); };
const fromBlob = blob => { const copy = Uint8Array.from(blob); return new Float32Array(copy.buffer, 0, copy.byteLength / 4); };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS projects_user ON projects(user_id);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL, file_name TEXT NOT NULL, status TEXT NOT NULL,
  error TEXT, page_count INTEGER, chunk_count INTEGER NOT NULL DEFAULT 0, embedded_count INTEGER NOT NULL DEFAULT 0,
  search_mode TEXT, meta TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS documents_project ON documents(user_id, project_id);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, project_id TEXT NOT NULL, user_id TEXT NOT NULL,
  ord INTEGER NOT NULL, page INTEGER, section TEXT, text TEXT NOT NULL, embedding BLOB);
CREATE INDEX IF NOT EXISTS chunks_project ON chunks(user_id, project_id);
CREATE INDEX IF NOT EXISTS chunks_document ON chunks(user_id, document_id);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
  skill TEXT, status TEXT NOT NULL DEFAULT 'done', error TEXT, upgrade TEXT, flags TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_project ON messages(user_id, project_id, created_at);
CREATE TABLE IF NOT EXISTS manuscripts (
  project_id TEXT NOT NULL, user_id TEXT NOT NULL, html TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, project_id));
CREATE TABLE IF NOT EXISTS usage (
  user_id TEXT NOT NULL, day TEXT NOT NULL, questions INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day));
`;

function createStore(dir = DEFAULT_DIR()) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'writer.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');
  db.exec(SCHEMA);
  const q = sql => db.prepare(sql);
  const transaction = fn => { db.exec('BEGIN'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } };

  const documentRow = r => !r ? null : ({ id: r.id, projectId: r.project_id, fileName: r.file_name, status: r.status, error: r.error || null,
    pageCount: r.page_count, chunkCount: r.chunk_count, embeddedCount: r.embedded_count, searchMode: r.search_mode || null,
    meta: json(r.meta, {}), createdAt: r.created_at });
  const messageRow = r => !r ? null : ({ id: r.id, role: r.role, text: r.text, skill: r.skill || null, status: r.status, error: r.error || null,
    upgrade: json(r.upgrade, null), flags: json(r.flags, {}), createdAt: r.created_at });

  const store = {
    dir, db,
    close() { db.close(); },

    // ---- projects
    createProject(userId, title) {
      const id = uuid(), t = now();
      q('INSERT INTO projects (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, userId, title, t, t);
      return store.getProject(userId, id);
    },
    countProjects: userId => q('SELECT COUNT(*) AS n FROM projects WHERE user_id = ?').get(userId).n,
    listProjects: userId => q(`SELECT p.id, p.title, p.created_at, p.updated_at,
        (SELECT COUNT(*) FROM documents d WHERE d.user_id = p.user_id AND d.project_id = p.id) AS documents
      FROM projects p WHERE p.user_id = ? ORDER BY p.updated_at DESC`).all(userId)
      .map(r => ({ id: r.id, title: r.title, documents: r.documents, createdAt: r.created_at, updatedAt: r.updated_at })),
    getProject(userId, id) {
      const r = q('SELECT * FROM projects WHERE user_id = ? AND id = ?').get(userId, String(id));
      return r ? { id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at } : null;
    },
    renameProject: (userId, id, title) => q('UPDATE projects SET title = ?, updated_at = ? WHERE user_id = ? AND id = ?').run(title, now(), userId, String(id)).changes > 0,
    touchProject: (userId, id) => q('UPDATE projects SET updated_at = ? WHERE user_id = ? AND id = ?').run(now(), userId, String(id)),
    deleteProject(userId, id) {
      return transaction(() => {
        const found = q('DELETE FROM projects WHERE user_id = ? AND id = ?').run(userId, String(id)).changes > 0;
        if (found) for (const table of ['documents', 'chunks', 'messages', 'manuscripts'])
          q(`DELETE FROM ${table} WHERE user_id = ? AND project_id = ?`).run(userId, String(id));
        return found;
      });
    },

    // ---- documents
    countDocuments: (userId, projectId) => q('SELECT COUNT(*) AS n FROM documents WHERE user_id = ? AND project_id = ?').get(userId, String(projectId)).n,
    addDocument(userId, projectId, { fileName, meta = {}, status = 'processing' }) {
      const id = uuid();
      q('INSERT INTO documents (id, project_id, user_id, file_name, status, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, String(projectId), userId, fileName, status, JSON.stringify(meta), now());
      return store.getDocument(userId, id);
    },
    getDocument: (userId, id) => documentRow(q('SELECT * FROM documents WHERE user_id = ? AND id = ?').get(userId, String(id))),
    listDocuments: (userId, projectId) => q('SELECT * FROM documents WHERE user_id = ? AND project_id = ? ORDER BY created_at').all(userId, String(projectId)).map(documentRow),
    updateDocument(userId, id, fields) {
      const columns = { status: 'status', error: 'error', pageCount: 'page_count', chunkCount: 'chunk_count', embeddedCount: 'embedded_count', searchMode: 'search_mode' };
      const sets = [], values = [];
      for (const [key, column] of Object.entries(columns)) if (fields[key] !== undefined) { sets.push(`${column} = ?`); values.push(fields[key]); }
      if (fields.meta !== undefined) { sets.push('meta = ?'); values.push(JSON.stringify(fields.meta)); }
      if (!sets.length) return false;
      return q(`UPDATE documents SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`).run(...values, userId, String(id)).changes > 0;
    },
    deleteDocument(userId, id) {
      return transaction(() => {
        const found = q('DELETE FROM documents WHERE user_id = ? AND id = ?').run(userId, String(id)).changes > 0;
        if (found) q('DELETE FROM chunks WHERE user_id = ? AND document_id = ?').run(userId, String(id));
        return found;
      });
    },

    // ---- chunks and vectors (never returned without the owner)
    insertChunks(userId, projectId, documentId, chunks) {
      const insert = q('INSERT INTO chunks (document_id, project_id, user_id, ord, page, section, text) VALUES (?, ?, ?, ?, ?, ?, ?)');
      transaction(() => chunks.forEach((c, i) => insert.run(String(documentId), String(projectId), userId, i, c.page ?? null, c.section || null, c.text)));
      store.updateDocument(userId, documentId, { chunkCount: chunks.length, embeddedCount: 0 });
    },
    chunksToEmbed: (userId, documentId, limit) => q('SELECT id, text FROM chunks WHERE user_id = ? AND document_id = ? AND embedding IS NULL ORDER BY ord LIMIT ?').all(userId, String(documentId), limit),
    setEmbeddings(userId, documentId, entries) {
      const update = q('UPDATE chunks SET embedding = ? WHERE user_id = ? AND document_id = ? AND id = ?');
      transaction(() => { for (const { id, vector } of entries) update.run(toBlob(vector), userId, String(documentId), id); });
      const done = q('SELECT COUNT(*) AS n FROM chunks WHERE user_id = ? AND document_id = ? AND embedding IS NOT NULL').get(userId, String(documentId)).n;
      store.updateDocument(userId, documentId, { embeddedCount: done });
      return done;
    },
    clearEmbeddings: (userId, documentId) => q('UPDATE chunks SET embedding = NULL WHERE user_id = ? AND document_id = ?').run(userId, String(documentId)),
    // Candidate set for one project's search: only this owner's chunks of documents that are ready.
    projectChunks(userId, projectId) {
      return q(`SELECT c.id, c.document_id, c.ord, c.page, c.section, c.text, c.embedding FROM chunks c
          JOIN documents d ON d.id = c.document_id AND d.user_id = c.user_id
        WHERE c.user_id = ? AND c.project_id = ? AND d.status = 'ready' ORDER BY c.document_id, c.ord`).all(userId, String(projectId))
        .map(r => ({ id: r.id, documentId: r.document_id, ord: r.ord, page: r.page, section: r.section, text: r.text, vector: r.embedding ? fromBlob(r.embedding) : null }));
    },
    // Neighbours of a chunk (same document), for expanding a hit with the text around it.
    chunkById: (userId, id) => q('SELECT id, document_id, ord, page, section, text FROM chunks WHERE user_id = ? AND id = ?').get(userId, Number(id)) ?? null,

    // ---- messages
    addMessage(userId, projectId, { role, text = '', skill = null, status = 'done' }) {
      const id = uuid();
      q('INSERT INTO messages (id, project_id, user_id, role, text, skill, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, String(projectId), userId, role, text, skill, status, now());
      return store.getMessage(userId, id);
    },
    getMessage: (userId, id) => messageRow(q('SELECT * FROM messages WHERE user_id = ? AND id = ?').get(userId, String(id))),
    updateMessage(userId, id, { text, status, error, upgrade, flags }) {
      const sets = [], values = [];
      if (text !== undefined) { sets.push('text = ?'); values.push(text); }
      if (status !== undefined) { sets.push('status = ?'); values.push(status); }
      if (error !== undefined) { sets.push('error = ?'); values.push(error); }
      if (upgrade !== undefined) { sets.push('upgrade = ?'); values.push(upgrade ? JSON.stringify(upgrade) : null); }
      if (flags !== undefined) { sets.push('flags = ?'); values.push(JSON.stringify(flags)); }
      if (sets.length) q(`UPDATE messages SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`).run(...values, userId, String(id));
    },
    // The most recent messages, oldest first.
    listMessages(userId, projectId, limit = 100) {
      return q('SELECT * FROM (SELECT *, rowid AS rid FROM messages WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at, rid')
        .all(userId, String(projectId), limit).map(messageRow);
    },
    clearMessages: (userId, projectId) => q('DELETE FROM messages WHERE user_id = ? AND project_id = ?').run(userId, String(projectId)),

    // ---- manuscript
    getManuscript(userId, projectId) {
      const r = q('SELECT html, revision, updated_at FROM manuscripts WHERE user_id = ? AND project_id = ?').get(userId, String(projectId));
      return r ? { html: r.html, revision: r.revision, updatedAt: r.updated_at } : { html: '', revision: 0, updatedAt: null };
    },
    // Optimistic concurrency: a save from a stale window is refused instead of overwriting newer text.
    saveManuscript(userId, projectId, html, revision) {
      const current = store.getManuscript(userId, projectId);
      if (revision !== current.revision) throw Object.assign(Error('Makale başka bir pencerede değişti; sayfayı yenileyin.'), { status: 409 });
      q(`INSERT INTO manuscripts (project_id, user_id, html, revision, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, project_id) DO UPDATE SET html = excluded.html, revision = excluded.revision, updated_at = excluded.updated_at`)
        .run(String(projectId), userId, html, current.revision + 1, now());
      store.touchProject(userId, projectId);
      return store.getManuscript(userId, projectId);
    },

    // ---- daily question usage (per user, per UTC day)
    questionsToday: userId => q('SELECT questions FROM usage WHERE user_id = ? AND day = ?').get(userId, today())?.questions || 0,
    addQuestion: userId => q(`INSERT INTO usage (user_id, day, questions) VALUES (?, ?, 1)
      ON CONFLICT(user_id, day) DO UPDATE SET questions = questions + 1`).run(userId, today()),

    // Work that was running when the server stopped cannot continue: mark it so the user can retry.
    recoverInterrupted() {
      const docs = q("UPDATE documents SET status = 'error', error = 'Sunucu yeniden başladı; işlem yarım kaldı. Yeniden deneyin.' WHERE status IN ('processing', 'embedding')").run().changes;
      const msgs = q("UPDATE messages SET status = 'error', error = 'Sunucu yeniden başladı; soruyu yeniden sorun.' WHERE status = 'working'").run().changes;
      return { documents: docs, messages: msgs };
    },
  };
  return store;
}

let shared = null, sharedDir = null;
// The process-wide store follows WRITER_DATA_DIR, so tests can point it at a temporary folder.
function defaultStore() {
  const dir = DEFAULT_DIR();
  if (!shared || sharedDir !== dir) { shared?.close(); shared = createStore(dir); sharedDir = dir; shared.recoverInterrupted(); }
  return shared;
}

module.exports = { createStore, defaultStore, today };
