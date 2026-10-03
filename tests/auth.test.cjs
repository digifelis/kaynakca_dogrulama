const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, fakeDirectory } = require('./helpers/harness.cjs');

const GOOD = 'Guclu-Parola-2026';

test('first start creates the default admin who must change the password before anything else', async () => {
  const h = await harness();
  try {
    const api = h.client();
    assert.equal((await api('GET', '/api/auth/me')).user, null);
    const login = await api('POST', '/api/auth/login', { username: 'admin@admin.com', password: 'admin' });
    assert.equal(login.status, 200);
    assert.equal(login.user.mustChangePassword, true);
    assert.equal(login.user.role, 'admin');
    // every API except /api/auth is blocked until the password is changed
    const blocked = await api('GET', '/api/writer/bootstrap');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.code, 'password_change_required');
    assert.equal((await api('GET', '/api/admin/overview')).status, 403);
    // weak passwords are refused, a strong one is accepted and ends the forced state
    assert.equal((await api('POST', '/api/auth/change-password', { current: 'admin', next: 'admin' })).status, 400);
    assert.equal((await api('POST', '/api/auth/change-password', { current: 'wrong', next: GOOD })).status, 400);
    assert.equal((await api('POST', '/api/auth/change-password', { current: 'admin', next: GOOD })).status, 200);
    assert.equal((await api('GET', '/api/admin/overview')).status, 200);
    // the old password no longer works
    assert.equal((await h.client()('POST', '/api/auth/login', { username: 'admin@admin.com', password: 'admin' })).status, 401);
    // bootstrapping again does not create a second admin or reset the password
    await h.app.auth.bootstrapAdmin({ log() {} });
    assert.equal(h.app.accounts.users.countAdmins(), 1);
  } finally { await h.close(); }
});

