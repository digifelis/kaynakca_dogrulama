// Embeddings travel as "embed" jobs: the web side publishes, the LLM service (which holds GEMINI_API_KEY) answers.
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { createQueueServer } = require('../services/queue/server.cjs');
const { createQueueClient, startWorker } = require('../lib/queue-client.cjs');
const Backend = require('../lib/backend.cjs');
const Embed = require('../lib/writer-embed.cjs');
const Llm = require('../services/llm/index.cjs');

const pairs = Object.fromEntries(['web', 'verify', 'llm'].map(name => [name, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })]));
const publicKeys = Object.fromEntries(Object.entries(pairs).map(([name, pair]) => [name, pair.publicKey]));
const client = (url, name) => createQueueClient({ url, issuer: name, privateKey: pairs[name].privateKey });
const until = async (check, ms = 5000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw Error('zaman aşımı'); await new Promise(r => setTimeout(r, 20)); } };

test('web publishes embed jobs; the LLM service calls Gemini, waits out a quota reply and returns unit vectors', async t => {
  const server = createQueueServer({ keys: publicKeys });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const realFetch = global.fetch, seen = [];
  process.env.GEMINI_API_KEY = 'queue-test-key'; process.env.GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001'; process.env.GEMINI_EMBEDDING_DIM = '128';
  let throttled = false;
  global.fetch = async (target, init) => {
    if (!String(target).includes('generativelanguage.googleapis.com')) return realFetch(target, init);
    const body = JSON.parse(init.body); seen.push({ task: body.requests[0].taskType, n: body.requests.length, key: init.headers['x-goog-api-key'] });
    if (!throttled && body.requests[0].taskType === 'RETRIEVAL_QUERY') { throttled = true; return { ok: false, status: 429, headers: new Headers({ 'retry-after': '1' }), json: async () => ({}) }; }
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ embeddings: body.requests.map((r, i) => ({ values: [i + 1, 2, 2] })) }) };
  };
  const worker = startWorker({ client: client(url, 'llm'), queue: 'llm', publicKeys, trustedPublishers: ['web', 'verify'], handler: Llm.handle, capabilities: { embedding: true }, concurrency: 1 });
  Backend.use(client(url, 'web'));
  t.after(async () => { global.fetch = realFetch; delete process.env.GEMINI_API_KEY; Backend.use(null); await worker.stop(); server.closeAllConnections?.(); server.close(); });
  await until(() => Backend.workers('llm').length > 0);
  await Backend.refresh('llm');
  assert.equal(Embed.available(), true, 'the service advertises that it can embed');

  const vectors = await Embed.embedAll(Array.from({ length: 40 }, (_, i) => 'metin ' + i), 'document');
  assert.equal(vectors.length, 40); assert.ok(vectors[0] instanceof Float32Array);
  assert.ok(Math.abs(Math.hypot(...vectors[0]) - 1) < 1e-3, 'unit length');
  assert.deepEqual(seen.map(s => s.n), [32, 8], '40 texts go out in batches of 32');
  assert.ok(seen.every(s => s.task === 'RETRIEVAL_DOCUMENT' && s.key === 'queue-test-key'));

  const waits = [];
  const started = Date.now();
  const [query] = await Embed.embedBatch(['soru'], 'query', { onWait: until => waits.push(until) });
  assert.equal(waits.length, 1, 'the quota reply was reported to the caller'); assert.ok(Date.now() - started >= 900, 'and waited for the retry time');
  assert.equal(query.length, 3);
});
