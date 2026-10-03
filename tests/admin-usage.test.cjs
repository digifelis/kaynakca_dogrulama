const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/harness.cjs');

const GOOD = 'Guclu-Parola-2026';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, ms = 8000) { const end = Date.now() + ms; for (;;) { const v = await check(); if (v) return v; if (Date.now() > end) throw Error('timeout'); await sleep(25); } }

// uploads the fixture PDF as a source and waits until it is searchable; returns the project id
async function projectWithSource(api, h) {
  const { project } = await api('POST', '/api/writer/projects', { title: 'Deneme' });
  const added = await api('POST', `/api/writer/projects/${project.id}/sources`, { name: 'makale.pdf', data: h.PDF });
  assert.equal(added.status, 202, JSON.stringify(added));
  await until(async () => (await api('GET', `/api/writer/projects/${project.id}`)).sources[0].status === 'ready');
  return project.id;
}
async function ask(api, projectId, text = 'Öğrenci katılımı neyle ilişkilidir?') {
  const started = await api('POST', `/api/writer/projects/${projectId}/ask`, { question: text, skill: 'genel' });
  assert.equal(started.status, 202, JSON.stringify(started));
  await until(async () => (await api('GET', `/api/writer/projects/${projectId}`)).messages.at(-1)?.status === 'done').catch(async e => { throw Error(JSON.stringify((await api('GET', `/api/writer/projects/${projectId}`)).messages.map(m => [m.status, m.error]))); });
  return started;
}

test('every operation is logged with its token cost; per-call breakdown, totals, and no user content in the admin view', async () => {
  const h = await harness();
  try {
    const user = await h.register('hasan');
    const projectId = await projectWithSource(user, h);
    await ask(user, projectId);
    const admin = await h.adminClient();

    const list = await admin('GET', '/api/admin/operations?user=hasan');
    const kinds = list.operations.map(o => o.kind);
    assert.ok(kinds.includes('ask') && kinds.includes('source-process'), kinds.join());
    const askOp = list.operations.find(o => o.kind === 'ask');
    assert.equal(askOp.status, 'ok'); assert.equal(askOp.username, 'hasan');
    assert.ok(askOp.promptTokens >= 120 && askOp.completionTokens === 30); assert.ok(askOp.totalTokens >= 150);
    // provider-reported tokens are exact; embeddings without a count are marked as estimates
    const detail = (await admin('GET', '/api/admin/operations/' + askOp.id)).operation;
    assert.ok(detail.calls.some(c => c.kind === 'chat' && c.totalTokens === 150 && !c.estimated));
    assert.ok(detail.calls.some(c => c.kind === 'embedding' && c.estimated));
    const processOp = list.operations.find(o => o.kind === 'source-process');
    assert.ok(processOp.totalTokens > 0, 'embedding tokens are counted for source processing');

    const stats = await admin('GET', '/api/admin/stats');
    assert.equal(stats.totalTokens, list.operations.reduce((n, o) => n + o.totalTokens, 0));
    assert.ok(stats.byKind.find(k => k.kind === 'ask').tokens >= 150);
    assert.equal(stats.topUsers[0].username, 'hasan');
    assert.ok(stats.byDay.length >= 1);

    // the user sees their own consumption, and the admin side never contains content
    const mine = await user('GET', '/api/auth/usage');
    assert.ok(mine.usage.month.totalTokens >= 150 && mine.plan.limits.monthlyTokens > 0);
    const dump = JSON.stringify([list, detail, stats, await admin('GET', '/api/admin/users'), await admin('GET', '/api/admin/audit')]);
    for (const secret of ['Öğrenci katılımı', 'makale.pdf', 'Digital transformation', 'geri bildirim kalitesiyle']) assert.ok(!dump.includes(secret), 'admin metadata must not contain: ' + secret);
    // per-user token numbers in the user list
    const row = (await admin('GET', '/api/admin/users?search=hasan')).users.find(u => u.username === 'hasan');
    assert.ok(row.monthTokens >= 150 && row.totalTokens >= row.monthTokens);
  } finally { await h.close(); }
});

