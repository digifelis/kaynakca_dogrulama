// Embeddings from one or more self-hosted Text Embeddings Inference (TEI) servers, as an alternative to Gemini for the writing assistant.
// The addresses and options come from the admin panel (app settings; the optional bearer token is sealed). The call is made by the web process itself:
// the TEI servers need no key pool, so the LLM queue is not involved.
// With several servers each request goes to the one with the fewest requests in flight; a server that cannot be reached is skipped for a while
// and the request moves on to the next one. All servers must run the same model (the vectors are mixed in one index).
const MAX_TEXTS = 256, MAX_CHARS = 12000, MAX_SERVERS = 8, DOWN_MS = 15000;

let provider = () => ({});
function configure({ config } = {}) { provider = typeof config === 'function' ? config : () => ({}); }

// Only plain http(s) addresses without credentials; a path prefix (reverse proxy) is allowed.
function normalizeUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) return '';
    return (url.origin + url.pathname).replace(/\/+$/, '');
  } catch { return ''; }
}
// Addresses separated by new lines, spaces, commas or semicolons: { urls: distinct valid ones, invalid: the rest }.
function normalizeUrls(value) {
  const urls = [], invalid = [];
  for (const part of String(value || '').split(/[\s,;]+/).filter(Boolean)) {
    const url = normalizeUrl(part);
    if (!url) invalid.push(part); else if (!urls.includes(url)) urls.push(url);
  }
  return { urls: urls.slice(0, MAX_SERVERS), invalid, tooMany: urls.length > MAX_SERVERS };
}
const clamp = (value, low, high, fallback) => { const n = Number(value); return Number.isFinite(n) ? Math.min(high, Math.max(low, Math.round(n))) : fallback; };
const text = (value, fallback, max) => typeof value === 'string' ? value.slice(0, max) : fallback;

// Normalised settings. Prefixes are kept as typed (E5 models want "query: " / "passage: ", BGE-M3 wants none).
// `concurrency` is per server.
function settings(raw = null) {
  let s = raw;
  if (!s) { try { s = provider() || {}; } catch { s = {}; } }
  const { urls } = normalizeUrls(s.url);
  return {
    enabled: s.provider === 'tei', urls, url: urls[0] || '', apiKey: String(s.apiKey || ''),
    model: text(s.model, 'multilingual-e5-small', 80).trim() || 'multilingual-e5-small',
    queryPrefix: text(s.queryPrefix, 'query: ', 40), passagePrefix: text(s.passagePrefix, 'passage: ', 40),
    batch: clamp(s.batch, 1, 64, 8), concurrency: clamp(s.concurrency, 1, 8, 4), timeoutSec: clamp(s.timeoutSec, 5, 600, 60),
  };
}
const active = () => { const s = settings(); return s.enabled && s.urls.length > 0; };
const modelId = () => 'tei:' + settings().model;

const safe = (value, key) => String(value || '').split(key || '\u0000').join('[gizli anahtar]').replace(/[\r\n]+/g, ' ').slice(0, 300);

// Per server: requests in flight and the time until which it is skipped after a failure.
// `concurrency` caps the requests in flight per server across ALL callers (every document being embedded). A TEI server works through them one batch
// after another, so more would only queue inside it, and their time in that queue would count against the request timeout.
const servers = new Map();
const stateOf = url => { let s = servers.get(url); if (!s) servers.set(url, s = { inflight: 0, downUntil: 0 }); return s; };
let turn = 0;
// The server with the fewest requests in flight among those not tried yet and below the cap; servers that failed recently come last.
function pick(urls, tried, cap) {
  const now = Date.now(), open = urls.filter(u => !tried.has(u) && stateOf(u).inflight < cap), up = open.filter(u => stateOf(u).downUntil <= now);
  const pool = up.length ? up : open.sort((a, b) => stateOf(a).downUntil - stateOf(b).downUntil).slice(0, 1);
  if (!pool.length) return null;
  const least = Math.min(...pool.map(u => stateOf(u).inflight)), best = pool.filter(u => stateOf(u).inflight === least);
  return best[turn++ % best.length];
}
// Waiting callers are woken whenever a request finishes.
const waiters = new Set();
const wake = () => { for (const resolve of [...waiters]) resolve(); };
// Reserves a slot on a server (waiting for one when all candidates are full); null when every server has been tried.
async function acquire(urls, tried, cap, signal) {
  for (;;) {
    if (urls.every(u => tried.has(u))) return null;
    const base = pick(urls, tried, cap);
    if (base) { stateOf(base).inflight++; return base; }
    await new Promise((resolve, reject) => {
      const done = () => { waiters.delete(done); signal?.removeEventListener('abort', onAbort); resolve(); };
      const onAbort = () => { waiters.delete(done); reject(signal.reason); };
      if (signal?.aborted) return reject(signal.reason);
      waiters.add(done); signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
const failover = (message, extra = {}) => Object.assign(Error(message), { failover: true, ...extra });

// One /embed request to one server. Resolves to { busy: true } when the server asks us to come back later (429/503);
// errors marked `failover` (unreachable, 5xx, bad answer) let the caller try another server.
async function call(config, base, inputs, { signal, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(base + '/embed', {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(config.timeoutSec * 1000)]),
      headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {}) },
      body: JSON.stringify({ inputs, normalize: true, truncate: true }),
    });
  } catch (error) {
    signal?.throwIfAborted();
    // A timeout means the server was reached but did not answer in time (it is busy, not down).
    if (error.name === 'TimeoutError') throw failover(`TEI sunucusu ${config.timeoutSec} sn içinde yanıt vermedi (${base}); sunucu çok meşgul olabilir.`, { slow: true });
    throw failover(`TEI sunucusuna ulaşılamadı (${base}): ${safe(error.cause?.code || error.message, config.apiKey)}`);
  }
  if (response.status === 429 || response.status === 503) return { busy: true };
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const error = Error(`TEI HTTP ${response.status} (${base}): ${safe(body?.error || body?.message, config.apiKey) || 'sunucu adresini ve model ayarını kontrol edin.'}`);
    if (response.status >= 500) error.failover = true;
    throw error;
  }
  const vectors = await response.json().catch(() => null);
  if (!Array.isArray(vectors) || vectors.length !== inputs.length || vectors.some(v => !Array.isArray(v) || !v.length)) throw failover(`TEI beklenen sayıda vektör döndürmedi (${base}).`);
  return { vectors };
}

