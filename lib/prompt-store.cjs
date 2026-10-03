// Administrator edits of the model prompts and of the writing assistant's skills: one SQLite file (prompts.db) next to the
// writer data. Reading never creates the file; without it (or without a row) the built-in defaults apply.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DIR = () => process.env.WRITER_DATA_DIR || path.join(__dirname, '..', 'data', 'writer');
const SCHEMA = `
CREATE TABLE IF NOT EXISTS prompts (id TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT);
CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', min_plan TEXT NOT NULL DEFAULT '',
  keywords TEXT NOT NULL DEFAULT '[]', needs_sources INTEGER NOT NULL DEFAULT 1, instruction TEXT NOT NULL DEFAULT '',
  deleted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, updated_by TEXT);
`;

function createStore(dir = DEFAULT_DIR(), now = Date.now) {
  const file = path.join(dir, 'prompts.db');
  let db = null;
  const open = create => {
    if (db) return db;
    if (!create && !fs.existsSync(file)) return null;
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    db.exec(SCHEMA);
    return db;
  };
  const skillRow = r => ({ name: r.name, title: r.title, description: r.description, minPlan: r.min_plan, keywords: JSON.parse(r.keywords || '[]'),
    needsSources: !!r.needs_sources, instruction: r.instruction, deleted: !!r.deleted, updatedAt: r.updated_at, updatedBy: r.updated_by });
  return {
    dir,
    prompts() {
      const rows = open(false)?.prepare('SELECT id, content, updated_at, updated_by FROM prompts').all() || [];
      return Object.fromEntries(rows.map(r => [r.id, { content: r.content, updatedAt: r.updated_at, updatedBy: r.updated_by }]));
    },
    setPrompt(id, content, by = '') {
      open(true).prepare('INSERT INTO prompts (id, content, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at, updated_by = excluded.updated_by').run(id, content, now(), by);
    },
    resetPrompt(id) { open(false)?.prepare('DELETE FROM prompts WHERE id = ?').run(id); },
    skills() { return (open(false)?.prepare('SELECT * FROM skills').all() || []).map(skillRow); },
    saveSkill(skill, by = '') {
      open(true).prepare(`INSERT INTO skills (name, title, description, min_plan, keywords, needs_sources, instruction, deleted, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET title = excluded.title, description = excluded.description, min_plan = excluded.min_plan, keywords = excluded.keywords,
        needs_sources = excluded.needs_sources, instruction = excluded.instruction, deleted = excluded.deleted, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
        .run(skill.name, skill.title || '', skill.description || '', skill.minPlan || '', JSON.stringify(skill.keywords || []), skill.needsSources === false ? 0 : 1, skill.instruction || '', skill.deleted ? 1 : 0, now(), by);
    },
    deleteSkillRow(name) { open(false)?.prepare('DELETE FROM skills WHERE name = ?').run(name); },
    // Changes whenever any edit is made, so readers can cache what they derived.
    version() {
      const d = open(false);
      if (!d) return '0';
      const a = d.prepare('SELECT COUNT(*) n, COALESCE(MAX(updated_at), 0) t FROM skills').get(), b = d.prepare('SELECT COUNT(*) n, COALESCE(MAX(updated_at), 0) t FROM prompts').get();
      return `${a.n}.${a.t}.${b.n}.${b.t}`;
    },
    close() { db?.close(); db = null; },
  };
}

let shared = null, sharedDir = null;
function defaultStore() {
  const dir = DEFAULT_DIR();
  if (!shared || sharedDir !== dir) { shared?.close(); shared = createStore(dir); sharedDir = dir; }
  return shared;
}

module.exports = { createStore, defaultStore };
