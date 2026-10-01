const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'reference-engine.js'), 'utf8');
const reference = 'Devlin, J. (2019). BERT: Pre-training of deep bidirectional transformers for language understanding. NAACL.';
const record = { title: ['BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding'],
  author: [{ family: 'Devlin', given: 'Jacob' }], published: { 'date-parts': [[2019]] }, DOI: '10.18653/v1/n19-1423', 'container-title': ['NAACL'] };

function load(fetch) {
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const context = { module: { exports: {} }, fetch, AbortController,
    Date: Clock,
    // Do not spend seconds on retry/backoff in deterministic fixture tests.
    setTimeout: (fn, ms) => ms === 15000 ? setTimeout(fn, ms) : setTimeout(() => { now += ms; fn(); }, 0), clearTimeout };
  vm.runInNewContext(source, context);
  return context.module.exports;
}
const json = data => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

test('normalization preserves words, accents and Unicode matching', () => {
  const engine = load();
  assert.equal(engine.normalizeTitle('Attention is all you need'), 'attention is all you need');
  assert.equal(engine.titleScore('Türkiye’de turizm', 'TURKIYE DE TURIZM'), 1);
  assert.equal(engine.titleScore('Mapping the world’s photos', "Mapping the world's photos"), 1);
  assert.equal(engine.titleScore('Unrelated topic', 'Attention is all you need'), 0);
});

test('arXiv references use arXiv metadata without Crossref fallback', async () => {
  const engine = load();
  const requests = [];
  engine.configure({ additionalProviders: {
    search: async (id) => {
      requests.push(id);
      return [{ provider: 'arXiv', title: 'A study of education', author: [{ literal: 'Smith, Alice' }], year: 2023, url: 'https://arxiv.org/abs/2304.14163', arxiv: '2304.14163', doi: '10.48550/arxiv.2304.14163' }];
    },
    route: () => ['arXiv'],
  } });
  const result = await engine.verifyReference('Smith, A. (2023). A study of education. https://arxiv.org/abs/2304.14163');
  assert.equal(result.provider, 'arXiv');
  assert.equal(result.status, 'verified');
  assert.equal(Array.from(result.sourcesChecked).join(','), 'arXiv');
  assert.deepEqual(requests, ['arXiv']);
  assert.equal(result.fallbackNeeded, false);
});

test('numbered, accented, compound and lowercase surnames split without merging', () => {
  const engine = load();
  const values = ['Gutiérrez, J. (2020). First title.', 'Gülenç Birsen, A. (2025). Second title.', 'van der Zee, E. (2018). Third title.', 'Prudencio-Vázquez, J. (2023). Fourth title.'];
  assert.equal(engine.splitReferences(values.join('\n')).length, 4);
  assert.equal(engine.splitReferences('1. ' + values[0] + '\ncontinued journal text\n[1000] ' + values[1]).length, 2);
  assert.equal(engine.parseReference(values[2]).firstAuthor, 'van der Zee');
  assert.equal(engine.parseReference(values[1]).firstAuthor, 'Gülenç Birsen');
});

test('APA year suffix and Vancouver title extraction', () => {
  const engine = load();
  assert.equal(engine.parseReference('Uslu, A. (2021a). Sosyal medya verileri. Dergi.').title, 'Sosyal medya verileri');
  const parsed = engine.parseReference('Devlin J, Chang MW. BERT: Pre-training of deep bidirectional transformers for language understanding. NAACL. 2019;1:20.');
  assert.equal(parsed.year, 2019);
  assert.equal(parsed.firstAuthor, 'Devlin');
  assert.ok(parsed.title.startsWith('BERT:'));
});

test('balanced DOI punctuation is preserved', () => {
  const engine = load();
  assert.equal(engine.getDoi('https://doi.org/10.1000/abc(123).'), '10.1000/abc(123)');
  assert.equal(engine.getDoi('(https://doi.org/10.1000/abc).'), '10.1000/abc');
});

test('all candidates are ranked; correct second result is selected', async () => {
  const engine = load(async () => json({ message: { items: [{ ...record, title: ['Completely different research'] }, record] } }));
  const result = await engine.verifyReference(reference);
  assert.equal(result.status, 'verified');
  assert.equal(result.matched.doi, record.DOI);
});

test('comma-delimited title with trailing journal is matched', async () => {
  const engine = load(async () => json({ message: { items: [record] } }));
  const result = await engine.verifyReference(reference.replace('. NAACL.', ', NAACL, 1: 20-30.'));
  assert.equal(result.status, 'verified');
});

