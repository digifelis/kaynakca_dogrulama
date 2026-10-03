// Sealing of secrets kept in the settings table (LDAP bind password, SMTP password): AES-256-GCM.
// The key comes from SETTINGS_SECRET, or is generated once and kept beside the database (settings.secret, mode 600).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function createSealer(dir) {
  let key = null;
  const getKey = () => {
    if (key) return key;
    if (process.env.SETTINGS_SECRET) return key = crypto.createHash('sha256').update(process.env.SETTINGS_SECRET).digest();
    const file = path.join(dir, 'settings.secret');
    try { key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex'); }
    catch { key = crypto.randomBytes(32); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 }); }
    return key;
  };
  return {
    seal(text) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
      const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
      return 'v1.' + [iv, cipher.getAuthTag(), data].map(b => b.toString('base64url')).join('.');
    },
    open(sealed) {
      const [version, iv, tag, data] = String(sealed || '').split('.');
      if (version !== 'v1' || !data) throw Error('Saklanan gizli değer okunamadı.');
      const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    },
  };
}
module.exports = { createSealer };
