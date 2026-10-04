const test = require('node:test');
const assert = require('node:assert/strict');
const Tei = require('../lib/tei-embed.cjs');
const Embed = require('../lib/writer-embed.cjs');

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const fake = (handler, seen = []) => async (url, init) => { const body = JSON.parse(init.body); seen.push({ url, init, body }); return handler(body, seen.length); };
const vec = inputs => inputs.map((_, i) => [3, 4, i]);

test('TEI adresi: yalnız düz http(s), kimlik bilgisi ve sorgu yok', () => {
  assert.equal(Tei.normalizeUrl('http://embedding:80/'), 'http://embedding');
  assert.equal(Tei.normalizeUrl('http://embedding:8082/'), 'http://embedding:8082');
  assert.equal(Tei.normalizeUrl('https://ornek.edu.tr/tei/'), 'https://ornek.edu.tr/tei');
  for (const bad of ['', 'ftp://x', 'http://u:p@x', 'http://x?a=1', 'embedding:80', 'javascript:1']) assert.equal(Tei.normalizeUrl(bad), '', bad);
});

test('TEI: önek, parti bölme, normalize ve model adı', async () => {
  const seen = [], config = Tei.settings({ provider: 'tei', url: 'http://embedding:8082', batch: 2, concurrency: 2, apiKey: 'gizli-anahtar' });
  const out = await Tei.embed({ texts: ['a', 'b', 'c'], task: 'document' }, { config, fetchImpl: fake(body => reply(200, vec(body.inputs)), seen) });
  assert.equal(out.vectors.length, 3); assert.equal(out.dim, 3); assert.equal(out.model, 'tei:multilingual-e5-small');
  assert.deepEqual(seen.map(s => s.body.inputs).flat().sort(), ['passage: a', 'passage: b', 'passage: c']);
  assert.ok(seen.every(s => s.url === 'http://embedding:8082/embed' && s.body.normalize === true && s.body.truncate === true && s.init.headers.Authorization === 'Bearer gizli-anahtar'));
  const q = await Tei.embed({ texts: ['soru'], task: 'query' }, { config, fetchImpl: fake(body => { assert.deepEqual(body.inputs, ['query: soru']); return reply(200, vec(body.inputs)); }) });
  assert.equal(q.vectors.length, 1);
  const bare = Tei.settings({ provider: 'tei', url: 'http://x', passagePrefix: '', queryPrefix: '' });
  await Tei.embed({ texts: ['a'], task: 'document' }, { config: bare, fetchImpl: fake(body => { assert.deepEqual(body.inputs, ['a']); return reply(200, vec(body.inputs)); }) });
});

test('TEI: meşgul (429) bekleme yanıtı olur, diğer hatalar atılır ve anahtar sızmaz', async () => {
  const config = Tei.settings({ provider: 'tei', url: 'http://embedding', apiKey: 'sir-anahtar' });
  const busy = await Tei.embed({ texts: ['a'], task: 'document' }, { config, fetchImpl: fake(() => reply(429, {})) });
  assert.ok(busy.quota.retryAt > Date.now());
  await assert.rejects(Tei.embed({ texts: ['a'], task: 'document' }, { config, fetchImpl: fake(() => reply(413, { error: 'batch size 99 sir-anahtar' })) }), e => /HTTP 413/.test(e.message) && !e.message.includes('sir-anahtar'));
  await assert.rejects(Tei.embed({ texts: ['a'], task: 'document' }, { config, fetchImpl: async () => { throw Object.assign(Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } }), /ulaşılamadı.*ECONNREFUSED/);
  await assert.rejects(Tei.embed({ texts: ['a', 'b'], task: 'document' }, { config, fetchImpl: fake(() => reply(200, [[1]])) }), /beklenen sayıda/);
});

test('TEI: sına ve sağlayıcı seçimi', async () => {
  const ok = await Tei.check(Tei.settings({ provider: 'tei', url: 'http://embedding' }), { fetchImpl: fake(body => reply(200, body.inputs.map(() => new Array(384).fill(0.1)))) });
  assert.equal(ok.ok, true); assert.equal(ok.dim, 384);
  assert.equal((await Tei.check(Tei.settings({ provider: 'tei', url: '' }))).ok, false);
  Tei.configure({ config: () => ({ provider: 'gemini', url: 'http://embedding' }) });
  assert.equal(Tei.active(), false);
  Tei.configure({ config: () => ({ provider: 'tei', url: 'http://embedding', model: 'bge-m3' }) });
  assert.equal(Tei.active(), true); assert.equal(Embed.available(), true); assert.equal(Embed.modelId(), 'tei:bge-m3');
  Tei.configure({});
});
