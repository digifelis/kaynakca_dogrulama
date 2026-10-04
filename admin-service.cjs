// /api/admin/*: the administrator's panel API. Administrators see accounts, plans, operations, tokens and the audit
// trail; they never see what users wrote, asked, uploaded or answered (only counts, kinds, timings and token numbers).
// Every change is written to the audit log.
const Identity = require('./lib/identity.cjs');
const Plans = require('./lib/plans.cjs');
const Ldap = require('./lib/ldap-auth.cjs');
const { temporaryPassword } = require('./lib/app.cjs');

const MB = 1024 * 1024;
const httpError = (status, message, code) => Object.assign(Error(message), { status, code });
const int = (value, name, min, max) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw httpError(400, `${name} ${min} ile ${max} arasında bir tam sayı olmalıdır.`, 'bad_request');
  return n;
};
const text = (value, name, max, { required = false } = {}) => {
  const v = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (required && !v) throw httpError(400, `${name} gerekli.`, 'bad_request');
  if (v.length > max) throw httpError(400, `${name} en fazla ${max} karakter olabilir.`, 'bad_request');
  return v;
};

// Management of the LLM provider keys: straight on the local pool, or through the LLM service when jobs go to a queue.
function defaultLlmKeys() {
  const Backend = require('./lib/backend.cjs'), LlmKeys = require('./lib/llm-keys.cjs');
  const client = Backend.queue();
  if (!client) return LlmKeys.createLocalKeys();
  const publicKey = require('./lib/jwt.cjs').loadPublicKeys(process.env.JWT_KEYS_DIR || require('node:path').join(__dirname, 'keys')).llm;
  if (!publicKey) throw httpError(500, 'LLM servisinin genel anahtarı (keys/public/llm.public.pem) bulunamadı.');
  return LlmKeys.createQueueKeys({ client, publicKey, ready: () => Backend.workers('llm').length > 0 });
}

