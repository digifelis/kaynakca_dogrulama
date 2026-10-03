// Reports for the admin panel: system performance and what users experience. Reads metrics.db (lib/metrics.cjs) and the
// operation log in app.db. Every section takes a time range and returns plain data (tables are arrays of flat objects, so
// any of them can be exported as CSV).
//
//   summary      headline numbers + insights (what to look at, what to do)
//   performance  waiting times: API routes, model calls, file handling, verification runs; all over time
//   errors       4xx / 5xx / client-cancelled responses: when, how many, on which route, for which user
//   usage        sources queried and tokens used: over time, per user, average per active user
//   experience   per-user experience score (Apdex, errors, model speed, file speed) and the share of users who are well served
//   capacity     process memory, CPU, event-loop delay, load by hour: when to add servers, workers or API keys
const { DAY } = require('./metrics.cjs');

const HOUR = 3600000;
const APDEX_T = () => Math.max(50, Number(process.env.APDEX_T_MS) || 500);     // a request this fast counts as "satisfied"
const LLM_SLOW_MS = () => Math.max(1000, Number(process.env.REPORT_LLM_SLOW_MS) || 30000);
const MAX_ROWS = 400000;

const round = (n, digits = 0) => n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** digits) / 10 ** digits;
const sum = (list, key) => list.reduce((total, row) => total + (Number(key ? row[key] : row) || 0), 0);