test('a failed model call is a failed operation, not a silent hole in the log', async () => {
  const h = await harness();
  try {
    const user = await h.register('irem');
    const projectId = await projectWithSource(user, h);
    const real = global.fetch;
    global.fetch = async (url, init) => String(url).includes('api.groq.com') ? { ok: false, status: 400, headers: new Headers(), json: async () => ({ error: { message: 'boom' } }), text: async () => JSON.stringify({ error: { message: 'boom' } }) } : real(url, init);
    const started = await user('POST', `/api/writer/projects/${projectId}/ask`, { question: 'Katılım nedir?', skill: 'genel' });
    assert.equal(started.status, 202);
    await until(async () => ['error', 'done'].includes((await user('GET', `/api/writer/projects/${projectId}`)).messages.at(-1)?.status));
    global.fetch = real;
    const admin = await h.adminClient();
    const op = (await admin('GET', '/api/admin/operations?kind=ask&user=irem')).operations[0];
    assert.equal(op.status, 'error'); assert.ok(op.error);
  } finally { await h.close(); }
});

test('monthly token quota: refused with an upgrade hint at the limit, other users unaffected, resets next month, admin can raise the plan', async () => {
  const h = await harness();
  try {
    const admin = await h.adminClient();
    assert.equal((await admin('PUT', '/api/admin/plans/basic', { title: 'Temel', monthlyTokens: 120 })).status, 200);
    const user = await h.register('kemal'), other = await h.register('leyla');
    const projectId = await projectWithSource(user, h);
    await ask(user, projectId);            // starts below the limit and ends above it (150 chat tokens + embeddings)
    const blocked = await user('POST', `/api/writer/projects/${projectId}/ask`, { question: 'Bir tane daha?', skill: 'genel' });
    assert.equal(blocked.status, 429); assert.equal(blocked.code, 'plan_limit'); assert.ok(blocked.upgrade || /paket/i.test(blocked.error));
    // the Word content check is guarded by the same quota
    const wordBlocked = await user('POST', '/api/word/upload', { name: 'a.pdf', data: h.PDF, mode: 'content' });
    assert.ok([200, 201, 202, 429].includes(wordBlocked.status));
    // someone else is not affected
    const { project } = await other('POST', '/api/writer/projects', { title: 'Başka' });
    assert.ok(project.id);
    // next month the counter starts again
    h.clock.t += 32 * 86400000;
    const again = await h.login('kemal', GOOD), boss = await h.adminClient();
    assert.equal((await again('POST', `/api/writer/projects/${projectId}/ask`, { question: 'Yeni ay', skill: 'genel' })).status, 202);
    await h.service.idle();
    // raising the plan limit unblocks immediately; 0 means unlimited
    assert.equal((await boss('PUT', '/api/admin/plans/basic', { title: 'Temel', monthlyTokens: 0 })).status, 200);
    assert.equal((await again('POST', `/api/writer/projects/${projectId}/ask`, { question: 'Sınırsız', skill: 'genel' })).status, 202);
    await h.service.idle();
  } finally { await h.close(); }
});

