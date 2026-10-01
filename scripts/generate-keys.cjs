// Generates one RS256 key pair per service: node scripts/generate-keys.cjs [keys-dir]
// Existing keys are kept unless --force is given. Private keys never leave their service.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const force = args.includes('--force');
const dir = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', 'keys'));
const services = ['web', 'verify', 'llm'];
fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
fs.mkdirSync(path.join(dir, 'private'), { recursive: true, mode: 0o700 });
for (const name of services) {
  const privateFile = path.join(dir, 'private', name + '.private.pem'), publicFile = path.join(dir, 'public', name + '.public.pem');
  if (fs.existsSync(privateFile) && !force) { console.log(`${name}: mevcut anahtar korundu`); continue; }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(privateFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(publicFile, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log(`${name}: anahtar çifti oluşturuldu`);
}
console.log(`Anahtarlar: ${dir}`);
