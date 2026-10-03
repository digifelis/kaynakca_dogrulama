// Gemini embedding calls. Keys come from the key pool (panel keys, then GEMINI_API_KEY). Runs where the pool lives: in the LLM service (queue mode) or the web process (local mode).
// Gemini is stateless: it returns vectors for the texts of one request and keeps nothing, so requests never mix.
const KeyPool = require('./key-pool.cjs');
const model = () => process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
const dimension = () => Math.min(3072, Math.max(128, Number(process.env.GEMINI_EMBEDDING_DIM) || 768));
const configured = () => KeyPool.pool().hasUsable('gemini');
const LIMITS = { texts: 64, chars: 12000 };

function validate(payload) {
  if (!Array.isArray(payload?.texts) || !payload.texts.length || payload.texts.length > LIMITS.texts) throw Error(`1 ile ${LIMITS.texts} arasında metin gönderin.`);
  if (payload.texts.some(t => typeof t !== 'string' || !t.trim() || t.length > LIMITS.chars)) throw Error('Metinler boş olamaz ve en fazla ' + LIMITS.chars + ' karakter olabilir.');
  if (!['document', 'query'].includes(payload.task)) throw Error('Geçersiz embedding görevi.');
  return { texts: payload.texts, task: payload.task };
}
function retryDelayMs(response, body) {
  const header = Number(response.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const info = (body?.error?.details || []).find(d => /RetryInfo/.test(d['@type'] || ''))?.retryDelay;
  const seconds = Number(String(info || '').replace(/s$/, ''));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60000;
}
const safe = text => KeyPool.maskSecrets(String(text || '')).replace(/[\r\n]+/g, ' ').slice(0, 300);

// Returns { vectors } or { quota: { retryAt, message } } when Gemini asks us to wait.
async function embed({ texts, task }, { signal, fetchImpl = fetch } = {}) {
  const pool = KeyPool.pool();
  if (!pool.hasUsable('gemini')) throw Error('Etkin bir Gemini API anahtarı yok. Yönetim → API anahtarları sayfasından ekleyin veya .env dosyasına GEMINI_API_KEY yazın.');
  const name = model();
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw Error('GEMINI_EMBEDDING_MODEL biçimi geçersiz.');
  // gemini-embedding-2 takes the task as a text prefix instead of a taskType field.
  const prefixed = /embedding-2/.test(name);
  const requests = texts.map(text => ({
    model: `models/${name}`,
    content: { parts: [{ text: prefixed ? (task === 'query' ? `task: search result | query: ${text}` : `title: none | text: ${text}`) : text }] },
    ...(prefixed ? {} : { taskType: task === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT' }),
    outputDimensionality: dimension(),
  }));
  let response, key, denied = null;
  // A key that is resting or refused is skipped: the same request goes on with the next key at once.
  while (true) {
    key = pool.acquire('gemini');
    if (!key) {
      if (denied && !pool.hasUsable('gemini')) throw denied;
      const readyAt = pool.nextAvailableAt('gemini');
      return { quota: { retryAt: Number.isFinite(readyAt) && readyAt > 0 ? readyAt : Date.now() + 60000, message: 'Gemini embedding kotası doldu.' } };
    }
    response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${name}:batchEmbedContents`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key.key }, body: JSON.stringify({ requests }),
    }).catch(error => { signal?.throwIfAborted(); pool.report(key.id, { status: 0, error: error.message, retryAfterMs: 2000 }); throw error; });
    if (response.status === 429 || response.status >= 500) {
      const body = await response.json().catch(() => null);
      pool.report(key.id, { status: response.status, retryAfterMs: Math.max(1000, retryDelayMs(response, body)), error: safe(body?.error?.message) });
      continue;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null), detail = safe(body?.error?.message);
      // Google answers a bad key with 400 "API key not valid"; that and 401/403 mark the key invalid.
      if (response.status === 401 || response.status === 403 || (response.status === 400 && /API key not valid|API_KEY_INVALID/i.test(detail + JSON.stringify(body?.error?.details || '')))) {
        pool.report(key.id, { status: response.status === 400 ? 401 : response.status, error: detail });
        denied = Error(`Gemini embedding HTTP ${response.status}: ${detail || 'anahtar reddedildi.'}`);
        continue;
      }
      pool.report(key.id, { status: response.status, error: detail, retryAfterMs: 1000 });
      throw Error(`Gemini embedding HTTP ${response.status}: ${detail || 'erişim veya model ayarını kontrol edin.'}`);
    }
    break;
  }
  const body = await response.json();
  const vectors = (body.embeddings || []).map(e => e.values);
  pool.report(key.id, { ok: true });
  if (vectors.length !== texts.length || vectors.some(v => !Array.isArray(v) || !v.length)) throw Error('Gemini beklenen sayıda vektör döndürmedi.');
  // Truncated dimensions are not unit length for gemini-embedding-001; normalize so cosine similarity is a dot product.
  // The API reports no token count for embeddings, so usage is estimated from the text size (about 4 characters per token).
  const tokens = texts.reduce((sum, text) => sum + Math.max(1, Math.ceil(text.length / 4)), 0);
  return { tokens, estimated: true, vectors: vectors.map(v => { const n = Math.hypot(...v) || 1; return v.map(x => Math.round(x / n * 1e5) / 1e5); }), model: name, dim: vectors[0].length };
}

module.exports = { embed, validate, configured, model, dimension, LIMITS };
