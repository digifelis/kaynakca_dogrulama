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

test('TEI çoklu adres: satır/virgülle yazılır, tekrar ve geçersizler ayıklanır', () => {
  const out = Tei.normalizeUrls('http://a:8082\nhttp://b:8083, http://a:8082  ftp://x\nhttp://u:p@c');
  assert.deepEqual(out.urls, ['http://a:8082', 'http://b:8083']); assert.deepEqual(out.invalid, ['ftp://x', 'http://u:p@c']);
  assert.equal(Tei.settings({ provider: 'tei', url: 'http://a:8082\nhttp://b:8083' }).urls.length, 2);
  assert.equal(Tei.normalizeUrls(Array.from({ length: 10 }, (_, i) => 'http://h' + i).join('\n')).tooMany, true);
});

test('TEI çoklu adres: istekler sunuculara dağılır', async () => {
  const hits = {}, config = Tei.settings({ provider: 'tei', url: 'http://dagit-a:8082\nhttp://dagit-b:8082', batch: 1, concurrency: 1 });
  const fetchImpl = async (url, init) => { const host = new URL(url).host; hits[host] = (hits[host] || 0) + 1; await new Promise(r => setTimeout(r, 5)); return reply(200, vec(JSON.parse(init.body).inputs)); };
  const out = await Tei.embed({ texts: Array.from({ length: 8 }, (_, i) => 'm' + i), task: 'document' }, { config, fetchImpl });
  assert.equal(out.vectors.length, 8);
  assert.ok(hits['dagit-a:8082'] >= 3 && hits['dagit-b:8082'] >= 3, JSON.stringify(hits));
});

test('TEI çoklu adres: ulaşılamayan sunucu atlanır, hepsi kapalıysa hata verilir', async () => {
  const config = Tei.settings({ provider: 'tei', url: 'http://kapali-a:8082\nhttp://acik-b:8082', batch: 2 }), seen = [];
  const fetchImpl = async (url, init) => { seen.push(new URL(url).host); if (url.includes('kapali-a')) throw Object.assign(Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); return reply(200, vec(JSON.parse(init.body).inputs)); };
  const out = await Tei.embed({ texts: ['a', 'b', 'c', 'd'], task: 'document' }, { config, fetchImpl });
  assert.equal(out.vectors.length, 4);
  seen.length = 0;
  await Tei.embed({ texts: ['a', 'b'], task: 'document' }, { config, fetchImpl });
  assert.deepEqual(seen, ['acik-b:8082'], 'a recently failed server is skipped');
  const dead = Tei.settings({ provider: 'tei', url: 'http://olu-a:8082\nhttp://olu-b:8082' });
  await assert.rejects(Tei.embed({ texts: ['a'], task: 'document' }, { config: dead, fetchImpl: async () => { throw Object.assign(Error('x'), { cause: { code: 'ECONNREFUSED' } }); } }), /Hiçbir TEI sunucusundan yanıt alınamadı.*ECONNREFUSED/);
  // a request error (4xx) is the same on every server: no failover
  const calls = [];
  await assert.rejects(Tei.embed({ texts: ['a'], task: 'document' }, { config: Tei.settings({ provider: 'tei', url: 'http://hata-a:8082\nhttp://hata-b:8082' }), fetchImpl: async url => { calls.push(url); return reply(413, { error: 'cok buyuk' }); } }), /HTTP 413/);
  assert.equal(calls.length, 1);
});

test('TEI çoklu adres: sunucu bazlı sına ve boyut uyumsuzluğu', async () => {
  const dim = { 'http://sina-a:8082': 384, 'http://sina-b:8082': 384 };
  const fetchImpl = async (url, init) => { const base = url.replace('/embed', ''); if (!(base in dim)) throw Object.assign(Error('x'), { cause: { code: 'ECONNREFUSED' } }); return reply(200, JSON.parse(init.body).inputs.map(() => new Array(dim[base]).fill(0.1))); };
  const good = await Tei.check(Tei.settings({ provider: 'tei', url: 'http://sina-a:8082\nhttp://sina-b:8082' }), { fetchImpl });
  assert.equal(good.ok, true); assert.equal(good.servers.length, 2); assert.match(good.message, /2\/2 sunucu/);
  const half = await Tei.check(Tei.settings({ provider: 'tei', url: 'http://sina-a:8082\nhttp://sina-yok:8082' }), { fetchImpl });
  assert.equal(half.ok, false); assert.match(half.message, /1\/2 sunucu/); assert.equal(half.servers[1].ok, false);
  dim['http://sina-b:8082'] = 768;
  const mixed = await Tei.check(Tei.settings({ provider: 'tei', url: 'http://sina-a:8082\nhttp://sina-b:8082' }), { fetchImpl });
  assert.equal(mixed.ok, false); assert.match(mixed.message, /farklı boyutta/);
});

