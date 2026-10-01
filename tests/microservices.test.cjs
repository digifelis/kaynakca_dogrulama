const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Jwt = require('../lib/jwt.cjs');
const { createQueueServer } = require('../services/queue/server.cjs');
const { createQueueClient, startWorker } = require('../lib/queue-client.cjs');

const pairs = Object.fromEntries(['web', 'verify', 'llm'].map(name => [name, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })]));
const publicKeys = Object.fromEntries(Object.entries(pairs).map(([name, pair]) => [name, pair.publicKey]));
const client = (url, name) => createQueueClient({ url, issuer: name, privateKey: pairs[name].privateKey });
const until = async (check, ms = 5000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw Error('zaman aşımı'); await new Promise(r => setTimeout(r, 10)); } };

async function broker(options = {}) {
  const server = createQueueServer({ keys: publicKeys, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  return { server, url, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }) };
}

test('RS256 tokens: valid issuer passes; wrong key, expiry, audience and non-RS256 headers are refused', () => {
  const token = Jwt.sign({ iss: 'web', aud: 'kaynakca-queue' }, pairs.web.privateKey, { kid: 'web' });
  assert.equal(Jwt.verify(token, publicKeys, { audience: 'kaynakca-queue' }).iss, 'web');
  const forged = Jwt.sign({ iss: 'web', aud: 'kaynakca-queue' }, pairs.llm.privateKey, { kid: 'web' });
  assert.throws(() => Jwt.verify(forged, publicKeys, { audience: 'kaynakca-queue' }), /imzası geçersiz/);
  assert.throws(() => Jwt.verify(Jwt.sign({ iss: 'web', aud: 'x' }, pairs.web.privateKey, { kid: 'web' }), publicKeys, { audience: 'kaynakca-queue' }), /hedefi/);
  assert.throws(() => Jwt.verify(Jwt.sign({ iss: 'web', aud: 'kaynakca-queue' }, pairs.web.privateKey, { kid: 'web', expiresIn: -120 }), publicKeys, { audience: 'kaynakca-queue' }), /süresi dolmuş/);
  const [, body, signature] = token.split('.');
  const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT', kid: 'web' })).toString('base64url');
  assert.throws(() => Jwt.verify(`${none}.${body}.${signature}`, publicKeys), /algoritması/);
  const hs = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'web' })).toString('base64url');
  assert.throws(() => Jwt.verify(`${hs}.${body}.${signature}`, publicKeys), /algoritması/);
  // kid and iss must name the same service: a verify-signed token cannot claim to be the web app.
  assert.throws(() => Jwt.verify(Jwt.sign({ iss: 'web', aud: 'kaynakca-queue' }, pairs.verify.privateKey, { kid: 'verify' }), publicKeys), /yayıncısı/);
});

