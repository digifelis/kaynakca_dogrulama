// Semantic Scholar: search, id lookup, key handling, safe PDF download, and the admin panel's key setting.
const test = require('node:test');
const assert = require('node:assert/strict');
const Scholar = require('../lib/scholar.cjs');
const { harness } = require('./helpers/harness.cjs');

const ID = n => String(n).repeat(40);
const raw = (n, extra = {}) => ({ paperId: ID(n), title: 'Paper ' + n, year: 2020, authors: [{ name: 'John A. Smith' }, { name: 'Doe, Jane' }], venue: 'Journal', externalIds: { DOI: '10.1/ABC' }, openAccessPdf: { url: 'https://host.example/p.pdf' }, citationCount: 3, ...extra });
function withFetch(handler, fn) {
  const real = global.fetch, calls = [];
  global.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
  process.env.SCHOLAR_GAP_MS = '0';
  return Promise.resolve(fn(calls)).finally(() => { global.fetch = real; delete process.env.SCHOLAR_GAP_MS; Scholar.configure({}); });
}
const ok = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('search: keywords become a plain query, the key is sent as a header, PDF addresses stay on the server', async () => {
  Scholar.configure({ key: () => 'panel-key-123456' });
  await withFetch(() => ok({ total: 2, offset: 0, next: 20, data: [raw(1), raw(2, { openAccessPdf: null }), { paperId: 'bozuk' }] }), async calls => {
    const out = await Scholar.search('motivasyon, başarı;  eğitim', { limit: 20, offset: 0 });
    assert.match(calls[0].url, /\/paper\/search\?query=motivasyon%20ba%C5%9Far%C4%B1%20e%C4%9Fitim&limit=20&offset=0&fields=/); assert.match(calls[0].url, /&openAccessPdf$/);
    assert.equal(calls[0].init.headers['x-api-key'], 'panel-key-123456');
    assert.equal(out.papers.length, 2, 'records without a valid paper id are dropped'); assert.equal(out.next, 20);
    assert.deepEqual(out.papers.map(p => p.pdf), [true, false]); assert.deepEqual(out.papers[0].authors, ['Smith, John A.', 'Doe, Jane']); assert.equal(out.papers[0].doi, '10.1/abc');
    assert.doesNotMatch(JSON.stringify(out), /host\.example|pdfUrl/);
    await Scholar.search('abc', { openAccessOnly: false }); assert.doesNotMatch(calls[1].url, /&openAccessPdf$/);
    await assert.rejects(Scholar.search(' , '), /anahtar kelime/); await assert.rejects(Scholar.search('x'.repeat(201)), /200/);
  });
});

test('search errors are explained and never contain the key', async () => {
  Scholar.configure({ key: () => 'panel-key-123456' });
  await withFetch(() => new Response('{}', { status: 429 }), async () => { await assert.rejects(Scholar.search('abc'), e => e.status === 429 && /sınırına/.test(e.message)); });
  await withFetch(() => new Response('{}', { status: 403 }), async () => { await assert.rejects(Scholar.search('abc'), e => e.rejected && !/panel-key/.test(e.message)); });
  await withFetch(() => { throw new TypeError('fetch failed panel-key-123456'); }, async () => { await assert.rejects(Scholar.search('abc'), e => !/panel-key/.test(e.message)); });
});

test('byIds asks for exactly the chosen papers and keeps unknown ones as missing', async () => {
  await withFetch(() => ok([raw(1), null]), async calls => {
    const out = await Scholar.byIds([ID(1), ID(2), 'zararlı', ID(1)]);
    assert.equal(calls[0].init.method, 'POST'); assert.deepEqual(JSON.parse(calls[0].init.body), { ids: [ID(1), ID(2)] });
    assert.equal(out[0].pdfUrl, 'https://host.example/p.pdf'); assert.equal(out[1].missing, true);
  });
});

test('download refuses plain http, private addresses and unsafe redirects before any request', async () => {
  await assert.rejects(Scholar.download('http://example.org/a.pdf'), /Güvenli olmayan/);
  await assert.rejects(Scholar.download('https://user:pw@example.org/a.pdf'), /Güvenli olmayan/);
  await assert.rejects(Scholar.download('https://example.org:8443/a.pdf'), /Güvenli olmayan/);
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '169.254.169.254', '172.16.0.1', '::1', 'fd00::1']) {
    await assert.rejects(Scholar.download('https://intranet.example/a.pdf', { lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }] }), /İç ağ/, address);
  }
  assert.equal(Scholar.publicIp('93.184.216.34'), true);
});

test('admin panel: the Semantic Scholar key is stored sealed, tested on save, never returned, and audited without its value', async () => {
  const h = await harness();
  const real = global.fetch; process.env.SCHOLAR_GAP_MS = '0';
  try {
    const admin = await h.adminClient(), user = await h.register('ali');
    assert.equal((await user('GET', '/api/admin/settings/scholar')).status, 403);
    assert.equal((await user('PUT', '/api/admin/settings/scholar', { key: 'abcdefgh12345678' })).status, 403);
    assert.equal((await admin('GET', '/api/admin/settings/scholar')).scholar.keySet, false);
    assert.equal((await admin('PUT', '/api/admin/settings/scholar', { key: 'kısa' })).status, 400);
    const seen = [];
    global.fetch = async (url, init = {}) => { if (String(url).includes('semanticscholar')) { seen.push(init.headers?.['x-api-key']); return init.headers?.['x-api-key'] === 'bad-key-0000000' ? new Response('{}', { status: 403 }) : ok({ total: 0, data: [] }); } return real(url, init); };
    const refused = await admin('PUT', '/api/admin/settings/scholar', { key: 'bad-key-0000000' });
    assert.equal(refused.status, 400); assert.equal((await admin('GET', '/api/admin/settings/scholar')).scholar.keySet, false, 'a refused key is not saved');
    const saved = await admin('PUT', '/api/admin/settings/scholar', { key: 's2k-secret-value-9876' });
    assert.equal(saved.status, 200, JSON.stringify(saved)); assert.equal(saved.scholar.keySet, true); assert.equal(saved.scholar.last4, '9876'); assert.equal(saved.test.ok, true);
    assert.doesNotMatch(JSON.stringify(await admin('GET', '/api/admin/settings')), /s2k-secret/);
    assert.equal(Scholar.apiKey(), 's2k-secret-value-9876', 'the stored key is what the search uses');
    seen.length = 0; assert.equal((await admin('POST', '/api/admin/settings/scholar/test')).ok, true); assert.equal(seen[0], 's2k-secret-value-9876');
    assert.equal((await admin('PUT', '/api/admin/settings/scholar', { clear: true })).scholar.keySet, false);
    const audit = JSON.stringify((await admin('GET', '/api/admin/audit')).entries);
    for (const wanted of ['scholar.key_set', 'scholar.key_tested', 'scholar.key_removed']) assert.match(audit, new RegExp(wanted));
    assert.doesNotMatch(audit, /s2k-secret|bad-key/); assert.match(audit, /9876/);
  } finally { global.fetch = real; delete process.env.SCHOLAR_GAP_MS; await h.close(); }
});
