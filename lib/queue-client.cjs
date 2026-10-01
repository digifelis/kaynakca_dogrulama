// Client for services/queue: publishers send and watch jobs, workers claim and answer them.
// Calls are authorized with a short-lived RS256 token; every job also carries a publisher-signed
// token binding its payload digest, so a worker can reject jobs the queue did not get from a trusted service.
const os = require('node:os');
const crypto = require('node:crypto');
const Jwt = require('./jwt.cjs');

const QUEUE_AUDIENCE = 'kaynakca-queue', JOB_AUDIENCE = 'kaynakca-job';
const FINAL = new Set(['done', 'failed', 'cancelled']);
const abortError = () => Object.assign(Error('İşlem durduruldu'), { name: 'AbortError' });

function createQueueClient({ url, issuer, privateKey, request = fetch }) {
  const base = String(url).replace(/\/+$/, '');
  const token = Jwt.tokenSource({ issuer, privateKey, audience: QUEUE_AUDIENCE });
  async function call(method, path, body, { signal, timeout = 40000 } = {}) {
    const signals = [AbortSignal.timeout(timeout), ...(signal ? [signal] : [])];
    const response = await request(base + path, { method, signal: AbortSignal.any(signals), headers: { Authorization: 'Bearer ' + token(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(Error(data.error || `Kuyruk HTTP ${response.status}`), { status: response.status });
    return data;
  }
  async function publish(queue, payload, { maxAttempts, leaseMs } = {}) {
    const auth = Jwt.sign({ iss: issuer, aud: JOB_AUDIENCE, sub: queue, dig: Jwt.digest(payload) }, privateKey, { kid: issuer, expiresIn: 6 * 3600 });
    return (await call('POST', `/v1/queues/${queue}/jobs`, { payload, auth, maxAttempts, leaseMs })).id;
  }
  const cancel = id => call('DELETE', `/v1/jobs/${id}`).catch(() => null);
  // Follows a job until it is final, passing progress events on; aborting cancels the job in the queue.
  async function watch(id, { onEvent = () => {}, signal } = {}) {
    let after = 0;
    try {
      while (true) {
        if (signal?.aborted) throw abortError();
        const job = await call('GET', `/v1/jobs/${id}?after=${after}&waitMs=20000`, null, { signal });
        for (const event of job.events || []) { after = Math.max(after, event.seq); onEvent(event); }
        after = Math.max(after, job.seq || 0);
        if (job.state === 'done') return job.result;
        if (FINAL.has(job.state)) throw Object.assign(Error(job.error || 'İş tamamlanamadı'), { state: job.state });
      }
    } catch (error) {
      if (signal?.aborted) { await cancel(id); throw abortError(); }
      throw error;
    }
  }
  async function run(queue, payload, options = {}) {
    if (options.signal?.aborted) throw abortError();
    return watch(await publish(queue, payload, options), options);
  }
  const workers = queue => call('GET', `/v1/queues/${queue}/workers`).then(data => data.workers);
  return { call, publish, watch, run, cancel, workers, issuer };
}

// Pulls jobs from one queue whenever this service is idle and answers them through the handler.
function startWorker({ client, queue, publicKeys, trustedPublishers, handler, capabilities = {}, concurrency = 1, workerId = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`, log = () => {} }) {
  let stopped = false;
  const controllers = new Set(), stopping = new AbortController();
  function authorize(job) {
    const claims = Jwt.verify(job.auth, publicKeys, { audience: JOB_AUDIENCE, issuers: trustedPublishers });
    if (claims.sub !== queue || claims.iss !== job.publisher || claims.dig !== Jwt.digest(job.payload)) throw Error('İş imzası içerikle uyuşmuyor');
  }
  async function handle(job) {
    const controller = new AbortController(); controllers.add(controller);
    let progress = Promise.resolve();
    const report = event => {
      progress = progress.then(() => client.call('POST', `/v1/jobs/${job.id}/progress`, { leaseToken: job.leaseToken, event }))
        .then(answer => { if (answer?.cancelled) controller.abort(); }, error => { if (error.status === 409) controller.abort(); });
      return progress;
    };
    const heartbeat = setInterval(() => report(null), Math.max(2000, Math.floor(job.leaseMs / 3)));
    try {
      try { authorize(job); } catch (error) { log(`Reddedilen iş ${job.id}: ${error.message}`); await client.call('POST', `/v1/jobs/${job.id}/fail`, { leaseToken: job.leaseToken, error: 'İş imzası doğrulanamadı', retryable: false }); return; }
      let result, failure;
      try { result = await handler(job.payload, { signal: controller.signal, emit: event => { report(event); }, job }); }
      catch (error) { failure = error; }
      clearInterval(heartbeat);
      await progress;
      if (controller.signal.aborted) return;
      if (failure) await client.call('POST', `/v1/jobs/${job.id}/fail`, { leaseToken: job.leaseToken, error: failure.message, retryable: !!failure.retryable });
      else await client.call('POST', `/v1/jobs/${job.id}/complete`, { leaseToken: job.leaseToken, result });
    } catch (error) { log(`İş ${job.id} yanıtlanamadı: ${error.message}`); }
    finally { clearInterval(heartbeat); controllers.delete(controller); }
  }
  async function loop() {
    let backoff = 1000;
    while (!stopped) {
      try {
        const job = await client.call('POST', `/v1/queues/${queue}/claim`, { worker: { id: workerId, capabilities }, waitMs: 20000 }, { signal: stopping.signal });
        backoff = 1000;
        if (job) await handle(job);
      } catch (error) {
        if (stopped) break;
        log(`Kuyruğa ulaşılamadı (${error.message}); ${backoff / 1000} sn sonra yeniden denenecek`);
        await new Promise(resolve => setTimeout(resolve, backoff)); backoff = Math.min(30000, backoff * 2);
      }
    }
  }
  const loops = Array.from({ length: Math.max(1, concurrency) }, loop);
  return { workerId, stop() { stopped = true; stopping.abort(); for (const c of controllers) c.abort(); return Promise.allSettled(loops); } };
}

module.exports = { createQueueClient, startWorker, QUEUE_AUDIENCE, JOB_AUDIENCE };
