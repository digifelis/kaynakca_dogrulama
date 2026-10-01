// Starts the whole system on one machine: queue, verification service(s), LLM service(s) and the web app.
//   node scripts/start-services.cjs
// Settings (optional): PORT=4173 QUEUE_PORT=4180 VERIFY_INSTANCES=2 LLM_INSTANCES=1
// Each service reads its own .env (services/verify/.env, services/llm/.env); this script passes no keys.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const keysDir = process.env.JWT_KEYS_DIR || path.join(root, 'keys');
const queuePort = Number(process.env.QUEUE_PORT) || 4180;
const queueUrl = `http://127.0.0.1:${queuePort}`;
const count = (name, fallback) => Math.max(1, Math.min(64, Number(process.env[name]) || fallback));

if (!fs.existsSync(path.join(keysDir, 'private', 'web.private.pem'))) execFileSync(process.execPath, [path.join(__dirname, 'generate-keys.cjs'), keysDir], { stdio: 'inherit' });

const children = new Map();
let stopping = false;
function run(label, script, env = {}) {
  const child = spawn(process.execPath, [path.join(root, script)], { cwd: root, env: { ...process.env, JWT_KEYS_DIR: keysDir, QUEUE_URL: queueUrl, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const prefix = line => line && console.log(`[${label}] ${line}`);
  let buffer = '';
  const write = chunk => { buffer += chunk; const lines = buffer.split(/\r?\n/); buffer = lines.pop(); lines.forEach(prefix); };
  child.stdout.on('data', write); child.stderr.on('data', write);
  child.on('exit', code => {
    children.delete(label);
    if (stopping) return;
    // A crashed service is restarted; the queue hands its unfinished job to another service when the lease ends.
    console.log(`[${label}] durdu (kod ${code}); 2 sn sonra yeniden başlatılıyor`);
    setTimeout(() => { if (!stopping) run(label, script, env); }, 2000);
  });
  children.set(label, child);
}
async function waitForQueue() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(queueUrl + '/health', { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw Error('Kuyruk servisi başlamadı.');
}

(async () => {
  run('kuyruk', 'services/queue/server.cjs', { QUEUE_PORT: String(queuePort) });
  await waitForQueue();
  for (let i = 1; i <= count('VERIFY_INSTANCES', 2); i++) run(`doğrulama-${i}`, 'services/verify/index.cjs');
  for (let i = 1; i <= count('LLM_INSTANCES', 1); i++) run(`llm-${i}`, 'services/llm/index.cjs');
  run('web', 'server.cjs');
})().catch(error => { console.error(error.message); shutdown(1); });

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