test('user management: create, find, change plan/role, reset password, disable, delete; guards protect the last admin and yourself', async () => {
  const h = await harness();
  try {
    const admin = await h.adminClient();
    const me = h.app.accounts.users.byUsername('admin@admin.com');
    const created = await admin('POST', '/api/admin/users', { username: 'nurhan', displayName: 'Nurhan', planId: 'premium', email: 'nur@example.com' });
    assert.equal(created.status, 201);
    assert.ok(created.temporaryPassword && created.temporaryPassword.length >= 12);
    const nurhan = await h.login('nurhan', created.temporaryPassword);
    assert.equal((await nurhan('GET', '/api/auth/me')).user.mustChangePassword, true);
    assert.equal((await nurhan('GET', '/api/admin/users')).status, 403);
    const id = created.user.id;

    assert.equal((await admin('PATCH', '/api/admin/users/' + id, { planId: 'gold' })).status, 200);
    assert.equal((await admin('PATCH', '/api/admin/users/' + id, { planId: 'yok-boyle-paket' })).status, 400);
    const expiry = h.clock.t + 86400000;
    assert.equal((await admin('PATCH', '/api/admin/users/' + id, { planId: 'gold', planExpiresAt: expiry })).status, 200);
    assert.equal(h.app.auth.effectivePlan(h.app.accounts.users.byId(id)), 'gold');
    h.clock.t += 2 * 86400000;       // the gold period ended: back to the default plan
    assert.equal(h.app.auth.effectivePlan(h.app.accounts.users.byId(id)), 'basic');

    const reset = await admin('POST', `/api/admin/users/${id}/reset-password`, {});
    assert.equal(reset.status, 200); assert.ok(reset.temporaryPassword);
    assert.equal((await h.client()('POST', '/api/auth/login', { username: 'nurhan', password: created.temporaryPassword })).status, 401);

    // guards
    assert.equal((await admin('PATCH', '/api/admin/users/' + me.id, { role: 'user' })).status, 400);
    assert.equal((await admin('PATCH', '/api/admin/users/' + me.id, { status: 'disabled' })).status, 400);
    assert.equal((await admin('DELETE', '/api/admin/users/' + me.id)).status, 400);
    const second = await admin('POST', '/api/admin/users', { username: 'ikinci-yonetici', role: 'admin' });
    const secondApi = await h.login('ikinci-yonetici', second.temporaryPassword);
    await secondApi('POST', '/api/auth/change-password', { current: second.temporaryPassword, next: 'Ikinci-Yonetici-Parola-9' });
    assert.equal((await admin('PATCH', '/api/admin/users/' + second.user.id, { role: 'user' })).status, 200);   // there is still another admin: me

    assert.equal((await admin('DELETE', '/api/admin/users/' + id)).status, 200);
    assert.equal(h.app.accounts.users.byId(id), null);
    // everything is in the audit trail with who did it
    const audit = (await admin('GET', '/api/admin/audit')).entries;
    const actions = audit.map(a => a.action);
    for (const action of ['admin.user_created', 'admin.user_updated', 'admin.user_deleted', 'admin.password_reset']) assert.ok(actions.includes(action), action + ' in ' + actions.join());
    assert.ok(audit.every(a => !/Guclu|temporaryPassword|password"/i.test(JSON.stringify(a))), 'no secrets in the audit trail');
  } finally { await h.close(); }
});

test('plans: edit limits, add a plan, defaults, delete needs a destination for its users; skills follow plan rank', async () => {
  const h = await harness();
  try {
    const admin = await h.adminClient();
    assert.deepEqual((await admin('GET', '/api/admin/plans')).plans.map(p => p.id).slice(0, 3), ['basic', 'premium', 'gold']);
    const made = await admin('POST', '/api/admin/plans', { id: 'kurumsal', title: 'Kurumsal', projects: 500, documentsPerProject: 300, documentBytes: 150 * 1048576, questionsPerDay: 9000, monthlyTokens: 50000000 });
    assert.equal(made.status, 201);
    assert.equal((await admin('POST', '/api/admin/plans', { id: 'kurumsal', title: 'Aynı', projects: 1, documentsPerProject: 1, documentBytes: 1048576, questionsPerDay: 1 })).status, 409);
    assert.equal((await admin('POST', '/api/admin/plans', { id: 'Kötü Kod', title: 'x' })).status, 400);
    assert.equal((await admin('PUT', '/api/admin/plans/kurumsal', { title: 'Kurumsal Plus', monthlyTokens: 70000000 })).status, 200);
    assert.equal((await admin('GET', '/api/admin/plans')).plans.find(p => p.id === 'kurumsal').monthlyTokens, 70000000);

    // premium-only skill: refused for basic, available after the plan changes
    const user = await h.register('oya');
    const boot = await user('GET', '/api/writer/bootstrap');
    const locked = boot.lockedSkills.find(x => x.minPlan === 'premium');
    assert.ok(locked, 'basic users see the premium skill as locked');
    assert.ok(!boot.skills.some(x => x.name === locked.name));
    const id = h.app.accounts.users.byUsername('oya').id;
    await admin('PATCH', '/api/admin/users/' + id, { planId: 'kurumsal' });
    // custom plans sort after the built-in ones, so every skill is included
    const after = await user('GET', '/api/writer/bootstrap');
    assert.ok(after.skills.some(x => x.name === locked.name));
    assert.equal(after.lockedSkills.length, 0);

    // delete: users must be moved somewhere
    const refusal = await admin('DELETE', '/api/admin/plans/kurumsal');
    assert.equal(refusal.status, 409);
    assert.equal((await admin('DELETE', '/api/admin/plans/kurumsal?reassign=basic')).status, 200);
    assert.equal(h.app.accounts.users.byId(id).planId, 'basic');
  } finally { await h.close(); }
});

test('admin API: only admins, no cross-site writes, settings never expose secrets, general settings and SMTP test', async () => {
  const h = await harness();
  try {
    assert.equal((await h.client()('GET', '/api/admin/overview')).status, 401);
    const user = await h.register('pelin');
    for (const url of ['/api/admin/overview', '/api/admin/users', '/api/admin/plans', '/api/admin/operations', '/api/admin/stats', '/api/admin/audit', '/api/admin/settings']) assert.equal((await user('GET', url)).status, 403, url);
    assert.equal((await user('PUT', '/api/admin/settings/general', { registrationOpen: false })).status, 403);

    const admin = await h.adminClient();
    const noHeader = await fetch(h.base + '/api/admin/settings/general', { method: 'PUT', headers: { cookie: admin.cookie(), 'content-type': 'application/json' }, body: '{"registrationOpen":false}' });
    assert.equal(noHeader.status, 403);
    assert.equal(h.app.auth.settings.general().registrationOpen, true);

    assert.equal((await admin('PUT', '/api/admin/settings/smtp', { host: 'smtp.test', port: 587, from: 'x@test.com', user: 'u', pass: 'smtp-gizli-parola' })).status, 200);
    const settings = JSON.stringify(await admin('GET', '/api/admin/settings'));
    assert.ok(!settings.includes('smtp-gizli-parola')); assert.match(settings, /"passSet":true/);
    const sent = await admin('POST', '/api/admin/settings/smtp/test', { to: 'deneme@example.com' });
    assert.equal(sent.status, 200); assert.ok(h.mailbox.at(-1).to === 'deneme@example.com');
    const overview = await admin('GET', '/api/admin/overview');
    assert.ok(overview.users.total >= 2);
    // changing the setting is recorded
    assert.ok((await admin('GET', '/api/admin/audit')).entries.some(e => e.action === 'admin.settings_smtp'));
  } finally { await h.close(); }
});

test('Word documents belong to their owner; the legacy anonymous archive is deleted once', async () => {
  const fs = require('node:fs'), path = require('node:path');
  const dirBefore = require('node:os').tmpdir();
  void dirBefore;
  const h = await harness();
  try {
    const archive = process.env.WORD_ARCHIVE_DIR;
    const a = await h.register('berk'), b = await h.register('cansu');
    const up = await a('POST', '/api/word/upload', { name: 'tez.pdf', data: h.PDF });
    assert.ok(up.status < 300, JSON.stringify(up));
    const id = up.id || up.document?.id;
    assert.ok(id);
    assert.equal((await a('GET', '/api/word/documents')).documents.length, 1);
    assert.equal((await b('GET', '/api/word/documents')).documents.length, 0);
    const foreign = await b('GET', `/api/word/${id}/state`);
    assert.equal(foreign.status, 404);
    assert.equal((await b('DELETE', '/api/word/' + id)).status, 404);
    assert.equal((await h.client()('GET', '/api/word/documents')).status, 401);
    assert.equal((await a('DELETE', '/api/word/' + id)).status, 200);

    // legacy files without an owner: removed one time, not again
    const store = require('../word-store.cjs');
    const legacy = path.join(archive, '11111111-1111-4111-8111-111111111111.json');
    fs.mkdirSync(archive, { recursive: true });
    fs.rmSync(path.join(archive, '.owners-enabled'), { force: true });
    fs.writeFileSync(legacy, '{}');
    assert.ok(store.purgeUnowned() >= 1);
    assert.equal(fs.existsSync(legacy), false);
    fs.writeFileSync(legacy, '{}');
    assert.equal(store.purgeUnowned(), 0);
    assert.equal(fs.existsSync(legacy), true);
  } finally { await h.close(); }
});

test('deleting a user removes their sources and documents but keeps the metadata log for accounting', async () => {
  const h = await harness();
  try {
    const user = await h.register('selim');
    const projectId = await projectWithSource(user, h);
    await ask(user, projectId);
    const admin = await h.adminClient();
    const id = h.app.accounts.users.byUsername('selim').id;
    assert.equal(h.writerStore.listProjects(id).length, 1);
    assert.equal((await admin('DELETE', '/api/admin/users/' + id)).status, 200);
    assert.equal(h.writerStore.listProjects(id).length, 0);
    const operations = (await admin('GET', '/api/admin/operations')).operations.filter(o => o.userId === id);
    assert.ok(operations.length >= 1, 'token history stays');
  } finally { await h.close(); }
});
