// Job queue broker. Publishers enqueue jobs; idle workers long-poll "claim" and receive the oldest job.
// Every call carries an RS256 JWT; the issuer's role decides which queues it may publish to or consume.
// State lives in memory and is journaled to disk so queued jobs survive a restart.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Jwt = require('../../lib/jwt.cjs');
const { loadEnv } = require('../../lib/env.cjs');

const AUDIENCE = 'kaynakca-queue';
const DEFAULT_ACL = {
  web: { publish: ['verify', 'llm'], consume: [] },
  verify: { publish: ['llm'], consume: ['verify'] },
  llm: { publish: [], consume: ['llm'] },
};
const FINAL = new Set(['done', 'failed', 'cancelled']);
const MAX_BODY = 8 * 1024 * 1024;

function createQueueServer({ keys, acl = DEFAULT_ACL, dataDir = null, resultTtlMs = 10 * 60000, defaultLeaseMs = 60000, maxWaitMs = 25000, now = Date.now } = {}) {
  const jobs = new Map();
  const queued = new Map();   // queue name -> job ids in FIFO order
  const claimers = new Map(); // queue name -> waiting workers
  const watchers = new Map(); // job id -> waiting publishers
  const workers = new Map();  // worker id -> { queue, issuer, capabilities, lastSeen, busy }
  const journal = dataDir ? path.join(dataDir, 'queue.jsonl') : null;
  let appended = 0;

  const list = (map, key) => { if (!map.has(key)) map.set(key, []); return map.get(key); };
  const publicJob = job => ({ id: job.id, queue: job.queue, state: job.state, attempts: job.attempts, createdAt: job.createdAt, updatedAt: job.updatedAt, result: job.result, error: job.error });
  // Only durable fields are journaled; events are transient progress for live watchers.
  const durable = ({ events, leaseToken, ...job }) => job;

  function save(job) {
    if (!journal) return;
    fs.appendFileSync(journal, JSON.stringify(job.deleted ? { id: job.id, deleted: true } : durable(job)) + '\n');
    if (++appended >= 1000) compact();
  }
  function compact() {
    if (!journal) return;
    const temp = journal + '.tmp';
    fs.writeFileSync(temp, [...jobs.values()].map(job => JSON.stringify(durable(job)) + '\n').join(''));
    fs.renameSync(temp, journal);
    appended = 0;
  }
  function restore() {
    if (!journal) return;
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(journal)) return;
    for (const line of fs.readFileSync(journal, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let record; try { record = JSON.parse(line); } catch { continue; }
      if (record.deleted) jobs.delete(record.id); else jobs.set(record.id, { ...record, events: [] });
    }
    // A lease does not survive a broker restart: active jobs go back to the queue.
    for (const job of [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      if (job.state === 'active') { job.state = 'queued'; delete job.worker; delete job.leaseUntil; }
      if (job.state === 'queued') list(queued, job.queue).push(job.id);
    }
    compact();
  }

  function notify(job) {
    const waiting = watchers.get(job.id) || [];
    watchers.delete(job.id);
    for (const watcher of waiting) watcher();
  }
  function finish(job, state, fields) {
    Object.assign(job, fields, { state, updatedAt: now(), finishedAt: now() });
    delete job.leaseToken; delete job.leaseUntil;
    const worker = workers.get(job.worker); if (worker) worker.busy = Math.max(0, worker.busy - 1);
    save(job); notify(job);
  }
  function dispatch(queue) {
    const ids = list(queued, queue), waiting = list(claimers, queue);
    while (ids.length && waiting.length) {
      const job = jobs.get(ids.shift());
      if (!job || job.state !== 'queued') continue;
      const claimer = waiting.shift();
      lease(job, claimer.worker, claimer.issuer);
      claimer.resolve(job);
    }
  }
  function lease(job, worker, issuer) {
    Object.assign(job, { state: 'active', worker, consumer: issuer, attempts: job.attempts + 1, leaseToken: crypto.randomBytes(18).toString('base64url'), leaseUntil: now() + job.leaseMs, updatedAt: now() });
    const entry = workers.get(worker); if (entry) entry.busy++;
    save(job);
  }
  function requeue(job, error) {
    const entry = workers.get(job.worker); if (entry) entry.busy = Math.max(0, entry.busy - 1);
    if (job.attempts >= job.maxAttempts) return finish(job, 'failed', { error: error || 'Servis işi zamanında tamamlamadı.' });
    Object.assign(job, { state: 'queued', updatedAt: now(), lastError: error });
    delete job.leaseToken; delete job.leaseUntil; delete job.worker;
    list(queued, job.queue).push(job.id);
    save(job); dispatch(job.queue);
  }
  function sweep() {
    const time = now();
    for (const job of jobs.values()) {
      if (job.state === 'active' && job.leaseUntil < time) requeue(job, 'Servis yanıt vermeyi bıraktı; iş yeniden kuyruğa alındı.');
      else if (FINAL.has(job.state) && job.finishedAt + resultTtlMs < time) { jobs.delete(job.id); watchers.delete(job.id); save({ id: job.id, deleted: true }); }
    }
    for (const [id, worker] of workers) if (worker.lastSeen + 120000 < time) workers.delete(id);
  }

  function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', chunk => { size += chunk.length; if (size > MAX_BODY) { reject(Object.assign(Error('İstek gövdesi çok büyük'), { status: 413 })); req.destroy(); } else chunks.push(chunk); });
      req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(Error('Geçersiz JSON'), { status: 400 })); } });
      req.on('error', reject);
    });
  }
  const fail = (status, message) => Object.assign(Error(message), { status });
  function authenticate(req) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) throw fail(401, 'Token gerekli');
    try { return Jwt.verify(header.slice(7), keys, { audience: AUDIENCE }); }
    catch (error) { throw fail(401, error.message); }
  }
  const can = (issuer, action, queue) => !!acl[issuer]?.[action]?.includes(queue);
  const validQueue = name => /^[a-z][a-z0-9-]{0,40}$/.test(name);
  const delay = (ms, signal) => new Promise(resolve => { const timer = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });

  async function route(req, res, url, abort) {
    if (req.method === 'GET' && url.pathname === '/health') {
      const counts = {};
      for (const job of jobs.values()) { counts[job.queue] ||= {}; counts[job.queue][job.state] = (counts[job.queue][job.state] || 0) + 1; }
      return send(res, 200, { ok: true, queues: counts });
    }
    const token = authenticate(req), issuer = token.iss;
    let match;
    if (req.method === 'POST' && (match = url.pathname.match(/^\/v1\/queues\/([^/]+)\/jobs$/))) {
      const queue = match[1];
      if (!validQueue(queue) || !can(issuer, 'publish', queue)) throw fail(403, 'Bu kuyruğa iş gönderme yetkiniz yok');
      const body = await readBody(req);
      if (body.payload === undefined) throw fail(400, 'İş içeriği gerekli');
      const job = { id: crypto.randomUUID(), queue, payload: body.payload, auth: String(body.auth || ''), publisher: issuer, state: 'queued', attempts: 0,
        maxAttempts: Math.min(10, Math.max(1, Number(body.maxAttempts) || 3)), leaseMs: Math.min(15 * 60000, Math.max(5000, Number(body.leaseMs) || defaultLeaseMs)),
        createdAt: now(), updatedAt: now(), events: [], seq: 0 };
      jobs.set(job.id, job); list(queued, queue).push(job.id); save(job); dispatch(queue);
      return send(res, 201, { id: job.id, state: job.state });
    }
    if (req.method === 'POST' && (match = url.pathname.match(/^\/v1\/queues\/([^/]+)\/claim$/))) {
      const queue = match[1];
      if (!validQueue(queue) || !can(issuer, 'consume', queue)) throw fail(403, 'Bu kuyruktan iş alma yetkiniz yok');
      const body = await readBody(req);
      const workerId = String(body.worker?.id || issuer).slice(0, 120);
      const entry = workers.get(workerId) || { busy: 0 };
      workers.set(workerId, { ...entry, id: workerId, queue, issuer, capabilities: body.worker?.capabilities || {}, lastSeen: now() });
      const waitMs = Math.min(maxWaitMs, Math.max(0, Number(body.waitMs) || 0));
      const job = await new Promise(resolve => {
        const claimer = { worker: workerId, issuer, resolve };
        list(claimers, queue).push(claimer); dispatch(queue);
        if (!list(claimers, queue).includes(claimer)) return;
        const done = () => { const waiting = list(claimers, queue), at = waiting.indexOf(claimer); if (at >= 0) { waiting.splice(at, 1); resolve(null); } };
        const timer = setTimeout(done, waitMs);
        abort.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
      });
      const worker = workers.get(workerId); if (worker) worker.lastSeen = now();
      if (!job) return send(res, 204);
      // The client vanished while the job was being handed over: release it immediately.
      if (abort.aborted) { job.attempts--; requeue(job); return; }
      return send(res, 200, { id: job.id, queue, payload: job.payload, auth: job.auth, publisher: job.publisher, attempt: job.attempts, leaseToken: job.leaseToken, leaseMs: job.leaseMs });
    }
    if ((match = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]{36})(?:\/(progress|complete|fail))?$/))) {
      const job = jobs.get(match[1]), action = match[2];
      if (!job) throw fail(404, 'İş bulunamadı');
      if (action) {
        if (req.method !== 'POST') throw fail(405, 'Yalnız POST');
        const body = await readBody(req);
        if (!can(issuer, 'consume', job.queue) || job.consumer !== issuer) throw fail(403, 'Bu iş size ait değil');
        // A cancelled job tells the worker to stop at its next heartbeat.
        if (job.state === 'cancelled') return send(res, 200, { cancelled: true });
        if (job.state !== 'active' || body.leaseToken !== job.leaseToken) throw fail(409, 'İşin kiralama süresi doldu veya başka servise verildi');
        if (action === 'progress') {
          job.leaseUntil = now() + job.leaseMs; job.updatedAt = now();
          if (body.event && typeof body.event === 'object') { job.events.push({ ...body.event, seq: ++job.seq }); if (job.events.length > 200) job.events.splice(0, job.events.length - 200); notify(job); }
          return send(res, 200, { cancelled: false, leaseUntil: job.leaseUntil });
        }
        if (action === 'complete') { finish(job, 'done', { result: body.result ?? null }); return send(res, 200, { state: job.state }); }
        const message = String(body.error || 'İş başarısız oldu').slice(0, 2000);
        if (body.retryable) requeue(job, message); else finish(job, 'failed', { error: message });
        return send(res, 200, { state: job.state });
      }
      if (job.publisher !== issuer) throw fail(403, 'Bu iş size ait değil');
      if (req.method === 'DELETE') {
        if (!FINAL.has(job.state)) {
          const ids = list(queued, job.queue), at = ids.indexOf(job.id); if (at >= 0) ids.splice(at, 1);
          finish(job, 'cancelled', { error: 'İş iptal edildi' });
        }
        return send(res, 200, publicJob(job));
      }
      if (req.method !== 'GET') throw fail(405, 'Desteklenmeyen yöntem');
      // Long-poll: answer as soon as there are events after `after` or the job is final.
      const after = Number(url.searchParams.get('after')) || 0, waitMs = Math.min(maxWaitMs, Math.max(0, Number(url.searchParams.get('waitMs')) || 0));
      const ready = () => FINAL.has(job.state) || job.seq > after;
      if (!ready() && waitMs) await new Promise(resolve => { list(watchers, job.id).push(resolve); delay(waitMs, abort).then(resolve); });
      return send(res, 200, { ...publicJob(job), events: job.events.filter(e => e.seq > after), seq: job.seq });
    }
    if (req.method === 'GET' && (match = url.pathname.match(/^\/v1\/queues\/([^/]+)\/workers$/))) {
      const queue = match[1];
      if (!can(issuer, 'publish', queue) && !can(issuer, 'consume', queue)) throw fail(403, 'Yetkiniz yok');
      const time = now();
      return send(res, 200, { workers: [...workers.values()].filter(w => w.queue === queue && w.lastSeen + 60000 >= time).map(({ id, capabilities, lastSeen, busy }) => ({ id, capabilities, lastSeen, busy })) });
    }
    throw fail(404, 'Uç nokta bulunamadı');
  }

  restore();
  const timer = setInterval(sweep, 1000); timer.unref();
  const server = http.createServer((req, res) => {
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    route(req, res, new URL(req.url, 'http://queue'), controller.signal).catch(error => {
      if (!res.headersSent && !res.destroyed) send(res, error.status || 500, { error: error.status ? error.message : 'Kuyruk iç hatası' });
    });
  });
  server.on('close', () => { clearInterval(timer); for (const waiting of claimers.values()) for (const c of waiting.splice(0)) c.resolve(null); });
  server.jobs = jobs; server.sweep = sweep;
  return server;
}

if (require.main === module) {
  loadEnv(path.join(__dirname, '.env'));
  const keys = Jwt.loadPublicKeys(process.env.JWT_KEYS_DIR || path.join(__dirname, '../../keys'));
  if (!Object.keys(keys).length) { console.error('Açık anahtar bulunamadı; "node scripts/generate-keys.cjs" çalıştırın ve JWT_KEYS_DIR ayarlayın.'); process.exit(1); }
  const acl = process.env.QUEUE_ACL ? JSON.parse(process.env.QUEUE_ACL) : DEFAULT_ACL;
  const port = Number(process.env.QUEUE_PORT) || 4180, host = process.env.QUEUE_HOST || '127.0.0.1';
  const server = createQueueServer({ keys, acl, dataDir: process.env.QUEUE_DATA_DIR || path.join(__dirname, '../../data/queue') });
  server.listen(port, host, () => console.log(`Kuyruk servisi: http://${host}:${port} (yayıncılar: ${Object.keys(keys).join(', ')})`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
module.exports = { createQueueServer, DEFAULT_ACL, AUDIENCE };
