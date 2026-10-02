// LLM service: answers "llm" queue jobs (citation evidence, search terms, web metadata, writing answers) with Groq/OpenRouter,
// and embedding jobs (writing assistant) with Gemini.
// The provider keys live only in this service's .env; jobs never carry them.
const path = require('node:path');
const { loadEnv } = require('../../lib/env.cjs');
const Jwt = require('../../lib/jwt.cjs');
const { createQueueClient, startWorker } = require('../../lib/queue-client.cjs');
const Content = require('../../word-content.cjs');
const Gemini = require('../../lib/gemini-embed.cjs');

const LIMITS = { name: 64, system: 20000, user: 4 * 1024 * 1024 };
function validate(payload) {
  const spec = payload?.spec;
  if (payload?.kind !== 'chat' || !spec || typeof spec !== 'object') throw Error('Desteklenmeyen LLM işi');
  if (typeof spec.name !== 'string' || !/^[a-z_]{1,64}$/.test(spec.name)) throw Error('Geçersiz şema adı');
  if (!spec.schema || typeof spec.schema !== 'object') throw Error('JSON şeması gerekli');
  if (typeof spec.system !== 'string' || spec.system.length > LIMITS.system) throw Error('Sistem iletisi geçersiz');
  if (typeof spec.user !== 'string' || spec.user.length > LIMITS.user) throw Error('Kullanıcı iletisi geçersiz');
  return { name: spec.name, schema: spec.schema, system: spec.system, user: spec.user,
    maxTokens: Math.min(4000, Math.max(100, Number(spec.maxTokens) || 2500)),
    ...(spec.maxWaitMs !== undefined ? { maxWaitMs: Math.max(0, Number(spec.maxWaitMs) || 0) } : {}) };
}

async function handle(payload, { signal, emit }) {
  // Embeddings for the writing assistant; Gemini quota replies are handed back so the caller can wait and retry.
  if (payload?.kind === 'embed') return Gemini.embed(Gemini.validate(payload), { signal });
  const spec = validate(payload);
  let lastWait = 0;
  // Quota waits tick every second inside chat(); only a changed retry time is reported.
  const onWait = retryAt => { if (retryAt !== lastWait) { lastWait = retryAt; emit({ kind: 'quota-wait', retryAt }); } };
  try { return await Content.chat(spec, signal, onWait, event => emit(event)); }
  catch (error) {
    if (error.quota) return { quota: { retryAt: error.retryAt, message: error.message } };
    throw error;
  }
}
const capabilities = () => ({ groq: !!process.env.GROQ_API_KEY, openRouter: Content.openRouterEnabled(), embedding: Gemini.configured() });

function start({ queueUrl = process.env.QUEUE_URL, keysDir = process.env.JWT_KEYS_DIR || path.join(__dirname, '../../keys'), concurrency = Number(process.env.LLM_CONCURRENCY) || 1, log = console.log } = {}) {
  if (!queueUrl) throw Error('QUEUE_URL tanımlı değil.');
  const client = createQueueClient({ url: queueUrl, issuer: 'llm', privateKey: Jwt.loadPrivateKey(keysDir, 'llm') });
  const worker = startWorker({ client, queue: 'llm', publicKeys: Jwt.loadPublicKeys(keysDir), trustedPublishers: ['web', 'verify'], handler: handle, capabilities: capabilities(), concurrency, log });
  log(`LLM servisi kuyruğu dinliyor: ${queueUrl} (Groq: ${capabilities().groq ? 'var' : 'yok'}, OpenRouter: ${capabilities().openRouter ? 'var' : 'yok'}, Gemini embedding: ${capabilities().embedding ? 'var' : 'yok'})`);
  return worker;
}

if (require.main === module) {
  // Keys are read only when this file runs as the service, never when it is imported (e.g. by tests).
  loadEnv(path.join(__dirname, '.env'));
  const worker = start();
  const stop = () => worker.stop().then(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
module.exports = { start, handle, validate };
