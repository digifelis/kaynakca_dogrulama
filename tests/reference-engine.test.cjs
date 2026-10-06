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
test('Crossref transient gateway failure falls through to Semantic Scholar and the other sources', async () => {
  const queried = [];
  const engine = load(async () => new Response('', { status: 502 }));
  engine.configure({ additionalProviders: { route: () => ['Semantic Scholar', 'CORE'], search: async id => { queried.push(id); return []; } } });
  const result = await engine.verifyReference(reference);
  assert.deepEqual(queried, ['Semantic Scholar', 'CORE']);
  assert.ok(result.sourcesChecked.includes('Semantic Scholar'));
  assert.ok(result.warnings.some(warning => warning.startsWith('Crossref:')));
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

test('lines holding only a DOI or arXiv link are separate records; a wrapped DOI line stays with its reference', () => {
  const engine = load();
  const ids = ['10.1007/s44443-025-00113-3', 'http://arxiv.org/abs/2603.14170', 'https://doi.org/10.1016/j.is.2021.101967', 'arXiv:2301.00001'];
  assert.deepEqual(Array.from(engine.splitReferences(ids.join('\n'))), ids);
  const wrapped = 'Song, Y. (2025). Legal text summarization. Journal of Law, 37(5), 1–9.\nhttps://doi.org/10.1007/s44443-025-00113-3';
  assert.equal(engine.splitReferences(wrapped).length, 1);
});

test('identifier-only input is recognised; ordinary references are not', () => {
  const engine = load();
  for (const input of ['10.1145/3788646.3789533', 'doi: 10.1016/j.is.2021.101967', 'https://doi.org/10.1109/ICTBIG68706.2025.11323570', 'http://arxiv.org/abs/2603.14170', '10.48550/arXiv.1706.03762']) assert.equal(engine.parseReference(input).idOnly, true, input);
  assert.equal(engine.parseReference('Smith, A. (2020). A title here. https://doi.org/10.1/abc').idOnly, false);
  assert.equal(engine.parseReference('https://example.com/page').idOnly, false);
});

test('a bare DOI is resolved from its Crossref record and formatted as registered', async () => {
  const requests = [];
  const engine = load(async url => {
    requests.push(String(url));
    return json({ message: { type: 'proceedings-article', title: ['Advances in Legal Text Summarization: A Survey'], DOI: '10.1109/ICTBIG68706.2025.11323570',
      author: [{ family: 'Potluri', given: 'Tejaswi' }, { family: 'Motupalli', given: 'Ravikanth' }, { name: 'Legal AI Group' }],
      'container-title': ['2025 IEEE 5th International Conference on ICT in Business Industry &amp;amp; Government (ICTBIG)'], page: '1-8', issued: { 'date-parts': [[2025, 12, 12]] } } });
  });
  const result = await engine.verifyReference('https://doi.org/10.1109/ICTBIG68706.2025.11323570');
  assert.equal(result.status, 'verified');
  assert.equal(result.corrected, 'Potluri, T., Motupalli, R., & Legal AI Group (2025). Advances in Legal Text Summarization: A Survey. 2025 IEEE 5th International Conference on ICT in Business Industry & Government (ICTBIG), 1–8. https://doi.org/10.1109/ICTBIG68706.2025.11323570');
  assert.match(result.correctedHtml, /<em>2025 IEEE 5th International Conference on ICT in Business Industry &amp; Government \(ICTBIG\)<\/em>, 1–8\./);
  assert.equal(requests.length, 1, 'a Crossref identity hit needs no further source');
});

test('a bare journal DOI gets volume and issue; a missing record is reported as not found without title searches', async () => {
  const seen = [];
  const engine = load(async url => {
    seen.push(String(url));
    if (String(url).includes('api.crossref.org/works/10.1007')) return json({ message: { type: 'journal-article', title: ['Legal text summarization via judicial syllogism'], DOI: '10.1007/s44443-025-00113-3',
      author: [{ family: 'Song', given: 'Yumei' }, { family: 'Lin', given: 'Chuan' }], 'container-title': ['Journal of King Saud University Computer and Information Sciences'], volume: '37', issue: '5', 'article-number': '111', issued: { 'date-parts': [[2025, 7]] } } });
    return new Response('', { status: 404 });
  });
  const found = await engine.verifyReference('10.1007/s44443-025-00113-3');
  assert.equal(found.corrected, 'Song, Y., & Lin, C. (2025). Legal text summarization via judicial syllogism. Journal of King Saud University Computer and Information Sciences, 37(5). https://doi.org/10.1007/s44443-025-00113-3');
  seen.length = 0;
  const missing = await engine.verifyReference('10.1234/does-not-exist');
  assert.equal(missing.status, 'failed');
  assert.match(missing.reason, /tanımlayıcıyla kayıt bulunamadı/);
  assert.ok(!seen.some(url => url.includes('query.bibliographic') || url.includes('search=')), seen.join('\n'));
});

test('a bare arXiv link uses the arXiv record, never the web-page path', async () => {
  const engine = load(async () => { throw new Error('no network'); });
  engine.configure({ additionalProviders: {
    route: () => ['arXiv'],
    search: async () => [{ provider: 'arXiv', title: 'Citation-Enforced RAG for Fiscal Document Intelligence', author: [{ family: 'Shanivendra', given: 'Akhil Chandra' }],
      year: 2026, url: 'https://arxiv.org/abs/2603.14170v1', arxiv: '2603.14170', doi: '10.48550/arxiv.2603.14170' }] } });
  const result = await engine.verifyReference('http://arxiv.org/abs/2603.14170 ');
  assert.equal(result.status, 'verified');
  assert.equal(result.corrected, 'Shanivendra, A. C. (2026). Citation-Enforced RAG for Fiscal Document Intelligence. ArXiv, abs/2603.14170.');
});

test('retry button re-queries only service-error records and keeps the others', async () => {
  const doi = '10.18653/v1/n19-1423';
  let failing = true;
  const urls = [];
  const engine = load(async url => {
    urls.push(String(url));
    if (failing) return new Response('', { status: 503 });
    return json({ message: record });
  });
  const elements = new Map();
  const document = { querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, { value: '', textContent: '', innerHTML: '', disabled: false, style: {}, classList: { add() {}, remove() {} }, addEventListener() {}, focus() {} });
    return elements.get(selector);
  }, querySelectorAll: () => [] };
  const context = vm.createContext({ document, ReferenceEngine: engine, navigator: {}, AbortController });
  vm.runInContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), context);
  document.querySelector('#reference-input').value = `Devlin, J. (2019). BERT: Pre-training of deep bidirectional transformers for language understanding. https://doi.org/${doi}`;
  await vm.runInContext('runVerification()', context);
  assert.match(document.querySelector('#summary-stats').innerHTML, /data-filter="error"[^>]*><strong>1</);
  assert.match(document.querySelector('#retry-button').textContent, /\(1\)/);
  failing = false;
  await vm.runInContext('retryUnresolved()', context);
  assert.match(document.querySelector('#summary-stats').innerHTML, /data-filter="verified"[^>]*><strong>1</);
  assert.match(document.querySelector('#retry-button').textContent, /\(0\)/);
  assert.equal(document.querySelector('#verify-button').disabled, false);
  const before = urls.length;
  await vm.runInContext('retryUnresolved()', context);
  assert.equal(urls.length, before, 'nothing unresolved: no new requests');
});

