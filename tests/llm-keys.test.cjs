// Key management for the admin panel: the sealed envelope, adding with a check, and the LLM service's handling of "keys" jobs.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPool } = require('../lib/key-pool.cjs');
const LlmKeys = require('../lib/llm-keys.cjs');
const Service = require('../services/llm/index.cjs');

const KEY = n => `gsk_test_key_number_${n}_abcdefghijklmnop`;
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
function setup(status = 200) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-keys-'));
  const fetchImpl = async () => new Response('{}', { status: fetchImpl.status });
  fetchImpl.status = status;
  return { pool: createPool({ dir, env: {}, fetchImpl }), fetchImpl, dir };
}

test('a key sealed to the service opens only with its private key and never appears in the envelope', () => {
  const envelope = LlmKeys.seal(KEY(1), rsa.publicKey);
  assert.doesNotMatch(JSON.stringify(envelope), /key_number_1/);
  assert.equal(LlmKeys.open(envelope, rsa.privateKey), KEY(1));
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => LlmKeys.open(envelope, other.privateKey), /çözülemedi/);
  assert.throws(() => LlmKeys.open({ ...envelope, data: Buffer.from('tampered').toString('base64') }, rsa.privateKey), /çözülemedi/);
});

test('a key is checked before it is stored; a refused key is not saved', async () => {
  const { pool, fetchImpl } = setup(401);
  const keys = LlmKeys.createLocalKeys({ pool });
  await assert.rejects(keys.run({ action: 'add', provider: 'groq', key: KEY(1) }), e => e.status === 400 && /geçersiz/.test(e.message));
  assert.equal(pool.list('groq').length, 0);
  fetchImpl.status = 200;
  const added = await keys.run({ action: 'add', provider: 'groq', label: 'Hesap A', key: KEY(1), group: 'a', rpm: 30 });
  assert.equal(added.key.label, 'Hesap A'); assert.equal(added.key.last4, 'mnop'); assert.doesNotMatch(JSON.stringify(added), /key_number_1/);
  const listed = await keys.run({ action: 'list' });
  assert.equal(listed.keys.length, 1); assert.deepEqual(listed.summary.groq, { total: 1, available: 1 });
  await assert.rejects(keys.run({ action: 'add', provider: 'groq', key: KEY(1) }), /zaten ekli/);
});

test('update replaces a key only after it checks out; remove and test work by id', async () => {
  const { pool, fetchImpl } = setup();
  const keys = LlmKeys.createLocalKeys({ pool });
  const { key } = await keys.run({ action: 'add', provider: 'openrouter', key: 'sk-or-v1-aaaaaaaaaaaaaaaa' });
  fetchImpl.status = 401;
  await assert.rejects(keys.run({ action: 'update', id: key.id, key: 'sk-or-v1-bbbbbbbbbbbbbbbb' }), /değiştirilmedi/);
  assert.equal(pool.list('openrouter')[0].last4, 'aaaa');
  fetchImpl.status = 200;
  assert.equal((await keys.run({ action: 'update', id: key.id, key: 'sk-or-v1-bbbbbbbbbbbbbbbb', label: 'Yeni' })).key.last4, 'bbbb');
  assert.equal((await keys.run({ action: 'update', id: key.id, enabled: false })).key.status, 'disabled');
  assert.equal((await keys.run({ action: 'test', id: key.id })).ok, true);
  assert.deepEqual(await keys.run({ action: 'remove', id: key.id }), { removed: true });
  await assert.rejects(keys.run({ action: 'bogus' }), /Geçersiz/);
});

test('the LLM service opens a sealed key, adds it, and takes key jobs only from the web application', async () => {
  const { pool, dir } = setup();
  const sealedKey = LlmKeys.seal(KEY(4), rsa.publicKey);
  const out = await LlmKeys.handleKeys({ kind: 'keys', action: 'add', provider: 'groq', label: 'Sunucu', sealedKey }, { pool, privateKey: rsa.privateKey });
  assert.equal(out.key.label, 'Sunucu'); assert.equal(pool.acquire('groq').key, KEY(4));
  // Through the service handler: the key-management job of another publisher is refused.
  await assert.rejects(Service.handle({ kind: 'keys', action: 'list' }, { signal: new AbortController().signal, emit() {}, job: { publisher: 'verify' }, privateKey: rsa.privateKey }), /yalnızca web/);
  const process = require('node:process'); const before = process.env.LLM_DATA_DIR; process.env.LLM_DATA_DIR = dir;
  try {
    const listed = await Service.handle({ kind: 'keys', action: 'list' }, { signal: new AbortController().signal, emit() {}, job: { publisher: 'web' }, privateKey: rsa.privateKey });
    assert.equal(listed.keys.length, 1);
    assert.doesNotMatch(JSON.stringify(listed), /key_number_4/);
  } finally { if (before === undefined) delete process.env.LLM_DATA_DIR; else process.env.LLM_DATA_DIR = before; require('../lib/key-pool.cjs').pool().close(); }
});

test('the queue transport seals the key and reports an absent service', async () => {
  const sent = [];
  const client = { run: async (queue, payload) => { sent.push({ queue, payload }); return { keys: [] }; } };
  const keys = LlmKeys.createQueueKeys({ client, publicKey: rsa.publicKey, ready: () => true });
  await keys.run({ action: 'add', provider: 'groq', key: KEY(5), label: 'x' });
  assert.equal(sent[0].queue, 'llm'); assert.equal(sent[0].payload.kind, 'keys'); assert.ok(!('key' in sent[0].payload));
  assert.doesNotMatch(JSON.stringify(sent[0]), /key_number_5/); assert.equal(LlmKeys.open(sent[0].payload.sealedKey, rsa.privateKey), KEY(5));
  const down = LlmKeys.createQueueKeys({ client, publicKey: rsa.publicKey, ready: () => false });
  await assert.rejects(down.run({ action: 'list' }), e => e.status === 503);
  const refused = LlmKeys.createQueueKeys({ client: { run: async () => { throw Object.assign(Error('Anahtar eklenmedi: x'), { state: 'failed' }); } }, publicKey: rsa.publicKey });
  await assert.rejects(refused.run({ action: 'list' }), e => e.status === 400 && /eklenmedi/.test(e.message));
});
