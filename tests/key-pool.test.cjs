// The API key pool: use order, rest after 429, own limits, account groups, invalid keys, sealing and public views.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPool, maskSecrets } = require('../lib/key-pool.cjs');

const KEY = n => `gsk_test_key_number_${n}_abcdefghijklmnop`;
function setup(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-pool-'));
  const clock = { t: Date.UTC(2026, 9, 3, 12, 0, 0) };
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, headers: init.headers }); const key = Object.values(init.headers)[0]; return fetchImpl.reply(key, url); };
  fetchImpl.reply = () => new Response('{}', { status: 200 });
  const pool = createPool({ dir, now: () => clock.t, env, fetchImpl });
  return { pool, clock, dir, calls, fetchImpl, advance: ms => { clock.t += ms; } };
}

test('keys are used in order; a refused key rests and the next one is taken at once', () => {
  const { pool, advance } = setup();
  const a = pool.add({ provider: 'groq', label: 'A', key: KEY(1) }), b = pool.add({ provider: 'groq', label: 'B', key: KEY(2) });
  assert.equal(pool.acquire('groq').label, 'A');
  assert.equal(pool.acquire('groq').label, 'A', 'the first usable key keeps being used');
  pool.report(a.id, { status: 429, retryAfterMs: 30000 });
  assert.equal(pool.acquire('groq').label, 'B');
  pool.report(b.id, { status: 429, retryAfterMs: 10000 });
  assert.equal(pool.acquire('groq'), null);
  const wait = pool.nextAvailableAt('groq');
  assert.ok(wait > 0 && wait - Date.now() !== undefined);
  advance(10000);
  assert.equal(pool.acquire('groq').label, 'B', 'B is rested first');
  advance(20000);
  assert.equal(pool.acquire('groq').label, 'A');
  assert.equal(pool.nextAvailableAt('groq'), 0);
});

test('providers are separate pools; a provider without keys is unavailable', () => {
  const { pool } = setup();
  pool.add({ provider: 'gemini', key: KEY(3) });
  assert.equal(pool.hasUsable('gemini'), true); assert.equal(pool.hasUsable('groq'), false);
  assert.equal(pool.acquire('groq'), null); assert.equal(pool.nextAvailableAt('groq'), Infinity);
  assert.ok(pool.acquire('gemini').key.includes('number_3'));
  assert.throws(() => pool.acquire('claude'), /Bilinmeyen sağlayıcı/);
});

test('own per-minute and per-day limits rest a key before the provider refuses', () => {
  const { pool, advance } = setup();
  pool.add({ provider: 'groq', label: 'A', key: KEY(1), rpm: 2 }); pool.add({ provider: 'groq', label: 'B', key: KEY(2), rpd: 3 });
  assert.deepEqual([1, 2, 3, 4].map(() => pool.acquire('groq').label), ['A', 'A', 'B', 'B']);
  assert.equal(pool.acquire('groq').label, 'B');
  assert.equal(pool.acquire('groq'), null, 'A has used its 2/min and B its 3/day');
  advance(61000);
  assert.equal(pool.acquire('groq').label, 'A', 'the minute window slid');
  advance(24 * 3600 * 1000);
  assert.equal(pool.acquire('groq').label, 'A');
  assert.equal(pool.list('groq').find(k => k.label === 'B').today.requests, 0, 'the daily counter starts again the next UTC day');
});

test('keys of one group rest together after 429; a 401/403 makes a key invalid until it is replaced', () => {
  const { pool, advance } = setup();
  const a = pool.add({ provider: 'openrouter', label: 'A', key: 'sk-or-v1-aaaaaaaaaaaaaaaa', group: 'hesap1' });
  pool.add({ provider: 'openrouter', label: 'B', key: 'sk-or-v1-bbbbbbbbbbbbbbbb', group: 'hesap1' });
  const c = pool.add({ provider: 'openrouter', label: 'C', key: 'sk-or-v1-cccccccccccccccc', group: 'hesap2' });
  pool.report(a.id, { status: 429, retryAfterMs: 60000 });
  assert.equal(pool.acquire('openrouter').label, 'C', 'B shares A\'s account and rests too');
  pool.report(c.id, { status: 401, error: 'bad key sk-or-v1-cccccccccccccccc' });
  const view = pool.list('openrouter').find(k => k.label === 'C');
  assert.equal(view.status, 'invalid'); assert.doesNotMatch(JSON.stringify(view), /cccccccccccccccc/);
  assert.equal(pool.hasUsable('openrouter'), true, 'A and B are only resting');
  advance(60000);
  assert.equal(pool.acquire('openrouter').label, 'A');
  const fixed = pool.update(c.id, { key: 'sk-or-v1-dddddddddddddddd' });
  assert.equal(fixed.status, 'active'); assert.equal(fixed.last4, 'dddd');
});

test('tokens and outcomes are counted per key; spacing after a request is honoured', () => {
  const { pool, advance } = setup();
  const a = pool.add({ provider: 'openrouter', label: 'A', key: 'sk-or-v1-aaaaaaaaaaaaaaaa' });
  const key = pool.acquire('openrouter');
  pool.report(key.id, { ok: true, tokens: { prompt: 100, completion: 40 }, gapMs: 3000 });
  assert.equal(pool.acquire('openrouter'), null, 'the 3 s gap between requests of one key');
  advance(3000);
  assert.ok(pool.acquire('openrouter'));
  pool.report(a.id, { status: 500, error: 'upstream' });
  const view = pool.list('openrouter')[0];
  assert.deepEqual([view.total.ok, view.total.fail, view.total.promptTokens, view.total.completionTokens, view.today.tokens], [1, 1, 100, 40, 140]);
  assert.equal(view.status, 'cooling'); assert.equal(view.lastError, 'upstream');
});

