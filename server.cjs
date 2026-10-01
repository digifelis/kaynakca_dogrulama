const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const wordService = require('./word-service.cjs');
const webInspect = require('./web-source.cjs').createService();

// Only this local project file is read; keys are never returned to the browser.
function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const targets = {
  Crossref: ['api.crossref.org', '/works'], DataCite: ['api.datacite.org', '/dois/'],
  OpenAlex: ['api.openalex.org', '/works'], PubMed: ['eutils.ncbi.nlm.nih.gov', '/entrez/eutils/'],
  'Europe PMC': ['www.ebi.ac.uk', '/europepmc/webservices/rest/'], DBLP: ['dblp.org', '/search/publ/api'],
  ERIC: ['api.ies.ed.gov', '/eric/'], 'Semantic Scholar': ['api.semanticscholar.org', '/graph/v1/paper/'],
  CORE: ['api.core.ac.uk', '/v3/search/works'], arXiv: ['export.arxiv.org', '/api/query'], 'TR Dizin': ['search.trdizin.gov.tr', '/api/'],
  'İSAM': ['makale.isam.org.tr', '/server/api/discover/search/objects'],
  'Google Books': ['www.googleapis.com', '/books/v1/volumes'], OpenLibrary: ['openlibrary.org', '/search.json'],
};
function allowedTarget(provider, value) {
  const target = targets[provider];
  if (!target) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash && url.hostname === target[0] && url.pathname.startsWith(target[1]);
  } catch { return false; }
}

