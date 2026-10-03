// Performance and experience reports: the numbers are computed correctly from recorded metrics, only administrators see them,
// and the running server records requests, errors and users.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.METRICS_SAMPLE = '1';
const { createMetrics, routeOf } = require('../lib/metrics.cjs');
const { createReports, wstats, apdexOf } = require('../lib/reports.cjs');
const { harness } = require('./helpers/harness.cjs');

const fakeDb = (operations = []) => ({ q: sql => ({ all: () => /FROM operations/.test(sql) ? operations : [] }) });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kaynakca-metrics-'));

test('weighted percentiles and Apdex treat sampled requests as the requests they stand for', () => {
  const s = wstats([{ v: 100, w: 9 }, { v: 1000, w: 1 }]);
  assert.equal(s.n, 10); assert.equal(s.p50, 100); assert.equal(s.p95, 1000); assert.equal(Math.round(s.avg), 190);
  assert.equal(wstats([]).avg, null);
  // 3 fast, 1 tolerable, 1 slow, 1 server error, 1 client mistake (ignored): (3 + 0.5 + 0 + 0) / 6
  const rows = [200, 200, 200, 200, 200, 500, 404].map((status, i) => ({ status, w: 1, duration_ms: [100, 100, 100, 1000, 5000, 100, 100][i] }));
  assert.equal(Math.round(apdexOf(rows) * 1000) / 1000, 0.583);
  assert.equal(routeOf('/api/word/0f9d3c4e-1b2a-4c3d-8e9f-0a1b2c3d4e5f/state'), '/api/word/:id/state');
});

