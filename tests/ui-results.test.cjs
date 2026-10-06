const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const appSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const engineSource = fs.readFileSync(path.join(__dirname, '../reference-engine.js'), 'utf8');

function fixture(engine, extra = {}) {
  const elements = new Map();
  const events = new Map();
  const document = { querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, { value: '', textContent: '', innerHTML: '', disabled: false, style: {}, classList: { add() {}, remove() {} }, focus() {},
      addEventListener: (name, handler) => events.set(`${selector}:${name}`, handler) });
    return elements.get(selector);
  }, querySelectorAll: () => [] };
  const context = vm.createContext({ document, ReferenceEngine: engine, navigator: {}, AbortController, ...extra });
  vm.runInContext(appSource, context);
  return { context, document, events };
}
const result = (raw, status) => ({ raw, corrected: raw, status, statusText: status, score: 90, provider: 'Crossref', changes: [], reason: '' });
test('web draft survives rerender and applies the edited text only on click', () => {
  const { context, document, events } = fixture(require('../reference-engine.js'));
  context.rows = [{ ...result('Original', 'review'), type: 'web', suggested: 'Proposal' }, { ...result('Complete', 'verified'), type: 'web' }];
  vm.runInContext('renderResults(rows); renderOutput(rows)', context);
  assert.equal((document.querySelector('#result-list').innerHTML.match(/<textarea/g) || []).length, 1);
  events.get('#result-list:input')({ target: { closest: () => ({ dataset: { webDraft: '0' }, value: 'My edit </textarea><script>bad</script>' }) } });
  vm.runInContext('renderResults(rows)', context);
  assert.ok(document.querySelector('#result-list').innerHTML.includes('My edit &lt;/textarea&gt;'));
  assert.equal(document.querySelector('#output-text').textContent, 'Original\n\nComplete');
  vm.runInContext('applySuggestion(0)', context);
  assert.ok(document.querySelector('#output-text').textContent.startsWith('My edit'));
  assert.ok(!document.querySelector('#output-text').innerHTML.includes('<script>'));
  vm.runInContext('applySuggestion(0)', context);
  assert.equal(document.querySelector('#output-text').textContent, 'Original\n\nComplete');
});

test('web evidence renders safely and accepted web suggestion preserves formatted output', () => {
  const Web = require('../web-reference.js');
  const { context, document } = fixture(require('../reference-engine.js'), { ReferenceWeb: Web });
  context.rows = [Web.compare('Company. (2026). Office water. https://example.org/blog', {
    state: 'ok', title: 'Office water', authors: [{ name: 'Elizabeth Smith', type: 'Person' }], published: '2025-03-26', site: 'Example', url: 'https://example.org/blog',
    evidence: [{ field: 'Yazar', source: 'meta author', value: '<script>bad</script>' }],
  })];
  vm.runInContext('renderResults(rows); renderOutput(rows);', context);
  let html = document.querySelector('#result-list').innerHTML;
  assert.ok(html.includes('Web künye kanıtları')); assert.ok(html.includes('Yayın tarihi'));
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('null/100'));
  assert.ok(html.includes('Web’de ara'));
  vm.runInContext('applySuggestion(0)', context);
  assert.ok(document.querySelector('#output-text').innerHTML.includes('<em>Office water</em>'));
  vm.runInContext('applySuggestion(0)', context);
  assert.equal(document.querySelector('#output-text').textContent, context.rows[0].raw);
});

