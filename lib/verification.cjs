// Reference verification run shared by the in-process worker thread and the queue-backed mode.
// Both emit the same messages: result, debug, wait, ready, done, error.
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(resolve, Math.max(0, ms));
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});
const pendingRetryAt = result => result.pendingProviders?.length ? Math.min(...result.pendingProviders.map(item => item.retryAt || result.pendingRetryAt || 0)) : result.pendingRetryAt;
async function pool(items, size, task) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => { while (queue.length) await task(queue.shift()); }));
}

// Primary pass over every record first, then additional indexes with quota waits.
// A record still waiting for quota rotates to the back so it cannot starve the others.
// A record whose earlier result is final needs no new lookups.
// A "not found" record taken from the cache (fromCache, set only for that run) is final too; one a user already has is not, so a re-run asks again.
const reusableResult = previous => !!previous && (previous.pendingRetryAt > Date.now() || ['verified', 'review'].includes(previous.status) && !previous.pendingRetryAt && !previous.fallbackNeeded
  || previous.fromCache === true && previous.status === 'failed' && !previous.pendingRetryAt && !previous.fallbackNeeded);
async function orchestrate({ references, initialResults = [], verify, emit, retryAt = pendingRetryAt, wait = sleep, parallel = 1, signal }) {
  const results = [];
  await pool(references.map((_, i) => i), parallel, async i => {
    const previous = initialResults[i];
    const reusable = reusableResult(previous);
    results[i] = reusable ? previous : await verify(i, { primaryOnly: true });
    emit({ type: 'result', index: i, result: results[i] });
  });
  let pending = results.map((r, i) => r.fallbackNeeded ? i : -1).filter(i => i >= 0);
  while (pending.length) {
    await pool(pending.filter(i => !(retryAt(results[i]) > Date.now())), parallel, async i => {
      results[i] = await verify(i, {});
      emit({ type: 'result', index: i, result: results[i] });
    });
    pending = pending.filter(i => results[i].pendingRetryAt);
    if (pending.length) {
      const at = Math.min(...pending.map(i => retryAt(results[i])));
      emit({ type: 'ready', pending: pending.length, completed: results.length - pending.length, retryAt: at });
      emit({ type: 'wait', provider: 'Kaynak dizinleri', retryAt: at });
      await wait(at - Date.now(), signal);
      pending = [...pending.slice(1), pending[0]];
    }
  }
  emit({ type: 'done' });
}

// Worker-like handle (on('message'), terminate()) over queue jobs, so callers need not know the mode.
function startQueued(data, client, { parallel = Number(process.env.VERIFY_PARALLEL) || 4 } = {}) {
  const run = new EventEmitter(), controller = new AbortController();
  const emit = message => { if (!controller.signal.aborted) run.emit('message', message); };
  const verify = async (index, options) => {
    try {
      return await client.run('verify', { reference: data.references[index], options: { ...data.options, ...options } }, { signal: controller.signal, leaseMs: 120000,
        onEvent: event => event.type === 'wait' ? emit({ type: 'wait', provider: event.provider, retryAt: event.retryAt, index }) : emit({ type: 'debug', event: { ...event, index } }) });
    } catch (error) {
      if (controller.signal.aborted) throw error;
      // One failed job must not stop the batch; the record is reported as a service error.
      const raw = data.references[index];
      return { raw, corrected: raw, status: 'error', statusText: 'Doğrulama servisi yanıt vermedi', score: 0, provider: 'Doğrulama servisi', changes: [], reason: error.message };
    }
  };
  run.terminate = () => { controller.abort(Object.assign(Error('İşlem durduruldu'), { name: 'AbortError' })); return Promise.resolve(); };
  setImmediate(() => orchestrate({ references: data.references, initialResults: data.initialResults, verify, emit, parallel, signal: controller.signal })
    .catch(() => emit({ type: 'error', message: 'Kaynak doğrulama tamamlanamadı; yeniden başlatabilirsiniz.' })));
  return run;
}

// Picks the queue when one is configured, otherwise the in-process worker thread.
function start(data, { queue } = {}) {
  if (queue) return startQueued(data, queue);
  return new Worker(path.join(__dirname, '../scripts/word-verify-worker.cjs'), { workerData: data });
}

module.exports = { reusableResult, orchestrate, start, startQueued, pendingRetryAt, sleep };
