// Plan limits on references: per document, per month, and the number of stored Word/PDF documents.
const test = require('node:test');
const assert = require('node:assert/strict');
const Plans = require('../lib/plans.cjs');
const { harness } = require('./helpers/harness.cjs');
const { makePdf } = require('./pdf-fixture.cjs');

const L = (...t) => t.map((x, i) => [72, 760 - i * 16, x]);
const withReferences = n => makePdf([[...L('Digital transformation in higher education', 'Digital learning platforms increased student engagement in universities during the pandemic years (Smith, 2020).', 'Student engagement was strongly related to the quality of feedback that learners received from their instructors.', 'References', ...Array.from({ length: n }, (_, i) => `Smith, J. (20${10 + i}). Makale ${i + 1}. Dergi, 1(1), 1-9.`))]]).toString('base64');

test('enforce counts what an action adds; 0 means unlimited for the reference limits', () => {
  const plan = Plans.limitsFor('basic').id;
  assert.throws(() => Plans.enforce(plan, 'referencesPerDocument', 0, Plans.limitsFor(plan).referencesPerDocument + 1), e => e.code === 'plan_limit' && /kaynak/.test(e.message));
  Plans.enforce(plan, 'referencesPerDocument', 0, Plans.limitsFor(plan).referencesPerDocument);
  const monthly = Plans.limitsFor(plan).monthlyReferences;
  assert.throws(() => Plans.enforce(plan, 'monthlyReferences', monthly - 5, 6), /bu işlem 6/);
  Plans.enforce(plan, 'monthlyReferences', monthly - 5, 5);
  Plans.enforce(plan, 'monthlyReferences', monthly + 100, 0);
  const saved = { ...Plans.PLANS.basic };
  try { Object.assign(Plans.PLANS.basic, { referencesPerDocument: 0, monthlyReferences: 0, wordDocuments: 0 }); Plans.enforce(plan, 'monthlyReferences', 1e9, 1e9); Plans.enforce(plan, 'wordDocuments', 1e9); }
  finally { Object.assign(Plans.PLANS.basic, saved); }
});

test('admin sets the reference limits per plan; the user sees them with this month\'s use', async () => {
  const h = await harness();
  try {
    const admin = await h.adminClient(), user = await h.register('ece');
    const made = await admin('PUT', '/api/admin/plans/basic', { title: 'Temel', referencesPerDocument: 2, monthlyReferences: 3, wordDocuments: 1 });
    assert.equal(made.status, 200, JSON.stringify(made));
    const plan = (await admin('GET', '/api/admin/plans')).plans.find(p => p.id === 'basic');
    assert.deepEqual([plan.referencesPerDocument, plan.monthlyReferences, plan.wordDocuments], [2, 3, 1]);
    assert.equal((await admin('PUT', '/api/admin/plans/basic', { title: 'Temel', monthlyReferences: -1 })).status, 400);
    const me = await user('GET', '/api/auth/me');
    assert.deepEqual([me.plan.limits.referencesPerDocument, me.plan.limits.monthlyReferences, me.plan.limits.wordDocuments, me.monthReferences], [2, 3, 1, 0]);

    // The second stored document is refused with an upgrade-style error.
    const first = await user('POST', '/api/word/upload', { name: 'a.pdf', data: h.PDF, mode: 'content' });
    assert.ok(first.status < 300, JSON.stringify(first));
    const second = await user('POST', '/api/word/upload', { name: 'b.pdf', data: h.PDF, mode: 'content' });
    assert.equal(second.status, 429); assert.equal(second.code, 'plan_limit'); assert.equal(second.upgrade.limit, 'wordDocuments');
  } finally { await h.close(); }
});

test('a document with more references than the plan allows is not verified', async () => {
  const h = await harness();
  try {
    const admin = await h.adminClient(), user = await h.register('deniz');
    await admin('PUT', '/api/admin/plans/basic', { title: 'Temel', referencesPerDocument: 2, monthlyReferences: 0, wordDocuments: 0 });
    const up = await user('POST', '/api/word/upload', { name: 'r.pdf', data: withReferences(3), mode: 'word' });
    assert.ok(up.status < 300, JSON.stringify(up));
    const id = up.id || up.document?.id || up.state?.id;
    const blocked = await user('POST', `/api/word/${id}/verify`, {});
    assert.equal(blocked.status, 429, JSON.stringify(blocked)); assert.equal(blocked.upgrade.limit, 'referencesPerDocument');
    // Only the queries a run really needs count against the monthly limit.
    await admin('PUT', '/api/admin/plans/basic', { title: 'Temel', referencesPerDocument: 0, monthlyReferences: 2, wordDocuments: 0 });
    const monthly = await user('POST', `/api/word/${id}/verify`, {});
    assert.equal(monthly.status, 429, JSON.stringify(monthly)); assert.equal(monthly.upgrade.limit, 'monthlyReferences'); assert.match(monthly.error, /bu işlem 3/);
  } finally { await h.close(); }
});

test('a reference answered from the shared cache still counts against the monthly quota and does not query the indexes', async () => {
  const h = await harness();
  try {
    const Cache = require('../lib/cache-store.cjs').defaultCache();
    const refs = [0, 1, 2].map(i => `Smith, J. (20${10 + i}). Makale ${i + 1}. Dergi, 1(1), 1-9.`);
    for (const raw of refs) Cache.putVerification(raw, { raw, corrected: raw, status: 'verified', statusText: 'Doğrulandı', score: 1, provider: 'Crossref', matched: { title: 'Makale', doi: '10.1/x' }, changes: [] });
    const admin = await h.adminClient(), user = await h.register('cem');
    await admin('PUT', '/api/admin/plans/basic', { title: 'Temel', referencesPerDocument: 0, monthlyReferences: 4, wordDocuments: 0 });
    const upload = async name => (await user('POST', '/api/word/upload', { name, data: withReferences(3), mode: 'word' })).id;
    const first = await upload('bir.pdf'), second = await upload('iki.pdf');
    const ran = await user('POST', `/api/word/${first}/verify`, {});
    assert.ok(ran.status < 300, JSON.stringify(ran));
    const state = await until(async () => { const r = await user('GET', `/api/word/${first}/state`); return r.references?.every(x => x.verification?.status === 'verified') ? r : null; });
    assert.ok(state.references.every(x => x.verification.cached), 'all three came from the cache');
    const blocked = await user('POST', `/api/word/${second}/verify`, {});
    assert.equal(blocked.status, 429, JSON.stringify(blocked)); assert.equal(blocked.upgrade.limit, 'monthlyReferences'); assert.match(blocked.error, /bu işlem 3/);
    assert.equal((await user('GET', '/api/auth/me')).monthReferences, 3);
  } finally { await h.close(); }
});
async function until(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 50)); } throw Error('timeout'); }
