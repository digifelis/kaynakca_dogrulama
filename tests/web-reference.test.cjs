const test = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const Web = require('../web-reference.js');
const { metadata, validateUrl, fetchPage, createService, retryTime } = require('../web-source.cjs');
const { createServer } = require('../server.cjs');
const Engine = require('../reference-engine.js');
const url = 'https://example.org/news/water';
const title = 'Water in offices. What comes next?';
const raw = `Bhat, D. (2025, August 4). ${title} Example News. ${url}`;
test('Groq fields require literal evidence and cannot use copyright or invented authors', () => {
  const { merge } = require('../web-groq.cjs');
  const page = { title: 'Known', authors: [], evidence: [] };
  const text = 'Written by Jane Smith. Published: 4 August 2025. Copyright 2026.';
  const enriched = merge(page, { title: { value: 'Changed', quote: 'Changed' }, author: { value: 'Jane Smith', quote: 'Written by Jane Smith' }, published: { value: '2025-08-04', quote: 'Published: 4 August 2025' } }, text);
  assert.equal(enriched.title, 'Known'); assert.equal(enriched.authors[0].name, 'Jane Smith'); assert.equal(enriched.published, '2025-08-04');
  const rejected = merge(page, { author: { value: 'Fake Person', quote: 'Written by Jane Smith' }, published: { value: '2026', quote: 'Copyright 2026' } }, text);
  assert.equal(rejected.authors.length, 0); assert.equal(rejected.published, undefined); assert.equal(rejected.warnings.length, 2);
});
test('service enriches missing fields before site author fallback and uses update date', async () => {
  let calls = 0;
  const inspect = createService({ spacing: 0, transport: async () => ({ status: 200, url, html: '<meta property="og:site_name" content="Example"><meta property="article:modified_time" content="2025-08-04"><h1>Article headline</h1>' }), enrich: async page => { calls++; return page; } });
  const page = await inspect(url), r = Web.compare(raw, page);
  assert.equal(calls, 1); assert.equal(page.authors[0].type, 'Organization'); assert.equal(r.status, 'review');
  assert.ok(r.suggested.includes('2025, August 4')); assert.ok(r.webFields.some(f => f.field.includes('güncelleme')));
  assert.equal(Web.dateParts('Copyright 2026'), null); assert.deepEqual(Web.dateParts('04.08.2025'), { year: 2025, month: 8, day: 4 });
});
test('blocked refresh falls back to the last successful web metadata', async () => {
  let blocked = false, clock = 1000;
  const inspect = createService({ now: () => clock, spacing: 0, transport: async () => blocked ? { status: 403, url } : { status: 200, url, html: fixture() } });
  const first = await inspect(url); assert.equal(first.state, 'ok');
  blocked = true; clock += 301000;
  const second = await inspect(url); assert.equal(second.state, 'ok'); assert.equal(second.staleAccess, true);
  assert.equal(second.title, first.title); assert.match(second.warnings.at(-1), /önceki başarılı künye/);
  const r = Web.compare(raw.replace('August 4', 'August 5'), second);
  assert.equal(r.status, 'review'); assert.match(r.statusText, /önceki künye/); assert.equal(r.staleAccess, true);
});
function fixture(overrides = {}) {
  const article = { '@type': 'NewsArticle', url, headline: title, author: { '@type': 'Person', name: 'Divsha Bhat' }, datePublished: '2025-08-04T10:00:00Z', publisher: { '@type': 'Organization', name: 'Example News' }, ...overrides };
  return `<html><head><meta property="og:title" content="A different SEO title"><script type="application/ld+json">${JSON.stringify(article)}</script></head><body><h1>${title}</h1><footer>Copyright 2026</footer></body></html>`;
}
test('web parsing preserves full dates, multi-sentence titles, whitespace and markdown URLs', () => {
  const p = Web.parse(raw.replace(url, `[${url}](${url})`).replace('Water in', 'Water\u00a0   in'));
  assert.equal(p.url, url); assert.deepEqual(p.date, { year: 2025, month: 8, day: 4 });
  assert.equal(p.title, title + ' Example News');
  assert.equal(Web.parse('A. (2025). Title. https://doi.org/10.1234/test'), null);
  assert.equal(Web.dateParts('2025-02-30'), null);
  assert.equal(Web.dateParts('4 Ağustos 2025').month, 8);
  const list = `${raw}\nCulligan Quench. (2026). Office water usage. https://example.org/blog\nBloombergNews p. (2025, May 8). Water. https://example.org/news`;
  assert.equal(Engine.splitReferences(list).length, 3);
});
test('matching web metadata verifies without SEO title false mismatch', () => {
  const page = metadata(fixture(), url), r = Web.compare(raw, page);
  assert.equal(r.status, 'verified'); assert.equal(r.score, null); assert.equal(r.fallbackNeeded, false);
  assert.ok(r.correctedHtml.includes('<em>Water in offices. What comes next?</em>'));
  assert.ok(!r.corrected.includes('?.')); // Punctuation is preserved without a double stop.
});
test('wrong date/author yields review and preserves original with field evidence', () => {
  const original = `Example News. (2026). ${title} ${url}`;
  const r = Web.compare(original, metadata(fixture(), url));
  assert.equal(r.status, 'review'); assert.equal(r.corrected, original);
  assert.ok(r.suggested.includes('Bhat, D. (2025, August 4)'));
  assert.equal(r.webFields.find(r => r.field === 'Yayın tarihi').matches, false);
});
test('same-year different day is a conflict; publication and modification remain separate', () => {
  const page = metadata(fixture({ dateModified: '2026-01-01' }), url);
  const r = Web.compare(raw.replace('August 4', 'August 5'), page);
  assert.equal(r.status, 'review'); assert.equal(r.webModified, '2026-01-01');
  assert.ok(r.suggested.includes('2025, August 4'));
});
test('copyright and reviewBy cannot become publication date or author', () => {
  const page = metadata(fixture({ datePublished: undefined, author: undefined, reviewedBy: { name: 'Reviewer' } }), url);
  assert.equal(page.published, ''); assert.equal(page.authors.length, 0);
  const r = Web.compare(raw, page); assert.equal(r.status, 'review'); assert.ok(r.suggested.includes('(t.y.)')); assert.ok(!r.suggested.includes('Reviewer')); assert.equal(r.webAuthorFallback, true);
});
test('related article and organization metadata cannot supply current article fields', () => {
  const unrelated = fixture({ url: 'https://example.org/other', headline: 'Other article', author: { name: 'Wrong Author' } });
  const page = metadata(unrelated, url);
  assert.equal(page.authors.length, 0); assert.equal(page.published, '');
});
test('explicit visible publication date conflicts are retained', () => {
  const page = metadata(fixture().replace('</body>', '<p>Published: August 5, 2025</p></body>'), url);
  assert.ok(page.conflicts.length); assert.equal(Web.compare(raw, page).status, 'review');
});
test('blocked page and scholarly page are not automatically verified', () => {
  assert.equal(metadata('<h1>Just a moment</h1>', url).state, 'blocked');
  assert.equal(metadata(fixture({ '@type': 'ScholarlyArticle' }), url).state, 'unsupported');
});
test('HTML in extracted fields cannot inject result markup', () => {
  const r = Web.compare(raw, { ...metadata(fixture(), url), title: '<img src=x onerror=alert(1)>', authors: [{ name: '<script>bad</script>', type: 'Organization' }] });
  assert.ok(!r.suggestedHtml.includes('<img')); assert.ok(!r.suggestedHtml.includes('<script>'));
  assert.ok(!Web.details(r).includes('<script>'));
});
test('SSRF validation blocks credentials, ports, local and mapped IPv6 addresses', async () => {
  const { publicIp } = require('../word-content.cjs');
  assert.equal(publicIp('192.0.66.112'), true);
  for (const ip of ['192.0.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1']) assert.equal(publicIp(ip), false);
  for (const value of ['file:///etc/passwd', 'https://u:p@example.org/', 'http://example.org:8080/']) assert.throws(() => validateUrl(value));
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1']) {
    await assert.rejects(fetchPage(url, undefined, 0, async () => [{ address, family: address.includes(':') ? 6 : 4 }]), /İç ağ/);
  }
  await assert.rejects(fetchPage(url, undefined, 5), /Yönlendirme/);
});
test('shared domain cooldown defers without infinite retry and expires when allowed', async () => {
  let time = 100000, calls = 0;
  const inspect = createService({ now: () => time, spacing: 0, transport: async target => { calls++; return calls === 1 ? { status: 429, retryAfter: '120', url: target } : { status: 200, url: target, html: fixture() }; } });
  const first = await inspect(url); assert.equal(first.state, 'deferred'); assert.equal(first.retryAt, 220000);
  assert.equal((await inspect(url + '/second')).state, 'deferred'); assert.equal(calls, 1);
  time = 221000; assert.equal((await inspect(url)).state, 'ok'); assert.equal(calls, 2);
  const r = Web.compare(raw, first); assert.equal(r.fallbackNeeded, false); assert.equal(r.pendingRetryAt, undefined);
  assert.equal(retryTime('bad', 100000), 160000);
});
test('home redirect, unsupported document and 404 do not become valid references', async () => {
  for (const response of [{ status: 200, url: 'https://example.org/', html: fixture() }, { status: 200, url, unsupported: true }, { status: 404, url }]) {
    const inspect = createService({ spacing: 0, transport: async () => response });
    assert.notEqual((await inspect(url)).state, 'ok');
  }
});
test('server, shared engine and Word worker use web route without academic fallback', async () => {
  let calls = 0;
  const server = createServer({ inspectWeb: async target => { calls++; assert.equal(target, url); return metadata(fixture(), url); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const proxy = `http://127.0.0.1:${server.address().port}/api/proxy`;
  try {
    Engine.configure({ proxyUrl: proxy });
    const r = await Engine.verifyReference(raw, { primaryOnly: true });
    assert.equal(r.status, 'verified'); assert.equal(r.type, 'web');
    const messages = [];
    const worker = new Worker(path.join(__dirname, '../scripts/word-verify-worker.cjs'), { workerData: { proxy, references: [raw] } });
    try {
      await new Promise((resolve, reject) => { worker.on('error', reject); worker.on('message', m => { messages.push(m); if (m.type === 'done') resolve(); if (m.type === 'error') reject(Error(m.message)); }); });
    } finally { await worker.terminate(); }
    assert.equal(messages.find(m => m.type === 'result').result.status, 'verified'); assert.equal(calls, 2);
    assert.equal((await fetch(proxy.replace('/proxy', '/web-reference') + '?url=x', { headers: { Origin: 'http://evil.test' } })).status, 403);
  } finally { Engine.configure({ proxyUrl: null }); await new Promise(resolve => server.close(resolve)); }
});