// Weighted statistics: rows are { v, w }; a sampled request stands for w requests.
function wstats(rows) {
  const list = rows.filter(r => Number.isFinite(r.v)).sort((a, b) => a.v - b.v);
  const total = list.reduce((t, r) => t + r.w, 0);
  if (!total) return { n: 0, avg: null, p50: null, p95: null, p99: null, max: null };
  const at = p => { let run = 0; for (const r of list) { run += r.w; if (run >= total * p) return r.v; } return list[list.length - 1].v; };
  return { n: total, avg: list.reduce((t, r) => t + r.v * r.w, 0) / total, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: list[list.length - 1].v };
}
const fmtStats = (s, digits = 0) => ({ n: round(s.n), avg: round(s.avg, digits), p50: round(s.p50, digits), p95: round(s.p95, digits), p99: round(s.p99, digits), max: round(s.max, digits) });
const groupBy = (list, keyOf) => { const map = new Map(); for (const item of list) { const key = keyOf(item); if (!map.has(key)) map.set(key, []); map.get(key).push(item); } return map; };
const median = list => { const s = list.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

// Apdex for API requests: satisfied <= T, tolerating <= 4T, frustrated slower or failed with a server error.
// Client mistakes (4xx) are not the server's fault, but a client that gave up (499) and a 5xx are.
function apdexOf(rows) {
  const T = APDEX_T(); let n = 0, score = 0;
  for (const r of rows) {
    if (r.status >= 400 && r.status < 500 && r.status !== 499 && r.status !== 429) continue;
    n += r.w;
    if (r.status >= 500 || r.status === 499 || r.status === 429) continue;
    score += r.w * (r.duration_ms <= T ? 1 : r.duration_ms <= 4 * T ? 0.5 : 0);
  }
  return n ? score / n : null;
}

function createReports({ metrics, appDb, names = () => ({}), now = Date.now }) {
  const q = sql => appDb.q(sql);
  const range = ({ since, until } = {}) => { const to = until || now(), from = since || to - 7 * DAY; return { from, to, bucket: to - from <= 2 * DAY + HOUR ? HOUR : DAY }; };
  const bucketOf = (at, r) => Math.floor(at / r.bucket) * r.bucket;
  const buckets = r => { const list = []; for (let t = bucketOf(r.from, r); t <= r.to; t += r.bucket) list.push(t); return list.slice(-400); };
  const load = (db, sql, r) => db ? db.prepare(sql + ` LIMIT ${MAX_ROWS}`).all(r.from, r.to) : [];

  function data(r) {
    const db = metrics.reader();
    return {
      http: load(db, 'SELECT at, method, route, class, status, duration_ms, user_id, code, error, w FROM http_requests WHERE at >= ? AND at <= ? ORDER BY at', r),
      llm: load(db, 'SELECT at, user_id, name, provider, model, status, duration_ms, wait_ms, prompt_tokens, completion_tokens, error FROM llm_calls WHERE at >= ? AND at <= ? ORDER BY at', r),
      file: load(db, 'SELECT at, user_id, kind, status, bytes, receive_ms, speed_kbps, queue_ms, extract_ms, embed_ms, total_ms, error FROM file_events WHERE at >= ? AND at <= ? ORDER BY at', r),
      verify: load(db, 'SELECT at, user_id, refs, queried, cached, duration_ms, status FROM verify_runs WHERE at >= ? AND at <= ? ORDER BY at', r),
      samples: load(db, 'SELECT * FROM samples WHERE at >= ? AND at <= ? ORDER BY at', r),
    };
  }
  const operations = r => q('SELECT user_id, kind, status, duration_ms, total_tokens, started_at, COALESCE(json_extract(detail, \'$.queried\'), json_extract(detail, \'$.references\'), 0) AS refs FROM operations WHERE started_at >= ? AND started_at <= ?').all(r.from, r.to);
  const referencesOf = op => op.kind === 'word-verify' ? Number(op.refs) || 0 : 0;

  // ---- building blocks
  const apiRows = d => d.http.filter(h => h.class === 'api');
  function routeTable(d) {
    return [...groupBy(apiRows(d), h => h.method + ' ' + h.route)].map(([key, rows]) => {
      const ok = rows.filter(h => h.status < 400), stats = wstats(ok.map(h => ({ v: h.duration_ms, w: h.w }))), total = sum(rows, 'w');
      const bad = status => sum(rows.filter(h => status(h.status)), 'w');
      return { route: key, requests: round(total), avgMs: round(stats.avg), p50Ms: round(stats.p50), p95Ms: round(stats.p95), p99Ms: round(stats.p99), maxMs: round(stats.max),
        errors4xx: round(bad(s => s >= 400 && s < 500 && s !== 499)), errors5xx: round(bad(s => s >= 500)), cancelled: round(bad(s => s === 499)),
        errorRate: total ? round((bad(s => s >= 500)) / total * 100, 2) : 0, apdex: round(apdexOf(rows), 3) };
    }).sort((a, b) => b.p95Ms - a.p95Ms || b.requests - a.requests);
  }
  function llmTable(d, keyOf, label) {
    return [...groupBy(d.llm, keyOf)].map(([key, rows]) => {
      const ok = rows.filter(c => c.status === 'ok'), stats = wstats(ok.map(c => ({ v: c.duration_ms, w: 1 })));
      return { [label]: key || '—', calls: rows.length, errors: rows.filter(c => c.status === 'error').length, errorRate: round(rows.filter(c => c.status === 'error').length / rows.length * 100, 1),
        avgMs: round(stats.avg), p50Ms: round(stats.p50), p95Ms: round(stats.p95), maxMs: round(stats.max), avgWaitMs: round(sum(rows, 'wait_ms') / rows.length),
        waitShare: sum(rows, 'duration_ms') ? round(sum(rows, 'wait_ms') / sum(rows, 'duration_ms') * 100, 1) : 0,
        promptTokens: sum(rows, 'prompt_tokens'), completionTokens: sum(rows, 'completion_tokens'), avgTokens: round((sum(rows, 'prompt_tokens') + sum(rows, 'completion_tokens')) / rows.length) };
    }).sort((a, b) => b.calls - a.calls);
  }
  function fileTable(d) {
    return [...groupBy(d.file, f => f.kind)].map(([kind, rows]) => {
      const ok = rows.filter(f => f.status === 'ok'), avg = key => { const v = ok.map(f => f[key]).filter(Number.isFinite); return v.length ? sum(v) / v.length : null; };
      const speeds = ok.map(f => f.speed_kbps).filter(Number.isFinite), totals = ok.map(f => f.total_ms).filter(Number.isFinite).sort((a, b) => a - b);
      return { kind, files: rows.length, errors: rows.filter(f => f.status === 'error').length, avgMb: round(sum(rows, 'bytes') / rows.length / 1048576, 2),
        avgSpeedKbps: round(speeds.length ? sum(speeds) / speeds.length : null), medianSpeedKbps: round(median(speeds)),
        avgReceiveMs: round(avg('receive_ms')), avgQueueMs: round(avg('queue_ms')), avgExtractMs: round(avg('extract_ms')), avgEmbedMs: round(avg('embed_ms')), avgTotalMs: round(avg('total_ms')),
        p95TotalMs: round(totals.length ? totals[Math.min(totals.length - 1, Math.floor(totals.length * 0.95))] : null) };
    }).sort((a, b) => b.files - a.files);
  }
  function verifyTable(d) {
    const ok = d.verify.filter(v => v.status === 'completed' || v.status === 'ok' || v.status === 'done'), rows = ok.length ? ok : d.verify;
    const refs = sum(rows, 'refs'), queried = sum(rows, 'queried'), cached = sum(rows, 'cached'), time = sum(rows, 'duration_ms');
    return { runs: d.verify.length, failed: d.verify.filter(v => v.status === 'error').length, avgRunMs: rows.length ? round(time / rows.length) : null, p95RunMs: round(wstats(rows.map(v => ({ v: v.duration_ms, w: 1 }))).p95),
      avgRefs: rows.length ? round(refs / rows.length, 1) : null, msPerReference: refs ? round(time / refs) : null, cachedShare: refs ? round(cached / refs * 100, 1) : null, references: refs, queried, cached };
  }
  function series(d, r, ops) {
    const http = groupBy(d.http, h => bucketOf(h.at, r)), llm = groupBy(d.llm, c => bucketOf(c.at, r)), files = groupBy(d.file, f => bucketOf(f.at, r)), verify = groupBy(d.verify, v => bucketOf(v.at, r));
    const opsBy = groupBy(ops, o => bucketOf(o.started_at, r));
    return buckets(r).map(at => {
      const h = apiRows({ http: http.get(at) || [] }), ok = h.filter(x => x.status < 400), stats = wstats(ok.map(x => ({ v: x.duration_ms, w: x.w }))), total = sum(h, 'w');
      const calls = (llm.get(at) || []).filter(c => c.status === 'ok'), fl = (files.get(at) || []).filter(f => f.status === 'ok'), vr = verify.get(at) || [], op = opsBy.get(at) || [];
      const speeds = fl.map(f => f.speed_kbps).filter(Number.isFinite), queues = fl.map(f => f.queue_ms).filter(Number.isFinite);
      return { at, requests: round(total), avgMs: round(stats.avg), p95Ms: round(stats.p95),
        errors4xx: round(sum(h.filter(x => x.status >= 400 && x.status < 500 && x.status !== 499), 'w')), errors5xx: round(sum(h.filter(x => x.status >= 500), 'w')), cancelled: round(sum(h.filter(x => x.status === 499), 'w')),
        llmCalls: (llm.get(at) || []).length, llmAvgMs: calls.length ? round(sum(calls, 'duration_ms') / calls.length) : null, llmAvgWaitMs: calls.length ? round(sum(calls, 'wait_ms') / calls.length) : null,
        files: (files.get(at) || []).length, uploadSpeedKbps: speeds.length ? round(sum(speeds) / speeds.length) : null, fileQueueMs: queues.length ? round(sum(queues) / queues.length) : null,
        verifyRuns: vr.length, verifyAvgMs: vr.length ? round(sum(vr, 'duration_ms') / vr.length) : null,
        operations: op.length, activeUsers: new Set(op.map(o => o.user_id).filter(Boolean)).size };
    });
  }

  const reports = {
    range,

    // ---------------------------------------------------------------- performance
    performance(options) {
      const r = range(options), d = data(r), ops = operations(r);
      const ok = apiRows(d).filter(h => h.status < 400), stats = fmtStats(wstats(ok.map(h => ({ v: h.duration_ms, w: h.w }))));
      const llmOk = d.llm.filter(c => c.status === 'ok'), llmStats = fmtStats(wstats(llmOk.map(c => ({ v: c.duration_ms, w: 1 }))));
      const wait = fmtStats(wstats(llmOk.map(c => ({ v: c.wait_ms, w: 1 }))));
      const fileOk = d.file.filter(f => f.status === 'ok'), speed = fmtStats(wstats(fileOk.filter(f => Number.isFinite(f.speed_kbps)).map(f => ({ v: f.speed_kbps, w: 1 }))));
      const queue = fmtStats(wstats(fileOk.filter(f => Number.isFinite(f.queue_ms)).map(f => ({ v: f.queue_ms, w: 1 }))));
      const fileTotal = fmtStats(wstats(fileOk.filter(f => Number.isFinite(f.total_ms)).map(f => ({ v: f.total_ms, w: 1 }))));
      const operationsDone = ops.filter(o => o.status !== 'running' && Number.isFinite(o.duration_ms));
      const byKind = [...groupBy(operationsDone, o => o.kind)].map(([kind, rows]) => { const s = wstats(rows.map(o => ({ v: o.duration_ms, w: 1 }))); return { kind, operations: rows.length, avgMs: round(s.avg), p50Ms: round(s.p50), p95Ms: round(s.p95), maxMs: round(s.max), failed: rows.filter(o => o.status === 'error').length }; }).sort((a, b) => b.operations - a.operations);
      return { range: r, api: stats, llm: llmStats, llmWait: wait, uploadSpeed: speed, fileQueue: queue, fileTotal,
        routes: routeTable(d), models: llmTable(d, c => (c.provider || '—') + ' / ' + (c.model || '—'), 'model'), llmByName: llmTable(d, c => c.name, 'name'),
        files: fileTable(d), verification: verifyTable(d), operationsByKind: byKind, series: series(d, r, ops) };
    },

    // ---------------------------------------------------------------- errors
    errors(options) {
      const r = range(options), d = data(r), bad = d.http.filter(h => h.status >= 400);
      const total = sum(d.http.filter(h => h.class === 'api'), 'w'), count = list => round(sum(list, 'w'));
      const nameOf = names(bad.map(h => h.user_id));
      const byStatus = [...groupBy(bad, h => h.status)].map(([status, rows]) => ({ status: Number(status), count: count(rows), share: total ? round(sum(rows, 'w') / total * 100, 2) : 0, users: new Set(rows.map(h => h.user_id).filter(Boolean)).size, last: Math.max(...rows.map(h => h.at)) })).sort((a, b) => b.count - a.count);
      const byRoute = [...groupBy(bad, h => h.status + ' ' + h.method + ' ' + h.route)].map(([, rows]) => ({ status: rows[0].status, route: rows[0].method + ' ' + rows[0].route, count: count(rows), users: new Set(rows.map(h => h.user_id).filter(Boolean)).size,
        first: rows[0].at, last: rows[rows.length - 1].at, code: rows.find(h => h.code)?.code || '', message: rows.find(h => h.error)?.error || '' })).sort((a, b) => b.count - a.count).slice(0, 60);
      const reqBy = groupBy(d.http, h => h.user_id || '');
      const byUser = [...groupBy(bad.filter(h => h.user_id), h => h.user_id)].map(([userId, rows]) => {
        const all = sum(reqBy.get(userId) || [], 'w');
        return { userId, username: nameOf[userId] || null, errors4xx: count(rows.filter(h => h.status < 500 && h.status !== 499)), errors5xx: count(rows.filter(h => h.status >= 500)), cancelled: count(rows.filter(h => h.status === 499)),
          requests: round(all), errorRate: all ? round(sum(rows, 'w') / all * 100, 1) : 0, last: rows[rows.length - 1].at, topRoute: [...groupBy(rows, h => h.status + ' ' + h.route)].sort((a, b) => b[1].length - a[1].length)[0][0] };
      }).sort((a, b) => b.errors5xx - a.errors5xx || b.errors4xx - a.errors4xx).slice(0, 100);
      const grouped = groupBy(bad, h => bucketOf(h.at, r));
      const series = buckets(r).map(at => { const rows = grouped.get(at) || []; return { at, errors4xx: count(rows.filter(h => h.status < 500 && h.status !== 499)), errors5xx: count(rows.filter(h => h.status >= 500)), cancelled: count(rows.filter(h => h.status === 499)) }; });
      const recent = bad.slice(-100).reverse().map(h => ({ at: h.at, status: h.status, route: h.method + ' ' + h.route, userId: h.user_id, username: nameOf[h.user_id] || null, durationMs: round(h.duration_ms), code: h.code || '', message: h.error || '' }));
      const failedModel = d.llm.filter(c => c.status === 'error').slice(-30).reverse().map(c => ({ at: c.at, userId: c.user_id, name: c.name, model: (c.provider || '') + ' / ' + (c.model || ''), durationMs: round(c.duration_ms), message: c.error || '' }));
      return { range: r, totalRequests: round(total), errors4xx: count(bad.filter(h => h.status < 500 && h.status !== 499)), errors5xx: count(bad.filter(h => h.status >= 500)), cancelled: count(bad.filter(h => h.status === 499)),
        byStatus, byRoute, byUser, series, recent, failedModelCalls: failedModel };
    },

    // ---------------------------------------------------------------- usage
    usage(options) {
      const r = range(options), ops = operations(r), d = data(r);
      const users = groupBy(ops.filter(o => o.user_id), o => o.user_id), nameOf = names([...users.keys()]);
      const perUser = [...users].map(([userId, rows]) => {
        const refs = sum(rows.map(referencesOf)), tokens = sum(rows, 'total_tokens'), days = new Set(rows.map(o => Math.floor(o.started_at / DAY))).size;
        return { userId, username: nameOf[userId] || null, operations: rows.length, references: refs, tokens, tokensPerOperation: rows.length ? round(tokens / rows.length) : 0, activeDays: days,
          referencesPerActiveDay: days ? round(refs / days, 1) : 0, tokensPerActiveDay: days ? round(tokens / days) : 0, failed: rows.filter(o => o.status === 'error').length, last: Math.max(...rows.map(o => o.started_at)) };
      }).sort((a, b) => b.tokens - a.tokens);
      const active = perUser.length, tokens = sum(perUser, 'tokens'), refs = sum(perUser, 'references');
      const byBucket = groupBy(ops, o => bucketOf(o.started_at, r)), calls = groupBy(d.llm, c => bucketOf(c.at, r));
      const series = buckets(r).map(at => {
        const rows = byBucket.get(at) || [], who = new Set(rows.map(o => o.user_id).filter(Boolean)), t = sum(rows, 'total_tokens'), rf = sum(rows.map(referencesOf)), n = who.size;
        return { at, operations: rows.length, activeUsers: n, references: rf, tokens: t, referencesPerUser: n ? round(rf / n, 1) : 0, tokensPerUser: n ? round(t / n) : 0,
          promptTokens: sum(calls.get(at) || [], 'prompt_tokens'), completionTokens: sum(calls.get(at) || [], 'completion_tokens') };
      });
      const byKind = [...groupBy(ops, o => o.kind)].map(([kind, rows]) => ({ kind, operations: rows.length, references: sum(rows.map(referencesOf)), tokens: sum(rows, 'total_tokens'), avgTokens: rows.length ? round(sum(rows, 'total_tokens') / rows.length) : 0, failed: rows.filter(o => o.status === 'error').length })).sort((a, b) => b.tokens - a.tokens);
      // How concentrated the use is: share of all tokens used by the heaviest 10 % of users.
      const heavy = Math.max(1, Math.ceil(active * 0.1)), topShare = tokens ? round(sum(perUser.slice(0, heavy), 'tokens') / tokens * 100, 1) : 0;
      return { range: r, activeUsers: active, operations: ops.length, references: refs, tokens,
        perActiveUser: { references: active ? round(refs / active, 1) : 0, tokens: active ? round(tokens / active) : 0, operations: active ? round(ops.length / active, 1) : 0,
          medianReferences: median(perUser.map(u => u.references)), medianTokens: median(perUser.map(u => u.tokens)) },
        topDecileShare: topShare, byKind, perUser: perUser.slice(0, 300), series };
    },

    // ---------------------------------------------------------------- experience
    experience(options) {
      const r = range(options), d = data(r), ops = operations(r);
      const ids = new Set([...d.http, ...d.llm, ...d.file].map(x => x.user_id).filter(Boolean)), nameOf = names([...ids]);
      const httpBy = groupBy(apiRows(d).filter(h => h.user_id), h => h.user_id), llmBy = groupBy(d.llm.filter(c => c.user_id), c => c.user_id), fileBy = groupBy(d.file.filter(f => f.user_id), f => f.user_id);
      const failedBy = groupBy(ops.filter(o => o.user_id && o.status === 'error'), o => o.user_id), opsBy = groupBy(ops.filter(o => o.user_id), o => o.user_id);
      const clamp = x => Math.max(0, Math.min(1, x));
      const rows = [...ids].map(userId => {
        const h = httpBy.get(userId) || [], c = llmBy.get(userId) || [], f = fileBy.get(userId) || [], total = sum(h, 'w');
        const apdex = apdexOf(h), serverErrors = sum(h.filter(x => x.status >= 500 || x.status === 499), 'w'), errRate = total ? serverErrors / total : null;
        const llmOk = c.filter(x => x.status === 'ok'), llmAvg = llmOk.length ? sum(llmOk, 'duration_ms') / llmOk.length : null;
        const fOk = f.filter(x => x.status === 'ok'), queues = fOk.map(x => x.queue_ms).filter(Number.isFinite), speeds = fOk.map(x => x.speed_kbps).filter(Number.isFinite);
        const queueAvg = queues.length ? sum(queues) / queues.length : null, speedAvg = speeds.length ? sum(speeds) / speeds.length : null;
        const opCount = (opsBy.get(userId) || []).length, opFail = (failedBy.get(userId) || []).length;
        // Components in 0..1; a component with no data is left out and the remaining weights are rescaled.
        const parts = [[0.35, apdex], [0.2, errRate == null ? null : clamp(1 - errRate / 0.05)], [0.2, llmAvg == null ? null : clamp(1 - (llmAvg - 5000) / 55000)],
          [0.1, queueAvg == null ? null : clamp(1 - (queueAvg - 3000) / 57000)], [0.15, opCount ? clamp(1 - opFail / opCount / 0.2) : null]].filter(([, v]) => v != null);
        const weight = sum(parts.map(p => p[0])), score = weight ? parts.reduce((t, [w, v]) => t + w * v, 0) / weight * 100 : null;
        return { userId, username: nameOf[userId] || null, requests: round(total), apdex: round(apdex, 2), serverErrorRate: errRate == null ? null : round(errRate * 100, 1),
          llmCalls: c.length, llmAvgMs: round(llmAvg), fileCount: f.length, fileQueueMs: round(queueAvg), uploadSpeedKbps: round(speedAvg), operations: opCount, failedOperations: opFail,
          score: round(score), level: score == null ? 'unknown' : score >= 85 ? 'good' : score >= 70 ? 'fair' : 'poor' };
      }).sort((a, b) => (a.score ?? 101) - (b.score ?? 101));
      const scored = rows.filter(u => u.score != null), count = level => scored.filter(u => u.level === level).length;
      const all = apdexOf(apiRows(d));
      return { range: r, apdexT: APDEX_T(), apdex: round(all, 3), users: rows.length, good: count('good'), fair: count('fair'), poor: count('poor'),
        satisfiedShare: scored.length ? round(count('good') / scored.length * 100, 1) : null, averageScore: scored.length ? round(sum(scored, 'score') / scored.length, 1) : null, perUser: rows.slice(0, 300) };
    },

    // ---------------------------------------------------------------- capacity
    capacity(options) {
      const r = range(options), d = data(r), ops = operations(r);
      const samples = d.samples, grouped = groupBy(samples, s => bucketOf(s.at, r));
      const series = buckets(r).map(at => {
        const rows = grouped.get(at) || [], avg = key => rows.length ? sum(rows, key) / rows.length : null, max = key => rows.length ? Math.max(...rows.map(x => x[key] ?? 0)) : null;
        return { at, rssMb: round(avg('rss') / 1048576), maxRssMb: round(max('rss') / 1048576), cpu: round(avg('cpu'), 1), lagP99Ms: round(max('lag_p99'), 1), maxInflight: max('inflight'), load1: round(avg('load1'), 2) };
      });
      // Busiest hours of the day (server local time): requests and operations.
      const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, requests: 0, operations: 0, llmCalls: 0 }));
      for (const h of apiRows(d)) hours[new Date(h.at).getHours()].requests += h.w;
      for (const o of ops) hours[new Date(o.started_at).getHours()].operations++;
      for (const c of d.llm) hours[new Date(c.at).getHours()].llmCalls++;
      const wait = d.llm.filter(c => c.status === 'ok'), providers = [...groupBy(d.llm, c => c.provider || '—')].map(([provider, rows]) => ({ provider, calls: rows.length,
        throttled: rows.filter(c => c.wait_ms > 1000).length, avgWaitMs: round(sum(rows, 'wait_ms') / rows.length), maxWaitMs: round(Math.max(...rows.map(c => c.wait_ms))), errors: rows.filter(c => c.status === 'error').length })).sort((a, b) => b.calls - a.calls);
      const peak = series.reduce((m, s) => Math.max(m, s.maxInflight || 0), 0);
      return { range: r, samples: samples.length, peakInflight: peak, maxLagP99Ms: round(Math.max(0, ...samples.map(s => s.lag_p99 || 0)), 1), maxRssMb: round(Math.max(0, ...samples.map(s => s.rss || 0)) / 1048576),
        avgCpu: samples.length ? round(sum(samples, 'cpu') / samples.length, 1) : null, cpus: require('node:os').cpus().length,
        hours: hours.map(h => ({ ...h, requests: round(h.requests) })), providers, waitingModelCalls: wait.filter(c => c.wait_ms > 1000).length, series };
    },

    // ---------------------------------------------------------------- summary + insights
    summary(options) {
      const r = range(options), perf = reports.performance(options), err = reports.errors(options), use = reports.usage(options), exp = reports.experience(options), cap = reports.capacity(options);
      const insights = reports.insights({ perf, err, use, exp, cap });
      return { range: r, requests: err.totalRequests, errors4xx: err.errors4xx, errors5xx: err.errors5xx, cancelled: err.cancelled,
        errorRate: err.totalRequests ? round(err.errors5xx / err.totalRequests * 100, 2) : 0, api: perf.api, llm: perf.llm, llmWait: perf.llmWait, uploadSpeed: perf.uploadSpeed, fileQueue: perf.fileQueue,
        verification: perf.verification, activeUsers: use.activeUsers, references: use.references, tokens: use.tokens, perActiveUser: use.perActiveUser,
        apdex: exp.apdex, apdexT: exp.apdexT, satisfiedShare: exp.satisfiedShare, averageScore: exp.averageScore, poorUsers: exp.poor, scoredUsers: exp.good + exp.fair + exp.poor,
        insights, series: perf.series.map(s => ({ at: s.at, requests: s.requests, p95Ms: s.p95Ms, errors5xx: s.errors5xx, llmAvgMs: s.llmAvgMs })) };
    },

    // Rules of thumb that turn the numbers into things to do. Each says what was seen, why it matters and what to try.
    insights({ perf, err, use, exp, cap }) {
      const list = [], add = (level, title, detail, action) => list.push({ level, title, detail, action: action || '' });
      const rate = err.totalRequests ? err.errors5xx / err.totalRequests : 0;
      if (err.errors5xx) add(rate > 0.01 ? 'critical' : 'warning', `${err.errors5xx} sunucu hatası (5xx)`, `İsteklerin %${round(rate * 100, 2)}'i sunucu hatasıyla bitti. En sık: ${err.byRoute.find(x => x.status >= 500)?.route || '—'}.`, 'Hatalar sekmesinde yolu ve saati inceleyin; hata iletisi nedeni gösterir.');
      const throttled = err.byStatus.find(s => s.status === 429);
      if (throttled?.count) add('warning', `${throttled.count} kez "çok sık istek / kota" (429) yanıtı`, `${throttled.users} kullanıcı etkilendi.`, 'Paket sınırlarını ya da hız sınırını gözden geçirin; kullanıcıya beklemesi gerektiği daha açık gösterilebilir.');
      if (err.totalRequests && err.cancelled / err.totalRequests > 0.02) add('warning', 'İstekler tamamlanmadan bırakılıyor', `İsteklerin %${round(err.cancelled / err.totalRequests * 100, 1)}'i, yanıt gelmeden kullanıcı tarafından kesildi (499).`, 'Bu yollardaki yavaşlığa bakın; kullanıcılar beklemekten vazgeçiyor olabilir.');
      const slow = perf.routes.find(x => x.requests >= 5 && x.p95Ms > 3000);
      if (perf.api.p95 > 1500) add(perf.api.p95 > 5000 ? 'critical' : 'warning', `API yanıtının %95'i ${perf.api.p95} ms üzerinde`, slow ? `En yavaş yol: ${slow.route} (p95 ${slow.p95Ms} ms).` : '', 'Yavaş yolu inceleyin; CPU/bellek sekmesinde olay döngüsü gecikmesi yüksekse sunucu çekirdeği ya da süreç sayısı yetersizdir.');
      else if (perf.api.n) add('good', `API hızlı: ortanca ${perf.api.p50} ms, %95'i ${perf.api.p95} ms`, '', '');
      if (perf.llm.p95 > LLM_SLOW_MS()) add('warning', `Model cevaplarının %95'i ${round(perf.llm.p95 / 1000, 1)} sn'den uzun`, `Ortalama ${round(perf.llm.avg / 1000, 1)} sn.`, 'Daha hızlı/küçük model seçin ya da istem boyutunu azaltın (Model istemleri sekmesi).');
      const waitShare = perf.models.reduce((t, m) => t + m.avgWaitMs * m.calls, 0) / Math.max(1, sum(perf.models, 'calls'));
      if (perf.llm.avg && waitShare / perf.llm.avg > 0.3) add('warning', 'Model süresinin büyük kısmı kota beklemekle geçiyor', `Ortalama bekleme ${round(waitShare / 1000, 1)} sn, toplam cevap süresinin %${round(waitShare / perf.llm.avg * 100)}'i.`, 'API anahtarları sekmesinden ek anahtar ekleyin; sağlayıcı kotası darboğaz.');
      const failing = perf.models.find(m => m.calls >= 5 && m.errorRate > 10);
      if (failing) add('warning', `${failing.model} modelinde hata oranı %${failing.errorRate}`, `${failing.errors}/${failing.calls} çağrı başarısız.`, 'Anahtarın geçerliliğini ve sağlayıcı kotasını kontrol edin; gerekirse başka modele geçin.');
      if (perf.fileQueue.avg > 10000) add('warning', `Dosyalar işlenmeden önce ortalama ${round(perf.fileQueue.avg / 1000, 1)} sn bekliyor`, 'Yükleme sırasında okuma kuyruğu doluyor.', 'WRITER_PROCESS_PARALLEL ve PYTHON_POOL değerlerini artırın (CPU boşsa).');
      if (perf.uploadSpeed.p50 && perf.uploadSpeed.p50 < 200) add('info', `Ortanca yükleme hızı ${perf.uploadSpeed.p50} KB/sn`, 'Ağ yavaş ya da dosyalar sunucuya ulaşmadan önce ters vekilde bekliyor olabilir.', 'Ters vekil/ağ ayarlarını ve istemci bağlantısını kontrol edin.');
      if (perf.verification.cachedShare != null && perf.verification.references > 50 && perf.verification.cachedShare < 10) add('info', `Doğrulamaların yalnız %${perf.verification.cachedShare}'i önbellekten geldi`, '', 'Kullanıcılar çoğunlukla farklı kaynaklar sorguluyor; önbellek süresi/boyutu değiştirmek çok fark yaratmaz.');
      if (cap.maxLagP99Ms > 200) add(cap.maxLagP99Ms > 1000 ? 'critical' : 'warning', `Olay döngüsü gecikmesi en çok ${cap.maxLagP99Ms} ms`, 'Sunucu süreci tek iş parçacığında geç kalıyor; tüm isteklerin yavaşlamasına yol açar.', 'Daha fazla CPU çekirdeği, kuyruk modunda ayrı doğrulama/LLM servisleri ya da ikinci bir web süreci düşünün.');
      if (cap.avgCpu > 70) add('warning', `Ortalama CPU %${cap.avgCpu}`, '', 'Sunucuyu büyütmeyi ya da işleri ayrı servislere taşımayı planlayın.');
      if (exp.users >= 3 && exp.poor / Math.max(1, exp.good + exp.fair + exp.poor) > 0.2) add('warning', `Kullanıcıların %${round(exp.poor / (exp.good + exp.fair + exp.poor) * 100)}'i kötü deneyim yaşıyor`, 'Deneyim skoru 70\'in altında.', 'Deneyim sekmesinde en düşük skorlu kullanıcılara bakın; ortak neden (hata, yavaş model, kuyruk) genellikle görünür.');
      else if (exp.satisfiedShare != null && exp.satisfiedShare >= 80) add('good', `Kullanıcıların %${exp.satisfiedShare}'i iyi deneyim yaşıyor`, `Ortalama skor ${exp.averageScore}.`, '');
      if (use.topDecileShare > 60 && use.activeUsers >= 10) add('info', `En çok kullanan %10'luk kesim token'ların %${use.topDecileShare}'ini harcıyor`, '', 'Paket limitlerini ağır kullanıcılara göre ayarlayın ya da ayrı bir üst paket tanımlayın.');
      if (!list.some(x => x.level === 'critical' || x.level === 'warning') && perf.api.n) add('good', 'Dikkat gerektiren bir sorun görünmüyor', '', '');
      if (!perf.api.n && !use.operations) add('info', 'Bu dönemde veri yok', 'Metrikler sunucu çalıştıkça birikir.', 'Daha geniş bir dönem seçin.');
      const order = { critical: 0, warning: 1, info: 2, good: 3 };
      return list.sort((a, b) => order[a.level] - order[b.level]);
    },
  };
  return reports;
}

module.exports = { createReports, wstats, apdexOf };