test('yönetim paneli: çok satırlı TEI adresleri kaydedilir, geri okunur ve sınanır', async () => {
  const { harness } = require('./helpers/harness.cjs');
  const h = await harness(), real = global.fetch;
  try {
    const admin = await h.adminClient(), user = await h.register('veli');
    assert.equal((await user('PUT', '/api/admin/settings/embedding', { provider: 'tei', url: 'http://a:8082' })).status, 403);
    const lines = 'http://tei-1:8082\nhttp://tei-2:8083\r\n  http://tei-1:8082 ';
    const saved = await admin('PUT', '/api/admin/settings/embedding', { provider: 'tei', url: lines, model: 'multilingual-e5-small', batch: 8, concurrency: 4, timeoutSec: 60, queryPrefix: 'query: ', passagePrefix: 'passage: ' });
    assert.equal(saved.status, 200, JSON.stringify(saved));
    assert.equal(saved.embedding.url, 'http://tei-1:8082\nhttp://tei-2:8083', 'duplicates are dropped, one address per line');
    assert.equal((await admin('GET', '/api/admin/settings/embedding')).embedding.url, 'http://tei-1:8082\nhttp://tei-2:8083');
    Tei.configure({ config: () => h.app.auth.settings.embedding({ secret: true }) });
    assert.equal(Tei.active(), true); assert.equal(Tei.settings().urls.length, 2);
    const bad = await admin('PUT', '/api/admin/settings/embedding', { provider: 'tei', url: 'http://tei-1:8082\nftp://x' });
    assert.equal(bad.status, 400); assert.match(bad.error, /ftp:\/\/x/);
    assert.equal((await admin('PUT', '/api/admin/settings/embedding', { provider: 'tei', url: '' })).status, 400);
    global.fetch = async (url, init) => /tei-/.test(String(url)) ? reply(200, JSON.parse(init.body).inputs.map(() => new Array(384).fill(0.1))) : real(url, init);
    const test = await admin('POST', '/api/admin/settings/embedding/test', { url: 'http://tei-1:8082\nhttp://tei-2:8083' });
    assert.equal(test.ok, true, JSON.stringify(test)); assert.equal(test.servers.length, 2); assert.match(test.message, /2\/2 sunucu/);
    assert.match(JSON.stringify((await admin('GET', '/api/admin/audit')).entries), /admin\.settings_embedding/);
  } finally { global.fetch = real; Tei.configure({}); await h.close(); }
});

test('TEI: sunucu başına toplam eşzamanlı istek, farklı çağrılar toplamında bile sınırlanır', async () => {
  let inflight = 0, peak = 0;
  const config = Tei.settings({ provider: 'tei', url: 'http://sinir-a:8082', batch: 1, concurrency: 2 });
  const fetchImpl = async (url, init) => { inflight++; peak = Math.max(peak, inflight); await new Promise(r => setTimeout(r, 10)); inflight--; return reply(200, vec(JSON.parse(init.body).inputs)); };
  const calls = Array.from({ length: 6 }, (_, k) => Tei.embed({ texts: ['a' + k, 'b' + k, 'c' + k, 'd' + k], task: 'document' }, { config, fetchImpl }));
  const outs = await Promise.all(calls);
  assert.ok(outs.every(o => o.vectors.length === 4)); assert.equal(peak, 2, 'never more than 2 requests at once on the server');
  // an aborted caller does not hang while waiting for a slot
  const stop = new AbortController(), releases = [];
  const hold = Tei.embed({ texts: ['x', 'y'], task: 'document' }, { config, fetchImpl: () => new Promise(r => { releases.push(() => r(reply(200, vec(['x'])))); }) }).catch(() => {});
  await new Promise(r => setTimeout(r, 20));
  const waiting = Tei.embed({ texts: ['z'], task: 'document' }, { config, signal: stop.signal, fetchImpl });
  stop.abort(Error('iptal')); await assert.rejects(waiting, /iptal/);
  releases.forEach(r => r()); await hold;
});

test('TEI: zaman aşımı "ulaşılamadı" değil "yanıt vermedi" olarak bildirilir ve sunucu devre dışı bırakılmaz', async () => {
  const config = Tei.settings({ provider: 'tei', url: 'http://yavas-a:8082', timeoutSec: 5 }), seen = [];
  const timeout = async () => { seen.push('t'); throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  await assert.rejects(Tei.embed({ texts: ['a'], task: 'document' }, { config, fetchImpl: timeout }), e => /5 sn içinde yanıt vermedi/.test(e.message) && !/ulaşılamadı/.test(e.message));
  await Tei.embed({ texts: ['a'], task: 'document' }, { config, fetchImpl: async (u, init) => { seen.push('ok'); return reply(200, vec(JSON.parse(init.body).inputs)); } });
  assert.deepEqual(seen, ['t', 'ok'], 'a slow server is still used by the next call');
});
