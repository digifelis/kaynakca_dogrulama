// Which operation is running right now. Code that calls a model or an embedding service reports the tokens it used with
// record(); if an operation is active (AsyncLocalStorage follows async work, including background tasks) the tokens are
// added to it, otherwise nothing happens. No database access here, so any module can import it.
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();
const estimate = chars => Math.max(1, Math.ceil(chars / 4));

// call: { kind: 'chat' | 'embedding', provider, model, prompt, completion, total, estimated }
function record(call) { als.getStore()?.addCall(call); }
// OpenAI-style usage ({ prompt_tokens, completion_tokens, total_tokens }); when a provider sends none, the size is estimated.
function fromUsage(usage, { promptChars = 0, completionChars = 0 } = {}) {
  const prompt = Number(usage?.prompt_tokens ?? usage?.promptTokens), completion = Number(usage?.completion_tokens ?? usage?.completionTokens);
  if (Number.isFinite(prompt) || Number.isFinite(completion)) {
    const p = Number.isFinite(prompt) ? prompt : 0, c = Number.isFinite(completion) ? completion : 0;
    return { prompt: p, completion: c, total: Number(usage?.total_tokens) || p + c, estimated: false };
  }
  const p = estimate(promptChars), c = estimate(completionChars);
  return { prompt: p, completion: c, total: p + c, estimated: true };
}
module.exports = { als, record, fromUsage, estimate };
