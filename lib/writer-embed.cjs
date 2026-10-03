// Embeddings for the writing assistant, wherever the Gemini key lives:
// as "embed" jobs for the LLM service when a queue is configured, otherwise a direct call.
const Backend = require('./backend.cjs');
const Gemini = require('./gemini-embed.cjs');
const UsageContext = require('./usage-context.cjs');

const BATCH = 32;
const MAX_TRIES = 6, MAX_WAIT_MS = 90000;
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(resolve, Math.max(0, ms));
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

function available() {
  return Backend.queue() ? !!Backend.merged('llm').embedding : Gemini.configured();
}
async function once(texts, task, signal) {
  const queue = Backend.queue();
  if (queue) return queue.run('llm', { kind: 'embed', texts, task }, { signal, leaseMs: 90000, maxAttempts: 2 });
  return Gemini.embed({ texts, task }, { signal });
}
// Waits out Gemini quota replies (reported through onWait) and gives up after a few tries.
async function embedBatch(texts, task, { signal, onWait = () => {} } = {}) {
  for (let tries = 1; ; tries++) {
    const answer = await once(texts, task, signal);
    if (answer?.vectors) {
      UsageContext.record({ kind: 'embedding', provider: 'Gemini', model: answer.model, prompt: answer.tokens || 0, total: answer.tokens || 0, estimated: answer.estimated !== false });
      return answer.vectors.map(v => Float32Array.from(v));
    }
    if (!answer?.quota || tries >= MAX_TRIES) throw Error(answer?.quota?.message || 'Embedding alınamadı.');
    const until = Math.min(answer.quota.retryAt, Date.now() + MAX_WAIT_MS);
    onWait(until);
    await sleep(until - Date.now(), signal);
  }
}
// Any number of texts, in batches; `onProgress(done)` fires after each batch.
async function embedAll(texts, task, { signal, onWait, onProgress } = {}) {
  const vectors = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    vectors.push(...await embedBatch(texts.slice(i, i + BATCH), task, { signal, onWait }));
    onProgress?.(vectors.length);
  }
  return vectors;
}

module.exports = { available, embedBatch, embedAll, BATCH };
