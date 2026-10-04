// Writing assistant storage: SQLite (node:sqlite, no dependency) with one hard rule.
// Every method takes the owner's userId and puts it in the WHERE clause; there is no query that reads a
// collection, project, document, chunk or message without it, so one user's data can never reach another's.
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
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS collections_user ON collections(user_id);
CREATE TABLE IF NOT EXISTS project_collections (
  user_id TEXT NOT NULL, project_id TEXT NOT NULL, collection_id TEXT NOT NULL, PRIMARY KEY (user_id, project_id, collection_id));
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, collection_id TEXT, user_id TEXT NOT NULL, file_name TEXT NOT NULL, status TEXT NOT NULL,
  error TEXT, page_count INTEGER, chunk_count INTEGER NOT NULL DEFAULT 0, embedded_count INTEGER NOT NULL DEFAULT 0,
  search_mode TEXT, meta TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS documents_project ON documents(user_id, project_id);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, project_id TEXT NOT NULL, collection_id TEXT, user_id TEXT NOT NULL,
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

// Sources belong to a collection of the user; a project reads the collections linked to it. Databases made before
// collections existed get one collection per project that had sources, named after the project and linked to it.
function migrate(db) {
  // The language a project's answers are written in ("tr" or "en").
  if (!db.prepare('PRAGMA table_info(projects)').all().some(column => column.name === 'language')) db.exec("ALTER TABLE projects ADD COLUMN language TEXT NOT NULL DEFAULT 'tr'");
  // The citation style of a project's manuscript: "apa", "vancouver" or "ieee".
  if (!db.prepare('PRAGMA table_info(projects)').all().some(column => column.name === 'citation_style')) db.exec("ALTER TABLE projects ADD COLUMN citation_style TEXT NOT NULL DEFAULT 'apa'");
  for (const table of ['documents', 'chunks'])
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'collection_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN collection_id TEXT`);
  db.exec('CREATE INDEX IF NOT EXISTS documents_collection ON documents(user_id, collection_id); CREATE INDEX IF NOT EXISTS chunks_collection ON chunks(user_id, collection_id);');
  const legacy = db.prepare('SELECT DISTINCT user_id, project_id FROM documents WHERE collection_id IS NULL').all();
  for (const { user_id: userId, project_id: projectId } of legacy) {
    const project = db.prepare('SELECT title FROM projects WHERE user_id = ? AND id = ?').get(userId, projectId);
    const id = uuid(), t = now();
    db.prepare('INSERT INTO collections (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, userId, project?.title || 'Kaynaklarım', t, t);
    db.prepare('UPDATE documents SET collection_id = ? WHERE user_id = ? AND project_id = ? AND collection_id IS NULL').run(id, userId, projectId);
    db.prepare('UPDATE chunks SET collection_id = ? WHERE user_id = ? AND project_id = ? AND collection_id IS NULL').run(id, userId, projectId);
    if (project) db.prepare('INSERT OR IGNORE INTO project_collections (user_id, project_id, collection_id) VALUES (?, ?, ?)').run(userId, projectId, id);
  }
}

function createStore(dir = DEFAULT_DIR()) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'writer.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');
  db.exec(SCHEMA);
  migrate(db);
  const q = sql => db.prepare(sql);
  const transaction = fn => { db.exec('BEGIN'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } };

  const documentRow = r => !r ? null : ({ id: r.id, collectionId: r.collection_id, fileName: r.file_name, status: r.status, error: r.error || null,
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
        (SELECT COUNT(*) FROM project_collections pc WHERE pc.user_id = p.user_id AND pc.project_id = p.id) AS collections
      FROM projects p WHERE p.user_id = ? ORDER BY p.updated_at DESC`).all(userId)
      .map(r => ({ id: r.id, title: r.title, collections: r.collections, createdAt: r.created_at, updatedAt: r.updated_at })),
    getProject(userId, id) {
      const r = q('SELECT * FROM projects WHERE user_id = ? AND id = ?').get(userId, String(id));
      return r ? { id: r.id, title: r.title, language: r.language === 'en' ? 'en' : 'tr', citationStyle: ['vancouver', 'ieee'].includes(r.citation_style) ? r.citation_style : 'apa', createdAt: r.created_at, updatedAt: r.updated_at } : null;
    },
    setProjectLanguage: (userId, id, language) => q('UPDATE projects SET language = ?, updated_at = ? WHERE user_id = ? AND id = ?').run(language === 'en' ? 'en' : 'tr', now(), userId, String(id)).changes > 0,
    setProjectCitationStyle: (userId, id, style) => q('UPDATE projects SET citation_style = ?, updated_at = ? WHERE user_id = ? AND id = ?').run(['vancouver', 'ieee'].includes(style) ? style : 'apa', now(), userId, String(id)).changes > 0,
    renameProject: (userId, id, title) => q('UPDATE projects SET title = ?, updated_at = ? WHERE user_id = ? AND id = ?').run(title, now(), userId, String(id)).changes > 0,
    touchProject: (userId, id) => q('UPDATE projects SET updated_at = ? WHERE user_id = ? AND id = ?').run(now(), userId, String(id)),
    deleteProject(userId, id) {
      return transaction(() => {
        const found = q('DELETE FROM projects WHERE user_id = ? AND id = ?').run(userId, String(id)).changes > 0;
        // The project's collections and their sources stay: they belong to the user, not to the project.
        if (found) for (const table of ['project_collections', 'messages', 'manuscripts'])
          q(`DELETE FROM ${table} WHERE user_id = ? AND project_id = ?`).run(userId, String(id));
        return found;
      });
    },

    // ---- collections: named sets of sources that projects can use
    createCollection(userId, name) {
      const id = uuid(), t = now();
      q('INSERT INTO collections (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, userId, name, t, t);
      return store.getCollection(userId, id);
    },
    countCollections: userId => q('SELECT COUNT(*) AS n FROM collections WHERE user_id = ?').get(userId).n,
    getCollection(userId, id) {
      const r = q('SELECT * FROM collections WHERE user_id = ? AND id = ?').get(userId, String(id));
      return r ? { id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at } : null;
    },
    listCollections: userId => q(`SELECT c.id, c.name, c.created_at, c.updated_at,
        (SELECT COUNT(*) FROM documents d WHERE d.user_id = c.user_id AND d.collection_id = c.id) AS documents,
        (SELECT COUNT(*) FROM project_collections pc WHERE pc.user_id = c.user_id AND pc.collection_id = c.id) AS projects
      FROM collections c WHERE c.user_id = ? ORDER BY c.name COLLATE NOCASE`).all(userId)
      .map(r => ({ id: r.id, name: r.name, documents: r.documents, projects: r.projects, createdAt: r.created_at, updatedAt: r.updated_at })),
    renameCollection: (userId, id, name) => q('UPDATE collections SET name = ?, updated_at = ? WHERE user_id = ? AND id = ?').run(name, now(), userId, String(id)).changes > 0,
    touchCollection: (userId, id) => q('UPDATE collections SET updated_at = ? WHERE user_id = ? AND id = ?').run(now(), userId, String(id)),
    deleteCollection(userId, id) {
      return transaction(() => {
        const found = q('DELETE FROM collections WHERE user_id = ? AND id = ?').run(userId, String(id)).changes > 0;
        if (found) {
          q('DELETE FROM chunks WHERE user_id = ? AND collection_id = ?').run(userId, String(id));
          q('DELETE FROM documents WHERE user_id = ? AND collection_id = ?').run(userId, String(id));
          q('DELETE FROM project_collections WHERE user_id = ? AND collection_id = ?').run(userId, String(id));
        }
        return found;
      });
    },
    // The collections a project writes from. Only the owner's own collections can be linked.
    projectCollectionIds: (userId, projectId) => q('SELECT collection_id FROM project_collections WHERE user_id = ? AND project_id = ?').all(userId, String(projectId)).map(r => r.collection_id),
    setProjectCollections(userId, projectId, collectionIds) {
      const owned = new Set(store.listCollections(userId).map(c => c.id));
      const ids = [...new Set(collectionIds.map(String))].filter(id => owned.has(id));
      transaction(() => {
        q('DELETE FROM project_collections WHERE user_id = ? AND project_id = ?').run(userId, String(projectId));
        for (const id of ids) q('INSERT INTO project_collections (user_id, project_id, collection_id) VALUES (?, ?, ?)').run(userId, String(projectId), id);
      });
      store.touchProject(userId, projectId);
      return ids;
    },

    // ---- documents (each belongs to one collection)
    countDocuments: (userId, collectionId) => q('SELECT COUNT(*) AS n FROM documents WHERE user_id = ? AND collection_id = ?').get(userId, String(collectionId)).n,
    addDocument(userId, collectionId, { fileName, meta = {}, status = 'processing' }) {
      const id = uuid();
      q('INSERT INTO documents (id, project_id, collection_id, user_id, file_name, status, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, '', String(collectionId), userId, fileName, status, JSON.stringify(meta), now());
      return store.getDocument(userId, id);
    },
    getDocument: (userId, id) => documentRow(q('SELECT * FROM documents WHERE user_id = ? AND id = ?').get(userId, String(id))),
    listDocuments: (userId, collectionId) => q('SELECT * FROM documents WHERE user_id = ? AND collection_id = ? ORDER BY created_at').all(userId, String(collectionId)).map(documentRow),
    // Every source of the collections linked to a project.
    projectDocuments: (userId, projectId) => q(`SELECT d.* FROM documents d JOIN project_collections pc ON pc.collection_id = d.collection_id AND pc.user_id = d.user_id
        WHERE d.user_id = ? AND pc.project_id = ? ORDER BY d.created_at`).all(userId, String(projectId)).map(documentRow),
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
    insertChunks(userId, collectionId, documentId, chunks) {
      const insert = q("INSERT INTO chunks (document_id, project_id, collection_id, user_id, ord, page, section, text) VALUES (?, '', ?, ?, ?, ?, ?, ?)");
      transaction(() => chunks.forEach((c, i) => insert.run(String(documentId), String(collectionId), userId, i, c.page ?? null, c.section || null, c.text)));
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
    // Candidate set for one project's search: only this owner's chunks of ready documents in the collections linked to the project.
    projectChunks(userId, projectId) {
      return q(`SELECT c.id, c.document_id, c.ord, c.page, c.section, c.text, c.embedding FROM chunks c
          JOIN documents d ON d.id = c.document_id AND d.user_id = c.user_id
          JOIN project_collections pc ON pc.collection_id = d.collection_id AND pc.user_id = c.user_id
        WHERE c.user_id = ? AND pc.project_id = ? AND d.status = 'ready' ORDER BY c.document_id, c.ord`).all(userId, String(projectId))
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

    // ---- account administration: counts only (the admin never reads content) and complete removal of one user's data
    countsFor(userIds) {
      const out = Object.fromEntries(userIds.map(id => [id, { projects: 0, documents: 0 }]));
      for (const id of userIds) {
        out[id].projects = q('SELECT COUNT(*) AS n FROM projects WHERE user_id = ?').get(id).n;
        out[id].documents = q('SELECT COUNT(*) AS n FROM documents WHERE user_id = ?').get(id).n;
      }
      return out;
    },
    deleteUserData(userId) {
      return transaction(() => {
        let rows = 0;
        for (const table of ['projects', 'collections', 'project_collections', 'documents', 'chunks', 'messages', 'manuscripts', 'usage']) rows += q(`DELETE FROM ${table} WHERE user_id = ?`).run(userId).changes;
        return rows;
      });
    },

    // Work that was running when the server stopped cannot continue: mark it so the user can retry.
    // A source whose passages were already saved keeps keyword search and only needs its embedding repeated; one without passages must be added again.
    recoverInterrupted() {
      const resumable = q("UPDATE documents SET status = 'ready', search_mode = 'keyword', error = 'Sunucu yeniden başladı; embedding yarım kaldı. “Hatalı eklemeleri yeniden dene” ile tamamlayın.' WHERE status IN ('processing', 'embedding') AND chunk_count > 0").run().changes;
      const lost = q("UPDATE documents SET status = 'error', error = 'Sunucu yeniden başladı; işlem yarım kaldı. Yeniden deneyin.' WHERE status IN ('processing', 'embedding')").run().changes;
      const docs = resumable + lost;
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
