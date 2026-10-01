const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../reference-engine.js');
const item = { title: 'Mapping Destination Images and Behavioral Patterns from User-Generated Photos: A Computer Vision Approach', author: [{ family: 'Zhang', given: 'Kai' }], year: 2020,
  containerTitle: 'Asia Pacific Journal of Tourism Research', volume: '25', issue: '11', pages: '1199–1214', doi: '10.1000/test' };

test('article title uses sentence case including subtitle and hyphenated words', () => {
  assert.equal(engine.sentenceCase(item.title), 'Mapping destination images and behavioral patterns from user-generated photos: A computer vision approach');
  assert.equal(engine.sentenceCase('ATTENTION IS ALL YOU NEED'), 'Attention is all you need');
  assert.equal(engine.sentenceCase('Tourism Research — A Spatial Approach'), 'Tourism research — A spatial approach');
});

test('copy writes italic HTML with matching plain text and falls back if rich clipboard fails', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const path = require('node:path');
  for (const richFails of [false, true]) {
    const elements = new Map();
    const events = new Map();
    const plain = engine.formatApa(item);
    const html = `<p>${engine.formatApaHtml(item)}</p>`;
    const document = { querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, { value: '', textContent: '', innerHTML: '',
        addEventListener: (name, handler) => events.set(selector + ':' + name, handler), querySelectorAll: () => [{ textContent: plain }] });
      return elements.get(selector);
    }, querySelectorAll: () => [] };
    let copied;
    let fallback;
    class Item { constructor(data) { this.data = data; } }
    const context = { document, ReferenceEngine: engine, Blob, ClipboardItem: Item,
      navigator: { clipboard: { write: async values => { if (richFails) throw Error('unsupported'); copied = values[0].data; }, writeText: async value => { fallback = value; } } } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), context);
    document.querySelector('#output-text').innerHTML = html;
    await events.get('#copy-button:click')();
    if (richFails) {
      assert.equal(fallback, plain);
      assert.ok(document.querySelector('#copy-status').textContent.includes('italikler korunamadı'));
    } else {
      assert.equal(await copied['text/html'].text(), html);
      assert.equal(await copied['text/plain'].text(), plain);
    }
  }
});

test('Turkish casing, known proper names, acronyms and scientific mixed case are preserved', () => {
  assert.equal(engine.sentenceCase('TÜRKİYE’DE İÇ TURİZMİN GELİŞİMİ', 'tr'), 'Türkiye’de iç turizmin gelişimi');
  assert.equal(engine.sentenceCase('Mapping Tourism in Los Angeles Using Google Maps and GIS'), 'Mapping tourism in Los Angeles using Google Maps and GIS');
  assert.equal(engine.sentenceCase('BERT: Pre-training of Deep Bidirectional Transformers'), 'BERT: Pre-training of deep bidirectional transformers');
  assert.equal(engine.sentenceCase('Analysis of MDIVis and eDNA Methods'), 'Analysis of MDIVis and eDNA methods');
  assert.equal(engine.sentenceCase('Mapping Places in Atlantis', 'en', ['Atlantis']), 'Mapping places in Atlantis');
});

test('journal title and volume are italic, article title and issue are plain', () => {
  const html = engine.formatApaHtml(item);
  assert.ok(html.includes('<em>Asia Pacific Journal of Tourism Research</em>, <em>25</em>(11), 1199–1214.'));
  assert.ok(!html.includes('<em>Mapping'));
  assert.ok(!html.includes('<em>(11)'));
  assert.equal(html.replace(/<\/?em>/g, ''), engine.formatApa(item));
});

test('books italicize title rather than publisher; title punctuation is not doubled', () => {
  const html = engine.formatApaHtml({ ...item, type: 'book', publisher: 'Publisher', title: 'Start With Why: How Great Leaders Inspire Everyone' });
  assert.ok(html.includes('<em>Start with why: How great leaders inspire everyone</em>. Publisher.'));
  assert.ok(!engine.formatApa({ ...item, title: 'Why Tourism?' }).includes('?.'));
});

test('provider metadata is escaped and cannot inject executable HTML', () => {
  const html = engine.formatApaHtml({ ...item, containerTitle: '<img src=x onerror=alert(1)>', title: 'Study <script>alert(1)</script>', author: [{ literal: '<svg/onload=alert(1)>' }] });
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<svg'));
  assert.ok(html.includes('&lt;img'));
});