test('reports summarise requests, errors, model calls, files and users, and explain what to do', async () => {
  const dir = tmp(), at = Date.now() - 3600000, metrics = createMetrics(dir);
  try {
    for (let i = 0; i < 20; i++) metrics.http({ method: 'GET', pathname: '/api/word/documents', status: 200, durationMs: 80 + i, userId: 'u1', at: at + i });
    for (let i = 0; i < 4; i++) metrics.http({ method: 'POST', pathname: '/api/word/0f9d3c4e-1b2a-4c3d-8e9f-0a1b2c3d4e5f/verify', status: 500, durationMs: 900, userId: 'u2', code: 'boom', error: 'Beklenmeyen hata', at: at + 100 + i });
    metrics.http({ method: 'POST', pathname: '/api/auth/login', status: 401, durationMs: 40, userId: null, at: at + 200 });
    metrics.http({ method: 'GET', pathname: '/index.html', status: 200, durationMs: 5, at });
    for (let i = 0; i < 3; i++) metrics.llm({ userId: 'u1', name: 'content', provider: 'groq', model: 'm-big', durationMs: 4000 + i * 1000, waitMs: 3000, promptTokens: 1000, completionTokens: 200, at: at + i });
    metrics.llm({ userId: 'u2', name: 'content', provider: 'groq', model: 'm-big', status: 'error', durationMs: 500, error: 'rate limit', at });
    metrics.file({ userId: 'u1', kind: 'source-upload', bytes: 2 * 1048576, receiveMs: 1000, queueMs: 12000, extractMs: 800, embedMs: 3000, totalMs: 17000, at });
    metrics.verify({ userId: 'u1', refs: 40, queried: 30, cached: 10, durationMs: 20000, status: 'ok', at });
    metrics.sample({ at, rss: 300 * 1048576, heap: 100, lagP50: 5, lagP99: 450, cpu: 80, load1: 1.5, inflight: 7, requests: 40 });
    const ops = [{ user_id: 'u1', kind: 'word-verify', status: 'ok', duration_ms: 20000, total_tokens: 3600, started_at: at, refs: 30 }, { user_id: 'u2', kind: 'writer-ask', status: 'error', duration_ms: 500, total_tokens: 100, started_at: at, refs: 0 }];
    const reports = createReports({ metrics, appDb: fakeDb(ops), names: ids => Object.fromEntries(ids.map(id => [id, 'kullanici-' + id])) });

    const perf = reports.performance({ since: at - 60000 });
    const get = perf.routes.find(r => r.route === 'GET /api/word/documents');
    assert.equal(get.requests, 20); assert.equal(get.errors5xx, 0); assert.ok(get.p95Ms >= 95);
    assert.equal(perf.routes.find(r => r.route === 'POST /api/word/:id/verify').errors5xx, 4);
    assert.ok(!perf.routes.some(r => r.route.includes('index.html')), 'successful static files are not recorded');
    const model = perf.models.find(m => m.model === 'groq / m-big');
    assert.equal(model.calls, 4); assert.equal(model.errors, 1); assert.equal(model.avgMs, 5000); assert.equal(model.avgWaitMs, 2250); assert.equal(model.promptTokens, 3000 + 0);
    assert.equal(perf.files[0].avgQueueMs, 12000); assert.equal(perf.files[0].avgSpeedKbps, 2048);
    assert.equal(perf.verification.cachedShare, 25); assert.equal(perf.verification.msPerReference, 500);
    assert.ok(perf.series.some(s => s.requests > 0 && s.llmCalls > 0 && s.files === 1));

    const err = reports.errors({ since: at - 60000 });
    assert.equal(err.errors5xx, 4); assert.equal(err.errors4xx, 1);
    assert.deepEqual(err.byStatus.map(s => s.status), [500, 401]);
    assert.equal(err.byUser[0].username, 'kullanici-u2'); assert.equal(err.byUser[0].errors5xx, 4);
    assert.equal(err.recent[0].status === 401 || err.recent[0].status === 500, true);
    assert.equal(err.failedModelCalls[0].message, 'rate limit');

    const use = reports.usage({ since: at - 60000 });
    assert.equal(use.activeUsers, 2); assert.equal(use.references, 30); assert.equal(use.tokens, 3700);
    assert.equal(use.perActiveUser.tokens, 1850); assert.equal(use.perActiveUser.references, 15);
    assert.equal(use.perUser[0].username, 'kullanici-u1'); assert.ok(use.series.some(s => s.activeUsers === 2 && s.tokensPerUser === 1850));

    const exp = reports.experience({ since: at - 60000 });
    const u1 = exp.perUser.find(u => u.userId === 'u1'), u2 = exp.perUser.find(u => u.userId === 'u2');
    assert.ok(u1.score > u2.score, 'the user with server errors and a failed operation scores lower');
    assert.equal(u2.level, 'poor');

    const cap = reports.capacity({ since: at - 60000 });
    assert.equal(cap.maxLagP99Ms, 450); assert.equal(cap.peakInflight, 7); assert.equal(cap.providers[0].throttled, 3);

    const summary = reports.summary({ since: at - 60000 }), titles = summary.insights.map(i => i.title).join(' | ');
    assert.match(titles, /sunucu hatası/); assert.match(titles, /kota beklemekle/); assert.match(titles, /Olay döngüsü/); assert.match(titles, /bekliyor/);
    assert.equal(summary.insights[0].level, 'critical');
    assert.deepEqual(reports.performance({ since: Date.now() + 1000, until: Date.now() + 2000 }).routes, [], 'an empty period gives empty tables');
  } finally { metrics.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the admin reports API is for administrators and reflects what the server handled', async () => {
  const h = await harness();
  try {
    const admin = await h.adminClient(), user = await h.register('mehmet');
    await user('GET', '/api/word/documents'); await user('GET', '/api/word/00000000-0000-4000-8000-000000000000/state'); await user('GET', '/api/admin/users');
    assert.equal((await user('GET', '/api/admin/reports/summary')).status, 403);
    for (const section of ['summary', 'performance', 'errors', 'usage', 'experience', 'capacity']) {
      const body = await admin('GET', `/api/admin/reports/${section}?days=1`);
      assert.equal(body.status, 200, section); assert.ok(body.range?.from < body.range?.to, section);
    }
    const errors = await admin('GET', '/api/admin/reports/errors?days=1');
    assert.ok(errors.errors4xx >= 2, 'the 404 and the 403 were recorded');
    assert.ok(errors.byUser.some(u => u.username === 'mehmet'), 'with the user who got them');
    assert.equal((await admin('GET', '/api/admin/reports/yok')).status, 404);
    assert.equal((await admin('GET', '/api/admin/reports/errors?days=1&format=csv&table=yok')).status, 400);
  } finally { await h.close(); }
});