test('Crossref journal articles and conference papers use container-based APA, not publisher', async () => {
  const article = { title: ['Effective deep learning approaches for summarization of legal texts'], author: [{ family: 'Anand', given: 'Deepa' }, { family: 'Wagh', given: 'Rupali' }],
    issued: { 'date-parts': [[2022, 5]] }, DOI: '10.1016/j.jksuci.2019.11.015', 'container-title': ['Journal of King Saud University - Computer and Information Sciences'],
    volume: '34', issue: '5', page: '2141-2150', publisher: 'Springer Science and Business Media LLC', type: 'journal-article' };
  const engine = load(async () => json({ message: article }));
  const result = await engine.verifyReference('Anand, D., & Wagh, R. (2022). Effective deep learning approaches for summarization of legal texts. https://doi.org/10.1016/j.jksuci.2019.11.015');
  assert.equal(result.suggested, 'Anand, D., & Wagh, R. (2022). Effective deep learning approaches for summarization of legal texts. Journal of King Saud University - Computer and Information Sciences, 34(5), 2141–2150. https://doi.org/10.1016/j.jksuci.2019.11.015');
});

test('Crossref year: issue date, then published-online/print, issued, created; none stays undated', async () => {
  const year = async raw => { const engine = load(async () => json({ message: { title: ['Example title of work'], author: [{ family: 'Smith', given: 'A' }], DOI: '10.1234/x', ...raw } }));
    return (await engine.verifyReference('Smith, A. (2000). Example title of work. https://doi.org/10.1234/x')).matched.year; };
  assert.equal(await year({ 'journal-issue': { 'published-online': { 'date-parts': [[2023, 1]] } }, 'published-online': { 'date-parts': [[2022, 12, 27]] }, issued: { 'date-parts': [[2022, 12, 27]] } }), 2023);
  assert.equal(await year({ 'published-print': { 'date-parts': [[2021]] }, 'published-online': { 'date-parts': [[2020]] }, issued: { 'date-parts': [[2019]] } }), 2020);
  assert.equal(await year({ 'published-print': { 'date-parts': [[2021]] }, issued: { 'date-parts': [[2019]] } }), 2021);
  assert.equal(await year({ issued: { 'date-parts': [[2019]] }, created: { 'date-parts': [[2018]] } }), 2019);
  assert.equal(await year({ created: { 'date-parts': [[2018]] } }), 2018);
  assert.equal(await year({}), null);
});
