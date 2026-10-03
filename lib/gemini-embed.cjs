// Gemini embedding calls. Runs where GEMINI_API_KEY lives: in the LLM service (queue mode) or the web process (local mode).
// Gemini is stateless: it returns vectors for the texts of one request and keeps nothing, so requests never mix.
const model = () => process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
const dimension = () => Math.min(3072, Math.max(128, Number(process.env.GEMINI_EMBEDDING_DIM) || 768));
const configured = () => !!process.env.GEMINI_API_KEY;
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
const safe = text => String(text || '').replace(/AIza[\w-]+/g, '[gizli anahtar]').replace(/[\r\n]+/g, ' ').slice(0, 300);

// Returns { vectors } or { quota: { retryAt, message } } when Gemini asks us to wait.
async function embed({ texts, task }, { signal, fetchImpl = fetch } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw Error('GEMINI_API_KEY yapılandırılmamış.');
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
  const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${name}:batchEmbedContents`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]),
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ requests }),
  });
  if (response.status === 429 || response.status >= 500) {
    const body = await response.json().catch(() => null);
    return { quota: { retryAt: Date.now() + Math.max(1000, retryDelayMs(response, body)), message: response.status === 429 ? 'Gemini embedding kotası doldu.' : 'Gemini servisi geçici olarak yanıt vermiyor.' } };
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw Error(`Gemini embedding HTTP ${response.status}: ${safe(body?.error?.message) || 'erişim veya model ayarını kontrol edin.'}`);
  }
  const body = await response.json();
  const vectors = (body.embeddings || []).map(e => e.values);
  if (vectors.length !== texts.length || vectors.some(v => !Array.isArray(v) || !v.length)) throw Error('Gemini beklenen sayıda vektör döndürmedi.');
  // Truncated dimensions are not unit length for gemini-embedding-001; normalize so cosine similarity is a dot product.
  // The API reports no token count for embeddings, so usage is estimated from the text size (about 4 characters per token).
  const tokens = texts.reduce((sum, text) => sum + Math.max(1, Math.ceil(text.length / 4)), 0);
  return { tokens, estimated: true, vectors: vectors.map(v => { const n = Math.hypot(...v) || 1; return v.map(x => Math.round(x / n * 1e5) / 1e5); }), model: name, dim: vectors[0].length };
}

module.exports = { embed, validate, configured, model, dimension, LIMITS };
