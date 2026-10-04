const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/harness.cjs');
const Plans = require('../lib/plans.cjs');

const GOOD = 'Guclu-Parola-2026';

test('plans carry the areas they open: defaults, admin editing and validation', async () => {
  const h = await harness({ openAreas: false });
  try {
    const admin = await h.adminClient();
    const list = (await admin('GET', '/api/admin/plans')).plans;
    assert.deepEqual(list.find(p => p.id === 'basic').features, ['reference', 'orphan']);
    assert.deepEqual(list.find(p => p.id === 'premium').features, ['reference', 'orphan', 'content', 'export', 'web']);
    assert.deepEqual(list.find(p => p.id === 'gold').features, Plans.FEATURE_IDS);
    const saved = await admin('PUT', '/api/admin/plans/basic', { features: ['reference', 'orphan', 'export'] });
    assert.equal(saved.status, 200); assert.deepEqual(saved.plan.features, ['reference', 'orphan', 'export']);
    assert.equal((await admin('PUT', '/api/admin/plans/basic', { features: ['reference', 'nonsense'] })).status, 400);
    // a plan edited without sending the list keeps it
    assert.deepEqual((await admin('PUT', '/api/admin/plans/basic', { title: 'Temel' })).plan.features, ['reference', 'orphan', 'export']);
    // a new plan without a list starts with the basic areas
    const created = await admin('POST', '/api/admin/plans', { id: 'ozel', title: 'Özel', projects: 5, documentsPerProject: 5, documentBytes: 1048576, questionsPerDay: 5 });
    assert.equal(created.status, 201); assert.deepEqual(created.plan.features, ['reference', 'orphan']);
  } finally { await h.close(); }
});

test('the session lists the areas of the plan; administrators have all of them', async () => {
  const h = await harness({ openAreas: false });
  try {
    const user = await h.register('ali'), admin = await h.adminClient();
    assert.deepEqual((await user('GET', '/api/auth/me')).user.features, ['reference', 'orphan']);
    assert.deepEqual((await admin('GET', '/api/auth/me')).user.features, Plans.FEATURE_IDS);
  } finally { await h.close(); }
});

test('the writing assistant: refused without the area, stored data stays readable, administrators are never held back', async () => {
  const h = await harness({ openAreas: false });
  try {
    const admin = await h.adminClient(), user = await h.register('burak');
    const id = (await admin('GET', '/api/admin/users?search=burak')).users[0].id;
    assert.equal((await admin('PATCH', '/api/admin/users/' + id, { planId: 'gold' })).status, 200);
    const gold = await h.login('burak', GOOD);
    const { project } = await gold('POST', '/api/writer/projects', { title: 'Önceki' });
    assert.ok(project.id);
    // the plan is lowered: nothing new, but what exists is still there
    assert.equal((await admin('PATCH', '/api/admin/users/' + id, { planId: 'basic' })).status, 200);
    const low = await h.login('burak', GOOD);
    const refused = await low('POST', '/api/writer/projects', { title: 'Yeni' });
    assert.equal(refused.status, 403); assert.equal(refused.code, 'plan_feature'); assert.equal(refused.upgrade.feature, 'writer'); assert.equal(refused.upgrade.nextPlan, 'gold');
    assert.match(refused.error, /Yazım yardımcısı/);
    assert.equal((await low('POST', `/api/writer/projects/${project.id}/ask`, { question: 'Soru?', skill: 'genel' })).status, 403);
    assert.ok((await low('GET', '/api/writer/projects')).projects.some(p => p.id === project.id), 'stored projects can still be read');
    assert.equal((await low('DELETE', `/api/writer/projects/${project.id}`)).status, 200, 'and deleted');
    // an administrator needs no area
    assert.equal((await admin('POST', '/api/writer/projects', { title: 'Yönetici' })).status, 201);
    void user;
  } finally { await h.close(); }
});