test('registration, session cookie flags, logout and API protection', async () => {
  const h = await harness();
  try {
    const anonymous = h.client();
    // protected areas refuse anonymous visitors; the reference page API stays open
    assert.equal((await anonymous('GET', '/api/writer/bootstrap')).status, 401);
    assert.equal((await anonymous('GET', '/api/word/documents')).status, 401);
    assert.equal((await anonymous('GET', '/api/auth/config')).registrationOpen, true);

    const raw = await h.client()('POST', '/api/auth/register', { username: 'ayse', displayName: 'Ayşe', password: GOOD }, { raw: true });
    assert.equal(raw.status, 201);
    const cookie = raw.headers.getSetCookie()[0];
    assert.match(cookie, /^km_session=/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    const stored = h.app.appDb.db.prepare('SELECT token_hash FROM sessions').all().map(r => r.token_hash);
    assert.ok(stored.length && stored.every(hash => !cookie.includes(hash)), 'only a hash of the token is stored');

    const api = await h.login('ayse', GOOD);
    assert.equal((await api('GET', '/api/writer/bootstrap')).status, 200);
    // mutating calls need the app header
    const noHeader = await fetch(h.base + '/api/auth/logout', { method: 'POST', headers: { cookie: api.cookie() } });
    assert.equal(noHeader.status, 403);
    await api('POST', '/api/auth/logout', {});
    assert.equal((await api('GET', '/api/writer/bootstrap')).status, 401);
    // duplicate and invalid names, weak passwords
    assert.equal((await h.client()('POST', '/api/auth/register', { username: 'AYSE', password: GOOD })).status, 409);
    assert.equal((await h.client()('POST', '/api/auth/register', { username: 'a', password: GOOD })).status, 400);
    assert.equal((await h.client()('POST', '/api/auth/register', { username: 'mehmet', password: 'password123' })).status, 400);
    assert.equal((await h.client()('POST', '/api/auth/register', { username: 'mehmet', password: 'mehmet-mehmet-1' })).status, 400);
    // a closed registration is refused for everyone
    const admin = await h.adminClient();
    assert.equal((await admin('PUT', '/api/admin/settings/general', { registrationOpen: false })).status, 200);
    assert.equal((await h.client()('POST', '/api/auth/register', { username: 'zeynep', password: GOOD })).status, 403);
  } finally { await h.close(); }
});

test('wrong passwords lock the account for a growing time; the right password does not bypass the lock', async () => {
  const h = await harness();
  try {
    await h.register('can');
    const api = h.client();
    for (let i = 0; i < 5; i++) assert.equal((await api('POST', '/api/auth/login', { username: 'can', password: 'yanlis-parola-1' })).status, 401);
    const locked = await api('POST', '/api/auth/login', { username: 'can', password: GOOD });
    assert.equal(locked.status, 429);
    assert.ok(locked.retryAt > h.clock.t);
    h.clock.t += 20 * 60 * 1000;
    assert.equal((await api('POST', '/api/auth/login', { username: 'can', password: GOOD })).status, 200);
    // unknown users answer exactly like wrong passwords (no user enumeration)
    const unknown = await h.client()('POST', '/api/auth/login', { username: 'yok-boyle-biri', password: GOOD });
    const wrong = await h.client()('POST', '/api/auth/login', { username: 'can', password: 'yanlis-parola-2' });
    assert.equal(unknown.status, wrong.status); assert.equal(unknown.error, wrong.error);
  } finally { await h.close(); }
});

test('sessions expire, slide forward and end when the account is disabled or the password changes', async () => {
  const h = await harness();
  try {
    const api = await h.register('deniz');
    h.clock.t += 10 * 86400000;
    assert.equal((await api('GET', '/api/writer/bootstrap')).status, 200); // sliding: renewed
    h.clock.t += 10 * 86400000;
    assert.equal((await api('GET', '/api/writer/bootstrap')).status, 200);
    h.clock.t += 15 * 86400000;
    assert.equal((await api('GET', '/api/writer/bootstrap')).status, 401);

    // changing the password signs the other devices out
    const first = await h.login('deniz', GOOD), second = await h.login('deniz', GOOD);
    assert.equal((await first('POST', '/api/auth/change-password', { current: GOOD, next: 'Baska-Guclu-Parola-7' })).status, 200);
    assert.equal((await first('GET', '/api/writer/bootstrap')).status, 200);
    assert.equal((await second('GET', '/api/writer/bootstrap')).status, 401);

    // a disabled account is cut off immediately and cannot sign in
    const admin = await h.adminClient();
    const id = h.app.accounts.users.byUsername('deniz').id;
    assert.equal((await admin('PATCH', '/api/admin/users/' + id, { status: 'disabled' })).status, 200);
    assert.equal((await first('GET', '/api/writer/bootstrap')).status, 401);
    assert.equal((await h.client()('POST', '/api/auth/login', { username: 'deniz', password: 'Baska-Guclu-Parola-7' })).status, 403);
  } finally { await h.close(); }
});

test('e-mail: optional, verified through a one-time link, and the link cannot be reused or stolen by someone else', async () => {
  const h = await harness();
  try {
    const api = await h.register('elif');
    const set = await api('PATCH', '/api/auth/profile', { email: 'elif@example.com' });
    assert.equal(set.status, 200);
    assert.equal(h.mailbox.length, 1);
    const link = /https?:\/\/[^\s"<]+verify-email\?token=[\w-]+/.exec(h.mailbox[0].text || h.mailbox[0].html)[0];
    const path = link.replace(/^https?:\/\/[^/]+/, '');
    assert.equal((await api('GET', '/api/auth/me')).user.emailVerified, false);
    const done = await api('GET', path, undefined, { raw: true });
    assert.equal(done.status, 302); assert.match(done.headers.get('location'), /email=dogrulandi/);
    assert.equal((await api('GET', '/api/auth/me')).user.emailVerified, true);
    const again = await h.client()('GET', path, undefined, { raw: true });
    assert.match(again.headers.get('location'), /email=hata/);
    // the same address cannot be claimed by another account once verified
    const other = await h.register('fatma');
    assert.equal((await other('PATCH', '/api/auth/profile', { email: 'ELIF@example.com' })).status, 409);
    // changing the address clears the verification
    await api('PATCH', '/api/auth/profile', { email: 'elif.yeni@example.com' });
    assert.equal((await api('GET', '/api/auth/me')).user.emailVerified, false);
  } finally { await h.close(); }
});

test('password reset: only verified addresses, answers never reveal accounts, token works once and ends all sessions', async () => {
  const h = await harness();
  try {
    const api = await h.register('gulsen');
    await api('PATCH', '/api/auth/profile', { email: 'gul@example.com' });
    // unverified address: same answer, no mail beyond the verification one
    const sent = h.mailbox.length;
    const answer = await h.client()('POST', '/api/auth/forgot', { identifier: 'gul@example.com' });
    const none = await h.client()('POST', '/api/auth/forgot', { identifier: 'nobody@example.com' });
    assert.equal(answer.status, 200); assert.equal(none.status, 200); assert.equal(answer.message, none.message);
    assert.equal(h.mailbox.length, sent);

    const verify = /verify-email\?token=([\w-]+)/.exec(h.mailbox[0].text || h.mailbox[0].html)[1];
    await h.client()('GET', '/api/auth/verify-email?token=' + verify, undefined, { raw: true });
    await h.client()('POST', '/api/auth/forgot', { identifier: 'gul@example.com' });
    assert.equal(h.mailbox.length, sent + 1);
    const token = /token=([\w-]+)/.exec(h.mailbox.at(-1).text || h.mailbox.at(-1).html)[1];
    assert.equal((await h.client()('POST', '/api/auth/reset', { token, password: 'zayif' })).status, 400);
    // a weak password does not burn the token
    assert.equal((await h.client()('POST', '/api/auth/reset', { token, password: 'Yepyeni-Parola-2027' })).status, 200);
    assert.equal((await h.client()('POST', '/api/auth/reset', { token, password: 'Bir-Baska-Parola-2028' })).status, 400);
    assert.equal((await api('GET', '/api/writer/bootstrap')).status, 401);
    await h.login('gulsen', 'Yepyeni-Parola-2027');
    // an expired token is useless
    await h.client()('POST', '/api/auth/forgot', { identifier: 'gul@example.com' });
    const late = /token=([\w-]+)/.exec(h.mailbox.at(-1).text || h.mailbox.at(-1).html)[1];
    h.clock.t += 2 * 3600 * 1000;
    assert.equal((await h.client()('POST', '/api/auth/reset', { token: late, password: 'Yepyeni-Parola-2029' })).status, 400);
  } finally { await h.close(); }
});

test('password hashing: scrypt format, salted, verified in constant shape; policy rules', async () => {
  const h = await harness();
  try {
    const a = await h.app.auth.hashPassword(GOOD), b = await h.app.auth.hashPassword(GOOD);
    assert.match(a, /^scrypt\$\d+\$\d+\$\d+\$[\w+/=-]+\$[\w+/=-]+$/);
    assert.notEqual(a, b);
    assert.equal(await h.app.auth.verifyPassword(GOOD, a), true);
    assert.equal(await h.app.auth.verifyPassword(GOOD + 'x', a), false);
    assert.equal(await h.app.auth.verifyPassword(GOOD, 'bozuk'), false);
    const problem = h.app.auth.passwordProblem;
    assert.ok(problem('kisa-1'));
    assert.ok(problem('password123456'));
    assert.ok(problem('ahmet-ahmet-12', 'ahmet'));
    assert.equal(problem(GOOD, 'ahmet'), null);
  } finally { await h.close(); }
});

test('LDAP: provisioning on first sign-in, group mapping to plan and admin, escaped filters, empty passwords, outages', async () => {
  const directory = fakeDirectory({
    alice: { dn: 'uid=alice,ou=people,dc=test', password: 'ldap-sifre-1', mail: 'alice@siirt.edu.tr', cn: 'Alice Yılmaz', memberOf: ['cn=gold-users,ou=groups,dc=test'] },
    bob: { dn: 'uid=bob,ou=people,dc=test', password: 'ldap-sifre-2', mail: 'bob@siirt.edu.tr', cn: 'Bob', memberOf: ['cn=staff,ou=groups,dc=test', 'CN=Premium-Users,ou=groups,dc=test'] },
    root: { dn: 'uid=root,ou=people,dc=test', password: 'ldap-sifre-3', mail: '', cn: 'Root', memberOf: ['cn=ldap-admins,ou=groups,dc=test'] },
    carol: { dn: 'uid=carol,ou=people,dc=test', password: 'ldap-sifre-4', mail: 'carol@siirt.edu.tr', cn: 'Carol', memberOf: [] },
  });
  const h = await harness({ ldap: directory });
  try {
    const admin = await h.adminClient();
    const settings = { enabled: true, url: 'ldap://ldap.test:389', bindDn: 'cn=service,dc=test', bindPassword: 'service-secret', baseDn: 'ou=people,dc=test',
      userFilter: '(uid={username})', startTls: false, defaultPlan: 'basic', groupMappings: [{ group: 'cn=gold-users,ou=groups,dc=test', plan: 'gold' }, { group: 'premium-users', plan: 'premium' }, { group: 'cn=ldap-admins,ou=groups,dc=test', admin: true }] };
    const saved = await admin('PUT', '/api/admin/settings/ldap', settings);
    assert.equal(saved.status, 200);
    assert.ok(!JSON.stringify(saved).includes('service-secret'), 'bind password is never returned');
    assert.ok(!JSON.stringify(await admin('GET', '/api/admin/settings')).includes('service-secret'));
    assert.ok(!require('node:fs').readFileSync(require('node:path').join(h.dir, 'app.db')).includes('service-secret'), 'bind password is encrypted at rest');

    const test = await admin('POST', '/api/admin/settings/ldap/test', {});
    assert.equal(test.status, 200); assert.equal(test.ok, true);

    const alice = await h.login('alice', 'ldap-sifre-1');
    const me = (await alice('GET', '/api/auth/me')).user;
    assert.equal(me.plan, 'gold'); assert.equal(me.source, 'ldap'); assert.equal(me.mustChangePassword, false); assert.equal(me.role, 'user');
    assert.equal((await alice('GET', '/api/writer/bootstrap')).status, 200);
    // LDAP accounts have no local password to change or reset
    assert.equal((await alice('POST', '/api/auth/change-password', { current: 'ldap-sifre-1', next: GOOD })).status, 400);

    assert.equal((await (await h.login('bob', 'ldap-sifre-2'))('GET', '/api/auth/me')).user.plan, 'premium');
    const root = (await (await h.login('root', 'ldap-sifre-3'))('GET', '/api/auth/me')).user;
    assert.equal(root.role, 'admin');
    assert.equal((await (await h.login('carol', 'ldap-sifre-4'))('GET', '/api/auth/me')).user.plan, 'basic');

    // group changes follow at the next sign-in
    directory.users.carol.memberOf = ['cn=gold-users,ou=groups,dc=test'];
    assert.equal((await (await h.login('carol', 'ldap-sifre-4'))('GET', '/api/auth/me')).user.plan, 'gold');

    // wrong, empty and injected input
    assert.equal((await h.client()('POST', '/api/auth/login', { username: 'alice', password: 'yanlis' })).status, 401);
    assert.ok([400, 401].includes((await h.client()('POST', '/api/auth/login', { username: 'alice', password: '' })).status));
    directory.log.filters.length = 0;
    const injected = await h.client()('POST', '/api/auth/login', { username: 'alice)(uid=*', password: 'x' });
    assert.equal(injected.status, 401);
    assert.ok(directory.log.filters.every(f => !f.includes('alice)(uid=*')), 'filter special characters are escaped');
    // local registration cannot take a directory name
    assert.equal((await h.client()('POST', '/api/auth/register', { username: 'alice', password: GOOD })).status, 409);

    // the directory is down: LDAP users get a clear error, local accounts keep working
    directory.down = true;
    const down = await h.client()('POST', '/api/auth/login', { username: 'alice', password: 'ldap-sifre-1' });
    assert.ok(down.status >= 400 && down.status !== 200);
    await h.register('yerel');
    assert.equal((await (await h.login('yerel', GOOD))('GET', '/api/auth/me')).user.username, 'yerel');
  } finally { await h.close(); }
});

test('front-end assets are served and the public config needs no login', async () => {
  const h = await harness();
  try {
    for (const file of ['/auth-app.js', '/admin-app.js', '/pages.js', '/']) assert.equal((await fetch(h.base + file)).status, 200, file);
    assert.equal((await fetch(h.base + '/api/auth/config')).status, 200);
  } finally { await h.close(); }
});
