// Accounts: registration, sign-in (local password or LDAP), sessions, profile, e-mail verification and password reset.
// Rules only; storage is accounts.cjs. Errors carry an HTTP status and a stable `code` for the UI.
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const Plans = require('./plans.cjs');
const Ldap = require('./ldap-auth.cjs');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'km_session';
const SESSION_MS = 14 * 24 * 3600 * 1000, TOUCH_MS = 10 * 60 * 1000;
const VERIFY_MS = 24 * 3600 * 1000, RESET_MS = 3600 * 1000;
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._@+-]{2,63}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const COMMON = new Set(['password', 'passw0rd', '1234567890', '12345678910', 'qwertyuiop', 'qwerty12345', 'administrator', 'admin12345', 'iloveyou123', 'parola12345', 'sifre12345']);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DEFAULT_ADMIN = { username: 'admin@admin.com', password: 'admin' };

const fail = (status, message, code, extra = {}) => Object.assign(Error(message), { status, code, ...extra });

async function hashPassword(password) {
  const salt = crypto.randomBytes(16), key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
// Returns a Turkish message when the password is too weak, otherwise null.
function passwordProblem(password, username = '') {
  if (typeof password !== 'string' || password.length < 10) return 'Parola en az 10 karakter olmalıdır.';
  if (password.length > 200) return 'Parola en fazla 200 karakter olabilir.';
  if (COMMON.has(password.toLowerCase()) || COMMON.has(password.toLowerCase().replace(/[\d!@#$%^&*._-]+$/, '')) || /^(.)\1+$/.test(password)) return 'Bu parola çok kolay tahmin edilir; başka bir parola seçin.';
  if (username && password.toLowerCase().includes(String(username).toLowerCase().split('@')[0]) && String(username).split('@')[0].length >= 3) return 'Parola kullanıcı adınızı içermemelidir.';
  return null;
}

function createAuth({ accounts, mailer = null, sealer, ldapClientFactory, now = Date.now, publicUrl = process.env.PUBLIC_URL || '' } = {}) {
  let dummyHash = null;
  const settings = {
    ldap({ secret = false } = {}) {
      const stored = accounts.settings.get('ldap', {});
      const { bindPasswordSealed, ...rest } = stored;
      const out = { enabled: false, ...rest };
      if (secret && bindPasswordSealed) out.bindPassword = sealer.open(bindPasswordSealed);
      else out.bindPasswordSet = !!bindPasswordSealed;
      return out;
    },
    // A blank password field keeps the stored one; the secret is never sent back to the browser.
    saveLdap(input) {
      const current = accounts.settings.get('ldap', {});
      const { bindPassword, bindPasswordSet, ...rest } = input;
      const next = { ...rest };
      if (bindPassword) next.bindPasswordSealed = sealer.seal(bindPassword); else if (current.bindPasswordSealed && !input.clearBindPassword) next.bindPasswordSealed = current.bindPasswordSealed;
      delete next.clearBindPassword;
      accounts.settings.set('ldap', next);
    },
    smtp({ secret = false } = {}) {
      const { passSealed, ...rest } = accounts.settings.get('smtp', {});
      const out = { ...rest };
      if (secret && passSealed) out.pass = sealer.open(passSealed); else out.passSet = !!passSealed;
      return out;
    },
    saveSmtp(input) {
      const current = accounts.settings.get('smtp', {});
      const { pass, passSet, ...rest } = input;
      const next = { ...rest };
      if (pass) next.passSealed = sealer.seal(pass); else if (current.passSealed && !input.clearPass) next.passSealed = current.passSealed;
      delete next.clearPass;
      accounts.settings.set('smtp', next);
    },
    // Semantic Scholar API key (paper search of the writing assistant): sealed like the other secrets, never returned.
    scholar({ secret = false } = {}) {
      const { keySealed } = accounts.settings.get('scholar', {});
      if (!keySealed) return { keySet: false };
      const key = sealer.open(keySealed);
      return secret ? { keySet: true, key } : { keySet: true, last4: key.slice(-4) };
    },
    saveScholar({ key = '', clear = false } = {}) {
      if (clear) return accounts.settings.set('scholar', {});
      if (key) accounts.settings.set('scholar', { keySealed: sealer.seal(String(key).trim()) });
    },
    // Embedding provider of the writing assistant: Gemini (default) or a self-hosted TEI server. The optional bearer token is sealed and never returned.
    embedding({ secret = false } = {}) {
      const { apiKeySealed, ...rest } = accounts.settings.get('embedding', {});
      const out = { provider: 'gemini', ...rest };
      if (secret && apiKeySealed) out.apiKey = sealer.open(apiKeySealed); else out.apiKeySet = !!apiKeySealed;
      return out;
    },
    saveEmbedding(input) {
      const current = accounts.settings.get('embedding', {});
      const { apiKey, apiKeySet, clearApiKey, ...rest } = input;
      const next = { ...rest };
      if (apiKey) next.apiKeySealed = sealer.seal(String(apiKey).trim()); else if (current.apiKeySealed && !clearApiKey) next.apiKeySealed = current.apiKeySealed;
      accounts.settings.set('embedding', next);
    },
    general: () => ({ registrationOpen: true, defaultPlan: '', ...accounts.settings.get('general', {}) }),
    saveGeneral: value => accounts.settings.set('general', value),
  };
  const defaultPlanId = () => { const wanted = settings.general().defaultPlan; return wanted && Plans.all().some(p => p.id === wanted) ? wanted : Plans.all()[0]?.id || 'basic'; };
  const mailEnabled = () => !!mailer?.enabled();
  const ldapConfig = () => settings.ldap({ secret: true });
  const ldapOn = () => Ldap.usable(ldapConfig());
  const baseUrl = req => (publicUrl || (req ? `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}` : '')).replace(/\/$/, '');

  const audit = (ctx, action, extra = {}) => accounts.audit.log({ actorId: ctx.actor?.id ?? null, actorName: ctx.actor?.username ?? null, ip: ctx.ip, action, ...extra });
  const effectivePlan = user => user.planExpiresAt && user.planExpiresAt < now() ? defaultPlanId() : Plans.known(user.planId);
  const publicUser = user => ({ id: user.id, username: user.username, displayName: user.displayName || user.username, email: user.email, emailVerified: user.emailVerified,
    role: user.role, source: user.source, status: user.status, plan: effectivePlan(user), features: Plans.featuresFor(effectivePlan(user), user.role), planId: user.planId, planExpiresAt: user.planExpiresAt,
    mustChangePassword: user.mustChangePassword, canChangePassword: user.source === 'local', createdAt: user.createdAt, lastLoginAt: user.lastLoginAt });

  // ---- public settings the login page needs
  const config = () => ({ registrationOpen: !!settings.general().registrationOpen, ldapEnabled: ldapOn(), emailEnabled: mailEnabled()});

  // ---- sessions
  function startSession(user, ctx) {
    accounts.sessions.purgeExpired();
    return accounts.sessions.create(user.id, { ip: ctx.ip || '', ua: ctx.ua || '', ttlMs: SESSION_MS });
  }
  function cookieValue(req, header) { for (const part of String(header || '').split(';')) { const [name, ...rest] = part.trim().split('='); if (name === COOKIE) return rest.join('='); } return ''; }
  const tokenOf = req => cookieValue(req, req.headers.cookie);
  function sessionCookie(token, req, { clear = false } = {}) {
    const secure = /^https:/i.test(publicUrl) || req?.headers?.['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return `${COOKIE}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : Math.floor(SESSION_MS / 1000)}${secure}`;
  }
  // The signed-in user for a request, or null. Disabled accounts lose their session immediately.
  function userFromRequest(req) {
    const token = tokenOf(req);
    if (!token) return null;
    const session = accounts.sessions.find(token);
    if (!session || session.expiresAt < now()) { if (session) accounts.sessions.revoke(token); return null; }
    const user = accounts.users.byId(session.userId);
    if (!user || user.status !== 'active') { accounts.sessions.revoke(token); return null; }
    if (now() - session.lastSeen > TOUCH_MS) accounts.sessions.extend(token, now() + SESSION_MS);
    return { user, token };
  }
  // Shape used by lib/identity.cjs: what the other services need to know about the caller.
  function resolveRequest(req) {
    const found = userFromRequest(req);
    return found ? { userId: found.user.id, plan: effectivePlan(found.user), user: publicUser(found.user), mustChangePassword: found.user.mustChangePassword, role: found.user.role } : null;
  }

  // ---- login throttling: per account and per address, growing lock time
  const LIMITS = { account: { max: 5, lockMs: 5 * 60000 }, address: { max: 40, lockMs: 5 * 60000 } };
  function lockedFor(keys) {
    const until = Math.max(0, ...keys.map(key => accounts.attempts.get(key).locked_until));
    return until > now() ? until : 0;
  }

  async function localLogin(user, password) {
    if (!user.passwordHash) return false;
    return verifyPassword(password, user.passwordHash);
  }
  async function dummyCheck(password) { dummyHash ||= await hashPassword('zamanlama-koruması'); await verifyPassword(password, dummyHash); }

  // Creates or refreshes the account of a directory user from the profile LDAP returned.
  function syncLdapUser(profile, existing) {
    const cfg = ldapConfig(), hasAdminMapping = (cfg.groupMappings || []).some(m => m.admin);
    const fields = { displayName: profile.displayName, ldapDn: profile.dn };
    if (profile.email && profile.email !== existing?.email) {
      const taken = accounts.users.byVerifiedEmail(profile.email);
      if (!taken || taken.id === existing?.id) Object.assign(fields, { email: profile.email, emailVerified: true });
    }
    if (existing) {
      if (cfg.syncPlan !== false) Object.assign(fields, { planId: profile.plan, planExpiresAt: null });
      if (hasAdminMapping) fields.role = profile.admin ? 'admin' : 'user';
      return accounts.users.update(existing.id, fields);
    }
    return accounts.users.create({ username: profile.username, displayName: profile.displayName, email: fields.email || null, emailVerified: !!fields.email, source: 'ldap', ldapDn: profile.dn,
      role: hasAdminMapping && profile.admin ? 'admin' : 'user', planId: cfg.syncPlan === false ? defaultPlanId() : profile.plan });
  }

  async function login({ username, password }, ctx = {}) {
    username = String(username || '').trim();
    if (!username || typeof password !== 'string' || !password || username.length > 200 || password.length > 1000) throw fail(400, 'Kullanıcı adı ve parola gerekli.', 'bad_request');
    const keys = [`u:${username.toLowerCase()}`, `ip:${ctx.ip || '-'}`];
    const until = lockedFor(keys);
    if (until) { audit(ctx, 'auth.login_blocked', { detail: { username } }); throw fail(429, `Çok fazla başarısız deneme. ${Math.max(1, Math.ceil((until - now()) / 60000))} dakika sonra tekrar deneyin.`, 'locked', { retryAt: until }); }
    const bad = reason => {
      accounts.attempts.fail(keys[0], LIMITS.account); accounts.attempts.fail(keys[1], LIMITS.address);
      audit(ctx, 'auth.login_failed', { detail: { username, reason } });
      return fail(401, 'Kullanıcı adı veya parola hatalı.', 'bad_credentials');
    };
    let user = accounts.users.byUsername(username), ok = false, method = 'local';
    if (user && user.source === 'local') ok = await localLogin(user, password);
    else if (user?.source === 'ldap' || (!user && ldapOn())) {
      method = 'ldap';
      let profile = null;
      try { profile = await Ldap.authenticate(ldapConfig(), username, password, { clientFactory: ldapClientFactory }); }
      catch (error) { audit(ctx, 'auth.ldap_error', { detail: { username, message: String(error?.message || error).slice(0, 200) } }); throw fail(503, 'Dizin (LDAP) sunucusuna ulaşılamadı; daha sonra tekrar deneyin.', 'ldap_unavailable'); }
      if (profile) {
        if (user?.status === 'disabled') { audit(ctx, 'auth.login_failed', { detail: { username, reason: 'disabled' } }); throw fail(403, 'Hesabınız devre dışı bırakılmış.', 'disabled'); }
        user = syncLdapUser(profile, user); ok = true;
      }
    } else await dummyCheck(password);
    if (!ok) throw bad('bad_credentials');
    if (user.status !== 'active') { audit(ctx, 'auth.login_failed', { detail: { username, reason: 'disabled' } }); throw fail(403, 'Hesabınız devre dışı bırakılmış.', 'disabled'); }
    accounts.attempts.clear(keys[0]);
    user = accounts.users.update(user.id, { lastLoginAt: now() });
    const token = startSession(user, ctx);
    audit({ ...ctx, actor: user }, 'auth.login', { targetType: 'user', targetId: user.id, detail: { method } });
    return { token, user: publicUser(user) };
  }

  async function register({ username, displayName, password }, ctx = {}) {
    if (!settings.general().registrationOpen) throw fail(403, 'Yeni üye kaydı şu anda kapalı.', 'registration_closed');
    username = String(username || '').trim();
    if (!USERNAME.test(username)) throw fail(400, 'Kullanıcı adı 3–64 karakter olmalı; harf, rakam ve . _ @ + - kullanılabilir.', 'bad_username');
    displayName = String(displayName || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const problem = passwordProblem(password, username);
    if (problem) throw fail(400, problem, 'weak_password');
    const keys = [`reg:${ctx.ip || '-'}`];
    if (lockedFor(keys)) throw fail(429, 'Çok fazla kayıt denemesi; daha sonra tekrar deneyin.', 'locked');
    if (accounts.users.byUsername(username)) { accounts.attempts.fail(keys[0], { max: 10, lockMs: 10 * 60000 }); throw fail(409, 'Bu kullanıcı adı kullanılıyor.', 'username_taken'); }
    // A directory user's name must stay theirs: local registration cannot squat it.
    if (ldapOn()) { try { if (await Ldap.exists(ldapConfig(), username, { clientFactory: ldapClientFactory })) throw fail(409, 'Bu kullanıcı adı kullanılıyor.', 'username_taken'); } catch (error) { if (error.code === 'username_taken') throw error; } }
    const user = accounts.users.create({ username, displayName: displayName || username, passwordHash: await hashPassword(password), planId: defaultPlanId(), lastLoginAt: now() });
    const token = startSession(user, ctx);
    audit({ ...ctx, actor: user }, 'auth.register', { targetType: 'user', targetId: user.id });
    return { token, user: publicUser(user) };
  }

  async function logout(token, ctx = {}) { if (token) accounts.sessions.revoke(token); audit(ctx, 'auth.logout', { targetType: 'user', targetId: ctx.actor?.id }); }

  async function changePassword(user, { current, next }, ctx = {}, token = null) {
    if (user.source !== 'local') throw fail(400, 'Bu hesabın parolası dizin (LDAP) tarafından yönetilir.', 'managed_externally');
    if (!await verifyPassword(String(current || ''), user.passwordHash)) throw fail(400, 'Mevcut parola hatalı.', 'bad_credentials');
    const problem = passwordProblem(next, user.username);
    if (problem) throw fail(400, problem, 'weak_password');
    if (current === next) throw fail(400, 'Yeni parola eskisinden farklı olmalıdır.', 'same_password');
    accounts.users.update(user.id, { passwordHash: await hashPassword(next), mustChangePassword: false });
    accounts.sessions.revokeUser(user.id, token);
    audit({ ...ctx, actor: user }, 'auth.password_changed', { targetType: 'user', targetId: user.id });
    return publicUser(accounts.users.byId(user.id));
  }

  // ---- e-mail (optional; set from the profile page)
  async function sendVerification(user, ctx = {}, req = null) {
    if (!user.email) throw fail(400, 'Önce bir e-posta adresi kaydedin.', 'no_email');
    if (!mailEnabled()) throw fail(503, 'E-posta gönderimi yapılandırılmamış; doğrulama bağlantısı gönderilemez.', 'email_disabled');
    const token = accounts.tokens.create(user.id, 'verify-email', { email: user.email, ttlMs: VERIFY_MS });
    await mailer.send({ to: user.email, subject: 'E-posta adresinizi doğrulayın', text: `Merhaba ${user.displayName || user.username},\n\nE-posta adresinizi doğrulamak için bağlantıya tıklayın (24 saat geçerli):\n${baseUrl(req)}/api/auth/verify-email?token=${token}\n\nBu isteği siz yapmadıysanız bu iletiyi yok sayın.` });
    audit({ ...ctx, actor: user }, 'auth.verification_sent', { targetType: 'user', targetId: user.id });
  }
  async function updateProfile(user, { displayName, email }, ctx = {}, req = null) {
    const fields = {};
    if (displayName !== undefined) fields.displayName = String(displayName).replace(/\s+/g, ' ').trim().slice(0, 80);
    let verify = false;
    if (email !== undefined) {
      if (user.source === 'ldap') throw fail(400, 'E-posta adresi dizin (LDAP) tarafından yönetilir.', 'managed_externally');
      const value = String(email || '').trim().toLowerCase();
      if (value && !EMAIL.test(value)) throw fail(400, 'Geçerli bir e-posta adresi girin.', 'bad_email');
      if (value && value !== (user.email || '').toLowerCase()) {
        const taken = accounts.users.byVerifiedEmail(value);
        if (taken && taken.id !== user.id) throw fail(409, 'Bu e-posta adresi başka bir hesapta doğrulanmış.', 'email_taken');
        Object.assign(fields, { email: value, emailVerified: false }); verify = true;
      } else if (!value && user.email) Object.assign(fields, { email: null, emailVerified: false });
    }
    const updated = accounts.users.update(user.id, fields);
    audit({ ...ctx, actor: user }, 'auth.profile_updated', { targetType: 'user', targetId: user.id, detail: { fields: Object.keys(fields).filter(k => k !== 'emailVerified') } });
    let verificationSent = false;
    if (verify && mailEnabled()) { await sendVerification(updated, ctx, req).catch(() => {}); verificationSent = true; }
    return { user: publicUser(updated), verificationSent };
  }
  function verifyEmail(token, ctx = {}) {
    const found = accounts.tokens.consume(String(token || ''), 'verify-email');
    if (!found) throw fail(400, 'Doğrulama bağlantısı geçersiz veya süresi dolmuş.', 'bad_token');
    const user = accounts.users.byId(found.userId);
    if (!user || (user.email || '').toLowerCase() !== (found.email || '').toLowerCase()) throw fail(400, 'Bu bağlantı eski bir e-posta adresine aittir.', 'bad_token');
    const taken = accounts.users.byVerifiedEmail(user.email);
    if (taken && taken.id !== user.id) throw fail(409, 'Bu e-posta adresi başka bir hesapta doğrulanmış.', 'email_taken');
    accounts.users.update(user.id, { emailVerified: true });
    audit({ ...ctx, actor: user }, 'auth.email_verified', { targetType: 'user', targetId: user.id });
    return publicUser(accounts.users.byId(user.id));
  }
  // Always answers the same way, so nobody can learn which names or addresses exist.
  async function forgotPassword(identifier, ctx = {}, req = null) {
    identifier = String(identifier || '').trim().toLowerCase();
    const key = `reset:${ctx.ip || '-'}`;
    if (lockedFor([key])) throw fail(429, 'Çok fazla istek; daha sonra tekrar deneyin.', 'locked');
    accounts.attempts.fail(key, { max: 8, lockMs: 15 * 60000 });
    if (!identifier || identifier.length > 200 || !mailEnabled()) return;
    const user = accounts.users.byUsername(identifier) || accounts.users.byVerifiedEmail(identifier);
    if (!user || user.source !== 'local' || user.status !== 'active' || !user.email || !user.emailVerified) return;
    const token = accounts.tokens.create(user.id, 'reset', { ttlMs: RESET_MS });
    await mailer.send({ to: user.email, subject: 'Parola sıfırlama', text: `Merhaba ${user.displayName || user.username},\n\nParolanızı sıfırlamak için bağlantıya tıklayın (1 saat geçerli):\n${baseUrl(req)}/#/sifre-sifirla?token=${token}\n\nBu isteği siz yapmadıysanız bu iletiyi yok sayın; parolanız değişmez.` }).catch(() => {});
    audit({ ...ctx, actor: user }, 'auth.reset_requested', { targetType: 'user', targetId: user.id });
  }
  async function resetPassword({ token, password }, ctx = {}) {
    const peek = accounts.tokens.peek(String(token || ''), 'reset');
    const user = peek && accounts.users.byId(peek.userId);
    if (!user || user.source !== 'local' || user.status !== 'active') throw fail(400, 'Sıfırlama bağlantısı geçersiz veya süresi dolmuş.', 'bad_token');
    const problem = passwordProblem(password, user.username);
    if (problem) throw fail(400, problem, 'weak_password');
    accounts.tokens.consume(String(token), 'reset');
    accounts.users.update(user.id, { passwordHash: await hashPassword(password), mustChangePassword: false });
    accounts.sessions.revokeUser(user.id);
    accounts.attempts.clear(`u:${user.username.toLowerCase()}`);
    audit({ ...ctx, actor: user }, 'auth.password_reset', { targetType: 'user', targetId: user.id });
  }

  // First start: with no administrator, the documented default account exists and must change its password on first sign-in.
  async function bootstrapAdmin({ username = process.env.ADMIN_USERNAME || DEFAULT_ADMIN.username, password = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN.password, log = console.log } = {}) {
    if (accounts.users.countAdmins()) return null;
    if (accounts.users.byUsername(username)) { accounts.users.update(accounts.users.byUsername(username).id, { role: 'admin', status: 'active' }); return null; }
    const top = Plans.all().at(-1)?.id;
    const user = accounts.users.create({ username, displayName: 'Yönetici', passwordHash: await hashPassword(password), role: 'admin', planId: top, mustChangePassword: true });
    accounts.audit.log({ action: 'system.admin_created', targetType: 'user', targetId: user.id, detail: { username } });
    log(`İlk yönetici hesabı oluşturuldu: ${username}. İlk girişte parolanın değiştirilmesi zorunludur.`);
    return user;
  }

  return { accounts, settings, config, publicUser, effectivePlan, defaultPlanId, login, register, logout, changePassword, updateProfile, sendVerification, verifyEmail, forgotPassword, resetPassword,
    userFromRequest, resolveRequest, sessionCookie, tokenOf, startSession, bootstrapAdmin, hashPassword, verifyPassword, passwordProblem, audit, mailEnabled, ldapConfig, ldapOn, baseUrl,
    ldapClientFactory, COOKIE, DEFAULT_ADMIN, EMAIL, USERNAME };
}

module.exports = { createAuth, hashPassword, verifyPassword, passwordProblem, COOKIE, DEFAULT_ADMIN, fail };
