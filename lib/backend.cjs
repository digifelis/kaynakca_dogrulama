// Where verification and LLM work runs. Without QUEUE_URL everything stays in this process (as before);
// with it, jobs go to the queue and the separate services answer them with their own API keys.
const path = require('node:path');
const Jwt = require('./jwt.cjs');
const { createQueueClient } = require('./queue-client.cjs');

let client = null, issuer = null;
const capabilities = { verify: { at: 0, workers: [] }, llm: { at: 0, workers: [] } };

function configure({ queueUrl = process.env.QUEUE_URL, keysDir = process.env.JWT_KEYS_DIR || path.join(__dirname, '..', 'keys'), name = process.env.SERVICE_NAME || 'web' } = {}) {
  if (!queueUrl) { client = null; return null; }
  issuer = name;
  client = createQueueClient({ url: queueUrl, issuer: name, privateKey: Jwt.loadPrivateKey(keysDir, name) });
  return client;
}
function use(queueClient) { client = queueClient; }
const queue = () => client;

// Workers advertise what they can do (which keys are configured) each time they ask for work.
async function refresh(name) {
  if (!client) return [];
  try { capabilities[name] = { at: Date.now(), workers: await client.workers(name) }; }
  catch { capabilities[name] = { at: Date.now(), workers: [] }; }
  return capabilities[name].workers;
}
function workers(name) {
  // An empty list is refreshed sooner so services started after the web app are noticed quickly.
  if (client && Date.now() - capabilities[name].at > (capabilities[name].workers.length ? 10000 : 2000)) { capabilities[name].at = Date.now(); refresh(name); }
  return capabilities[name].workers;
}
const merged = name => workers(name).reduce((all, worker) => {
  for (const [key, value] of Object.entries(worker.capabilities || {})) all[key] = typeof value === 'object' && value ? { ...(all[key] || {}), ...Object.fromEntries(Object.entries(value).map(([k, v]) => [k, v || all[key]?.[k] || false])) } : value || all[key] || false;
  return all;
}, {});

module.exports = { configure, use, queue, refresh, workers, merged };
