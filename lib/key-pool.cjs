// API key pool for the LLM providers (Groq, OpenRouter) and Gemini embeddings.
// Keys are used in their configured order; a key that answers 429 (or an own rpm/rpd limit) is rested and the request
// moves on to the next key at once. Keys of one `group` (same provider account) rest together, because the provider's
// limits belong to the account, not to the key. Keys are sealed on disk (AES-256-GCM) and never leave this module
// except as `acquire()` results; every public view shows only the last four characters.
// Keys from the environment (GROQ_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY; comma-separated lists allowed) take part as
// read-only entries after the stored ones, so a setup that only has a .env keeps working.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSealer } = require('./secrets.cjs');

const PROVIDERS = {
  groq: { name: 'Groq', env: 'GROQ_API_KEY' },
  openrouter: { name: 'OpenRouter', env: 'OPENROUTER_API_KEY' },
  gemini: { name: 'Gemini', env: 'GEMINI_API_KEY' },
};
const FILE = 'llm-keys.db';
const SCHEMA = `CREATE TABLE IF NOT EXISTS llm_keys (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, grp TEXT, sealed TEXT NOT NULL, last4 TEXT NOT NULL, fingerprint TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, invalid_reason TEXT, rpm INTEGER, rpd INTEGER, position INTEGER NOT NULL, created_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS llm_hidden (fingerprint TEXT PRIMARY KEY, provider TEXT NOT NULL);`;
const DAY = 86400000;
const normalize = provider => { const id = String(provider || '').toLowerCase(); if (!PROVIDERS[id]) throw Error('Bilinmeyen sağlayıcı: ' + provider); return id; };
const fingerprint = key => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
const utcDay = t => new Date(t).toISOString().slice(0, 10);
const nextUtcMidnight = t => Math.floor(t / DAY + 1) * DAY;
// Anything that looks like a provider key is removed from text that may be logged or shown.
const maskSecrets = text => String(text ?? '').replace(/\b(?:gsk_|sk-or-v1-|sk-or-|AIza|AQ\.)[\w.-]{8,}/g, '[gizli anahtar]');

const blankState = () => ({ cooldownUntil: 0, gapUntil: 0, hits: [], day: '', dayRequests: 0, dayOk: 0, dayFail: 0, dayTokens: 0,
  ok: 0, fail: 0, promptTokens: 0, completionTokens: 0, lastUsedAt: 0, lastError: '', lastErrorAt: 0, invalid: '', lastTest: null });