function credentials(provider, url) {
  const headers = { Accept: 'application/json', 'User-Agent': 'KaynakcaMasasi/1.0 (local bibliography verification)' };
  const params = {
    OpenAlex: ['OPENALEX_API_KEY', 'api_key'], PubMed: ['NCBI_API_KEY', 'api_key'],
    'Google Books': ['GOOGLE_BOOKS_API_KEY', 'key'], Crossref: ['CROSSREF_MAILTO', 'mailto'],
  };
  const config = params[provider];
  if (config && process.env[config[0]]) url.searchParams.set(config[1], process.env[config[0]]);
  // Ignore caller-supplied secrets; only configured credentials are used.
  if (config && !process.env[config[0]]) url.searchParams.delete(config[1]);
  if (provider === 'Semantic Scholar' && process.env.SEMANTIC_SCHOLAR_API_KEY) headers['x-api-key'] = process.env.SEMANTIC_SCHOLAR_API_KEY;
  if (provider === 'CORE' && process.env.CORE_API_KEY) headers.Authorization = `Bearer ${process.env.CORE_API_KEY}`;
  return headers;
}
function parseArxivXml(xml) {
  const decode = value => String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  const entries = [];
  for (const block of String(xml || '').matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const body = block[1];
    const value = tag => decode(body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1]);
    const authors = [...body.matchAll(/<author\b[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)].map(m => ({ literal: decode(m[1]) }));
    const id = value('id');
    entries.push({ id, title: value('title'), published: value('published'), authors, arxiv: id.match(/arxiv\.org\/(?:abs|pdf)\/([^?#/]+)/i)?.[1]?.replace(/v\d+$/i, '') || '' });
  }
  return { entries };
}

const queues = new Map();
const last = new Map();
const cache = new Map();
const cooldowns = new Map();
const quotaCounts = new Map();
const crossrefIntervals = new Map();
async function upstream(provider, input) {
  const previous = queues.get(provider) || Promise.resolve();
  const job = previous.catch(() => {}).then(async () => {
    const key = `${provider}:${input}`;
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.result;
    const remaining = (cooldowns.get(provider) || 0) - Date.now();
    if (remaining > 0) return { status: 429, body: { error: `${provider}: kota için bekleniyor` }, retryAfter: String(Math.ceil(remaining / 1000)) };
    const singleDoi = provider === 'Crossref' && new URL(input).pathname.startsWith('/works/');
    const rateType = singleDoi ? 'single' : 'list';
    const spacing = provider === 'Crossref' ? crossrefIntervals.get(rateType) || (singleDoi ? 200 : 1000) : ({ PubMed: 400, CORE: 2200, DBLP: 1100, OpenLibrary: 1100, 'Semantic Scholar': 1000, arXiv: 3000 })[provider] || 400;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, spacing - (Date.now() - (last.get(provider) || 0)))));
    last.set(provider, Date.now());
    const url = new URL(input);
    const headers = credentials(provider, url);
    // A redirect may not forward configured keys to a different host.
    // Crossref may normalize an encoded DOI slash with a same-host redirect.
    // Follow only redirects that remain inside this provider's allow-list;
    // this keeps API credentials from being sent to an unrelated host.
    let response;
    let requestUrl = url.href;
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      response = await fetch(requestUrl, { headers, redirect: 'manual', signal: AbortSignal.timeout(12000) });
      if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.get('location')) break;
      const nextUrl = new URL(response.headers.get('location'), requestUrl).href;
      if (!allowedTarget(provider, nextUrl)) return { status: 502, body: { error: `${provider}: güvenli yönlendirme reddedildi` } };
      requestUrl = nextUrl;
    }
    const retryAfter = response.headers.get('retry-after');
    if (provider === 'Crossref') {
      const limit = Number(response.headers.get('x-rate-limit-limit'));
      const interval = Number(response.headers.get('x-rate-limit-interval')?.replace(/s$/, ''));
      if (limit > 0 && interval > 0) crossrefIntervals.set(rateType, Math.max(singleDoi ? 200 : 1000, Math.ceil(interval * 1000 / limit)));
    }
    if (response.status === 429) {
      const value = retryAfter?.trim();
      const parsed = value ? (/^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()) : NaN;
      const count = quotaCounts.get(provider) || 0;
      const delay = Number.isFinite(parsed) ? Math.max(1000, parsed) : Math.min(900000, 60000 * 2 ** Math.min(count, 4));
      quotaCounts.set(provider, count + 1);
      cooldowns.set(provider, Date.now() + delay);
      // Preserve rate limits even when the provider returns an HTML/empty body.
      return { status: 429, body: { error: `${provider}: sorgu kotası/hız sınırı` }, retryAfter: String(Math.ceil(delay / 1000)) };
    }
    if (response.status === 404) return { status: 404, body: { error: 'Kayıt bulunamadı' } };
    let body;
    // ERIC serves valid JSON as text/plain. Parse content rather than trusting MIME.
    const responseText = await response.text();
    try { body = provider === 'arXiv' ? parseArxivXml(responseText) : JSON.parse(responseText); }
    catch { return { status: response.ok ? 403 : response.status >= 300 && response.status < 400 ? 502 : response.status, body: { error: `${provider}: JSON yanıtı alınamadı; erişim veya bot kontrolü olabilir` } }; }
    const result = { status: response.status, body, retryAfter };
    if (response.ok) {
      quotaCounts.delete(provider);
      cooldowns.delete(provider);
      if (cache.size >= 500) cache.delete(cache.keys().next().value);
      cache.set(key, { result, expires: Date.now() + 300000 });
    }
    return result;
  });
  queues.set(provider, job);
  return job;
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
}
function createServer({ inspectWeb = webInspect } = {}) {
  return http.createServer(async (req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    if (!['localhost', '127.0.0.1'].includes(host)) return json(res, 403, { error: 'Yerel erişim gerekli' });
    if (req.headers.origin && !['http://localhost:' + req.socket.localPort, 'http://127.0.0.1:' + req.socket.localPort].includes(req.headers.origin)) return json(res, 403, { error: 'Farklı kökenden erişim reddedildi' });
    try {
      const url = new URL(req.url, 'http://localhost');
      if (await wordService.handle(req, res, url, json)) return;
      if (req.method !== 'GET') return json(res, 405, { error: 'Yalnız GET desteklenir' });
      if (url.pathname === '/api/web-reference') {
        const target = url.searchParams.get('url');
        if (!target || target.length > 8000) return json(res, 400, { error: 'Geçerli web adresi gerekli' });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000);
        const closed = () => controller.abort();
        res.on('close', closed);
        try {
          const result = await inspectWeb(target, controller.signal);
          if (!res.destroyed) return json(res, 200, result);
        } catch (error) {
          if (!res.destroyed) return json(res, 200, { state: 'blocked', reason: controller.signal.aborted ? 'Web isteği zaman aşımına uğradı.' : error.message });
        } finally { clearTimeout(timer); res.removeListener('close', closed); }
        return;
      }
      if (url.pathname === '/api/config') return json(res, 200, { proxy: true, googleBooksConfigured: !!process.env.GOOGLE_BOOKS_API_KEY,
        groqConfigured: !!process.env.GROQ_API_KEY,
        configured: { OpenAlex: !!process.env.OPENALEX_API_KEY, PubMed: !!process.env.NCBI_API_KEY, 'Semantic Scholar': !!process.env.SEMANTIC_SCHOLAR_API_KEY, CORE: !!process.env.CORE_API_KEY } });
      if (url.pathname === '/api/proxy') {
        const provider = url.searchParams.get('provider');
        const target = url.searchParams.get('url');
        if (!target || target.length > 8000 || !allowedTarget(provider, target)) return json(res, 400, { error: 'Desteklenmeyen kaynak veya uç nokta' });
        try {
          const result = await upstream(provider, target);
          return json(res, result.status, result.body, result.retryAfter ? { 'Retry-After': result.retryAfter } : {});
        } catch (error) {
          // Keep provider failures diagnosable without exposing request headers or keys.
          return json(res, 502, { error: 'Dış kaynağa erişilemedi; tekrar deneyin', provider, detail: String(error?.message || 'Bilinmeyen bağlantı hatası').slice(0, 300) });
        }
      }
      const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/pages.js': ['pages.js', 'text/javascript'], '/ui.js': ['ui.js', 'text/javascript'], '/app.js': ['app.js', 'text/javascript'],
        '/web-reference.js': ['web-reference.js', 'text/javascript'], '/word-app.js': ['word-app.js', 'text/javascript'], '/reference-engine.js': ['reference-engine.js', 'text/javascript'], '/providers.js': ['providers.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
      const file = files[url.pathname];
      if (!file) return json(res, 404, { error: 'Dosya bulunamadı' });
      res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(fs.readFileSync(path.join(__dirname, file[0])));
    } catch { json(res, 502, { error: 'Dış kaynağa erişilemedi; tekrar deneyin' }); }
  });
}
if (require.main === module) {
  loadEnv();
  const port = Number(process.env.PORT) || 4173;
  createServer().listen(port, '127.0.0.1', () => console.log(`Kaynakça Masası: http://localhost:${port}/`));
}
module.exports = { allowedTarget, createServer, credentials };
