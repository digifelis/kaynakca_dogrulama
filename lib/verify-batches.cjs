// Bibliography page verification runs on the server: the browser posts the references, then polls.
// The run goes to the verification queue when configured, otherwise to the local worker thread.
const crypto = require('node:crypto');
const Verification = require('./verification.cjs');
const Backend = require('./backend.cjs');

const batches = new Map();
const MAX_REFERENCES = 500, MAX_ACTIVE = 20, KEEP_MS = 60 * 60000;

function cleanup() {
  for (const [id, batch] of batches) if (!batch.running && batch.finishedAt + KEEP_MS < Date.now()) batches.delete(id);
}
// web: false marks that the caller's plan does not include web source verification.
function create(references, { port, web = true }) {
  cleanup();
  if (!Array.isArray(references) || !references.length || references.length > MAX_REFERENCES || references.some(r => typeof r !== 'string' || !r.trim() || r.length > 8000)) throw Error(`1 ile ${MAX_REFERENCES} arasında geçerli kaynak gönderin.`);
  if ([...batches.values()].filter(b => b.running).length >= MAX_ACTIVE) throw Error('Çok sayıda doğrulama sürüyor; birini durdurup yeniden deneyin.');
  const batch = { id: crypto.randomUUID(), total: references.length, results: Array(references.length).fill(null), lastQuery: {}, primary: new Set(), running: true, version: 0, createdAt: Date.now() };
  const run = Verification.start({ proxy: `http://127.0.0.1:${port}/api/proxy`, references, initialResults: [], ...(web === false ? { options: { web: false } } : {}), googleBooksConfigured: !!process.env.GOOGLE_BOOKS_API_KEY }, { queue: Backend.queue() });
  const finish = fields => { if (!batch.running) return; Object.assign(batch, fields, { running: false, finishedAt: Date.now() }); batch.version++; batch.run = null; run.terminate(); };
  batch.run = run;
  run.on('message', m => {
    if (!batch.running) return;
    if (m.type === 'result') { batch.results[m.index] = m.result; batch.primary.add(m.index); delete batch.wait; }
    else if (m.type === 'debug' && m.event?.kind === 'request') batch.lastQuery[m.event.index] = { provider: m.event.provider, url: m.event.url, at: m.event.at };
    else if (m.type === 'wait') batch.wait = { provider: m.provider, retryAt: m.retryAt, index: m.index };
    else if (m.type === 'done') return finish({ state: 'done' });
    else if (m.type === 'error') return finish({ state: 'error', error: m.message });
    batch.version++;
  });
  run.on('error', () => finish({ state: 'error', error: 'Kaynak doğrulama tamamlanamadı; yeniden başlatabilirsiniz.' }));
  run.on('exit', () => finish({ state: 'error', error: 'Kaynak doğrulama işçisi beklenmedik biçimde durdu.' }));
  batch.stop = () => finish({ state: 'stopped' });
  batches.set(batch.id, batch);
  return snapshot(batch);
}
function snapshot(batch) {
  return { id: batch.id, total: batch.total, running: batch.running, state: batch.state || 'running', error: batch.error, version: batch.version,
    phase: batch.primary.size < batch.total ? 'primary' : 'fallback', primaryCompleted: batch.primary.size,
    results: batch.results, lastQuery: batch.lastQuery, wait: batch.wait || null };
}
const get = id => batches.get(id);

module.exports = { create, get, snapshot, batches };