test('keys are sealed on disk and views show only the last four characters', () => {
  const { pool, dir } = setup();
  pool.add({ provider: 'groq', label: 'Gizli', key: KEY(9) });
  pool.close();
  const raw = fs.readFileSync(path.join(dir, 'llm-keys.db')).toString('latin1');
  assert.doesNotMatch(raw, /key_number_9/, 'plain key text is not in the database file');
  const again = createPool({ dir });
  assert.match(again.acquire('groq').key, /key_number_9/, 'it opens again with the same secret');
  const view = again.list()[0];
  assert.equal(view.last4, 'mnop'); assert.ok(!('key' in view) && !JSON.stringify(view).includes('number_9'));
  assert.throws(() => again.add({ provider: 'groq', key: KEY(9) }), /zaten ekli/);
  assert.throws(() => again.add({ provider: 'groq', key: 'kısa' }), /8-400/);
  assert.throws(() => again.add({ provider: 'groq', key: KEY(5), rpm: -1 }), /sıfır veya pozitif/);
});

test('environment keys take part after stored ones, are read-only, and honour OPENROUTER_ENABLED', () => {
  const env = { GROQ_API_KEY: `${KEY(1)}, ${KEY(2)}`, OPENROUTER_API_KEY: 'sk-or-v1-eeeeeeeeeeeeeeee', OPENROUTER_ENABLED: 'false' };
  const { pool, dir } = setup(env);
  assert.equal(pool.hasUsable('openrouter'), false);
  env.OPENROUTER_ENABLED = 'true'; assert.equal(pool.hasUsable('openrouter'), true);
  pool.add({ provider: 'groq', label: 'Panel', key: KEY(7) });
  assert.deepEqual([1, 2, 3].map(() => pool.acquire('groq').label), ['Panel', 'Panel', 'Panel'], 'stored keys first');
  const list = pool.list('groq'); assert.deepEqual(list.map(k => [k.label, k.source]), [['Panel', 'db'], ['.env 1', 'env'], ['.env 2', 'env']]);
  // Deleting a .env key hides it from the pool (the file itself is not touched) and the choice survives a restart.
  assert.equal(pool.remove(list[2].id), true); assert.deepEqual(pool.list('groq').map(k => k.label), ['Panel', '.env']);
  pool.close(); assert.deepEqual(createPool({ dir, env }).list('groq').map(k => k.label), ['Panel', '.env'], 'still hidden after reopening');
  assert.throws(() => pool.update(list[1].id, { label: 'x' }), /\.env/);
  assert.throws(() => pool.add({ provider: 'groq', key: KEY(1) }), /zaten ekli/, 'a key that is already in the environment is a duplicate');
  delete env.GROQ_API_KEY; assert.equal(pool.list('groq').length, 1, 'removing the variable removes its keys');
  assert.equal(pool.remove(list[0].id), true); assert.equal(pool.hasUsable('groq'), false);
});

test('without a database file the pool is empty and creates nothing', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'key-pool-')), 'missing');
  const pool = createPool({ dir, env: {} });
  assert.deepEqual(pool.list(), []); assert.equal(pool.acquire('groq'), null); assert.equal(fs.existsSync(dir), false);
});

test('checking a key spends no model quota and tells valid, refused and rate-limited keys apart', async () => {
  const { pool, calls, fetchImpl } = setup();
  const a = pool.add({ provider: 'groq', label: 'A', key: KEY(1) });
  fetchImpl.reply = () => new Response('{}', { status: 200 });
  assert.equal((await pool.check('groq', KEY(1))).ok, true);
  assert.match(calls.at(-1).url, /\/models$/);
  assert.equal((await pool.check('openrouter', 'sk-or-v1-aaaaaaaaaaaaaaaa')).ok, true); assert.match(calls.at(-1).url, /auth\/key$/);
  assert.equal((await pool.check('gemini', 'AIzaSyAAAAAAAAAAAAAAAA')).ok, true); assert.match(calls.at(-1).url, /models\?pageSize=1$/);
  fetchImpl.reply = () => new Response('{}', { status: 401 });
  const refused = await pool.test(a.id);
  assert.equal(refused.ok, false); assert.equal(refused.key.status, 'invalid'); assert.equal(refused.key.lastTest.ok, false);
  fetchImpl.reply = () => new Response('{}', { status: 429 });
  const limited = await pool.test(a.id);
  assert.equal(limited.ok, true); assert.equal(limited.quota, true); assert.equal(limited.key.status, 'active', 'a 429 proves the key is accepted, so an earlier invalid mark is lifted');
  fetchImpl.reply = () => { throw new TypeError('fetch failed'); };
  assert.equal((await pool.check('groq', KEY(1))).message, 'Sağlayıcıya ulaşılamadı.');
});

test('secrets are masked in text', () => {
  assert.equal(maskSecrets('hata gsk_abcdefghijklmnopqrstuv ve sk-or-v1-0123456789abcdef ve AIzaSyA1234567890abc'), 'hata [gizli anahtar] ve [gizli anahtar] ve [gizli anahtar]');
});
