// LLM requests as queue jobs: the LLM service holds the Groq/OpenRouter keys and quota state.
// Progress events carry the service's debug records and quota waits back to the caller.
const Backend = require('./backend.cjs');

function createLlmTransport(client) {
  return {
    available() { const c = Backend.merged('llm'); return !!(c.groq || c.openRouter); },
    async chat(spec, signal, onWait = () => {}, onDebug = () => {}) {
      const answer = await client.run('llm', { kind: 'chat', spec }, { signal, leaseMs: 60000, maxAttempts: 2,
        onEvent: ({ seq, ...event }) => { if (event.kind === 'quota-wait') onWait(event.retryAt); else onDebug(event); } });
      if (answer?.quota) throw Object.assign(Error(answer.quota.message), { retryAt: answer.quota.retryAt, quota: true });
      return answer;
    },
  };
}

module.exports = { createLlmTransport };
