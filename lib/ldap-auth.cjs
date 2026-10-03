// LDAP / Active Directory sign-in: a service account finds the user's DN, then the user's own password is checked
// with a bind. Nothing here stores passwords. Settings come from the admin panel (bind password already opened).
const Plans = require('./plans.cjs');

const DEFAULTS = { userFilter: '(uid={username})', usernameAttr: 'uid', emailAttr: 'mail', nameAttr: 'cn', groupAttr: 'memberOf', timeoutMs: 10000 };

// RFC 4515: the typed username can never change the shape of the search filter.
const escapeFilter = value => String(value).replace(/[\\*()\0]/g, c => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
const first = value => Array.isArray(value) ? (value[0] == null ? '' : String(value[0])) : value == null ? '' : String(value);
const all = value => (Array.isArray(value) ? value : value == null || value === '' ? [] : [value]).map(String);
const cn = dn => String(dn).match(/^\s*cn\s*=\s*((?:\\.|[^,\\])+)/i)?.[1]?.trim().toLowerCase() || '';

function defaultFactory(config) {
  const { Client } = require('ldapts');
  return new Client({ url: config.url, timeout: config.timeoutMs, connectTimeout: config.timeoutMs,
    tlsOptions: { rejectUnauthorized: config.rejectUnauthorized !== false, ...(config.caCert ? { ca: config.caCert } : {}) } });
}
const usable = config => !!(config?.enabled && config.url && config.baseDn);

// groupMappings: [{ group: 'cn=editors,ou=groups,dc=x', plan: 'premium', admin: false }]. The highest mapped plan wins.
function mapGroups(groups, mappings = [], fallbackPlan) {
  const have = new Set(groups.flatMap(g => [String(g).trim().toLowerCase(), cn(g)]).filter(Boolean));
  let plan = fallbackPlan || Plans.all()[0]?.id || 'basic', admin = false;
  for (const mapping of mappings) {
    const wanted = String(mapping.group || '').trim().toLowerCase();
    // A mapping is either the group's full DN or just its name (the CN); both are compared case-insensitively.
    if (!wanted || !have.has(wanted)) continue;
    if (mapping.plan && Plans.rank(mapping.plan) > Plans.rank(plan)) plan = mapping.plan;
    if (mapping.admin) admin = true;
  }
  return { plan: Plans.known(plan), admin };
}

async function connect(config, factory) {
  const client = factory({ ...DEFAULTS, ...config });
  if (config.startTls) await client.startTLS({ rejectUnauthorized: config.rejectUnauthorized !== false, ...(config.caCert ? { ca: config.caCert } : {}) });
  return client;
}
async function findUser(config, username, factory) {
  const settings = { ...DEFAULTS, ...config };
  const client = await connect(settings, factory);
  try {
    if (settings.bindDn) await client.bind(settings.bindDn, settings.bindPassword || '');
    const filter = settings.userFilter.replace(/\{username\}/g, escapeFilter(username));
    const { searchEntries } = await client.search(settings.baseDn, { scope: 'sub', filter, sizeLimit: 2,
      attributes: [settings.usernameAttr, settings.emailAttr, settings.nameAttr, settings.groupAttr].filter(Boolean) });
    return searchEntries;
  } finally { await client.unbind().catch(() => {}); }
}

// Returns the directory profile on success, or null when the user is unknown or the password is wrong.
// Throws only when the directory itself cannot be reached (so the caller can say "LDAP unavailable").
async function authenticate(config, username, password, { clientFactory = defaultFactory } = {}) {
  if (!usable(config)) return null;
  // An empty password would turn the bind into an anonymous (always successful) bind on many servers.
  if (!username || !password || /[\0]/.test(username + password)) return null;
  const settings = { ...DEFAULTS, ...config };
  const entries = await findUser(config, username, clientFactory);
  if (entries.length !== 1) return null;
  const entry = entries[0];
  const client = await connect(settings, clientFactory);
  try { await client.bind(entry.dn, password); }
  catch (error) { if (/InvalidCredentials|49/.test(`${error?.name} ${error?.code} ${error?.message}`)) return null; throw error; }
  finally { await client.unbind().catch(() => {}); }
  const groups = all(entry[settings.groupAttr]);
  const { plan, admin } = mapGroups(groups, config.groupMappings, config.defaultPlan);
  return { dn: entry.dn, username: first(entry[settings.usernameAttr]) || username, email: first(entry[settings.emailAttr]) || null,
    displayName: first(entry[settings.nameAttr]) || username, groups, plan, admin };
}
// Existence check without a password (registration must not take a name that belongs to the directory).
async function exists(config, username, { clientFactory = defaultFactory } = {}) {
  if (!usable(config) || !username) return false;
  return (await findUser(config, username, clientFactory)).length > 0;
}
// Connection check for the admin panel: reports each step, never the passwords.
async function test(config, { username = '', password = '' } = {}, { clientFactory = defaultFactory } = {}) {
  const steps = [];
  const step = async (name, run) => { try { const detail = await run(); steps.push({ name, ok: true, detail: detail || '' }); return true; } catch (error) { steps.push({ name, ok: false, detail: String(error?.message || error).slice(0, 300) }); return false; } };
  if (!config?.url || !config.baseDn) return { ok: false, steps: [{ name: 'Ayarlar', ok: false, detail: 'Sunucu adresi ve arama tabanı gerekli.' }] };
  const settings = { ...DEFAULTS, ...config };
  let client;
  if (!await step('Bağlantı' + (config.startTls ? ' (StartTLS)' : ''), async () => { client = await connect(settings, clientFactory); })) return { ok: false, steps };
  const bound = await step('Servis hesabıyla bağlanma', async () => { if (settings.bindDn) await client.bind(settings.bindDn, settings.bindPassword || ''); return settings.bindDn ? '' : 'Anonim bağlanıldı'; });
  await client.unbind().catch(() => {});
  if (bound && username) {
    await step('Kullanıcı arama', async () => { const found = await findUser(config, username, clientFactory); if (found.length !== 1) throw Error(found.length ? 'Birden fazla kayıt bulundu; filtreyi daraltın.' : 'Kullanıcı bulunamadı.'); return found[0].dn; });
    if (password) await step('Kullanıcı parolasıyla giriş', async () => { const profile = await authenticate(config, username, password, { clientFactory }); if (!profile) throw Error('Parola reddedildi.'); return `Paket: ${profile.plan}${profile.admin ? ', yönetici' : ''}, grup sayısı: ${profile.groups.length}`; });
  }
  return { ok: steps.every(s => s.ok), steps };
}

module.exports = { authenticate, exists, test, mapGroups, escapeFilter, usable, DEFAULTS };
