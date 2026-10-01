const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('proxy preserves HTML 429, shares cooldown across queries and resumes after reset', async () => {
  let now = Date.now();
  let calls = 0;
  class Clock extends Date { static now() { return now; } }
  const context = { require: id => require(id.startsWith('./') ? path.join(__dirname, '..', id) : id), module: { exports: {} }, __dirname: path.join(__dirname, '..'), process,
    URL, AbortSignal, Date: Clock, setTimeout: (fn, ms) => setTimeout(() => { now += ms; fn(); }, 0),
    fetch: async () => ++calls === 1 ? new Response('<html>Rate limited</html>', { status: 429, headers: { 'retry-after': '120' } }) : new Response('{"results":[]}') };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server.cjs'), 'utf8'), context);
  const server = context.module.exports.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = query => `http://127.0.0.1:${server.address().port}/api/proxy?provider=CORE&url=${encodeURIComponent('https://api.core.ac.uk/v3/search/works/?q=' + query)}`;
    const first = await fetch(endpoint('first'));
    assert.equal(first.status, 429);
    assert.equal(first.headers.get('retry-after'), '120');
    assert.ok((await first.json()).error.includes('CORE'));
    const blocked = await fetch(endpoint('second'));
    assert.equal(blocked.status, 429);
    assert.equal(calls, 1);
    now += 121000;
    assert.equal((await fetch(endpoint('first'))).status, 200);
    assert.equal(calls, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
