// Management of the LLM provider keys (Groq, OpenRouter, Gemini) for the admin panel.
// Local mode: the web process owns the key pool and acts on it directly.
// Queue mode: the keys live only in the LLM service. The web process sends management jobs (kind "keys");
// a key typed in the panel travels as an RSA-OAEP/AES-GCM envelope sealed to the LLM service's public key,
// so it never sits in the queue in readable form.
const crypto = require('node:crypto');
const KeyPool = require('./key-pool.cjs');

const ACTIONS = ['list', 'add', 'update', 'remove', 'test'];
const fail = (status, message) => Object.assign(Error(message), { status });

// ---- envelope: random AES-256-GCM key sealed with the service's RSA public key ----
function seal(secret, publicKey) {
  const aes = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aes, iv);
  const data = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  const wrapped = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aes);
  return { v: 1, k: wrapped.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function open(envelope, privateKey) {
  try {
    if (envelope?.v !== 1) throw Error('sürüm');
    const aes = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(envelope.k, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', aes, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8');
  } catch { throw fail(400, 'Şifreli anahtar çözülemedi.'); }
}

// ---- the actions, shared by local mode and the LLM service ----
// `secrets` is { key } in clear text (already opened by the caller).
async function perform(pool, { action, id, provider, label, group, rpm, rpd, enabled }, secrets = {}, { signal } = {}) {
  switch (action) {
    case 'list': return { keys: pool.list(), summary: pool.summary() };
    case 'add': {
      const result = await pool.check(provider, String(secrets.key || '').trim(), { signal });
      if (!result.ok) throw fail(400, `Anahtar eklenmedi: ${result.message}`);
      const key = pool.add({ provider, label, key: secrets.key, group, rpm, rpd });
      return { key, test: { ok: true, quota: !!result.quota, message: result.message } };
    }
    case 'update': {
      const patch = { label, group, rpm, rpd, enabled };
      for (const name of Object.keys(patch)) if (patch[name] === undefined) delete patch[name];
      if (secrets.key) {
        const current = pool.list().find(item => item.id === id);
        if (!current) throw fail(404, 'Anahtar bulunamadı.');
        const result = await pool.check(current.provider, String(secrets.key).trim(), { signal });
        if (!result.ok) throw fail(400, `Anahtar değiştirilmedi: ${result.message}`);
        patch.key = secrets.key;
      }
      return { key: pool.update(id, patch) };
    }
    case 'remove': return { removed: pool.remove(id) };
    case 'test': return pool.test(id, { signal });
    default: throw fail(400, 'Geçersiz anahtar işlemi.');
  }
}

// Errors from the pool are the operator's own typing mistakes; they carry a 400 unless they already have a status.
const clientError = error => { if (!error.status) error.status = 400; return error; };

function createLocalKeys({ pool = KeyPool.pool } = {}) {
  const resolve = typeof pool === 'function' ? pool : () => pool;
  return { mode: 'local', async run(payload, options) { try { return await perform(resolve(), payload, { key: payload.key }, options); } catch (error) { throw clientError(error); } } };
}

// `client` is the queue client; `publicKey` the LLM service's RSA public key (kid "llm").
function createQueueKeys({ client, publicKey, ready = () => true }) {
  return {
    mode: 'queue',
    async run(payload, { signal } = {}) {
      const { key, ...rest } = payload;
      if (!ACTIONS.includes(rest.action)) throw fail(400, 'Geçersiz anahtar işlemi.');
      if (!ready()) throw fail(503, 'LLM servisi çalışmıyor; API anahtarları yalnızca LLM servisi açıkken yönetilebilir.');
      const job = { kind: 'keys', ...rest, ...(key ? { sealedKey: seal(key, publicKey) } : {}) };
      try { return await client.run('llm', job, { signal, leaseMs: 30000, maxAttempts: 1 }); }
      catch (error) {
        // A job the service refused carries its message; anything else means the queue or service could not be reached.
        if (error.state) throw clientError(error);
        throw fail(error.status || 503, 'LLM servisine ulaşılamadı: ' + error.message);
      }
    },
  };
}

// The LLM service's side of kind "keys".
function handleKeys(payload, { pool = KeyPool.pool(), privateKey, signal } = {}) {
  if (!ACTIONS.includes(payload?.action)) throw fail(400, 'Geçersiz anahtar işlemi.');
  const secrets = payload.sealedKey ? { key: open(payload.sealedKey, privateKey) } : {};
  const { sealedKey, ...rest } = payload;
  return perform(pool, rest, secrets, { signal });
}

module.exports = { seal, open, perform, createLocalKeys, createQueueKeys, handleKeys, ACTIONS };
