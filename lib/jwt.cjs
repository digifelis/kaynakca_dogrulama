// Minimal RS256 JSON Web Token implementation on node:crypto (no dependencies).
// Only RS256 is accepted; the algorithm in the header is never trusted to pick a verifier.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const b64url = value => Buffer.from(value).toString('base64url');
const json = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));

function sign(payload, privateKey, { kid, expiresIn = 300 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', ...(kid ? { kid } : {}) };
  const body = { iat: now, nbf: now - 5, exp: now + expiresIn, jti: crypto.randomUUID(), ...payload };
  const input = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(body));
  return input + '.' + crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
}

// `keys` maps issuer (kid) to a public key. The token's kid and iss must agree.
function verify(token, keys, { audience, issuers, leeway = 30 } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]*$/.test(p))) throw Error('Geçersiz token biçimi');
  let header, payload;
  try { header = json(parts[0]); payload = json(parts[1]); } catch { throw Error('Geçersiz token biçimi'); }
  if (header.alg !== 'RS256' || header.typ !== 'JWT') throw Error('Desteklenmeyen token algoritması');
  const key = Object.hasOwn(keys, header.kid) ? keys[header.kid] : null;
  if (!key || payload.iss !== header.kid) throw Error('Tanınmayan token yayıncısı');
  if (issuers && !issuers.includes(payload.iss)) throw Error('Bu yayıncıya izin verilmiyor');
  if (!crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'))) throw Error('Token imzası geçersiz');
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp + leeway < now) throw Error('Token süresi dolmuş');
  if (typeof payload.nbf === 'number' && payload.nbf - leeway > now) throw Error('Token henüz geçerli değil');
  if (audience && payload.aud !== audience) throw Error('Token hedefi uyuşmuyor');
  return payload;
}

// Layout: <dir>/public/<name>.public.pem is shared with every service; <dir>/private/<name>.private.pem
// stays with its own service (or comes from JWT_PRIVATE_KEY_FILE, e.g. a Docker secret).
function loadPublicKeys(dir) {
  const keys = {}, folder = dir && path.join(dir, 'public');
  if (!folder || !fs.existsSync(folder)) return keys;
  for (const file of fs.readdirSync(folder)) {
    const match = file.match(/^([a-z][a-z0-9-]*)\.public\.pem$/);
    if (match) keys[match[1]] = crypto.createPublicKey(fs.readFileSync(path.join(folder, file)));
  }
  return keys;
}
function loadPrivateKey(dir, name) {
  const file = process.env.JWT_PRIVATE_KEY_FILE || path.join(dir, 'private', name + '.private.pem');
  if (!fs.existsSync(file)) throw Error(`${file} bulunamadı; önce "node scripts/generate-keys.cjs" çalıştırın.`);
  return crypto.createPrivateKey(fs.readFileSync(file));
}

// Caches a short-lived token and renews it a minute before expiry.
function tokenSource({ issuer, privateKey, audience, scope, lifetime = 300 }) {
  let token = '', renewAt = 0;
  return () => {
    if (Date.now() < renewAt) return token;
    token = sign({ iss: issuer, sub: issuer, aud: audience, scope }, privateKey, { kid: issuer, expiresIn: lifetime });
    renewAt = Date.now() + (lifetime - 60) * 1000;
    return token;
  };
}

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('base64url');

module.exports = { sign, verify, loadPublicKeys, loadPrivateKey, tokenSource, digest };