test('Crossref 404 falls back to DataCite DOI lookup', async () => {
  const calls = [];
  const engine = load(async url => {
    calls.push(url);
    if (url.includes('api.crossref.org')) return new Response('Resource not found.', { status: 404 });
    if (url.includes('api.datacite.org')) return json({ data: { attributes: { titles: [{ title: record.title[0] }], creators: [{ familyName: 'Devlin', givenName: 'Jacob' }], publicationYear: 2019, doi: '10.48550/arxiv.test', publisher: 'arXiv' } } });
    throw Error('unexpected request');
  });
  const result = await engine.verifyReference(reference + ' https://doi.org/10.48550/arxiv.test');
  assert.equal(result.status, 'verified');
  assert.equal(result.provider, 'DataCite');
  assert.equal(calls.length, 2);
});
test('Crossref DOI lookup preserves the slash in the works path', async () => {
  const urls = [];
  const engine = load(async url => { urls.push(url); return json({ message: { items: [record] } }); });
  await engine.verifyReference(reference + ' https://doi.org/10.53328/inr26rma002');
  assert.ok(urls.some(url => url.includes('/works/10.53328/inr26rma002')));
  assert.ok(!urls.some(url => url.includes('/works/10.53328%2Finr26rma002')));
});

test('wrong DOI does not block title search; proposal never overwrites original', async () => {
  const engine = load(async url => {
    if (url.includes('api.crossref.org/works?')) return json({ message: { items: [record] } });
    if (url.includes('api.openalex.org')) return json({ results: [] });
    return new Response('not found', { status: 404 });
  });
  const raw = reference + ' https://doi.org/10.9999/incorrect';
  const result = await engine.verifyReference(raw);
  assert.equal(result.status, 'review');
  assert.equal(result.corrected, raw);
  assert.ok(result.suggested.includes(record.DOI));
});

test('year or author disagreement requires review', async () => {
  const engine = load(async url => url.includes('api.openalex.org') ? json({ results: [] }) : json({ message: { items: [record] } }));
  for (const raw of [reference.replace('2019', '2021'), reference.replace('Devlin', 'Other')]) {
    const result = await engine.verifyReference(raw);
    assert.equal(result.status, 'review');
    assert.equal(result.corrected, raw);
  }
});

test('empty successful searches are not technical errors', async () => {
  const engine = load(async url => json(url.includes('api.crossref.org') ? { message: { items: [] } } : { results: [] }));
  assert.equal((await engine.verifyReference(reference)).status, 'failed');
});

test('repeated HTTP 429 keeps the same query beyond the old three-attempt limit', async () => {
  let calls = 0;
  const urls = [];
  const engine = load(async url => { urls.push(url); return ++calls <= 4 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : json({ message: { items: [record] } }); });
  const result = await engine.verifyReference(reference);
  assert.equal(result.status, 'verified');
  assert.equal(calls, 5);
  assert.equal(new Set(urls).size, 1);
  assert.equal(result.warnings.length, 0);
});

