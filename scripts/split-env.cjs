// Moves service keys out of the project .env into services/verify/.env and services/llm/.env.
//   node scripts/split-env.cjs
// Only variable names are printed, never values. The original .env is kept as .env.yedek.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const targets = {
  verify: ['OPENALEX_API_KEY', 'NCBI_API_KEY', 'SEMANTIC_SCHOLAR_API_KEY', 'CORE_API_KEY', 'GOOGLE_BOOKS_API_KEY', 'CROSSREF_MAILTO', 'UNPAYWALL_EMAIL'],
  llm: ['GROQ_API_KEY', 'GROQ_MODEL', 'OPENROUTER_API_KEY', 'OPENROUTER_ENABLED', 'OPENROUTER_MODELS', 'OPENROUTER_SHARE', 'GEMINI_API_KEY', 'GEMINI_EMBEDDING_MODEL', 'GEMINI_EMBEDDING_DIM'],
};
const source = path.join(root, '.env');
if (!fs.existsSync(source)) { console.log('.env bulunamadı; taşınacak anahtar yok.'); process.exit(0); }
const name = line => line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/)?.[1];
const lines = fs.readFileSync(source, 'utf8').split(/\r?\n/);
const owner = key => Object.keys(targets).find(service => targets[service].includes(key));

for (const service of Object.keys(targets)) {
  const file = path.join(root, 'services', service, '.env');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const present = new Set(existing.map(name).filter(Boolean));
  const moved = lines.filter(line => owner(name(line)) === service && !present.has(name(line)));
  if (!moved.length) { console.log(`${service}: taşınacak yeni değişken yok`); continue; }
  const header = existing.length ? [] : [`# ${service === 'verify' ? 'Doğrulama' : 'LLM'} servisinin anahtarları (proje .env dosyasından taşındı). Sürüm kontrolüne alınmaz.`];
  fs.writeFileSync(file, [...header, ...existing.filter((line, i) => line || i < existing.length - 1), ...moved, ''].join('\n'), { mode: 0o600 });
  console.log(`${service}: ${moved.map(name).join(', ')} → services/${service}/.env`);
}
fs.copyFileSync(source, path.join(root, '.env.yedek'));
const rest = lines.filter(line => !owner(name(line)));
fs.writeFileSync(source, ['# Servis anahtarları services/verify/.env ve services/llm/.env dosyalarına taşındı (yedek: .env.yedek).', ...rest].join('\n').replace(/\n+$/, '') + '\n');
console.log('Proje .env dosyasında kalan değişkenler: ' + (rest.map(name).filter(Boolean).join(', ') || 'yok'));
