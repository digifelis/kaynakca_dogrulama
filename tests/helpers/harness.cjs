// Test harness for the account system: a real server (createServer with accounts), a temp data folder, a controllable
// clock, a captured mailbox, a fake LDAP directory and fake model providers (Groq chat, Gemini embeddings) that
// answer with token usage, so the real recording code paths run end to end.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const Identity = require('../../lib/identity.cjs');
const UsageContext = require('../../lib/usage-context.cjs');
const { createApp } = require('../../lib/app.cjs');
const { createServer } = require('../../server.cjs');
const wordService = require('../../word-service.cjs');
const writerService = require('../../writer-service.cjs');
const Plans = require('../../lib/plans.cjs');
const { makePdf } = require('../pdf-fixture.cjs');

const L = (...t) => t.map((x, i) => [72, 760 - i * 16, x]);
const PDF = makePdf([[...L('Digital transformation in higher education', 'Published 2021. Smith, J. and Brown, K.', '',
  'Digital learning platforms increased student engagement in universities during the pandemic years and this effect remained stable.',
  'Student engagement was strongly related to the quality of feedback that learners received from their instructors in all courses.')]]).toString('base64');

// A directory: users = { alice: { password, dn, mail, cn, memberOf: [...] } }. Records searches so tests can inspect filters.
function fakeDirectory(users, { down = false } = {}) {
  const log = { filters: [], binds: [] };
  const directory = { users, down, log };
  directory.factory = () => {
    const client = { async startTLS() {}, async unbind() {},
      async bind(dn, password) {
        if (directory.down) throw Object.assign(Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        log.binds.push(dn);
        const service = dn === 'cn=service,dc=test';
        const ok = service ? password === 'service-secret' : Object.values(users).some(u => u.dn === dn && u.password === password && password);
        if (!ok) throw Object.assign(Error('Invalid credentials'), { name: 'InvalidCredentialsError', code: 49 });
      },
      async search(base, options) {
        if (directory.down) throw Object.assign(Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        log.filters.push(options.filter);
        const match = /\(uid=([^)]*)\)$/.exec(options.filter);
        const hits = Object.entries(users).filter(([uid]) => match && match[1] === uid).map(([uid, u]) => ({ dn: u.dn, uid, mail: u.mail, cn: u.cn, memberOf: u.memberOf }));
        return { searchEntries: hits };
      } };
    if (directory.down) client.startTLS = async () => { throw Object.assign(Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); };
    return client;
  };
  return directory;
}

// Provider fakes: global fetch answers Groq chat completions and Gemini batch embeddings; everything else is real.
function fakeProviders({ promptTokens = 120, completionTokens = 30 } = {}) {
  const real = global.fetch, calls = { chat: 0, embed: 0 };
  global.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes('api.groq.com')) {
      calls.chat++;
      const body = JSON.parse(init.body), user = JSON.parse(body.messages[1].content);
      const answer = user.passages?.length ? 'Öğrenci katılımı geri bildirim kalitesiyle ilişkilidir [P1].' : 'Yeniden yazılmış metin.';
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ message: { content: JSON.stringify({ answer, insufficient: false }) } }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } }) };
    }
    if (target.includes('generativelanguage.googleapis.com')) {
      calls.embed++;
      const body = JSON.parse(init.body);
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ embeddings: body.requests.map((r, i) => ({ values: Array.from({ length: 8 }, (_, k) => ((i + k) % 5) + 1) })) }) };
    }
    return real(url, init);
  };
  return { calls, restore() { global.fetch = real; } };
}

async function harness({ ldap = null, startAt = Date.UTC(2026, 9, 3, 12), providers = true, smtp = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-'));
  process.env.WRITER_DATA_DIR = dir; process.env.WORD_ARCHIVE_DIR = path.join(dir, 'word');
  process.env.GROQ_API_KEY = 'groq-test'; process.env.GEMINI_API_KEY = 'gemini-test'; process.env.GEMINI_EMBEDDING_DIM = '128';
  delete process.env.OPENROUTER_API_KEY; delete process.env.ADMIN_USERNAME; delete process.env.ADMIN_PASSWORD;
  Identity._reset(); Plans.setProvider(null);
  const clock = { t: startAt }, mailbox = [];
  const app = createApp({ dir, now: () => clock.t, ldapClientFactory: ldap?.factory, publicUrl: 'http://127.0.0.1', transportFactory: () => ({ sendMail: async mail => { mailbox.push(mail); } }) });
  await app.auth.bootstrapAdmin({ log() {} });
  if (smtp) app.auth.settings.saveSmtp({ host: 'smtp.test', port: 587, from: 'Kaynakça <no-reply@test>' });
  wordService.useUsage(app.usage);
  wordService.useGuard(userId => { const user = app.accounts.users.byId(userId); if (user) Plans.enforce(app.auth.effectivePlan(user), 'monthlyTokens', app.usage.monthTokens(userId)); });
  const fakes = providers ? fakeProviders() : { calls: {}, restore() {} };
  const service = writerService.configure({ usage: app.usage, verifyMeta: async () => null });
  const writerStore = require('../../lib/writer-store.cjs').defaultStore();
  const server = createServer({ app, writerStore });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  // one browser: its own cookie jar
  const client = () => {
    let cookie = '';
    const call = async (method, url, body, { raw = false, headers = {} } = {}) => {
      const response = await fetch(base + url, { method, redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'x-word-request': '1', 'content-type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body) });
      for (const set of response.headers.getSetCookie?.() || []) { const pair = set.split(';')[0]; if (pair.endsWith('=')) cookie = ''; else cookie = pair; }
      if (raw) return response;
      const data = await response.json().catch(() => ({}));
      return { status: response.status, ...data };
    };
    call.cookie = () => cookie;
    return call;
  };
  const login = async (username, password) => { const api = client(); const result = await api('POST', '/api/auth/login', { username, password }); if (result.status !== 200) throw Error('login failed: ' + JSON.stringify(result)); return api; };
  // admin who has already replaced the default password (works on every call, also after the password was changed)
  const adminClient = async () => {
    const NEW = 'Yeni-Yonetici-Parola-1';
    const again = client(), result = await again('POST', '/api/auth/login', { username: 'admin@admin.com', password: NEW });
    if (result.status === 200) return again;
    const api = await login('admin@admin.com', 'admin');
    const changed = await api('POST', '/api/auth/change-password', { current: 'admin', next: NEW });
    if (changed.status !== 200) throw Error('password change failed: ' + JSON.stringify(changed));
    return api;
  };
  const register = async (username, password = 'Guclu-Parola-2026') => { const api = client(); const result = await api('POST', '/api/auth/register', { username, displayName: username, password }); if (result.status !== 201) throw Error('register failed: ' + JSON.stringify(result)); return api; };
  return { app, dir, clock, mailbox, fakes, server, base, client, login, adminClient, register, writerStore, service, PDF, UsageContext,
    async close() { await service.idle(); fakes.restore(); server.close(); server.closeAllConnections?.(); app.close(); } };
}

module.exports = { harness, fakeDirectory, PDF };
