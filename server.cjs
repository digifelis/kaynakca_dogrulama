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

const { allowedTarget, credentials, proxyRequest, providerConfig } = require('./lib/provider-proxy.cjs');
const Backend = require('./lib/backend.cjs');
const Batches = require('./lib/verify-batches.cjs');

async function readJson(req) {
  let size = 0; const parts = [];
  for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) throw Object.assign(Error('İstek çok büyük'), { status: 413 }); parts.push(chunk); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch { throw Object.assign(Error('Geçersiz JSON'), { status: 400 }); }
}
// Bibliography page: POST starts a server-side run, GET polls it, POST .../stop ends it.
async function handleBatches(req, res, url) {
  const match = url.pathname.match(/^\/api\/verify-batches(?:\/([0-9a-f-]{36})(\/stop)?)?$/);
  if (!match) return false;
  if (req.method !== 'GET' && req.headers['x-word-request'] !== '1') return json(res, 403, { error: 'Yerel uygulama isteği gerekli.' }), true;
  try {
    if (!match[1] && req.method === 'POST') return json(res, 201, Batches.create((await readJson(req)).references, { port: req.socket.localPort })), true;
    const batch = match[1] && Batches.get(match[1]);
    if (!batch) return json(res, 404, { error: 'Doğrulama bulunamadı; yeniden başlatın.' }), true;
    if (match[2] && req.method === 'POST') { batch.stop(); return json(res, 200, Batches.snapshot(batch)), true; }
    if (!match[2] && req.method === 'GET') return json(res, 200, Batches.snapshot(batch)), true;
    return json(res, 405, { error: 'Desteklenmeyen yöntem' }), true;
  } catch (error) { return json(res, error.status || 400, { error: error.message }), true; }
}
// In queue mode the services report which keys they hold; this process holds none.
function serviceConfig() {
  if (!Backend.queue()) return { ...providerConfig(), groqConfigured: !!process.env.GROQ_API_KEY, mode: 'local' };
  const verify = Backend.merged('verify'), llm = Backend.merged('llm');
  return { googleBooksConfigured: !!verify.googleBooksConfigured, configured: verify.configured || {}, groqConfigured: !!(llm.groq || llm.openRouter), mode: 'queue',
    services: { verify: Backend.workers('verify').length, llm: Backend.workers('llm').length } };
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
}
function createServer({ inspectWeb = webInspect } = {}) {
  return http.createServer(async (req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    if (!['localhost', '127.0.0.1'].includes(host)) return json(res, 403, { error: 'Yerel erişim gerekli' });
    // The Host was checked above; behind a container port mapping the browser's port differs from ours.
    if (req.headers.origin && !['http://localhost:' + req.socket.localPort, 'http://127.0.0.1:' + req.socket.localPort, 'http://' + req.headers.host].includes(req.headers.origin)) return json(res, 403, { error: 'Farklı kökenden erişim reddedildi' });
    try {
      const url = new URL(req.url, 'http://localhost');
      if (await wordService.handle(req, res, url, json)) return;
      if (await handleBatches(req, res, url)) return;
      if (req.method !== 'GET') return json(res, 405, { error: 'Yalnız GET desteklenir' });
      // In queue mode index and web lookups belong to the verification service, which holds the keys.
      if (Backend.queue() && (url.pathname === '/api/proxy' || url.pathname === '/api/web-reference')) return json(res, 404, { error: 'Bu sorgular doğrulama servisi üzerinden yapılır.' });
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
      if (url.pathname === '/api/config') {
        if (Backend.queue()) await Promise.all([Backend.refresh('verify'), Backend.refresh('llm')]);
        return json(res, 200, { proxy: true, ...serviceConfig() });
      }
      if (url.pathname === '/api/proxy') {
        const provider = url.searchParams.get('provider');
        const target = url.searchParams.get('url');
        const result = await proxyRequest(provider, target);
        return json(res, result.status, result.body, result.retryAfter ? { 'Retry-After': result.retryAfter } : {});
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
// With QUEUE_URL, verification and LLM work is published to the queue and answered by the services.
async function useQueue() {
  const client = Backend.configure();
  if (!client) return false;
  const transport = require('./lib/llm-queue.cjs').createLlmTransport(client);
  require('./word-content.cjs').useChatTransport(transport);
  require('./web-groq.cjs').useTransport(transport);
  await Promise.all([Backend.refresh('verify'), Backend.refresh('llm')]);
  return true;
}
if (require.main === module) {
  loadEnv();
  const port = Number(process.env.PORT) || 4173;
  useQueue().then(queued => {
    const services = queued ? ` (kuyruk: ${process.env.QUEUE_URL}; doğrulama servisi: ${Backend.workers('verify').length}, LLM servisi: ${Backend.workers('llm').length})` : ' (yerel mod)';
    createServer().listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Kaynakça Masası: http://localhost:${port}/${services}`));
  }, error => { console.error(error.message); process.exit(1); });
}
module.exports = { allowedTarget, createServer, credentials, useQueue };