test('summary clicks filter by status, preserve numbering and keep the full bibliography', () => {
  const { context, document, events } = fixture(require('../reference-engine.js'));
  context.rows = [result('First', 'verified'), result('Second', 'review'), result('Third', 'pending')];
  vm.runInContext('renderSummary(rows); renderResults(rows); renderOutput(rows);', context);
  const click = status => events.get('#summary-stats:click')({ target: { closest: () => ({ dataset: { filter: status } }) } });
  click('review');
  assert.equal((document.querySelector('#result-list').innerHTML.match(/class="result-card/g) || []).length, 1);
  assert.ok(document.querySelector('#result-list').innerHTML.includes('>02</span>'));
  assert.ok(!document.querySelector('#result-list').innerHTML.includes('First'));
  assert.equal(document.querySelector('#output-text').textContent, 'First\n\nSecond\n\nThird');
  context.rows[2].status = 'review';
  vm.runInContext('renderSummary(rows); renderResults(rows);', context);
  assert.equal((document.querySelector('#result-list').innerHTML.match(/class="result-card/g) || []).length, 2);
  assert.ok(document.querySelector('#summary-stats').innerHTML.includes('data-filter="review" aria-pressed="true"'));
  click('error');
  assert.ok(document.querySelector('#result-list').innerHTML.includes('Bu kategoride kayıt bulunmuyor'));
  click('all');
  assert.equal((document.querySelector('#result-list').innerHTML.match(/class="result-card/g) || []).length, 3);
});

test('real quota response resumes after reset and sends other queued records first', async () => {
  let now = Date.now();
  const coreCalls = [];
  let alphaCalls = 0;
  class Clock extends Date { static now() { return now; } }
  const context = { module: { exports: {} }, Date: Clock, AbortController,
    setTimeout: (fn, ms) => ms === 15000 ? setTimeout(fn, ms) : setTimeout(() => { now += ms; fn(); }, 0), clearTimeout,
    ReferenceProviders: { route: () => ['CORE'], async search(id, parsed, request) {
      const data = await request(id, 'https://example.test/' + (parsed.title.includes('Alpha') ? 'alpha' : 'beta'));
      return data?.ok ? [{ provider: id, title: parsed.title, author: [{ family: parsed.firstAuthor }], year: parsed.year }] : [];
    } },
    fetch: async url => {
      if (url.includes('api.crossref')) return new Response('{"message":{"items":[]}}');
      if (url.includes('api.openalex')) return new Response('{"results":[]}');
      const id = url.endsWith('alpha') ? 'alpha' : 'beta';
      coreCalls.push({ id, at: now });
      if (id === 'alpha' && ++alphaCalls === 1) return new Response('', { status: 429, headers: { 'retry-after': '2' } });
      return new Response('{"ok":true}');
    } };
  vm.runInNewContext(engineSource, context);
  const f = fixture(context.module.exports, { Date: Clock });
  f.document.querySelector('#reference-input').value = 'Smith, A. (2020). Alpha research study.\nJones, B. (2020). Beta research study.';
  await vm.runInContext('runVerification()', f.context);
  assert.deepEqual(coreCalls.map(call => call.id), ['alpha', 'beta', 'alpha']);
  assert.ok(coreCalls[1].at - coreCalls[0].at >= 2000);
  assert.equal(alphaCalls, 2);
  assert.equal(f.document.querySelector('#progress-label').textContent, 'Kontrol tamamlandı');
  assert.ok(!f.document.querySelector('#result-list').innerHTML.includes('Kota bekleniyor'));
  assert.ok(f.document.querySelector('#summary-stats').innerHTML.includes('2 doğrulandı: sonuçları göster'));
});

test('pending card exposes provider, retry time, retry count and actual last query', () => {
  const f = fixture(require('../reference-engine.js'));
  f.context.rows = [{ ...result('Pending', 'pending'), pendingRetryAt: Date.now() + 30000, pendingProviders: [{ provider: 'CORE', retryAt: Date.now() + 30000 }], retryCount: 2, lastQuery: { provider: 'CORE', at: Date.now() } }];
  vm.runInContext('renderResults(rows)', f.context);
  const html = f.document.querySelector('#result-list').innerHTML;
  assert.ok(html.includes('Bekleyen servis: CORE'));
  assert.ok(html.includes('Sonraki deneme: <time'));
  assert.ok(html.includes('Yeniden kontrol sayısı: 2'));
  assert.ok(html.includes('Son dış sorgu: CORE'));
});

test('apply suggestion updates only its original row, preserves italics and can be reverted', () => {
  const f = fixture(require('../reference-engine.js'));
  f.context.rows = [result('First', 'verified'), { ...result('Original second', 'review'), suggested: 'Corrected second. Journal.', suggestedHtml: 'Corrected second. <em>Journal</em>.' }, result('Third', 'pending')];
  vm.runInContext('renderSummary(rows); renderResults(rows); renderOutput(rows); setResultFilter("review");', f.context);
  const click = index => f.events.get('#result-list:click')({ target: { closest: () => ({ dataset: { applySuggestion: String(index) } }) } });
  click(1);
  assert.equal(f.document.querySelector('#output-text').textContent, 'First\n\nCorrected second. Journal.\n\nThird');
  assert.ok(f.document.querySelector('#output-text').innerHTML.includes('<em>Journal</em>'));
  assert.equal(f.context.rows[1].status, 'review');
  assert.equal(f.context.rows[1].raw, 'Original second');
  assert.ok(f.document.querySelector('#result-list').innerHTML.includes('Özgün kayda dön'));
  assert.ok(f.document.querySelector('#result-list').innerHTML.includes('data-apply-suggestion="1"'));
  f.context.rows[2] = result('Third changed by background verification', 'verified');
  vm.runInContext('renderResults(rows); renderOutput(rows);', f.context);
  assert.ok(f.document.querySelector('#output-text').textContent.includes('Corrected second'));
  click(1);
  assert.equal(f.document.querySelector('#output-text').textContent, 'First\n\nOriginal second\n\nThird changed by background verification');
  click(0);
  assert.equal(f.context.rows[0].appliedSuggestion, undefined);
});

test('Scholar buttons use encoded original title/author/year and appear only for unverified records', () => {
  const f = fixture(require('../reference-engine.js'));
  f.context.rows = [result('Verified', 'verified'), result('Smith, A. (2020). A study of education & learning. Journal.', 'failed'), result('<img src=x onerror=alert(1)>', 'error'), { ...result('Review', 'review'), suggested: 'Review suggestion' }, result('Waiting', 'pending')];
  vm.runInContext('renderResults(rows)', f.context);
  const html = f.document.querySelector('#result-list').innerHTML;
  assert.equal((html.match(/class="result-action scholar-search"/g) || []).length, 4);
  const url = vm.runInContext('scholarSearchUrl(rows[1])', f.context);
  assert.equal(new URL(url).hostname, 'scholar.google.com');
  assert.equal(new URL(url).searchParams.get('q'), 'A study of education & learning Smith 2020');
  assert.ok(html.includes('target="_blank" rel="noopener noreferrer"'));
  assert.ok(!html.includes('<img'));
  assert.equal((html.match(/data-apply-suggestion=/g) || []).length, 1);
});

test('choosing IEEE or Vancouver rewrites the corrected bibliography in that style, numbered', async () => {
  const engine = require('../reference-engine.js');
  const { context, document, events } = fixture(engine);
  const matched = { provider: 'Crossref', title: 'Deep learning', author: [{ family: 'LeCun', given: 'Yann' }], year: 2015, doi: '10.1038/nature14539', containerTitle: 'Nature', volume: '521', issue: '7553', pages: '436-444' };
  context.rows = [{ ...result('LeCun, Y. (2015). Deep learning. Nature.', 'verified'), corrected: 'APA TEXT', matched }];
  assert.equal(typeof events.get('#style-select:change'), 'function', 'style selector must be wired at load');
  const select = document.querySelector('#style-select');
  for (const [style, prefix] of [['ieee', '[1] '], ['vancouver', '1. ']]) {
    select.value = style;
    vm.runInContext('displayedResults = rows', context);
    events.get('#style-select:change')();
    const text = document.querySelector('#output-text').textContent;
    assert.ok(text.startsWith(prefix), `${style}: ${text}`);
    assert.ok(!text.includes('APA TEXT'));
  }
  select.value = 'apa';
  events.get('#style-select:change')();
  assert.equal(document.querySelector('#output-text').textContent, 'APA TEXT');
});