test('long Retry-After seconds and HTTP dates are fully honored with countdown', async () => {
  for (const header of ['90', new Date(Date.now() + 120000).toUTCString()]) {
    let calls = 0;
    const events = [];
    const engine = load(async () => ++calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': header } }) : json({ ok: true }));
    engine.configure({ onRetry: event => events.push(event) });
    assert.equal((await engine.requestJson('CORE', 'https://example.test/long')).ok, true);
    assert.ok(events[0].remainingMs >= 90000);
    assert.equal(events.at(-1).waiting, false);
    assert.equal(calls, 2);
  }
});

test('missing or invalid Retry-After increases cooldown on repeated quota limits', async () => {
  let calls = 0;
  const delays = [];
  const engine = load(async () => ++calls <= 3 ? new Response('', { status: 429, headers: { 'retry-after': 'invalid' } }) : json({ ok: true }));
  engine.configure({ onRetry: event => { if (event.waiting && !delays[event.count - 1]) delays.push(event.remainingMs); } });
  await engine.requestJson('Semantic Scholar', 'https://example.test/fallback');
  assert.deepEqual(delays, [60000, 120000, 240000]);
});

test('quota waiting can be cancelled promptly and a new run remains usable', async () => {
  const controller = new AbortController();
  let calls = 0;
  const engine = load(async () => ++calls === 1 ? new Response('', { status: 429 }) : json({ message: { items: [record] } }));
  engine.configure({ signal: controller.signal, onRetry: () => controller.abort() });
  await assert.rejects(engine.verifyReference(reference), { name: 'AbortError' });
  assert.equal(calls, 1);
  engine.configure({ signal: null, onRetry: null });
  assert.equal((await engine.verifyReference(reference)).status, 'verified');
});

test('provider queue resumes exact query before processing the next queued query', async () => {
  const urls = [];
  const engine = load(async url => { urls.push(url); return urls.length === 1 ? new Response('', { status: 429, headers: { 'retry-after': '1' } }) : json({ ok: true }); });
  await Promise.all([engine.requestJson('CORE', 'https://example.test/first'), engine.requestJson('CORE', 'https://example.test/second')]);
  assert.deepEqual(urls, ['https://example.test/first', 'https://example.test/first', 'https://example.test/second']);
});

test('deferred quota returns promptly, remembers cooldown and never sends early retries', async () => {
  let calls = 0;
  const engine = load(async () => { calls += 1; return new Response('', { status: 429, headers: { 'retry-after': '60' } }); });
  engine.configure({ deferQuota: true });
  await assert.rejects(engine.requestJson('Semantic Scholar', 'https://example.test/a'), error => error.status === 429 && error.retryAt > Date.now());
  await assert.rejects(engine.requestJson('Semantic Scholar', 'https://example.test/b'), error => error.status === 429 && error.retryAt > Date.now());
  assert.equal(calls, 1);
});

test('Crossref identity with a year discrepancy remains review without Semantic Scholar requests', async () => {
  const calls = [];
  const engine = load(async url => { calls.push(url); return json({ message: { items: [record] } }); });
  engine.configure({ additionalProviders: { route: () => ['Semantic Scholar'], search: () => { throw Error('must not query'); } } });
  const result = await engine.verifyReference(reference.replace('2019', '2021'));
  assert.equal(result.status, 'review');
  assert.equal(result.fallbackNeeded, false);
  assert.ok(result.sourcesChecked.every(id => id === 'Crossref'));
});
test('Crossref title and year identity does not enter the extra-source queue when author formatting differs', async () => {
  const engine = load(async () => json({ message: { items: [record] } }));
  engine.configure({ additionalProviders: { route: () => ['Semantic Scholar'], search: () => { throw Error('must not query'); } } });
  const result = await engine.verifyReference(reference.replace('Devlin, J.', 'Other, J.')); 
  assert.equal(result.status, 'review');
  assert.equal(result.fallbackNeeded, false);
  assert.ok(result.sourcesChecked.every(id => id === 'Crossref'));
});

test('primary phase never queries extra sources for Crossref misses', async () => {
  const engine = load(async () => json({ message: { items: [] } }));
  engine.configure({ additionalProviders: { route: () => ['Semantic Scholar'], search: () => { throw Error('must not query'); } } });
  const result = await engine.verifyReference(reference, { primaryOnly: true });
  assert.equal(result.fallbackNeeded, true);
  assert.deepEqual(Array.from(result.sourcesChecked), ['Crossref']);
});
test('Crossref transient gateway failure does not cascade into every fallback provider', async () => {
  const calls = [];
  const engine = load(async url => { calls.push(url); return new Response('', { status: 502 }); });
  engine.configure({ additionalProviders: { route: () => ['CORE'], search: () => { throw Error('must not query'); } } });
  const result = await engine.verifyReference(reference);
  assert.equal(result.status, 'error');
  assert.ok(result.warnings.every(warning => warning.startsWith('Crossref:')));
  assert.ok(result.reason.includes('ek kaynak sorguları')); 
  assert.equal(calls.every(url => url.includes('api.crossref.org')), true);
});

test('request scheduler respects five DOI requests/s and one search or Semantic Scholar request/s', async () => {
  for (const [provider, prefix, spacing] of [['Crossref', 'https://api.crossref.org/works/10.1000/', 200], ['Crossref', 'https://api.crossref.org/works?q=', 1000], ['Semantic Scholar', 'https://example.test/paper/', 1000]]) {
    let now = 100000;
    const times = [];
    class Clock extends Date { static now() { return now; } }
    const context = { module: { exports: {} }, AbortController, Date: Clock,
      setTimeout: (fn, ms) => ms === 15000 ? setTimeout(fn, ms) : setTimeout(() => { now += ms; fn(); }, 0), clearTimeout,
      fetch: async () => { times.push(now); return json({ ok: true }); } };
    vm.runInNewContext(source, context);
    await Promise.all(Array.from({ length: 6 }, (_, i) => context.module.exports.requestJson(provider, prefix + i)));
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= spacing);
  }
});

