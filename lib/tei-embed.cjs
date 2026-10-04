// Embeddings from a self-hosted Text Embeddings Inference (TEI) server, as an alternative to Gemini for the writing assistant.
// The address and options come from the admin panel (app settings; the optional bearer token is sealed). The call is made by the web process itself:
// the TEI container sits on the internal network and needs no key pool, so the LLM queue is not involved.
const MAX_TEXTS = 256, MAX_CHARS = 12000;

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
const clamp = (value, low, high, fallback) => { const n = Number(value); return Number.isFinite(n) ? Math.min(high, Math.max(low, Math.round(n))) : fallback; };
const text = (value, fallback, max) => typeof value === 'string' ? value.slice(0, max) : fallback;

// Normalised settings. Prefixes are kept as typed (E5 models want "query: " / "passage: ", BGE-M3 wants none).
function settings(raw = null) {
  let s = raw;
  if (!s) { try { s = provider() || {}; } catch { s = {}; } }
  return {
    enabled: s.provider === 'tei', url: normalizeUrl(s.url), apiKey: String(s.apiKey || ''),
    model: text(s.model, 'multilingual-e5-small', 80).trim() || 'multilingual-e5-small',
    queryPrefix: text(s.queryPrefix, 'query: ', 40), passagePrefix: text(s.passagePrefix, 'passage: ', 40),
    batch: clamp(s.batch, 1, 64, 8), concurrency: clamp(s.concurrency, 1, 8, 4), timeoutSec: clamp(s.timeoutSec, 5, 600, 60),
  };
}
const active = () => { const s = settings(); return s.enabled && !!s.url; };
const modelId = () => 'tei:' + settings().model;

const safe = (value, key) => String(value || '').split(key || '\u0000').join('[gizli anahtar]').replace(/[\r\n]+/g, ' ').slice(0, 300);

// One /embed request. Resolves to { busy: true } when the server asks us to come back later (429/503).
async function call(config, inputs, { signal, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(config.url + '/embed', {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(config.timeoutSec * 1000)]),
      headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {}) },
      body: JSON.stringify({ inputs, normalize: true, truncate: true }),
    });
  } catch (error) {
    signal?.throwIfAborted();
    throw Error(`TEI sunucusuna ulaşılamadı (${config.url}): ${safe(error.cause?.code || error.message, config.apiKey)}`);
  }
  if (response.status === 429 || response.status === 503) return { busy: true };
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw Error(`TEI HTTP ${response.status}: ${safe(body?.error || body?.message, config.apiKey) || 'sunucu adresini ve model ayarını kontrol edin.'}`);
  }
  const vectors = await response.json().catch(() => null);
  if (!Array.isArray(vectors) || vectors.length !== inputs.length || vectors.some(v => !Array.isArray(v) || !v.length)) throw Error('TEI beklenen sayıda vektör döndürmedi.');
  return { vectors };
}

// Returns { vectors, model, dim, tokens, estimated } or { quota } when the server is busy (the caller waits and retries).
async function embed({ texts, task }, { signal, fetchImpl = fetch, config = settings() } = {}) {
  if (!config.url) throw Error('TEI sunucu adresi ayarlanmamış. Yönetim → Ayarlar sayfasından girin.');
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
      const index = next++, answer = await call(config, groups[index], { signal, fetchImpl });
      if (answer.busy) { busy = true; return; }
      results[index] = answer.vectors;
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.concurrency, groups.length) }, worker));
  if (busy) return { quota: { retryAt: Date.now() + 3000, message: 'TEI sunucusu meşgul.' } };
  const vectors = results.flat();
  const tokens = texts.reduce((sum, t) => sum + Math.max(1, Math.ceil(t.length / 4)), 0);
  return { tokens, estimated: true, vectors, model: 'tei:' + config.model, dim: vectors[0].length };
}

// Used by the admin panel's "Sına" button: one short passage, timed.
async function check(config, { fetchImpl = fetch } = {}) {
  if (!config.url) return { ok: false, message: 'Sunucu adresi geçerli bir http:// veya https:// adresi olmalı.' };
  const started = Date.now();
  try {
    const answer = await embed({ texts: ['Bu bir deneme cümlesidir. This is a test sentence.'], task: 'document' }, { config, fetchImpl });
    if (answer.quota) return { ok: false, message: 'Sunucu yanıt verdi ama şu an meşgul (HTTP 429/503).' };
    const ms = Date.now() - started;
    return { ok: true, dim: answer.dim, ms, message: `Bağlantı başarılı: ${answer.dim} boyutlu vektör, ${ms} ms.` };
  } catch (error) { return { ok: false, message: error.message }; }
}

module.exports = { configure, settings, active, modelId, embed, check, normalizeUrl };
