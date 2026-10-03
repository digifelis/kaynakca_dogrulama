// The admin panel's API-key management: administrators only, the key value never comes back or reaches the audit trail.
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/harness.cjs');

const KEY = 'gsk_panel_key_value_0123456789abcdef';

test('admins add, test, edit and remove LLM keys; the value is never returned or audited', async () => {
  const h = await harness();
  try {
    const admin = await h.adminClient(), user = await h.register('ayse');
    assert.equal((await user('GET', '/api/admin/llm-keys')).status, 403);
    assert.equal((await user('POST', '/api/admin/llm-keys', { provider: 'groq', key: KEY })).status, 403);

    const before = await admin('GET', '/api/admin/llm-keys');
    assert.equal(before.status, 200); assert.equal(before.mode, 'local');
    assert.ok(before.keys.every(k => k.source === 'env'), 'only the .env keys at first');

    assert.equal((await admin('POST', '/api/admin/llm-keys', { provider: 'claude', key: KEY })).status, 400);
    const added = await admin('POST', '/api/admin/llm-keys', { provider: 'groq', label: 'Birinci hesap', key: KEY, group: 'h1', rpm: 20, rpd: 500 });
    assert.equal(added.status, 201, JSON.stringify(added));
    assert.equal(added.key.last4, 'cdef'); assert.equal(added.key.source, 'db'); assert.equal(added.key.rpm, 20);
    assert.equal((await admin('POST', '/api/admin/llm-keys', { provider: 'groq', key: KEY })).status, 400, 'a duplicate is refused');

    const listed = await admin('GET', '/api/admin/llm-keys');
    const mine = listed.keys.find(k => k.id === added.key.id);
    assert.equal(mine.status, 'active'); assert.equal(listed.keys.findIndex(k => k.id === mine.id) < listed.keys.findIndex(k => k.source === 'env'), true, 'panel keys come before .env keys');
    assert.doesNotMatch(JSON.stringify(listed), /panel_key_value/);

    const tested = await admin('POST', `/api/admin/llm-keys/${mine.id}/test`);
    assert.equal(tested.status, 200); assert.equal(tested.ok, true);
    const paused = await admin('PATCH', `/api/admin/llm-keys/${mine.id}`, { enabled: false, label: 'Birinci (durdu)' });
    assert.equal(paused.key.status, 'disabled'); assert.equal(paused.key.label, 'Birinci (durdu)');
    assert.equal((await admin('PATCH', `/api/admin/llm-keys/${mine.id}`, { rpm: -3 })).status, 400);
    const envKey = listed.keys.find(k => k.source === 'env');
    assert.equal((await admin('DELETE', `/api/admin/llm-keys/${envKey.id}`)).removed, true, 'a .env key can be removed from the pool');
    assert.ok(!(await admin('GET', '/api/admin/llm-keys')).keys.some(k => k.id === envKey.id));
    assert.equal((await admin('DELETE', `/api/admin/llm-keys/${mine.id}`)).removed, true);

    const audit = (await admin('GET', '/api/admin/audit')).entries;
    const actions = audit.map(a => a.action);
    for (const wanted of ['llm.key_added', 'llm.key_tested', 'llm.key_updated', 'llm.key_removed']) assert.ok(actions.includes(wanted), wanted + ' in ' + actions.join());
    assert.doesNotMatch(JSON.stringify(audit), /panel_key_value|gsk_panel/);
    assert.match(JSON.stringify(audit.find(a => a.action === 'llm.key_added')), /cdef/);
  } finally { await h.close(); }
});