test('all 57 primary checks precede fallback; a blocked fallback does not hold other misses', async () => {
  const refs = Array.from({ length: 57 }, (_, i) => `Smith, A. (2020). Research title ${i}. Journal.`);
  const calls = [];
  const elements = new Map();
  let now = 0;
  let retries = 0;
  class Clock extends Date { static now() { return now; } }
  const base = raw => ({ raw, corrected: raw, status: 'verified', statusText: 'Doğrulandı', score: 90, provider: 'Crossref', changes: [], reason: '', fallbackNeeded: false });
  const fakeEngine = { configure() {}, splitReferences: text => text.split('\n'), parseReference: text => ({ title: text }),
    async verifyReference(raw, settings = {}) {
      const index = refs.indexOf(raw);
      calls.push(`${settings.primaryOnly ? 'P' : 'E'}${index}`);
      if (settings.primaryOnly) return { ...base(raw), fallbackNeeded: index === 15 || index === 16 };
      if (index === 15 && ++retries === 1) return { ...base(raw), status: 'error', pendingRetryAt: now + 1000 };
      return base(raw);
    }, async waitForRetry(until) {
      assert.ok(calls.includes('E16'));
      assert.equal(document.querySelector('#output-text').textContent.split('\n\n').length, 57);
      now = until;
    } };
  const document = { querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, { value: '', textContent: '', innerHTML: '', disabled: false, style: {}, classList: { add() {}, remove() {} }, addEventListener() {}, focus() {} });
    return elements.get(selector);
  }, querySelectorAll: () => [] };
  const context = vm.createContext({ document, ReferenceEngine: fakeEngine, navigator: {}, AbortController, Date: Clock });
  vm.runInContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), context);
  document.querySelector('#reference-input').value = refs.join('\n');
  await vm.runInContext('runVerification()', context);
  assert.equal(calls[56], 'P56');
  assert.deepEqual(calls.slice(57), ['E15', 'E16', 'E15']);
  assert.equal(document.querySelector('#progress-value').textContent, '57 / 57');
  assert.equal(document.querySelector('#progress-label').textContent, 'Kontrol tamamlandı');
});

test('transient 429 then success recovers', async () => {
  let calls = 0;
  const engine = load(async () => ++calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : json({ message: { items: [record] } }));
  assert.equal((await engine.verifyReference(reference)).status, 'verified');
  assert.equal(calls, 2);
});

test('UI processes all 61 records and caches duplicate queries', async () => {
  let calls = 0;
  const engine = load(async () => { calls += 1; return json({ message: { items: [record] } }); });
  const elements = new Map();
  const document = { querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, { value: '', textContent: '', innerHTML: '', disabled: false, style: {}, classList: { add() {}, remove() {} }, addEventListener() {}, focus() {} });
    return elements.get(selector);
  }, querySelectorAll: () => [] };
  const context = vm.createContext({ document, ReferenceEngine: engine, navigator: {}, AbortController });
  vm.runInContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), context);
  document.querySelector('#reference-input').value = Array.from({ length: 61 }, (_, i) => `${i + 1}. ${reference}`).join('\n');
  await vm.runInContext('runVerification()', context);
  assert.equal(document.querySelector('#progress-value').textContent, '61 / 61');
  assert.equal(document.querySelector('#output-text').textContent.split('\n\n').length, 61);
  assert.equal(calls, 1);
  assert.equal(document.querySelector('#verify-button').disabled, false);
});

test('batch preserves completed records, shows quota countdown, then continues remaining records', async () => {
  const elements = new Map();
  const labels = [];
  const document = { querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, { value: '', textContent: '', innerHTML: '', disabled: false, style: {}, classList: { add() {}, remove() {} }, addEventListener() {}, focus() {} });
    return elements.get(selector);
  }, querySelectorAll: () => [] };
  Object.defineProperty(document.querySelector('#progress-label'), 'textContent', { set(value) { labels.push(value); }, get() { return labels.at(-1); } });
  let secondCalls = 0;
  const second = reference.replace('Devlin', 'Liu').replace('BERT:', 'RoBERTa:');
  const engine = load(async url => {
    if (url.includes('RoBERTa')) {
      assert.equal(document.querySelector('#progress-value').textContent, '1 / 2');
      assert.ok(document.querySelector('#result-list').innerHTML.includes('Doğrulandı'));
      if (++secondCalls <= 4) return new Response('', { status: 429, headers: { 'retry-after': '1' } });
      return json({ message: { items: [{ ...record, title: [record.title[0].replace('BERT:', 'RoBERTa:')], author: [{ family: 'Liu', given: 'Yinhan' }] }] } });
    }
    return json({ message: { items: [record] } });
  });
  const context = vm.createContext({ document, ReferenceEngine: engine, navigator: {}, AbortController });
  vm.runInContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), context);
  document.querySelector('#reference-input').value = reference + '\n' + second;
  await vm.runInContext('runVerification()', context);
  assert.equal(secondCalls, 5);
  assert.ok(labels.some(label => label.includes('Kayıt 2: Crossref kotası için')));
  assert.equal(labels.at(-1), 'Kontrol tamamlandı');
  assert.equal(document.querySelector('#progress-value').textContent, '2 / 2');
  assert.equal(document.querySelector('#output-text').textContent.split('\n\n').length, 2);
  assert.equal(document.querySelector('#stop-button').disabled, true);
});
