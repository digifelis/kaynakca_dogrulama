// Reference verification service: answers "verify" queue jobs with the reference engine.
// Index API keys (OpenAlex, Semantic Scholar, ...) live only in this service's .env.
// The engine talks to an in-process proxy on 127.0.0.1 that adds those keys; web pages are
// inspected here as well, and their missing fields are completed through the "llm" queue.
const http = require('node:http');
const path = require('node:path');
const { loadEnv } = require('../../lib/env.cjs');
const Jwt = require('../../lib/jwt.cjs');
const Backend = require('../../lib/backend.cjs');
const { startWorker } = require('../../lib/queue-client.cjs');
const { createLlmTransport } = require('../../lib/llm-queue.cjs');
const { proxyRequest, providerConfig } = require('../../lib/provider-proxy.cjs');
const Groq = require('../../web-groq.cjs');
const engine = require('../../reference-engine.js');
const Content = require('../../word-content.cjs');
const { python } = require('../../lib/python.cjs');

const text = (value, max) => value === undefined || value === null || typeof value === 'string' && value.length <= max;
function validateFullText(payload) {
  const r = payload.reference;
  if (!r || typeof r !== 'object' || !text(r.raw, 8000) || !r.raw || !text(r.effectiveRaw, 8000) || !text(r.title, 2000)) throw Error('Geçersiz kaynak kaydı');
  const matched = r.verification?.matched;
  if (matched !== null && matched !== undefined && (typeof matched !== 'object' || JSON.stringify(matched).length > 50000)) throw Error('Geçersiz eşleşme kaydı');
  return { raw: r.raw, effectiveRaw: r.effectiveRaw, title: r.title, verification: { matched: matched || null } };
}
function validate(payload) {
  if (typeof payload?.reference !== 'string' || !payload.reference.trim() || payload.reference.length > 8000) throw Error('Geçersiz kaynak kaydı');
  return { reference: payload.reference, options: { ...(payload.options?.primaryOnly ? { primaryOnly: true } : {}), ...(payload.options?.web === false ? { web: false } : {}) } };
}

function internalProxy(inspectWeb) {
  const server = http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (url.pathname === '/api/proxy') {
        const result = await proxyRequest(url.searchParams.get('provider'), url.searchParams.get('url'));
        return send(result.status, result.body, result.retryAfter ? { 'Retry-After': result.retryAfter } : {});
      }
      if (url.pathname === '/api/web-reference') {
        const target = url.searchParams.get('url');
        if (!target || target.length > 8000) return send(400, { error: 'Geçerli web adresi gerekli' });
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000);
        try { return send(200, await inspectWeb(target, controller.signal)); }
        catch (error) { return send(200, { state: 'blocked', reason: controller.signal.aborted ? 'Web isteği zaman aşımına uğradı.' : error.message }); }
        finally { clearTimeout(timer); }
      }
      send(404, { error: 'Bulunamadı' });
    } catch { send(502, { error: 'Dış kaynağa erişilemedi; tekrar deneyin' }); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function start({ queueUrl = process.env.QUEUE_URL, keysDir = process.env.JWT_KEYS_DIR || path.join(__dirname, '../../keys'), log = console.log } = {}) {
  if (!queueUrl) throw Error('QUEUE_URL tanımlı değil.');
  const client = Backend.configure({ queueUrl, keysDir, name: 'verify' });
  Groq.useTransport(createLlmTransport(client));
  await Backend.refresh('llm');
  const proxy = await internalProxy(require('../../web-source.cjs').createService());
  engine.configure({ proxyUrl: `http://127.0.0.1:${proxy.address().port}/api/proxy`, additionalProviders: require('../../providers.js'), googleBooksConfigured: !!process.env.GOOGLE_BOOKS_API_KEY, deferQuota: true });
  // The engine reports through global callbacks, so one service process verifies one record at a time;
  // run more service instances to verify in parallel.
  let current = null;
  engine.configure({
    onRequest: event => current?.({ kind: 'request', scope: 'reference', provider: event.provider, url: event.url, at: event.at }),
    onResponse: event => current?.({ kind: 'response', scope: 'reference', provider: event.provider, url: event.url, status: event.status, retryAfter: event.retryAfter, at: event.at }),
    onRetry: event => current?.({ type: 'wait', provider: event.provider, retryAt: event.retryAt }),
  });
  const handler = async (payload, { signal, emit }) => {
    // Full text of a publication for the content check: open-access sources, PDFs parsed with Python here.
    if (payload?.kind === 'fulltext') return Content.fullText(validateFullText(payload), python, signal, { onDebug: event => emit(event) });
    const { reference, options } = validate(payload);
    current = emit; engine.configure({ signal });
    try { return await engine.verifyReference(reference, options); }
    finally { current = null; engine.configure({ signal: null }); }
  };
  const worker = startWorker({ client, queue: 'verify', publicKeys: Jwt.loadPublicKeys(keysDir), trustedPublishers: ['web'], handler, capabilities: providerConfig(), concurrency: 1, log });
  log(`Doğrulama servisi kuyruğu dinliyor: ${queueUrl}`);
  return { worker, stop: () => worker.stop().then(() => new Promise(resolve => proxy.close(resolve))) };
}

if (require.main === module) {
  // Keys are read only when this file runs as the service, never when it is imported (e.g. by tests).
  loadEnv(path.join(__dirname, '.env'));
  start().then(service => {
    const stop = () => service.stop().then(() => process.exit(0));
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  }, error => { console.error(error.message); process.exit(1); });
}
module.exports = { start, validate, validateFullText };
