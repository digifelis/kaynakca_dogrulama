// Who is asking. Today: an anonymous browser identity in a signed cookie, always on the basic plan.
// Later: setResolver() swaps in the real login; callers only ever see { userId, plan }.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const COOKIE = 'km_uid';
const ID = /^[a-f0-9]{32}$/;
let secret = null;
let resolver = null;

function secretFile() {
  return path.join(process.env.WRITER_DATA_DIR || path.join(__dirname, '..', 'data', 'writer'), 'identity.secret');
}
// IDENTITY_SECRET lets several web servers share identities; otherwise one is generated and kept on disk.
function getSecret() {
  if (secret) return secret;
  if (process.env.IDENTITY_SECRET) return secret = Buffer.from(process.env.IDENTITY_SECRET);
  const file = secretFile();
  try { secret = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex'); }
  catch {
    secret = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secret.toString('hex'), { mode: 0o600 });
  }
  return secret;
}
const sign = id => crypto.createHmac('sha256', getSecret()).update(id).digest('base64url');
function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function readCookie(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return '';
}
function verifyCookie(value) {
  const [id, mac] = String(value).split('.');
  return ID.test(id || '') && mac && safeEqual(mac, sign(id)) ? id : null;
}

// The first visit gets a new identity and a Set-Cookie header; a forged or tampered cookie is replaced, never trusted.
function anonymous(req, res) {
  let id = verifyCookie(readCookie(req));
  if (!id) {
    id = crypto.randomBytes(16).toString('hex');
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${id}.${sign(id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${5 * 365 * 86400}${secure}`);
  }
  return { userId: id, plan: 'basic' };
}
function resolveUser(req, res) { return (resolver || anonymous)(req, res); }
function setResolver(fn) { resolver = fn; }

module.exports = { resolveUser, setResolver, COOKIE, anonymous, verifyCookie, _reset() { secret = null; resolver = null; } };
