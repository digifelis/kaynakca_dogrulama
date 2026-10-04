// Semantic Scholar: paper search for the writing assistant and the download of open-access PDFs.
// The API key is set in the admin panel (app settings, sealed) or SEMANTIC_SCHOLAR_API_KEY; it is never sent to the browser.
// The browser only ever sees paper ids and metadata: PDF addresses stay on the server, which looks them up again at import
// time and fetches them only from public hosts (see download()).
const dns = require('node:dns').promises;
const https = require('node:https');

const API = 'https://api.semanticscholar.org/graph/v1';
const FIELDS = 'title,year,authors,venue,externalIds,openAccessPdf,citationCount,isOpenAccess,publicationTypes';
const MAX_QUERY = 200;

let keyProvider = () => '';
// The admin panel's key wins over the environment.
function configure({ key } = {}) { keyProvider = typeof key === 'function' ? key : () => ''; }
function apiKey() { try { return String(keyProvider() || process.env.SEMANTIC_SCHOLAR_API_KEY || '').trim(); } catch { return process.env.SEMANTIC_SCHOLAR_API_KEY || ''; } }
const configured = () => !!apiKey();

class ScholarError extends Error { constructor(message, status = 502) { super(message); this.status = status; } }
const mask = text => String(text || '').split(apiKey() || '\u0000').join('[gizli anahtar]');

// Requests are spaced (1 per second with a key, slower without) and run one at a time.
let chain = Promise.resolve(), lastAt = 0;
const gap = () => process.env.SCHOLAR_GAP_MS !== undefined ? Number(process.env.SCHOLAR_GAP_MS) : (apiKey() ? 1100 : 3500);
function spaced(task) {
  const run = chain.then(async () => { const wait = lastAt + gap() - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait)); try { return await task(); } finally { lastAt = Date.now(); } });
  chain = run.catch(() => {});
  return run;
}