test('queue enforces token and roles: no token, wrong role and foreign jobs are refused', async () => {
  const q = await broker();
  try {
    assert.equal((await fetch(q.url + '/v1/queues/verify/jobs', { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(q.url + '/health')).status, 200);
    await assert.rejects(client(q.url, 'llm').publish('verify', { reference: 'x' }), /yetkiniz yok/);
    await assert.rejects(client(q.url, 'web').call('POST', '/v1/queues/verify/claim', { waitMs: 0 }), /yetkiniz yok/);
    await assert.rejects(client(q.url, 'llm').call('POST', '/v1/queues/verify/claim', { waitMs: 0 }), /yetkiniz yok/);
    const id = await client(q.url, 'web').publish('verify', { reference: 'x' });
    await assert.rejects(client(q.url, 'verify').call('GET', `/v1/jobs/${id}`), /size ait değil/);
    // The verification service may ask the LLM queue for web metadata, but not the other way round.
    assert.ok(await client(q.url, 'verify').publish('llm', { kind: 'chat' }));
  } finally { await q.close(); }
});

test('jobs go to whichever service is idle; results and progress return to the publisher', async () => {
  const q = await broker();
  const busy = new Set(), seen = [];
  const handler = name => async (payload, { emit }) => { busy.add(name); seen.push(name); emit({ kind: 'note', from: name }); await until(() => busy.size === 2 || seen.length > 2); await new Promise(r => setTimeout(r, 20)); return { echo: payload.n, by: name }; };
  const workers = ['a', 'b'].map(name => startWorker({ client: client(q.url, 'verify'), queue: 'verify', publicKeys, trustedPublishers: ['web'], handler: handler(name), workerId: name }));
  try {
    const web = client(q.url, 'web'), events = [];
    const results = await Promise.all([1, 2].map(n => web.run('verify', { n }, { onEvent: e => events.push(e) })));
    assert.deepEqual(results.map(r => r.echo), [1, 2]);
    assert.deepEqual(new Set(results.map(r => r.by)), new Set(['a', 'b']), 'two idle services each took one job');
    assert.equal(events.filter(e => e.kind === 'note').length, 2);
    const listed = await web.workers('verify');
    assert.deepEqual(listed.map(w => w.id).sort(), ['a', 'b']);
  } finally { await Promise.all(workers.map(w => w.stop())); await q.close(); }
});

test('a job altered inside the queue is rejected by the service signature check', async () => {
  const q = await broker();
  let handled = false;
  try {
    const web = client(q.url, 'web');
    const id = await web.publish('verify', { reference: 'original' });
    q.server.jobs.get(id).payload = { reference: 'tampered' };
    const worker = startWorker({ client: client(q.url, 'verify'), queue: 'verify', publicKeys, trustedPublishers: ['web'], handler: async () => { handled = true; } });
    await assert.rejects(web.watch(id), /İş imzası doğrulanamadı/);
    assert.equal(handled, false);
    await worker.stop();
  } finally { await q.close(); }
});

test('an expired lease returns the job to the queue; after the last attempt it fails', async () => {
  let now = Date.now();
  const q = await broker({ now: () => now });
  try {
    const web = client(q.url, 'web'), service = client(q.url, 'verify');
    const id = await web.publish('verify', { reference: 'x' }, { maxAttempts: 2, leaseMs: 5000 });
    const first = await service.call('POST', '/v1/queues/verify/claim', { waitMs: 0 });
    assert.equal(first.id, id);
    now += 6000; q.server.sweep();
    assert.equal(q.server.jobs.get(id).state, 'queued');
    const second = await service.call('POST', '/v1/queues/verify/claim', { waitMs: 0 });
    assert.equal(second.attempt, 2);
    await assert.rejects(service.call('POST', `/v1/jobs/${id}/complete`, { leaseToken: first.leaseToken, result: 1 }), /kiralama/);
    now += 6000; q.server.sweep();
    assert.equal(q.server.jobs.get(id).state, 'failed');
  } finally { await q.close(); }
});

test('stopping on the web side cancels the queued work and aborts the running service', async () => {
  const q = await broker();
  let aborted = false;
  const worker = startWorker({ client: client(q.url, 'verify'), queue: 'verify', publicKeys, trustedPublishers: ['web'],
    handler: (payload, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(Error('durdu')); })) });
  try {
    const web = client(q.url, 'web'), controller = new AbortController();
    const running = web.run('verify', { reference: 'x' }, { signal: controller.signal, leaseMs: 6000 });
    await until(() => [...q.server.jobs.values()].some(j => j.state === 'active'));
    controller.abort();
    await assert.rejects(running, { name: 'AbortError' });
    assert.equal([...q.server.jobs.values()][0].state, 'cancelled');
    await until(() => aborted, 8000);
  } finally { await worker.stop(); await q.close(); }
});

