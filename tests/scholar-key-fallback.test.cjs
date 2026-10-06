const test = require('node:test');
const assert = require('node:assert/strict');
const Proxy = require('../lib/provider-proxy.cjs');

test('a rejected Semantic Scholar key is retried once without the key', async () => {
  const saved = { fetch: global.fetch, key: process.env.SEMANTIC_SCHOLAR_API_KEY };
  process.env.SEMANTIC_SCHOLAR_API_KEY = 'bad-key';
  const seen = [];
  global.fetch = async (url, options) => {
    seen.push(options.headers['x-api-key'] || null);
    return options.headers['x-api-key'] ? new Response('', { status: 403 }) : new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await Proxy.upstream('Semantic Scholar', 'https://api.semanticscholar.org/graph/v1/paper/search?query=fallback-test&limit=1');
    assert.equal(result.status, 200);
    assert.deepEqual(seen, ['bad-key', null]);
  } finally {
    global.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.SEMANTIC_SCHOLAR_API_KEY; else process.env.SEMANTIC_SCHOLAR_API_KEY = saved.key;
  }
});