function createPool({ dir, now = () => Date.now(), env = process.env, sealer = null, fetchImpl = (...args) => fetch(...args) } = {}) {
  const dataDir = () => typeof dir === 'function' ? dir() : dir;
  let db = null, cache = null, seal = sealer;
  const sealerFor = () => seal ||= createSealer(dataDir());
  const states = new Map();                     // id -> runtime state (also persisted for stored keys)

  function open(create) {
    if (db) return db;
    const file = path.join(dataDir(), FILE);
    if (!create && !fs.existsSync(file)) return null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL;'); db.exec(SCHEMA);
    return db;
  }
  const stored = () => cache ||= (open(false)?.prepare('SELECT * FROM llm_keys ORDER BY position, created_at').all() || []);
  let hiddenCache = null;
  const touchCache = () => { cache = null; hiddenCache = null; };
  // A key from the environment cannot be deleted from .env by the panel; "deleting" it hides it from the pool.
  const hidden = () => hiddenCache ||= new Set((open(false)?.prepare('SELECT fingerprint FROM llm_hidden').all() || []).map(row => row.fingerprint));
  function stateOf(id, row) {
    let s = states.get(id);
    if (!s) { s = { ...blankState(), ...(row ? (() => { try { return JSON.parse(row.state || '{}'); } catch { return {}; } })() : {}) }; if (row?.invalid_reason) s.invalid = row.invalid_reason; states.set(id, s); }
    return s;
  }
  function envKeys(provider) {
    if (provider === 'openrouter' && /^(?:false|0|no|off)$/i.test(String(env.OPENROUTER_ENABLED ?? 'true').trim())) return [];
    return String(env[PROVIDERS[provider].env] || '').split(/[\s,;]+/).filter(Boolean).filter(key => !hidden().has(fingerprint(key)));
  }
  // Every entry of a provider in use order: stored keys by position, then environment keys.
  function entries(provider) {
    const list = stored().filter(row => row.provider === provider).map(row => ({
      id: row.id, source: 'db', provider, label: row.label, group: row.grp || '', last4: row.last4, enabled: !!row.enabled, rpm: row.rpm || 0, rpd: row.rpd || 0, row,
      state: stateOf(row.id, row) }));
    envKeys(provider).forEach((key, index, all) => {
      const id = `env-${provider}-${fingerprint(key).slice(0, 8)}`;
      list.push({ id, source: 'env', provider, label: all.length > 1 ? `.env ${index + 1}` : '.env', group: '', last4: key.slice(-4), enabled: true, rpm: 0, rpd: 0, envKey: key, state: stateOf(id) });
    });
    return list;
  }
  const allEntries = () => Object.keys(PROVIDERS).flatMap(entries);
  function persist(entry) {
    if (entry.source !== 'db') return;
    const s = entry.state, { hits, ...rest } = s;
    open(true).prepare('UPDATE llm_keys SET state = ?, invalid_reason = ? WHERE id = ?').run(JSON.stringify(rest), s.invalid || null, entry.id);
  }
  function rollDay(s, t) { const day = utcDay(t); if (s.day !== day) Object.assign(s, { day, dayRequests: 0, dayOk: 0, dayFail: 0, dayTokens: 0 }); }

  // { ok: true } when the key can take a request now, otherwise { ok: false, until, why }.
  function availability(entry, t) {
    const s = entry.state; rollDay(s, t);
    if (!entry.enabled) return { ok: false, until: Infinity, why: 'disabled' };
    if (s.invalid) return { ok: false, until: Infinity, why: 'invalid' };
    let until = Math.max(s.cooldownUntil, s.gapUntil), why = s.cooldownUntil > t ? 'cooling' : 'spacing';
    s.hits = s.hits.filter(hit => hit > t - 60000);
    if (entry.rpm && s.hits.length >= entry.rpm && s.hits[0] + 60000 > until) { until = s.hits[0] + 60000; why = 'limited'; }
    if (entry.rpd && s.dayRequests >= entry.rpd && nextUtcMidnight(t) > until) { until = nextUtcMidnight(t); why = 'limited'; }
    return until > t ? { ok: false, until, why } : { ok: true };
  }
  const keyOf = entry => entry.source === 'env' ? entry.envKey : sealerFor().open(entry.row.sealed);

  const pool = {
    PROVIDERS,
    // The first key (in use order) that can take a request now; the request is counted against its own limits.
    acquire(provider, { exclude = [] } = {}) {
      const t = now(), id = normalize(provider);
      for (const entry of entries(id)) {
        if (exclude.includes(entry.id) || !availability(entry, t).ok) continue;
        const s = entry.state; s.hits.push(t); s.dayRequests++; s.lastUsedAt = t; persist(entry);
        return { id: entry.id, key: keyOf(entry), label: entry.label, source: entry.source };
      }
      return null;
    },
    // True when at least one key could ever be used (enabled and not invalid), resting or not.
    hasUsable(provider) { return entries(normalize(provider)).some(entry => entry.enabled && !entry.state.invalid); },
    // 0 when a key is available now, the earliest time one becomes available, or Infinity without a usable key.
    nextAvailableAt(provider) {
      const t = now(); let soonest = Infinity;
      for (const entry of entries(normalize(provider))) { const a = availability(entry, t); if (a.ok) return 0; soonest = Math.min(soonest, a.until); }
      return soonest;
    },
    // The outcome of one request made with a key: counters, tokens, rest after 429 / server errors, invalid key after 401/403.
    report(id, { ok = false, status = 0, tokens = null, retryAfterMs = null, gapMs = 0, error = '' } = {}) {
      const t = now(), entry = allEntries().find(item => item.id === id);
      if (!entry) return;
      const s = entry.state; rollDay(s, t);
      if (gapMs) s.gapUntil = Math.max(s.gapUntil, t + gapMs);
      if (tokens) { const prompt = Number(tokens.prompt) || 0, completion = Number(tokens.completion) || 0; s.promptTokens += prompt; s.completionTokens += completion; s.dayTokens += prompt + completion; }
      if (ok) { s.ok++; s.dayOk++; }
      else {
        s.fail++; s.dayFail++; s.lastError = maskSecrets(error || (status ? 'HTTP ' + status : 'Hata')).slice(0, 300); s.lastErrorAt = t;
        if (status === 401 || status === 403) s.invalid = `Sağlayıcı anahtarı reddetti (HTTP ${status}).`;
        else {
          const rest = Math.max(1000, retryAfterMs ?? (status === 429 ? 60000 : 5000)), until = t + rest;
          // A provider account's limits are shared by its keys: the whole group rests with the key that was refused.
          const members = status === 429 && entry.group ? entries(entry.provider).filter(item => item.group === entry.group) : [entry];
          for (const member of members) { member.state.cooldownUntil = Math.max(member.state.cooldownUntil, until); persist(member); }
        }
      }
      persist(entry);
    },
    view(entry) {
      const t = now(), s = entry.state, a = availability(entry, t);
      const status = !entry.enabled ? 'disabled' : s.invalid ? 'invalid' : a.ok ? 'active' : a.why === 'limited' ? 'limited' : a.why === 'cooling' ? 'cooling' : 'active';
      return { id: entry.id, provider: entry.provider, providerName: PROVIDERS[entry.provider].name, label: entry.label, group: entry.group, last4: entry.last4, source: entry.source, enabled: entry.enabled,
        status, restUntil: !a.ok && Number.isFinite(a.until) ? a.until : null, rpm: entry.rpm || null, rpd: entry.rpd || null, invalidReason: s.invalid || '',
        total: { ok: s.ok, fail: s.fail, promptTokens: s.promptTokens, completionTokens: s.completionTokens },
        today: { requests: s.dayRequests, ok: s.dayOk, fail: s.dayFail, tokens: s.dayTokens },
        lastUsedAt: s.lastUsedAt || null, lastError: s.lastError, lastErrorAt: s.lastErrorAt || null, lastTest: s.lastTest };
    },
    list(provider) {
      const providers = provider ? [normalize(provider)] : Object.keys(PROVIDERS);
      return providers.flatMap(id => entries(id).map(entry => pool.view(entry)));
    },
    summary() {
      return Object.fromEntries(Object.keys(PROVIDERS).map(id => { const list = pool.list(id); return [id, { total: list.length, available: list.filter(item => item.status === 'active').length }]; }));
    },
    // Adds a key. The caller decides whether to test it first (the panel tests before adding).
    add({ provider, label, key, group, rpm, rpd }) {
      const id = normalize(provider), secret = String(key || '').trim();
      if (!/^[\x21-\x7e]{8,400}$/.test(secret)) throw Error('Anahtar 8-400 karakter olmalı ve boşluk içermemelidir.');
      const print = fingerprint(secret);
      if (stored().some(row => row.provider === id && row.fingerprint === print) || envKeys(id).some(item => fingerprint(item) === print)) throw Error('Bu anahtar zaten ekli.');
      const int = (value, name) => { if (value === null || value === undefined || value === '') return null; const n = Number(value); if (!Number.isInteger(n) || n < 0 || n > 1e7) throw Error(`${name} sıfır veya pozitif bir tam sayı olmalıdır.`); return n || null; };
      const limits = { rpm: int(rpm, 'Dakikalık sınır'), rpd: int(rpd, 'Günlük sınır') };
      const database = open(true), position = (database.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM llm_keys').get().n);
      const name = String(label || '').replace(/\s+/g, ' ').trim().slice(0, 60) || `${PROVIDERS[id].name} ${position}`;
      const groupName = String(group || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const newId = crypto.randomUUID();
      database.prepare('INSERT INTO llm_keys (id, provider, label, grp, sealed, last4, fingerprint, enabled, rpm, rpd, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)')
        .run(newId, id, name, groupName || null, sealerFor().seal(secret), secret.slice(-4), print, limits.rpm, limits.rpd, position, now());
      touchCache();
      return pool.view(entries(id).find(entry => entry.id === newId));
    },
    // Label, group, limits, on/off, or a replacement key value (which clears an "invalid" mark).
    update(id, patch) {
      const entry = allEntries().find(item => item.id === id);
      if (!entry) throw Object.assign(Error('Anahtar bulunamadı.'), { status: 404 });
      if (entry.source !== 'db') throw Error('Ortam değişkeninden gelen anahtar panelden değiştirilemez; .env dosyasını düzenleyin.');
      const sets = [], values = [], text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
      const int = (value, name) => { if (value === null || value === '' || value === undefined) return null; const n = Number(value); if (!Number.isInteger(n) || n < 0 || n > 1e7) throw Error(`${name} sıfır veya pozitif bir tam sayı olmalıdır.`); return n || null; };
      if (patch.label !== undefined) { const label = text(patch.label, 60); if (!label) throw Error('Etiket boş olamaz.'); sets.push('label = ?'); values.push(label); }
      if (patch.group !== undefined) { sets.push('grp = ?'); values.push(text(patch.group, 40) || null); }
      if (patch.rpm !== undefined) { sets.push('rpm = ?'); values.push(int(patch.rpm, 'Dakikalık sınır')); }
      if (patch.rpd !== undefined) { sets.push('rpd = ?'); values.push(int(patch.rpd, 'Günlük sınır')); }
      if (patch.enabled !== undefined) { sets.push('enabled = ?'); values.push(patch.enabled ? 1 : 0); }
      if (patch.key !== undefined) {
        const secret = String(patch.key).trim();
        if (!/^[\x21-\x7e]{8,400}$/.test(secret)) throw Error('Anahtar 8-400 karakter olmalı ve boşluk içermemelidir.');
        sets.push('sealed = ?', 'last4 = ?', 'fingerprint = ?'); values.push(sealerFor().seal(secret), secret.slice(-4), fingerprint(secret));
        entry.state.invalid = ''; entry.state.cooldownUntil = 0; persist(entry);
      }
      if (sets.length) open(true).prepare(`UPDATE llm_keys SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
      if (patch.enabled) { entry.state.invalid = ''; entry.state.cooldownUntil = 0; }
      touchCache(); const fresh = entries(entry.provider).find(item => item.id === id); persist(fresh);
      return pool.view(fresh);
    },
    remove(id) {
      const entry = allEntries().find(item => item.id === id);
      if (!entry) throw Object.assign(Error('Anahtar bulunamadı.'), { status: 404 });
      if (entry.source === 'env') open(true).prepare('INSERT OR IGNORE INTO llm_hidden (fingerprint, provider) VALUES (?, ?)').run(fingerprint(entry.envKey), entry.provider);
      else open(true).prepare('DELETE FROM llm_keys WHERE id = ?').run(id);
      states.delete(id); touchCache();
      return true;
    },
    // Checks a key against its provider with a call that spends no model quota (a model-list or key-info request).
    async check(provider, key, { signal } = {}) {
      const id = normalize(provider);
      const request = {
        groq: ['https://api.groq.com/openai/v1/models', { Authorization: 'Bearer ' + key }],
        openrouter: ['https://openrouter.ai/api/v1/auth/key', { Authorization: 'Bearer ' + key }],
        gemini: ['https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { 'x-goog-api-key': key }],
      }[id];
      try {
        const response = await fetchImpl(request[0], { method: 'GET', redirect: 'error', headers: request[1], signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]) });
        await response.body?.cancel?.();
        if (response.ok) return { ok: true, status: response.status, message: 'Anahtar geçerli.' };
        if (response.status === 429) return { ok: true, status: 429, quota: true, message: 'Anahtar geçerli görünüyor ama şu an kota dolu.' };
        if (response.status === 401 || response.status === 403 || (id === 'gemini' && response.status === 400)) return { ok: false, status: response.status, message: 'Anahtar geçersiz veya yetkisiz.' };
        return { ok: false, status: response.status, message: `Sağlayıcı beklenmeyen yanıt verdi (HTTP ${response.status}).` };
      } catch (error) {
        return { ok: false, status: 0, message: error?.name === 'TimeoutError' ? 'Sağlayıcı 15 saniyede yanıt vermedi.' : 'Sağlayıcıya ulaşılamadı.' };
      }
    },
    // Tests a stored key and records the result on it (a valid answer lifts an earlier "invalid" mark).
    async test(id, { signal } = {}) {
      const entry = allEntries().find(item => item.id === id);
      if (!entry) throw Object.assign(Error('Anahtar bulunamadı.'), { status: 404 });
      const result = await pool.check(entry.provider, keyOf(entry), { signal });
      entry.state.lastTest = { at: now(), ok: result.ok, message: result.message };
      if (result.ok) entry.state.invalid = ''; else if (result.status === 401 || result.status === 403) entry.state.invalid = result.message;
      persist(entry);
      return { ...result, key: pool.view(entry) };
    },
    close() { db?.close(); db = null; cache = null; },
  };
  return pool;
}

// The process-wide pool follows LLM_DATA_DIR (then WRITER_DATA_DIR), so tests can point it at a temporary folder.
const defaultDir = () => process.env.LLM_DATA_DIR || process.env.WRITER_DATA_DIR || path.join(__dirname, '..', 'data', 'writer');
let shared = null, sharedDir = null, sharedEnv = null, sharedNow = null;
const realNow = () => Date.now();
// `env` and `now` let a caller with its own environment (tests running code in a sandbox) share one pool per environment.
function defaultPool({ env = process.env, now = realNow } = {}) {
  const dir = defaultDir();
  if (!shared || sharedDir !== dir || sharedEnv !== env || sharedNow !== now) { shared?.close(); shared = createPool({ dir, env, now }); sharedDir = dir; sharedEnv = env; sharedNow = now; }
  return shared;
}

module.exports = { createPool, pool: defaultPool, PROVIDERS, normalize, maskSecrets, fingerprint };
