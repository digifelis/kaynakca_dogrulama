// Shared, user-independent cache of PUBLIC lookups: verified reference records, publication full texts, extracted text of
// open-access PDFs and their embeddings. It never holds a user's own uploads. One SQLite file (cache.db) beside the other data;
// reading never creates it. A cache hit only saves outside requests: plan quotas are charged exactly as before.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const DAY = 86400000;
// Test processes (node --test) without an explicit folder get a private temporary one, so runs never share cached answers.
const DEFAULT_DIR = () => process.env.CACHE_DIR || process.env.WRITER_DATA_DIR
  || (process.env.NODE_TEST_CONTEXT ? path.join(require('node:os').tmpdir(), 'kaynakca-test-cache-' + process.pid) : path.join(__dirname, '..', 'data', 'writer'));
const KINDS = ['verification', 'fulltext', 'extraction', 'embedding', 'terms'];
const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  kind TEXT NOT NULL, key TEXT NOT NULL, data BLOB NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, last_hit INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (kind, key));
CREATE INDEX IF NOT EXISTS entries_expiry ON entries(expires_at);
CREATE INDEX IF NOT EXISTS entries_lru ON entries(last_hit);
`;
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const enabled = () => !/^(?:false|0|no|off)$/i.test(String(process.env.CACHE_ENABLED ?? 'true').trim());
const maxBytes = () => Math.max(16, Number(process.env.CACHE_MAX_MB) || 2048) * 1024 * 1024;
// Bump when the verification engine or the text acquisition changes in a way old answers should not survive.
const VERSION = () => 'v1' + (process.env.CACHE_VERSION || '');
const normalizeReference = raw => String(raw || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const TTL = { verified: 90 * DAY, review: 14 * DAY, failed: DAY, terms: 90 * DAY, fulltext: 90 * DAY, abstract: 3 * DAY, extraction: 365 * DAY, embedding: 365 * DAY };

function createCache(dir = DEFAULT_DIR(), now = Date.now) {
  const file = path.join(dir, 'cache.db');
  let db = null, puts = 0;
  const open = create => {
    if (db) return db;
    if (!create && !fs.existsSync(file)) return null;
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    db.exec(SCHEMA);
    return db;
  };
  const get = (kind, key) => {
    if (!enabled()) return null;
    try {
      const d = open(false); if (!d) return null;
      const row = d.prepare('SELECT data, expires_at FROM entries WHERE kind = ? AND key = ?').get(kind, key);
      if (!row) return null;
      if (row.expires_at <= now()) { d.prepare('DELETE FROM entries WHERE kind = ? AND key = ?').run(kind, key); return null; }
      d.prepare('UPDATE entries SET hits = hits + 1, last_hit = ? WHERE kind = ? AND key = ?').run(now(), kind, key);
      return Buffer.from(row.data);
    } catch { return null; }
  };
  const put = (kind, key, buffer, ttl) => {
    if (!enabled()) return false;
    try {
      open(true).prepare(`INSERT INTO entries (kind, key, data, bytes, created_at, expires_at, last_hit, hits) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(kind, key) DO UPDATE SET data = excluded.data, bytes = excluded.bytes, created_at = excluded.created_at, expires_at = excluded.expires_at, last_hit = excluded.last_hit`)
        .run(kind, key, buffer, buffer.length, now(), now() + ttl, now());
      if (++puts % 50 === 0) cache.prune();
      return true;
    } catch { return false; }
  };
  const packJson = value => zlib.gzipSync(Buffer.from(JSON.stringify(value)));
  const unpackJson = buffer => { try { return JSON.parse(zlib.gunzipSync(buffer).toString('utf8')); } catch { return null; } };

  const cache = {
    dir, enabled,
    // ---- verification records: only final, trustworthy results of a lookup are kept
    // A "not found" answer (status failed) is kept only for a day and is handed out only when the caller accepts negatives:
    // a user who runs a check again expects a fresh lookup, not yesterday's "not found".
    getVerification(raw, { allowNegative = true } = {}) {
      const data = get('verification', sha(VERSION() + '\0' + normalizeReference(raw)));
      const result = data ? unpackJson(data) : null;
      return result && result.status === 'failed' && !allowNegative ? null : result;
    },
    putVerification(raw, result) {
      if (!result || result.pendingRetryAt || result.pendingProviders?.length || result.fallbackNeeded || !['verified', 'review', 'failed'].includes(result.status)) return false;
      return put('verification', sha(VERSION() + '\0' + normalizeReference(raw)), packJson(result), TTL[result.status] || TTL.review);
    },
    // ---- search terms the LLM produced for a citation sentence in another language
    getTerms(key) { const data = get('terms', sha(VERSION() + '\0' + key)); return data ? unpackJson(data) : null; },
    putTerms(key, terms) { return Array.isArray(terms) && terms.length ? put('terms', sha(VERSION() + '\0' + key), packJson(terms), TTL.terms) : false; },
    // ---- full texts of publications found by DOI or address (never texts waiting for a user's confirmation)
    getFullText(key) { const data = key ? get('fulltext', sha(VERSION() + '\0' + key)) : null; return data ? unpackJson(data) : null; },
    putFullText(key, text) {
      if (!key || !text || text.needsConfirmation || !Array.isArray(text.passages) || !text.passages.length) return false;
      const packed = packJson(text);
      if (packed.length > 8 * 1024 * 1024) return false;
      return put('fulltext', sha(VERSION() + '\0' + key), packed, text.abstractOnly ? TTL.abstract : TTL.fulltext);
    },
    // ---- text extracted from an open-access PDF (the paragraphs and file metadata)
    getExtraction(key) { const data = key ? get('extraction', sha(key)) : null; return data ? unpackJson(data) : null; },
    putExtraction(key, extraction) {
      if (!key || !extraction?.paragraphs?.length) return false;
      const packed = packJson(extraction);
      return packed.length <= 16 * 1024 * 1024 && put('extraction', sha(key), packed, TTL.extraction);
    },
    // ---- embeddings of public text, per model and text
    getEmbeddings(model, texts) {
      const found = new Map();
      texts.forEach((text, i) => { const data = get('embedding', sha(model + '\0' + text)); if (data && data.length % 4 === 0) found.set(i, new Float32Array(new Uint8Array(data).buffer)); });
      return found;
    },
    putEmbeddings(model, pairs) { for (const [text, vector] of pairs) put('embedding', sha(model + '\0' + text), Buffer.from(Float32Array.from(vector).buffer), TTL.embedding); },

    stats() {
      const d = open(false);
      const rows = d ? d.prepare('SELECT kind, COUNT(*) n, COALESCE(SUM(bytes), 0) bytes, COALESCE(SUM(hits), 0) hits FROM entries GROUP BY kind').all() : [];
      return { enabled: enabled(), maxBytes: maxBytes(), kinds: KINDS.map(kind => { const r = rows.find(x => x.kind === kind); return { kind, entries: r?.n || 0, bytes: r?.bytes || 0, hits: r?.hits || 0 }; }) };
    },
    clear(kind = '') {
      const d = open(false); if (!d) return 0;
      return kind ? Number(d.prepare('DELETE FROM entries WHERE kind = ?').run(kind).changes) : Number(d.prepare('DELETE FROM entries').run().changes);
    },
    // Expired rows go first, then the least recently used until the file is under 90% of the limit.
    prune() {
      const d = open(false); if (!d) return;
      d.prepare('DELETE FROM entries WHERE expires_at <= ?').run(now());
      let total = d.prepare('SELECT COALESCE(SUM(bytes), 0) n FROM entries').get().n;
      if (total <= maxBytes()) return;
      for (const row of d.prepare('SELECT kind, key, bytes FROM entries ORDER BY last_hit ASC').all()) {
        if (total <= maxBytes() * 0.9) break;
        d.prepare('DELETE FROM entries WHERE kind = ? AND key = ?').run(row.kind, row.key); total -= row.bytes;
      }
    },
    close() { db?.close(); db = null; },
  };
  return cache;
}

let shared = null, sharedDir = null;
function defaultCache() {
  const dir = DEFAULT_DIR();
  if (!shared || sharedDir !== dir) { shared?.close(); shared = createCache(dir); sharedDir = dir; }
  return shared;
}

module.exports = { createCache, defaultCache, normalizeReference, KINDS, sha };
