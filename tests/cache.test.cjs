// The shared cache of public lookups: what it keeps, what it refuses, expiry, and that cached references skip the indexes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCache } = require('../lib/cache-store.cjs');
const Verification = require('../lib/verification.cjs');

const setup = () => { const clock = { t: Date.UTC(2026, 9, 3) }; const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-')); return { dir, clock, cache: createCache(dir, () => clock.t) }; };
const VERIFIED = { raw: 'Smith, J. (2020). Title. Journal, 1(1), 1-9.', status: 'verified', provider: 'Crossref', matched: { doi: '10.1/x' }, score: 1 };

test('only final verified or review records are kept; whitespace and case do not matter; the file is created on first write', () => {
  const { cache, dir } = setup();
  assert.equal(fs.existsSync(path.join(dir, 'cache.db')), false); assert.equal(cache.getVerification('Smith'), null); assert.equal(fs.existsSync(path.join(dir, 'cache.db')), false, 'reading creates nothing');
  assert.equal(cache.putVerification(VERIFIED.raw, VERIFIED), true);
  assert.deepEqual(cache.getVerification('  smith, J.  (2020).  TITLE. Journal, 1(1), 1-9. ').matched, { doi: '10.1/x' });
  for (const bad of [{ ...VERIFIED, status: 'not_found' }, { ...VERIFIED, status: 'error' }, { ...VERIFIED, pendingRetryAt: Date.now() + 1000 }, { ...VERIFIED, fallbackNeeded: true }, { ...VERIFIED, pendingProviders: [{}] }]) assert.equal(cache.putVerification('başka kayıt', bad), false);
  assert.equal(cache.getVerification('başka kayıt'), null);
});

test('entries expire (verified later than review) and expired ones are pruned', () => {
  const { cache, clock } = setup();
  cache.putVerification('a', VERIFIED); cache.putVerification('b', { ...VERIFIED, status: 'review' });
  clock.t += 15 * 86400000; assert.ok(cache.getVerification('a')); assert.equal(cache.getVerification('b'), null, 'review records last 14 days');
  clock.t += 80 * 86400000; assert.equal(cache.getVerification('a'), null, 'verified records last 90 days');
  cache.prune(); assert.equal(cache.stats().kinds.reduce((n, k) => n + k.entries, 0), 0);
});

test('full texts, extractions and embeddings round-trip; unconfirmed texts and abstract-only texts are handled', () => {
  const { cache, clock } = setup();
  const text = { title: 'T', passages: [{ location: 'p1', text: 'gövde metni' }], access: 'Açık erişim' };
  assert.equal(cache.putFullText('doi:10.1/x', { ...text, needsConfirmation: true }), false, 'a text waiting for a user confirmation is never shared');
  assert.equal(cache.putFullText('doi:10.1/x', text), true); assert.equal(cache.getFullText('doi:10.1/x').passages[0].text, 'gövde metni'); assert.equal(cache.getFullText('doi:10.1/y'), null);
  cache.putFullText('doi:abs', { ...text, abstractOnly: true }); clock.t += 4 * 86400000; assert.equal(cache.getFullText('doi:abs'), null, 'an abstract-only text is retried after 3 days'); assert.ok(cache.getFullText('doi:10.1/x'));
  assert.equal(cache.putExtraction('scholar:a', { paragraphs: [] }), false); assert.equal(cache.putExtraction('scholar:a', { paragraphs: [{ text: 'x' }], metadata: { pages: 3 } }), true); assert.equal(cache.getExtraction('scholar:a').metadata.pages, 3);
  cache.putEmbeddings('m1', [['merhaba dünya', [0.5, -0.25, 1]], ['ikinci', [1, 2, 3]]]);
  const hits = cache.getEmbeddings('m1', ['merhaba dünya', 'yok', 'ikinci']);
  assert.deepEqual([...hits.keys()], [0, 2]); assert.deepEqual([...hits.get(0)], [0.5, -0.25, 1]); assert.equal(cache.getEmbeddings('m2', ['merhaba dünya']).size, 0, 'another model never reuses vectors');
  const stats = cache.stats(); assert.ok(stats.kinds.find(k => k.kind === 'embedding').entries === 2 && stats.kinds.find(k => k.kind === 'fulltext').hits >= 1);
  assert.equal(cache.clear('embedding'), 2); assert.ok(cache.clear() >= 1); assert.equal(cache.getFullText('doi:10.1/x'), null);
});

test('CACHE_ENABLED=false turns it off completely', () => {
  const { cache } = setup(); process.env.CACHE_ENABLED = 'false';
  try { assert.equal(cache.putVerification('a', VERIFIED), false); assert.equal(cache.getVerification('a'), null); } finally { delete process.env.CACHE_ENABLED; }
  assert.equal(cache.getVerification('a'), null, 'nothing was stored while it was off');
});

test('a cached record is a final result: the orchestrator reuses it without asking the indexes', async () => {
  const { cache } = setup(); cache.putVerification(VERIFIED.raw, VERIFIED);
  const hit = { ...cache.getVerification(VERIFIED.raw), fromCache: true };
  assert.equal(Verification.reusableResult(hit), true);
  const asked = [], emitted = [];
  await Verification.orchestrate({ references: [VERIFIED.raw, 'Yeni kayıt'], initialResults: [hit, undefined], verify: async i => { asked.push(i); return { raw: 'Yeni kayıt', status: 'verified' }; }, emit: m => emitted.push(m), parallel: 1 });
  assert.deepEqual(asked, [1], 'only the reference that was not cached is looked up');
  assert.equal(emitted.filter(m => m.type === 'result').length, 2);
});

test('additional sources are tried right away even while Crossref is waiting for quota', async () => {
  const calls = [];
  const waits = [];
  await Verification.orchestrate({
    references: ['A'],
    verify: async (i, options) => {
      calls.push(options.primaryOnly ? 'primary' : 'fallback');
      if (options.primaryOnly) return { raw: 'A', status: 'error', fallbackNeeded: true, pendingRetryAt: Date.now() + 600000 };
      return { raw: 'A', status: 'verified', fallbackNeeded: false };
    },
    emit() {}, wait: async ms => { waits.push(ms); },
  });
  assert.deepEqual(calls, ['primary', 'fallback']);
  assert.deepEqual(waits, []);
});