// Semantic Scholar answers 429 when its (shared, for anonymous callers) pool is used up; the request is repeated after a pause
// (its Retry-After, else 2, 5 and 12 s) before the user is told to wait.
const API_PAUSES = [2000, 5000, 12000];
async function call(path, options = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await callOnce(path, options); }
    catch (error) {
      if (error.status !== 429 || attempt >= (options.retries ?? API_PAUSES.length)) throw error;
      await pause(process.env.SCHOLAR_RETRY_MS !== undefined ? Number(process.env.SCHOLAR_RETRY_MS) : Math.min(20000, error.retryAfterMs || API_PAUSES[attempt]), options.signal);
    }
  }
}
async function callOnce(path, { method = 'GET', body, key = apiKey(), signal } = {}) {
  return spaced(async () => {
    let response;
    try {
      response = await fetch(API + path, { method, signal, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'x-api-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch (error) { if (signal?.aborted) throw error; throw new ScholarError('Semantic Scholar\'a ulaşılamadı.'); }
    if (response.status === 429) { const seconds = Number(response.headers.get('retry-after')); throw Object.assign(new ScholarError('Semantic Scholar istek sınırına ulaşıldı; biraz bekleyip yeniden deneyin.' + (key ? ' (Anahtarınız kullanılıyor ve sınırı doldu: aynı anahtar başka bir uygulamada ya da sunucuda da kullanılıyor olabilir.)' : ' (API anahtarı tanımlı değil; ortak havuz sınırı.)'), 429), { retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0 }); }
    if (response.status === 401 || response.status === 403) throw Object.assign(new ScholarError('Semantic Scholar API anahtarı reddedildi; yönetim panelinden anahtarı kontrol edin.', 502), { rejected: true });
    if (!response.ok) throw new ScholarError(`Semantic Scholar HTTP ${response.status}.`);
    try { return await response.json(); } catch { throw new ScholarError('Semantic Scholar yanıtı okunamadı.'); }
  });
}

// "John A. Smith" -> "Smith, John A." (the family-name-first form the sources' künye uses).
function authorName(name) {
  const text = String(name || '').replace(/\s+/g, ' ').trim();
  if (!text || text.includes(',')) return text;
  const parts = text.split(' ');
  return parts.length < 2 ? text : `${parts.at(-1)}, ${parts.slice(0, -1).join(' ')}`;
}
function record(paper) {
  const id = String(paper?.paperId || '');
  if (!/^[0-9a-f]{40}$/.test(id)) return null;
  const url = paper.openAccessPdf?.url ? String(paper.openAccessPdf.url) : '';
  return { paperId: id, title: String(paper.title || '').slice(0, 300), year: paper.year ? String(paper.year) : '', authors: (paper.authors || []).map(a => authorName(a.name)).filter(Boolean).slice(0, 30),
    venue: String(paper.venue || '').slice(0, 200), doi: String(paper.externalIds?.DOI || '').toLowerCase(), citations: Number(paper.citationCount) || 0, pdfUrl: /^https:\/\//i.test(url) ? url : '' };
}
// What the browser may see: no PDF address, only whether one exists.
const publicView = rec => ({ paperId: rec.paperId, title: rec.title, year: rec.year, authors: rec.authors, venue: rec.venue, doi: rec.doi, citations: rec.citations, pdf: !!rec.pdfUrl });

// Keywords (commas or spaces) -> a plain text query.
function cleanQuery(value) {
  const query = String(value || '').replace(/[,;\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (query.length < 2) throw new ScholarError('Aramak için en az bir anahtar kelime yazın.', 400);
  if (query.length > MAX_QUERY) throw new ScholarError(`Arama metni en fazla ${MAX_QUERY} karakter olabilir.`, 400);
  return query;
}
async function search(input, { limit = 20, offset = 0, openAccessOnly = true, signal } = {}) {
  const query = cleanQuery(input);
  const size = Math.min(100, Math.max(1, Number(limit) || 20)), skip = Math.min(900, Math.max(0, Number(offset) || 0));
  const data = await call(`/paper/search?query=${encodeURIComponent(query)}&limit=${size}&offset=${skip}&fields=${FIELDS}${openAccessOnly ? '&openAccessPdf' : ''}`, { signal });
  const papers = (data.data || []).map(record).filter(Boolean);
  return { query, total: Number(data.total) || papers.length, offset: skip, next: data.next === undefined ? null : Number(data.next), papers: papers.map(publicView) };
}
// Fresh records (with PDF addresses) for the ids the user picked; order and unknown ids are kept.
async function byIds(ids, { signal } = {}) {
  const wanted = [...new Set(ids)].filter(id => /^[0-9a-f]{40}$/.test(id)).slice(0, 50);
  if (!wanted.length) return [];
  const data = await call(`/paper/batch?fields=${FIELDS}`, { method: 'POST', body: { ids: wanted }, signal });
  const found = new Map((Array.isArray(data) ? data : []).filter(Boolean).map(record).filter(Boolean).map(rec => [rec.paperId, rec]));
  return wanted.map(id => found.get(id) || { paperId: id, missing: true });
}
// Cheap call that proves a key is accepted (the admin panel's "test" button).
async function check(key) {
  const k = String(key || '').trim();
  try { await call('/paper/search?query=test&limit=1&fields=title', { key: k, retries: 0 }); return { ok: true, message: k ? 'Anahtar kabul edildi.' : 'Anahtarsız erişim çalışıyor (ortak ve düşük sınır).' }; }
  catch (error) { return { ok: false, rejected: !!error.rejected, message: mask(error.message) }; }
}

function publicIp(ip) {
  if (ip.includes(':')) { const a = ip.toLowerCase(); return !(a === '::1' || a === '::' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb') || a.startsWith('::ffff:')); }
  const [a, b] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a >= 224);
}
// Downloads one PDF: https only, public addresses only (checked for every redirect hop), size and time limits.
function fetchPdf(url, { maxBytes = 50 * 1024 * 1024, signal, redirects = 0, lookup = dns.lookup.bind(dns) } = {}) {
  return (async () => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || redirects > 4) throw Error('Güvenli olmayan PDF bağlantısı.');
    const addresses = await lookup(u.hostname, { all: true });
    if (!addresses.length || addresses.some(a => !publicIp(a.address))) throw Error('İç ağ bağlantısı reddedildi.');
    const address = addresses.find(a => a.family === 4) || addresses[0];
    return new Promise((resolve, reject) => {
      const req = https.get(u, { signal, timeout: 30000, headers: { Accept: 'application/pdf,*/*;q=0.5', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36' },
        lookup: (_host, options, cb) => cb(null, options.all ? [address] : address.address, address.family) }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); fetchPdf(new URL(res.headers.location, u).href, { maxBytes, signal, redirects: redirects + 1, lookup }).then(resolve, reject); return; }
        if (res.statusCode !== 200) { res.resume(); const seconds = Number(res.headers['retry-after']); reject(Object.assign(Error(`${u.hostname}: HTTP ${res.statusCode}`), { status: res.statusCode, retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0 })); return; }
        let size = 0; const chunks = [];
        res.on('data', chunk => { size += chunk.length; if (size > maxBytes) { res.destroy(Error('PDF boyut sınırını aşıyor.')); return; } chunks.push(chunk); });
        res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(Error('PDF indirme zaman aşımı.'))); req.on('error', reject);
    });
  })();
}

// Publishers answer 429/503 when they are asked too often. The request is repeated after a pause (their Retry-After, else 3, 8 and 20 s).
// `hostGapMs` also spaces the requests that go to the same host, so a batch of papers from one publisher does not arrive at once.
const RETRY_PAUSES = [3000, 8000, 20000], hostNext = new Map();
const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(resolve, Math.max(0, ms));
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});
async function download(url, { hostGapMs = 0, retries = RETRY_PAUSES.length, ...options } = {}) {
  for (let attempt = 0; ; attempt++) {
    if (hostGapMs > 0) {
      const host = new URL(url).hostname, now = Date.now(), start = Math.max(now, hostNext.get(host) || 0);
      hostNext.set(host, start + hostGapMs); await pause(start - now, options.signal);
    }
    try { return await fetchPdf(url, options); }
    catch (error) {
      if (![429, 503].includes(error.status) || attempt >= retries) {
        if (error.status === 429) error.message += ' (site istek sınırı koydu; biraz sonra yeniden ekleyin)';
        throw error;
      }
      await pause(Math.min(30000, error.retryAfterMs || RETRY_PAUSES[attempt]), options.signal);
    }
  }
}

module.exports = { configure, configured, apiKey, search, byIds, check, download, cleanQuery, authorName, publicIp, ScholarError };