test('queued jobs survive a broker restart; an interrupted job is queued again', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-test-'));
  let q = await broker({ dataDir });
  const web = () => client(q.url, 'web');
  const waiting = await web().publish('llm', { kind: 'chat', n: 1 });
  const active = await web().publish('llm', { kind: 'chat', n: 2 });
  const claimed = await client(q.url, 'llm').call('POST', '/v1/queues/llm/claim', { waitMs: 0 });
  assert.equal(claimed.id, waiting);
  await q.close();
  q = await broker({ dataDir });
  try {
    assert.equal(q.server.jobs.get(waiting).state, 'queued', 'active job lost its lease with the broker');
    assert.equal(q.server.jobs.get(active).state, 'queued');
    const next = await client(q.url, 'llm').call('POST', '/v1/queues/llm/claim', { waitMs: 0 });
    assert.equal(next.id, waiting, 'original order is kept');
  } finally { await q.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('Word verification through the queue keeps the worker message protocol: primary pass, then fallback', async () => {
  const q = await broker();
  const calls = [];
  const worker = startWorker({ client: client(q.url, 'verify'), queue: 'verify', publicKeys, trustedPublishers: ['web'],
    handler: async ({ reference, options }, { emit }) => {
      calls.push((options.primaryOnly ? 'P:' : 'E:') + reference);
      emit({ kind: 'request', scope: 'reference', provider: 'Crossref', url: 'https://api.crossref.org/works?q=' + reference });
      if (reference === 'missing' && options.primaryOnly) return { raw: reference, status: 'failed', fallbackNeeded: true };
      return { raw: reference, status: 'verified' };
    } });
  try {
    const { startQueued } = require('../lib/verification.cjs');
    const run = startQueued({ references: ['good', 'missing'], initialResults: [] }, client(q.url, 'web'), { parallel: 2 });
    const messages = [];
    run.on('message', m => messages.push(m));
    await until(() => messages.some(m => m.type === 'done'));
    assert.deepEqual(calls.filter(c => c.startsWith('P:')).sort(), ['P:good', 'P:missing']);
    assert.deepEqual(calls.filter(c => c.startsWith('E:')), ['E:missing'], 'only the miss goes to additional indexes');
    const results = messages.filter(m => m.type === 'result');
    assert.equal(results.at(-1).index, 1);
    assert.equal(results.at(-1).result.status, 'verified');
    assert.ok(messages.some(m => m.type === 'debug' && m.event.provider === 'Crossref' && Number.isInteger(m.event.index)));
  } finally { await worker.stop(); await q.close(); }
});

test('LLM evaluation runs through the LLM queue; API keys never enter the queue or its journal', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-llm-'));
  const q = await broker({ dataDir });
  const secret = 'gsk_test_' + crypto.randomBytes(12).toString('hex');
  const previous = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = secret;
  const sent = [];
  const realFetch = global.fetch;
  // Stand-in for the LLM provider; the key is attached inside the LLM service only.
  global.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.groq.com')) {
      sent.push(options.headers.Authorization);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict: 'supported', explanation: 'Test', claims: [{ claim: '120 yetişkin', verdict: 'supported', passage: 'P1', quote: 'Çalışmada 120 yetişkin incelendi.' }] }) } }] }));
    }
    return realFetch(url, options);
  };
  const Llm = require('../services/llm/index.cjs');
  const service = startWorker({ client: client(q.url, 'llm'), queue: 'llm', publicKeys, trustedPublishers: ['web', 'verify'], handler: Llm.handle, capabilities: { groq: true, openRouter: false } });
  const Backend = require('../lib/backend.cjs'), Content = require('../word-content.cjs');
  try {
    const web = client(q.url, 'web');
    Backend.use(web);
    // The service registers its capabilities with its first claim.
    for (let i = 0; i < 100 && !(await Backend.refresh('llm')).length; i++) await new Promise(r => setTimeout(r, 20));
    Content.useChatTransport(require('../lib/llm-queue.cjs').createLlmTransport(web));
    assert.equal(Content.llmAvailable(), true);
    const result = await Content.evaluate({ sentence: 'Çalışmaya 120 yetişkin katıldı.', context: ['Çalışmaya 120 yetişkin katıldı.'] },
      { passages: [{ text: 'Çalışmada 120 yetişkin incelendi.', location: 'Sayfa 1' }], title: 'Yapay örnek', access: 'Test metni' }, new AbortController().signal, () => {});
    assert.equal(result.verdict, 'supported');
    assert.deepEqual(sent, ['Bearer ' + secret], 'the service used its own key');
    const stored = JSON.stringify([...q.server.jobs.values()]) + fs.readFileSync(path.join(dataDir, 'queue.jsonl'), 'utf8');
    assert.ok(stored.includes('citation_evidence'), 'the job really passed through the queue');
    assert.equal(stored.includes(secret), false, 'no API key in queue state or journal');
    await assert.rejects(Llm.handle({ kind: 'chat', spec: { name: 'x', schema: {}, system: 'a'.repeat(30000), user: '' } }, { emit() {} }), /Sistem iletisi/);
  } finally {
    Content.useChatTransport(null); Backend.use(null);
    global.fetch = realFetch;
    if (previous === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = previous;
    await service.stop(); await q.close(); fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('web metadata in queue mode returns at once with the retry time while the LLM quota waits', async () => {
  const Groq = require('../web-groq.cjs');
  const page = { url: 'https://example.org/a', title: 'Başlık', authors: [], warnings: [] };
  Groq.useTransport({ available: () => true, chat: async () => { throw Object.assign(Error('Groq kota beklemesi sürüyor'), { retryAt: 12345, quota: true }); } });
  try {
    const result = await Groq.enrich(page, 'metin', null);
    assert.equal(result.groqRetryAt, 12345);
    assert.match(result.warnings.at(-1), /kota/);
    Groq.useTransport({ available: () => false, chat: async () => assert.fail('çağrılmamalı') });
    assert.match((await Groq.enrich(page, 'metin', null)).warnings.at(-1), /LLM servisi bulunamadı/);
  } finally { Groq.useTransport(null); }
});