// One group of texts: on the least busy server, moving to the next one when a server fails.
async function dispatch(config, inputs, options) {
  const tried = new Set();
  let lastError = null, sawBusy = false;
  while (tried.size < config.urls.length) {
    const base = await acquire(config.urls, tried, config.concurrency, options.signal);
    if (!base) break;
    const state = stateOf(base);
    tried.add(base);
    try {
      const answer = await call(config, base, inputs, options);
      if (answer.busy) { sawBusy = true; continue; }
      state.downUntil = 0;
      return answer;
    } catch (error) {
      if (!error.failover) throw error;
      if (!error.slow) state.downUntil = Date.now() + DOWN_MS;
      lastError = error;
    } finally { state.inflight--; wake(); }
  }
  if (lastError && !sawBusy) throw config.urls.length > 1 ? Error(`Hiçbir TEI sunucusundan yanıt alınamadı. Son hata: ${lastError.message}`) : lastError;
  return { busy: true };
}

// Returns { vectors, model, dim, tokens, estimated } or { quota } when every server is busy (the caller waits and retries).
async function embed({ texts, task }, { signal, fetchImpl = fetch, config = settings() } = {}) {
  if (!config.urls?.length) throw Error('TEI sunucu adresi ayarlanmamış. Yönetim → Ayarlar sayfasından girin.');
  if (!Array.isArray(texts) || !texts.length || texts.length > MAX_TEXTS) throw Error(`1 ile ${MAX_TEXTS} arasında metin gönderin.`);
  if (texts.some(t => typeof t !== 'string' || !t.trim() || t.length > MAX_CHARS)) throw Error(`Metinler boş olamaz ve en fazla ${MAX_CHARS} karakter olabilir.`);
  if (!['document', 'query'].includes(task)) throw Error('Geçersiz embedding görevi.');
  const prefix = task === 'query' ? config.queryPrefix : config.passagePrefix;
  const groups = [];
  for (let i = 0; i < texts.length; i += config.batch) groups.push(texts.slice(i, i + config.batch).map(t => prefix + t));
  const results = new Array(groups.length);
  let next = 0, busy = false;
  const worker = async () => {
    while (!busy && next < groups.length) {
      const index = next++, answer = await dispatch(config, groups[index], { signal, fetchImpl });
      if (answer.busy) { busy = true; return; }
      results[index] = answer.vectors;
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.concurrency * config.urls.length, groups.length) }, worker));
  if (busy) return { quota: { retryAt: Date.now() + 3000, message: 'TEI sunucuları meşgul.' } };
  const vectors = results.flat();
  if (vectors.some(v => v.length !== vectors[0].length)) throw Error('TEI sunucuları farklı boyutta vektör döndürdü; hepsinde aynı model çalışmalı.');
  const tokens = texts.reduce((sum, t) => sum + Math.max(1, Math.ceil(t.length / 4)), 0);
  return { tokens, estimated: true, vectors, model: 'tei:' + config.model, dim: vectors[0].length };
}

// Used by the admin panel's "Sına" button: one short passage per server, timed, and the vector sizes compared.
async function check(config, { fetchImpl = fetch } = {}) {
  if (!config.urls?.length) return { ok: false, message: 'Sunucu adresi geçerli bir http:// veya https:// adresi olmalı.', servers: [] };
  const probe = async url => {
    const started = Date.now();
    try {
      const answer = await embed({ texts: ['Bu bir deneme cümlesidir. This is a test sentence.'], task: 'document' }, { config: { ...config, urls: [url] }, fetchImpl });
      if (answer.quota) return { url, ok: false, message: 'sunucu meşgul (HTTP 429/503)' };
      return { url, ok: true, dim: answer.dim, ms: Date.now() - started };
    } catch (error) { return { url, ok: false, message: error.message }; }
  };
  const found = await Promise.all(config.urls.map(probe));
  const good = found.filter(s => s.ok), dims = [...new Set(good.map(s => s.dim))];
  const ok = good.length === found.length && dims.length === 1;
  const line = s => s.ok ? `${s.url}: ${s.dim} boyut, ${s.ms} ms` : `${s.url}: ${s.message}`;
  let message;
  if (found.length === 1) message = ok ? `Bağlantı başarılı: ${good[0].dim} boyutlu vektör, ${good[0].ms} ms.` : found[0].message;
  else if (dims.length > 1) message = 'Sunucular farklı boyutta vektör döndürüyor; hepsinde aynı model çalışmalı. ' + found.map(line).join(' · ');
  else message = `${good.length}/${found.length} sunucu çalışıyor. ` + found.map(line).join(' · ');
  return { ok, dim: dims[0], ms: good.length ? Math.max(...good.map(s => s.ms)) : undefined, message, servers: found };
}

module.exports = { configure, settings, active, modelId, embed, check, normalizeUrl, normalizeUrls };