test('Semantic Scholar and the manuscript download are separate areas', async () => {
  const h = await harness({ openAreas: false });
  try {
    const admin = await h.adminClient(), user = await h.register('cem');
    // writer without scholar and export
    assert.equal((await admin('PUT', '/api/admin/plans/basic', { features: ['reference', 'orphan', 'writer'] })).status, 200);
    const search = await user('GET', '/api/writer/scholar/search?q=iklim');
    assert.equal(search.status, 403); assert.equal(search.upgrade.feature, 'scholar'); assert.equal(search.upgrade.nextPlan, 'gold');
    const { project } = await user('POST', '/api/writer/projects', { title: 'P' });
    const docx = await user('GET', `/api/writer/projects/${project.id}/manuscript.docx`);
    assert.equal(docx.status, 403); assert.equal(docx.upgrade.feature, 'export');
    const boot = await user('GET', '/api/writer/bootstrap');
    assert.equal(boot.services.scholar, false); assert.deepEqual(boot.features, ['reference', 'orphan', 'writer']);
  } finally { await h.close(); }
});

test('Word and content checks follow the areas: orphan/reference open the Word page, content opens the content page, export the download', async () => {
  const h = await harness({ openAreas: false });
  try {
    const user = await h.register('derya');
    const content = await user('POST', '/api/word/upload', { name: 'a.pdf', data: h.PDF, mode: 'content' });
    assert.equal(content.status, 403); assert.equal(content.code, 'plan_feature'); assert.equal(content.upgrade.feature, 'content'); assert.equal(content.upgrade.nextPlan, 'premium');
    const word = await user('POST', '/api/word/upload', { name: 'a.pdf', data: h.PDF, mode: 'word' });
    assert.ok(word.status < 300, JSON.stringify(word));
    const wordId = word.id || word.document?.id || word.snapshot?.id;
    assert.ok(wordId, JSON.stringify(word));
    const download = await user('GET', `/api/word/${wordId}/download`);
    assert.equal(download.status, 403); assert.equal(download.upgrade.feature, 'export');
    // nothing left of the Word page for a plan without both areas
    const admin = await h.adminClient();
    assert.equal((await admin('PUT', '/api/admin/plans/basic', { features: ['writer'] })).status, 200);
    const none = await user('POST', '/api/word/upload', { name: 'b.pdf', data: h.PDF, mode: 'word' });
    assert.equal(none.status, 403); assert.equal(none.upgrade.feature, 'orphan');
  } finally { await h.close(); }
});

test('the bibliography page: refused for a signed-in plan without the area; web sources are switched off by the plan', async () => {
  const h = await harness({ openAreas: false });
  try {
    const user = await h.register('ece'), admin = await h.adminClient();
    const started = await user('POST', '/api/verify-batches', { references: ['Smith, J. (2021). A study of things. Journal of Things, 1(1), 1–10.'] });
    assert.equal(started.status, 201, JSON.stringify(started));
    await user('POST', `/api/verify-batches/${started.id}/stop`, {});
    // web verification belongs to premium: the browser's own web request is refused for basic
    const web = await user('GET', '/api/web-reference?url=' + encodeURIComponent('https://example.org/'));
    assert.equal(web.status, 403); assert.equal(web.upgrade.feature, 'web');
    assert.equal((await admin('PUT', '/api/admin/plans/basic', { features: ['orphan'] })).status, 200);
    const blocked = await user('POST', '/api/verify-batches', { references: ['Smith, J. (2021). A study of things.'] });
    assert.equal(blocked.status, 403); assert.equal(blocked.upgrade.feature, 'reference');
    // the public page (no session) is not held to any plan
    const anonymous = h.client();
    assert.equal((await anonymous('POST', '/api/verify-batches', { references: ['Smith, J. (2021). A study of things.'] })).status, 201);
  } finally { await h.close(); }
});

test('without accounts every area is open and the web option reaches the engine', () => {
  const engine = require('../reference-engine.js');
  assert.equal(typeof engine.verifyReference, 'function');
  return engine.verifyReference('Ulusal Meteoroloji Servisi. (2020). Yağış verileri. https://example.org/veri', { web: false }).then(result => {
    assert.match(JSON.stringify(result), /paketinizde bulunmuyor/);
  });
});