function createAdminService({ app, writerStore = null, wordService = null, llmKeys = null }) {
  const { accounts, auth, usage } = app;
  let keysApi = llmKeys;
  const keys = () => keysApi || (keysApi = defaultLlmKeys());
  const ip = req => (process.env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || '';
  async function readBody(req, limit = 256 * 1024) {
    let size = 0; const parts = [];
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw httpError(413, 'İstek çok büyük.'); parts.push(chunk); }
    try { const body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); return body && typeof body === 'object' ? body : {}; } catch { throw httpError(400, 'Geçersiz JSON.'); }
  }
  function requireAdmin(req, res) {
    const caller = Identity.requireUser(req, res);
    if (caller.role !== 'admin') throw httpError(403, 'Bu işlem için yönetici yetkisi gerekir.', 'forbidden');
    return { id: caller.userId, username: caller.user.username };
  }
  const record = (actor, req, action, targetType, targetId, detail) => accounts.audit.log({ actorId: actor.id, actorName: actor.username, ip: ip(req), action, targetType, targetId, detail });
  let reportsApi = null;
  const reports = () => reportsApi || (reportsApi = require('./lib/reports.cjs').createReports({ metrics: require('./lib/metrics.cjs').defaultMetrics(), appDb: app.appDb, names: ids => names(ids) }));
  const names = ids => Object.fromEntries([...new Set(ids.filter(Boolean))].map(id => [id, accounts.users.byId(id)?.username || null]));

  const userView = (user, extras = {}) => ({ ...auth.publicUser(user), ...extras });
  function listUsers(query) {
    const { total, users } = accounts.users.list({ search: query.get('search') || '', role: query.get('role') || '', status: query.get('status') || '', planId: query.get('plan') || '',
      source: query.get('source') || '', limit: Number(query.get('limit')) || 50, offset: Number(query.get('offset')) || 0, sort: query.get('sort') || 'created_at', direction: query.get('dir') || 'desc' });
    const ids = users.map(u => u.id), month = usage.monthTokensFor(ids), all = usage.totalTokensFor(ids), counts = writerStore?.countsFor(ids) || {};
    return { total, users: users.map(u => userView(u, { monthTokens: month[u.id]?.tokens || 0, monthOperations: month[u.id]?.operations || 0, totalTokens: all[u.id] || 0,
      projects: counts[u.id]?.projects || 0, documents: counts[u.id]?.documents || 0, activeSessions: accounts.sessions.countForUser(u.id), monthlyTokenLimit: Plans.limitsFor(auth.effectivePlan(u)).monthlyTokens })) };
  }
  function lastAdminGuard(target, next) {
    const stays = (next.role ?? target.role) === 'admin' && (next.status ?? target.status) === 'active';
    if (target.role === 'admin' && target.status === 'active' && !stays && accounts.users.countAdmins() <= 1) throw httpError(400, 'Son etkin yönetici hesabı kaldırılamaz veya devre dışı bırakılamaz.', 'last_admin');
  }

  function parseFeatures(value) {
    if (!Array.isArray(value) || value.some(id => !Plans.FEATURE_IDS.includes(id))) throw httpError(400, 'Alan listesi geçersiz.', 'bad_request');
    return Plans.FEATURE_IDS.filter(id => value.includes(id));
  }
  function parsePlan(input, existing) {
    const id = existing?.id || String(input.id || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,29}$/.test(id)) throw httpError(400, 'Paket kodu 2–30 karakter olmalı; küçük harf, rakam ve "-" kullanılabilir.', 'bad_request');
    return { id, title: text(input.title ?? existing?.title, 'Paket adı', 40, { required: true }), description: text(input.description ?? existing?.description ?? '', 'Açıklama', 300),
      sortOrder: int(input.sortOrder ?? existing?.sortOrder ?? (Math.max(0, ...accounts.plans.list().map(p => p.sortOrder)) + 1), 'Sıra', 0, 10000),
      projects: int(input.projects ?? existing?.projects, 'Proje sayısı', 1, 100000), documentsPerProject: int(input.documentsPerProject ?? existing?.documentsPerProject, 'Projedeki belge sayısı', 1, 100000),
      documentBytes: int(input.documentBytes ?? existing?.documentBytes, 'Belge boyutu', MB, 200 * MB), questionsPerDay: int(input.questionsPerDay ?? existing?.questionsPerDay, 'Günlük soru sayısı', 1, 10000000),
      monthlyTokens: int(input.monthlyTokens ?? existing?.monthlyTokens ?? 0, 'Aylık token kotası', 0, 100000000000),
      referencesPerDocument: int(input.referencesPerDocument ?? existing?.referencesPerDocument ?? 0, 'Belge başına kaynak sayısı', 0, 1000000), monthlyReferences: int(input.monthlyReferences ?? existing?.monthlyReferences ?? 0, 'Aylık sorgulanan kaynak sayısı', 0, 100000000),
      wordDocuments: int(input.wordDocuments ?? existing?.wordDocuments ?? 0, 'Kayıtlı Word/PDF belge sayısı', 0, 1000000), active: input.active ?? existing?.active ?? true,
      features: parseFeatures(input.features ?? existing?.features ?? Plans.defaultFeatures(id)) };
  }
  function parseLdap(input) {
    const out = {};
    out.enabled = input.enabled === true;
    out.url = text(input.url, 'Sunucu adresi', 300);
    if (out.url && !/^ldaps?:\/\/[^\s/]+(?::\d+)?\/?$/i.test(out.url)) throw httpError(400, 'Sunucu adresi ldap://sunucu:389 veya ldaps://sunucu:636 biçiminde olmalıdır.', 'bad_request');
    out.startTls = input.startTls === true; out.rejectUnauthorized = input.rejectUnauthorized !== false;
    out.caCert = text(input.caCert, 'CA sertifikası', 20000).length ? String(input.caCert).trim() : '';
    out.bindDn = text(input.bindDn, 'Servis hesabı (bind DN)', 500); out.baseDn = text(input.baseDn, 'Arama tabanı', 500);
    out.userFilter = text(input.userFilter || Ldap.DEFAULTS.userFilter, 'Kullanıcı filtresi', 500);
    if (!out.userFilter.includes('{username}')) throw httpError(400, 'Kullanıcı filtresi {username} içermelidir; örn. (uid={username}).', 'bad_request');
    for (const key of ['usernameAttr', 'emailAttr', 'nameAttr', 'groupAttr']) out[key] = text(input[key] || Ldap.DEFAULTS[key], key, 80);
    out.syncPlan = input.syncPlan !== false; out.defaultPlan = input.defaultPlan && Plans.all().some(p => p.id === input.defaultPlan) ? input.defaultPlan : '';
    const mappings = Array.isArray(input.groupMappings) ? input.groupMappings : [];
    if (mappings.length > 100) throw httpError(400, 'En fazla 100 grup eşlemesi tanımlanabilir.', 'bad_request');
    out.groupMappings = mappings.map(m => {
      const plan = m.plan ? String(m.plan) : '';
      if (plan && !Plans.all().some(p => p.id === plan)) throw httpError(400, `Eşlemede bilinmeyen paket: ${plan}`, 'bad_request');
      return { group: text(m.group, 'Grup', 500, { required: true }), plan, admin: m.admin === true };
    });
    out.bindPassword = typeof input.bindPassword === 'string' ? input.bindPassword : ''; out.clearBindPassword = input.clearBindPassword === true;
    if (out.enabled && (!out.url || !out.baseDn)) throw httpError(400, 'LDAP etkinleştirmek için sunucu adresi ve arama tabanı gerekli.', 'bad_request');
    return out;
  }
  function parseSmtp(input) {
    const out = { host: text(input.host, 'Sunucu', 255), port: input.port === '' || input.port == null ? 587 : int(input.port, 'Port', 1, 65535), secure: input.secure === true, requireTls: input.requireTls !== false,
      user: text(input.user, 'Kullanıcı', 255), from: text(input.from, 'Gönderen', 255), pass: typeof input.pass === 'string' ? input.pass : '', clearPass: input.clearPass === true };
    if (out.host && !out.from) throw httpError(400, 'Gönderen adresi gerekli (örn. Kaynakça Masası <noreply@ornek.com>).', 'bad_request');
    if (out.from && !/<?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(out.from)) throw httpError(400, 'Gönderen adresi geçerli bir e-posta içermelidir.', 'bad_request');
    return out;
  }
  // Writing-assistant embeddings: provider choice and TEI server options (kept as typed; prefixes may be empty).
  function parseEmbedding(input) {
    const Tei = require('./lib/tei-embed.cjs');
    const provider = input.provider === 'tei' ? 'tei' : 'gemini', { urls, invalid, tooMany } = Tei.normalizeUrls(input.url);
    if (invalid.length) throw httpError(400, 'Geçersiz sunucu adresi: ' + invalid.join(', ').slice(0, 200) + '. Adresler http:// veya https:// ile başlamalı; kullanıcı adı, parola ve sorgu içermemeli (her satıra bir adres).', 'bad_request');
    if (tooMany) throw httpError(400, 'En fazla 8 TEI sunucusu tanımlanabilir.', 'bad_request');
    if (provider === 'tei' && !urls.length) throw httpError(400, 'TEI kullanmak için en az bir sunucu adresi gerekli (örn. http://10.0.0.5:8082).', 'bad_request');
    const model = String(input.model || '').trim();
    if (model && !/^[\w.\/:-]{1,80}$/.test(model)) throw httpError(400, 'Model adı yalnızca harf, rakam ve . _ - / : içerebilir.', 'bad_request');
    const prefix = (value, label) => { const v = typeof value === 'string' ? value : ''; if (v.length > 40 || /[\r\n]/.test(v)) throw httpError(400, label + ' en fazla 40 karakter ve tek satır olmalı.', 'bad_request'); return v; };
    return { provider, url: urls.join('\n'), model, queryPrefix: prefix(input.queryPrefix, 'Sorgu öneki'), passagePrefix: prefix(input.passagePrefix, 'Belge öneki'),
      batch: int(input.batch || 8, 'Parti boyutu', 1, 64), concurrency: int(input.concurrency || 4, 'Eşzamanlı istek (sunucu başına)', 1, 8), timeoutSec: int(input.timeoutSec || 60, 'Zaman aşımı', 5, 600),
      apiKey: typeof input.apiKey === 'string' ? input.apiKey.trim() : '', clearApiKey: input.clearApiKey === true };
  }

  async function handle(req, res, url, json) {
    if (!url.pathname.startsWith('/api/admin')) return false;
    try {
      if (req.method !== 'GET' && req.headers['x-word-request'] !== '1') return json(res, 403, { error: 'Yerel uygulama isteği gerekli.' }), true;
      const actor = requireAdmin(req, res), q = url.searchParams;
      const route = url.pathname.slice('/api/admin'.length).replace(/\/$/, '');
      let m;
      const range = () => { const days = Math.min(365, Math.max(1, Number(q.get('days')) || 30)); return { since: q.get('since') ? Number(q.get('since')) : Date.now() - days * 86400000, until: q.get('until') ? Number(q.get('until')) : 0, days }; };

      if (route === '/overview' && req.method === 'GET') {
        const { since, days } = range(), stats = usage.stats({ since }), today = usage.stats({ since: require('./lib/usage.cjs').dayStart() }), month = usage.stats({ since: require('./lib/usage.cjs').monthStart() }), all = usage.stats({});
        const planTitles = Object.fromEntries(accounts.plans.list().map(p => [p.id, p.title])), summary = accounts.users.summary();
        const failed = usage.list({ status: 'error', limit: 8 }).operations, userNames = names([...failed.map(o => o.userId), ...stats.topUsers.map(u => u.userId)]);
        return json(res, 200, { users: { ...summary, byPlan: summary.byPlan.map(p => ({ ...p, title: planTitles[p.planId] || p.planId })) }, days,
          tokens: { today: today.totalTokens, month: month.totalTokens, total: all.totalTokens, range: stats.totalTokens, promptRange: stats.promptTokens, completionRange: stats.completionTokens },
          operations: { today: today.operations, month: month.operations, total: all.operations, range: stats.operations, errorsRange: stats.errors }, byKind: stats.byKind, byModel: stats.byModel, byDay: stats.byDay,
          topUsers: stats.topUsers.map(u => ({ ...u, username: userNames[u.userId] })), recentErrors: failed.map(o => ({ ...o, username: userNames[o.userId] })),
          settings: { ldapEnabled: auth.ldapOn(), emailEnabled: auth.mailEnabled(), registrationOpen: !!auth.settings.general().registrationOpen } }), true;
      }

      // ---- users
      if (route === '/users' && req.method === 'GET') return json(res, 200, listUsers(q)), true;
      if (route === '/users' && req.method === 'POST') {
        const input = await readBody(req);
        const username = String(input.username || '').trim();
        if (!auth.USERNAME.test(username)) throw httpError(400, 'Kullanıcı adı 3–64 karakter olmalı; harf, rakam ve . _ @ + - kullanılabilir.', 'bad_username');
        if (accounts.users.byUsername(username)) throw httpError(409, 'Bu kullanıcı adı kullanılıyor.', 'username_taken');
        const password = input.password ? String(input.password) : temporaryPassword();
        const problem = input.password && auth.passwordProblem(password, username);
        if (problem) throw httpError(400, problem, 'weak_password');
        const email = input.email ? String(input.email).trim().toLowerCase() : null;
        if (email && !auth.EMAIL.test(email)) throw httpError(400, 'Geçerli bir e-posta adresi girin.', 'bad_email');
        const planId = input.planId || auth.defaultPlanId();
        if (!Plans.all().some(p => p.id === planId)) throw httpError(400, 'Bilinmeyen paket.', 'bad_request');
        const user = accounts.users.create({ username, displayName: text(input.displayName || username, 'Ad', 80), email, passwordHash: await auth.hashPassword(password), role: input.role === 'admin' ? 'admin' : 'user',
          planId, planExpiresAt: input.planExpiresAt ? Number(input.planExpiresAt) : null, mustChangePassword: input.mustChangePassword !== false });
        record(actor, req, 'admin.user_created', 'user', user.id, { username, role: user.role, plan: planId });
        return json(res, 201, { user: userView(user), temporaryPassword: input.password ? null : password }), true;
      }
      if ((m = route.match(/^\/users\/([0-9a-f]{32})(?:\/(reset-password|logout))?$/))) {
        const target = accounts.users.byId(m[1]);
        if (!target) throw httpError(404, 'Kullanıcı bulunamadı.', 'not_found');
        if (!m[2] && req.method === 'GET') {
          const counts = writerStore?.countsFor([target.id])[target.id] || { projects: 0, documents: 0 };
          return json(res, 200, { user: userView(target, { activeSessions: accounts.sessions.countForUser(target.id), ...counts, monthlyTokenLimit: Plans.limitsFor(auth.effectivePlan(target)).monthlyTokens }),
            usage: usage.summary(target.id), operations: usage.list({ userId: target.id, limit: 20 }).operations, audit: accounts.audit.list({ actor: target.id, limit: 20 }).entries }), true;
        }
        if (!m[2] && req.method === 'PATCH') {
          const input = await readBody(req), fields = {};
          if (input.displayName !== undefined) fields.displayName = text(input.displayName, 'Ad', 80);
          if (input.email !== undefined) {
            const email = input.email ? String(input.email).trim().toLowerCase() : null;
            if (email && !auth.EMAIL.test(email)) throw httpError(400, 'Geçerli bir e-posta adresi girin.', 'bad_email');
            Object.assign(fields, { email, emailVerified: input.emailVerified === true && !!email });
          }
          if (input.role !== undefined) { if (!['user', 'admin'].includes(input.role)) throw httpError(400, 'Geçersiz rol.', 'bad_request'); fields.role = input.role; }
          if (input.status !== undefined) { if (!['active', 'disabled'].includes(input.status)) throw httpError(400, 'Geçersiz durum.', 'bad_request'); fields.status = input.status; }
          if (input.planId !== undefined) { if (!Plans.all().some(p => p.id === input.planId)) throw httpError(400, 'Bilinmeyen paket.', 'bad_request'); fields.planId = input.planId; }
          if (input.planExpiresAt !== undefined) fields.planExpiresAt = input.planExpiresAt ? int(input.planExpiresAt, 'Paket bitiş tarihi', 1, 8.64e15) : null;
          if (input.mustChangePassword !== undefined) fields.mustChangePassword = input.mustChangePassword === true;
          if (target.id === actor.id && ((fields.role && fields.role !== 'admin') || (fields.status && fields.status !== 'active'))) throw httpError(400, 'Kendi yönetici hesabınızı değiştiremezsiniz.', 'self_change');
          lastAdminGuard(target, fields);
          const updated = accounts.users.update(target.id, fields);
          if (fields.status === 'disabled') accounts.sessions.revokeUser(target.id);
          const changed = {};
          for (const key of Object.keys(fields)) if (key !== 'emailVerified' && fields[key] !== target[key]) changed[key] = { from: target[key] ?? null, to: fields[key] };
          record(actor, req, 'admin.user_updated', 'user', target.id, { username: target.username, changed });
          return json(res, 200, { user: userView(updated) }), true;
        }
        if (!m[2] && req.method === 'DELETE') {
          if (target.id === actor.id) throw httpError(400, 'Kendi hesabınızı silemezsiniz.', 'self_change');
          lastAdminGuard(target, { status: 'deleted' });
          const removedRows = writerStore?.deleteUserData(target.id) || 0, removedDocs = wordService?.removeUserDocuments(target.id) || 0;
          accounts.sessions.revokeUser(target.id); accounts.users.delete(target.id);
          record(actor, req, 'admin.user_deleted', 'user', target.id, { username: target.username, writerRows: removedRows, wordDocuments: removedDocs });
          return json(res, 200, { deleted: true }), true;
        }
        if (m[2] === 'reset-password' && req.method === 'POST') {
          if (target.source !== 'local') throw httpError(400, 'Dizin (LDAP) kullanıcılarının parolası dizinde yönetilir.', 'managed_externally');
          const input = await readBody(req), password = input.password ? String(input.password) : temporaryPassword();
          const problem = input.password && auth.passwordProblem(password, target.username);
          if (problem) throw httpError(400, problem, 'weak_password');
          accounts.users.update(target.id, { passwordHash: await auth.hashPassword(password), mustChangePassword: true });
          accounts.sessions.revokeUser(target.id); accounts.attempts.clear(`u:${target.username.toLowerCase()}`);
          record(actor, req, 'admin.password_reset', 'user', target.id, { username: target.username });
          return json(res, 200, { temporaryPassword: input.password ? null : password }), true;
        }
        if (m[2] === 'logout' && req.method === 'POST') {
          const n = accounts.sessions.revokeUser(target.id);
          record(actor, req, 'admin.user_logout', 'user', target.id, { username: target.username, sessions: n });
          return json(res, 200, { revoked: n }), true;
        }
      }

      // ---- plans
      if (route === '/plans' && req.method === 'GET') return json(res, 200, { plans: accounts.plans.list().map(p => ({ ...p, users: accounts.plans.usersOn(p.id) })), featureCatalog: Plans.FEATURES }), true;
      if (route === '/plans' && req.method === 'POST') {
        const input = await readBody(req), plan = parsePlan(input);
        if (accounts.plans.get(plan.id)) throw httpError(409, 'Bu paket kodu kullanılıyor.', 'plan_exists');
        accounts.plans.save(plan); record(actor, req, 'admin.plan_created', 'plan', plan.id, plan);
        return json(res, 201, { plan: accounts.plans.get(plan.id) }), true;
      }
      if ((m = route.match(/^\/plans\/([a-z0-9-]{2,30})$/))) {
        const existing = accounts.plans.get(m[1]);
        if (!existing) throw httpError(404, 'Paket bulunamadı.', 'not_found');
        if (req.method === 'PUT') {
          const plan = parsePlan(await readBody(req), existing);
          if (plan.active === false && accounts.plans.list().filter(p => p.active && p.id !== plan.id).length === 0) throw httpError(400, 'En az bir paket etkin kalmalıdır.', 'last_plan');
          accounts.plans.save(plan);
          const changed = {}; for (const key of Object.keys(plan)) if (plan[key] !== existing[key]) changed[key] = { from: existing[key], to: plan[key] };
          record(actor, req, 'admin.plan_updated', 'plan', plan.id, { changed });
          return json(res, 200, { plan: accounts.plans.get(plan.id) }), true;
        }
        if (req.method === 'DELETE') {
          const others = accounts.plans.list().filter(p => p.id !== existing.id);
          if (!others.length) throw httpError(400, 'Son paket silinemez.', 'last_plan');
          const users = accounts.plans.usersOn(existing.id), target = q.get('reassign') || '';
          if (users && !others.some(p => p.id === target)) throw httpError(409, `Bu pakette ${users} kullanıcı var; silmek için kullanıcıların taşınacağı paketi belirtin (reassign).`, 'plan_in_use');
          const moved = users ? accounts.plans.reassign(existing.id, target) : 0;
          if (auth.settings.general().defaultPlan === existing.id) auth.settings.saveGeneral({ ...auth.settings.general(), defaultPlan: '' });
          accounts.plans.remove(existing.id);
          record(actor, req, 'admin.plan_deleted', 'plan', existing.id, { reassignedTo: target || null, users: moved });
          return json(res, 200, { deleted: true, moved }), true;
        }
      }

      // ---- Model prompts and the writing assistant's skills. Every change is audited (the text itself is not).
      if ((m = route.match(/^\/prompts(?:\/([a-z_]{3,40}))?$/))) {
        const Prompts = require('./lib/prompts.cjs'), id = m[1] || '';
        if (!id && req.method === 'GET') return json(res, 200, { prompts: Prompts.list(), maxChars: Prompts.MAX_CHARS }), true;
        if (id && req.method === 'PUT') {
          const body = await readBody(req, 64 * 1024), prompt = Prompts.set(id, body.content, actor.username);
          record(actor, req, 'prompt.updated', 'prompt', id, { chars: prompt.content.length });
          return json(res, 200, { prompt }), true;
        }
        if (id && req.method === 'DELETE') {
          const prompt = Prompts.reset(id);
          record(actor, req, 'prompt.reset', 'prompt', id, {});
          return json(res, 200, { prompt }), true;
        }
      }
      if ((m = route.match(/^\/skills(?:\/([a-z0-9-]{1,40}))?(\/reset)?$/))) {
        const Skills = require('./lib/writer-skills.cjs'), name = m[1] || '';
        const input = () => readBody(req, 64 * 1024);
        if (!name && req.method === 'GET') return json(res, 200, { ...Skills.adminList(), plans: Plans.all().map(p => ({ id: p.id, title: p.title })), defaultSkill: Skills.DEFAULT_SKILL }), true;
        if (!name && req.method === 'POST') {
          const body = await input(), skill = Skills.save(body, actor.username, { create: true });
          record(actor, req, 'skill.created', 'skill', skill.name, { title: skill.title });
          return json(res, 201, { skill }), true;
        }
        if (name && !m[2] && req.method === 'PUT') {
          const skill = Skills.save({ ...(await input()), name }, actor.username);
          record(actor, req, 'skill.updated', 'skill', name, { title: skill.title });
          return json(res, 200, { skill }), true;
        }
        if (name && !m[2] && req.method === 'DELETE') {
          const result = Skills.remove(name, actor.username);
          record(actor, req, 'skill.removed', 'skill', name, { hidden: result.hidden });
          return json(res, 200, result), true;
        }
        if (name && m[2] && req.method === 'POST') {
          const skill = Skills.reset(name);
          record(actor, req, 'skill.reset', 'skill', name, {});
          return json(res, 200, { skill }), true;
        }
      }

      // ---- LLM provider keys (Groq, OpenRouter, Gemini). Key values are never returned, logged or audited: only the last four characters.
      if ((m = route.match(/^\/llm-keys(?:\/([0-9a-z-]{8,64}))?(\/test)?$/))) {
        const id = m[1] || '', body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req, 16 * 1024);
        const label = value => text(value, 'Etiket', 60), group = value => text(value, 'Grup', 40);
        const limit = (value, name) => value === null || value === '' || value === undefined ? null : int(value, name, 0, 10000000);
        const mode = () => (keys().mode || 'local');
        if (!id && req.method === 'GET') return json(res, 200, { ...(await keys().run({ action: 'list' })), mode: mode() }), true;
        if (!id && req.method === 'POST') {
          const provider = String(body.provider || '');
          if (!['groq', 'openrouter', 'gemini'].includes(provider)) throw httpError(400, 'Sağlayıcı groq, openrouter veya gemini olmalıdır.', 'bad_request');
          const result = await keys().run({ action: 'add', provider, label: label(body.label), key: String(body.key || ''), group: group(body.group), rpm: limit(body.rpm, 'Dakikalık sınır'), rpd: limit(body.rpd, 'Günlük sınır') });
          record(actor, req, 'llm.key_added', 'llm_key', result.key.id, { provider, label: result.key.label, last4: result.key.last4, group: result.key.group || null });
          return json(res, 201, result), true;
        }
        if (id && m[2] && req.method === 'POST') {
          const result = await keys().run({ action: 'test', id });
          record(actor, req, 'llm.key_tested', 'llm_key', id, { provider: result.key?.provider, label: result.key?.label, ok: !!result.ok });
          return json(res, 200, result), true;
        }
        if (id && !m[2] && req.method === 'PATCH') {
          const patch = { action: 'update', id };
          if ('label' in body) patch.label = label(body.label);
          if ('group' in body) patch.group = group(body.group);
          if ('rpm' in body) patch.rpm = limit(body.rpm, 'Dakikalık sınır');
          if ('rpd' in body) patch.rpd = limit(body.rpd, 'Günlük sınır');
          if ('enabled' in body) patch.enabled = !!body.enabled;
          if (body.key) patch.key = String(body.key);
          const result = await keys().run(patch);
          record(actor, req, patch.key ? 'llm.key_replaced' : 'llm.key_updated', 'llm_key', id, { provider: result.key.provider, label: result.key.label, last4: result.key.last4, changed: Object.keys(patch).filter(k => !['action', 'id', 'key'].includes(k)) });
          return json(res, 200, result), true;
        }
        if (id && !m[2] && req.method === 'DELETE') {
          const before = (await keys().run({ action: 'list' })).keys.find(k => k.id === id);
          await keys().run({ action: 'remove', id });
          record(actor, req, 'llm.key_removed', 'llm_key', id, { provider: before?.provider, label: before?.label, last4: before?.last4 });
          return json(res, 200, { removed: true }), true;
        }
        return json(res, 405, { error: 'Desteklenmeyen yöntem' }), true;
      }

      // ---- operations, tokens, audit
      if (route === '/operations' && req.method === 'GET') {
        let userId = q.get('user') || '';
        if (userId && !/^[0-9a-f]{32}$/.test(userId)) userId = accounts.users.byUsername(userId)?.id || 'none';
        const result = usage.list({ userId, kind: q.get('kind') || '', status: q.get('status') || '', since: Number(q.get('since')) || 0, until: Number(q.get('until')) || 0, limit: Number(q.get('limit')) || 50, offset: Number(q.get('offset')) || 0 });
        const userNames = names(result.operations.map(o => o.userId));
        return json(res, 200, { total: result.total, operations: result.operations.map(o => ({ ...o, username: userNames[o.userId] })) }), true;
      }
      if ((m = route.match(/^\/operations\/([0-9a-f-]{36})$/)) && req.method === 'GET') {
        const operation = usage.detail(m[1]);
        if (!operation) throw httpError(404, 'İşlem bulunamadı.', 'not_found');
        return json(res, 200, { operation: { ...operation, username: names([operation.userId])[operation.userId] } }), true;
      }
      if (route === '/stats' && req.method === 'GET') {
        const { since, until } = range(), stats = usage.stats({ since, until }), userNames = names(stats.topUsers.map(u => u.userId));
        return json(res, 200, { ...stats, topUsers: stats.topUsers.map(u => ({ ...u, username: userNames[u.userId] })) }), true;
      }
      // ---- reports: performance and experience metrics (lib/reports.cjs); ?format=csv&table=<name> exports one table
      if ((m = route.match(/^\/reports\/(summary|performance|errors|usage|experience|capacity)$/)) && req.method === 'GET') {
        const { since, until } = range(), report = reports()[m[1]]({ since, until });
        if (q.get('format') === 'csv') {
          const table = report[q.get('table') || ''];
          if (!Array.isArray(table)) throw httpError(400, 'Dışa aktarılacak tablo bulunamadı.', 'bad_request');
          const cols = [...new Set(table.flatMap(row => Object.keys(row)))], cell = v => { const t = v == null ? '' : String(v); return /[",;\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
          const body = '﻿' + [cols.join(';'), ...table.map(row => cols.map(c => cell(row[c])).join(';'))].join('\r\n');
          res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="rapor-${m[1]}-${q.get('table')}.csv"`, 'Cache-Control': 'no-store' }); res.end(body);
          return true;
        }
        return json(res, 200, report), true;
      }
      if (route === '/audit' && req.method === 'GET') {
        const result = accounts.audit.list({ action: q.get('action') || '', actor: q.get('actor') || '', since: Number(q.get('since')) || 0, until: Number(q.get('until')) || 0, limit: Number(q.get('limit')) || 100, offset: Number(q.get('offset')) || 0 });
        return json(res, 200, result), true;
      }

      // ---- settings
      if (route === '/settings' && req.method === 'GET') return json(res, 200, { general: auth.settings.general(), ldap: auth.settings.ldap(), smtp: auth.settings.smtp(), plans: accounts.plans.list().map(p => ({ id: p.id, title: p.title })), ldapActive: auth.ldapOn(), emailActive: auth.mailEnabled() }), true;
      if (route === '/settings/general' && req.method === 'PUT') {
        const input = await readBody(req), defaultPlan = input.defaultPlan || '';
        if (defaultPlan && !Plans.all().some(p => p.id === defaultPlan)) throw httpError(400, 'Bilinmeyen paket.', 'bad_request');
        const next = { registrationOpen: input.registrationOpen !== false, defaultPlan };
        auth.settings.saveGeneral(next); record(actor, req, 'admin.settings_general', 'settings', 'general', next);
        return json(res, 200, { general: auth.settings.general() }), true;
      }
      if (route === '/settings/ldap' && req.method === 'PUT') {
        const input = parseLdap(await readBody(req)); auth.settings.saveLdap(input);
        record(actor, req, 'admin.settings_ldap', 'settings', 'ldap', { enabled: input.enabled, url: input.url, baseDn: input.baseDn, mappings: input.groupMappings.length, bindPasswordChanged: !!input.bindPassword });
        return json(res, 200, { ldap: auth.settings.ldap() }), true;
      }
      if (route === '/settings/ldap/test' && req.method === 'POST') {
        const body = await readBody(req), saved = auth.settings.ldap({ secret: true });
        const config = body.config ? { ...parseLdap({ ...body.config, enabled: true }), bindPassword: body.config.bindPassword || saved.bindPassword || '' } : saved;
        const result = await Ldap.test(config, { username: String(body.username || ''), password: String(body.password || '') }, { clientFactory: auth.ldapClientFactory });
        record(actor, req, 'admin.ldap_test', 'settings', 'ldap', { ok: result.ok });
        return json(res, 200, result), true;
      }
      // ---- shared cache of public lookups (verified references, full texts, PDF extractions, embeddings)
      if ((m = route.match(/^\/cache(?:\/(verification|fulltext|extraction|embedding|all))?$/))) {
        const Cache = require('./lib/cache-store.cjs').defaultCache();
        if (!m[1] && req.method === 'GET') return json(res, 200, Cache.stats()), true;
        if (m[1] && req.method === 'DELETE') {
          const removed = Cache.clear(m[1] === 'all' ? '' : m[1]);
          record(actor, req, 'cache.cleared', 'cache', m[1], { removed });
          return json(res, 200, { removed, ...Cache.stats() }), true;
        }
      }
      // ---- Semantic Scholar API key (paper search of the writing assistant). The value is sealed and never returned, logged or audited.
      if (route === '/settings/scholar' || route === '/settings/scholar/test') {
        const Scholar = require('./lib/scholar.cjs');
        const view = () => { const s = auth.settings.scholar(); return { keySet: s.keySet, last4: s.last4 || '', envKey: !!process.env.SEMANTIC_SCHOLAR_API_KEY && !s.keySet, active: Scholar.configured() }; };
        if (route === '/settings/scholar' && req.method === 'GET') return json(res, 200, { scholar: view() }), true;
        if (route === '/settings/scholar' && req.method === 'PUT') {
          const body = await readBody(req, 8 * 1024);
          if (body.clear) { auth.settings.saveScholar({ clear: true }); record(actor, req, 'scholar.key_removed', 'settings', 'scholar', {}); return json(res, 200, { scholar: view() }), true; }
          const key = String(body.key || '').trim();
          if (key.length < 8 || key.length > 200 || /\s/.test(key)) throw httpError(400, 'API anahtarı 8-200 karakter olmalı ve boşluk içermemelidir.', 'bad_request');
          const test = await Scholar.check(key);
          if (test.rejected) throw httpError(400, test.message, 'bad_key');
          auth.settings.saveScholar({ key });
          record(actor, req, 'scholar.key_set', 'settings', 'scholar', { last4: key.slice(-4), tested: test.ok });
          return json(res, 200, { scholar: view(), test }), true;
        }
        if (route === '/settings/scholar/test' && req.method === 'POST') {
          const test = await Scholar.check(Scholar.apiKey());
          record(actor, req, 'scholar.key_tested', 'settings', 'scholar', { ok: test.ok });
          return json(res, 200, { ...test, scholar: view() }), true;
        }
      }
      // ---- Embedding provider (Gemini or a self-hosted TEI server). Vectors of different models are not comparable, so a change applies to documents added afterwards.
      if (route === '/settings/embedding' || route === '/settings/embedding/test') {
        const Tei = require('./lib/tei-embed.cjs');
        const view = () => { const s = auth.settings.embedding(); return { provider: s.provider || 'gemini', url: s.url || '', model: s.model || '', queryPrefix: s.queryPrefix ?? 'query: ', passagePrefix: s.passagePrefix ?? 'passage: ', batch: s.batch || 8, concurrency: s.concurrency || 4, timeoutSec: s.timeoutSec || 60, apiKeySet: !!s.apiKeySet, active: Tei.active() }; };
        if (route === '/settings/embedding' && req.method === 'GET') return json(res, 200, { embedding: view() }), true;
        if (route === '/settings/embedding' && req.method === 'PUT') {
          const input = parseEmbedding(await readBody(req, 8 * 1024)); auth.settings.saveEmbedding(input);
          record(actor, req, 'admin.settings_embedding', 'settings', 'embedding', { provider: input.provider, servers: input.url ? input.url.split('\n').length : 0, url: input.url.replace(/\n/g, ' '), model: input.model, keyChanged: !!input.apiKey });
          return json(res, 200, { embedding: view() }), true;
        }
        if (route === '/settings/embedding/test' && req.method === 'POST') {
          // Tests the values in the form (saved token is used when the field is left blank), without saving them.
          const input = parseEmbedding({ ...(await readBody(req, 8 * 1024)), provider: 'tei' }), saved = auth.settings.embedding({ secret: true });
          const result = await Tei.check(Tei.settings({ ...input, apiKey: input.apiKey || (input.clearApiKey ? '' : saved.apiKey || '') }));
          record(actor, req, 'admin.embedding_test', 'settings', 'embedding', { ok: result.ok, url: input.url.replace(/\n/g, ' ') });
          return json(res, 200, result), true;
        }
      }
      if (route === '/settings/smtp' && req.method === 'PUT') {
        const input = parseSmtp(await readBody(req)); auth.settings.saveSmtp(input);
        record(actor, req, 'admin.settings_smtp', 'settings', 'smtp', { host: input.host, port: input.port, secure: input.secure, passwordChanged: !!input.pass });
        return json(res, 200, { smtp: auth.settings.smtp(), emailActive: auth.mailEnabled() }), true;
      }
      if (route === '/settings/smtp/test' && req.method === 'POST') {
        const to = String((await readBody(req)).to || '').trim();
        if (!auth.EMAIL.test(to)) throw httpError(400, 'Geçerli bir alıcı adresi girin.', 'bad_email');
        try { await app.mailer.send({ to, subject: 'Kaynakça Masası test iletisi', text: 'E-posta ayarlarınız çalışıyor.' }); } catch (error) { return json(res, 200, { ok: false, error: String(error.message || error).slice(0, 300) }), true; }
        record(actor, req, 'admin.smtp_test', 'settings', 'smtp', { to });
        return json(res, 200, { ok: true }), true;
      }
      return json(res, 404, { error: 'İşlem bulunamadı.' }), true;
    } catch (error) {
      json(res, error.status || 400, { error: error.message || 'İşlem tamamlanamadı.', ...(error.code ? { code: error.code } : {}) });
      return true;
    }
  }
  return { handle };
}

module.exports = { createAdminService };
