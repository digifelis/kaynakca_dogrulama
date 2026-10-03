// Performance and user-experience metrics. Written next to the data (metrics.db), batched so a request never waits for it,
// and never able to break a request: every write is best-effort. The admin panel's "Raporlar" tab reads from here
// (lib/reports.cjs) and from the operation log in app.db.
//
//   http_requests  every API request: route, status, duration, user      llm_calls    every model call: duration, quota wait, tokens
//   file_events    uploads / imports: size, receive time, queue wait,     verify_runs  reference verification runs: queried / cached
//                  extraction, embedding, total                           samples      process health every 30 s (memory, CPU, event-loop lag)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DAY = 86400000;
const DEFAULT_DIR = () => process.env.METRICS_DIR || process.env.WRITER_DATA_DIR
  || (process.env.NODE_TEST_CONTEXT ? path.join(os.tmpdir(), 'kaynakca-test-metrics-' + process.pid) : path.join(__dirname, '..', 'data', 'writer'));
const enabled = () => !/^(?:false|0|no|off)$/i.test(String(process.env.METRICS_ENABLED ?? 'true').trim());
const retentionDays = () => Math.min(730, Math.max(7, Number(process.env.METRICS_RETENTION_DAYS) || 90));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS http_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, method TEXT NOT NULL, route TEXT NOT NULL, class TEXT NOT NULL, status INTEGER NOT NULL,
  duration_ms REAL NOT NULL, user_id TEXT, code TEXT, error TEXT, w INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS http_at ON http_requests(at);
CREATE INDEX IF NOT EXISTS http_status ON http_requests(status, at);
CREATE INDEX IF NOT EXISTS http_user ON http_requests(user_id, at);
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, operation_id TEXT, user_id TEXT, name TEXT, provider TEXT, model TEXT, status TEXT NOT NULL,
  duration_ms REAL NOT NULL, wait_ms REAL NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE INDEX IF NOT EXISTS llm_at ON llm_calls(at);
CREATE TABLE IF NOT EXISTS file_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, user_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
  receive_ms REAL, speed_kbps REAL, queue_ms REAL, extract_ms REAL, embed_ms REAL, total_ms REAL, error TEXT);
CREATE INDEX IF NOT EXISTS file_at ON file_events(at);
CREATE TABLE IF NOT EXISTS verify_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, user_id TEXT, refs INTEGER NOT NULL, queried INTEGER NOT NULL, cached INTEGER NOT NULL DEFAULT 0,
  duration_ms REAL NOT NULL, status TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS verify_at ON verify_runs(at);
CREATE TABLE IF NOT EXISTS samples (
  at INTEGER PRIMARY KEY, rss INTEGER, heap INTEGER, lag_p50 REAL, lag_p99 REAL, cpu REAL, load1 REAL, inflight INTEGER, requests INTEGER);
`;

// Ids inside a path are replaced so that routes group: /api/word/<uuid>/state -> /api/word/:id/state.
function routeOf(pathname) {
  return String(pathname || '/').replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, '/:id').replace(/\/[0-9a-f]{32,}(?=\/|$)/gi, '/:id').replace(/\/\d+(?=\/|$)/g, '/:n').slice(0, 120);
}
const classOf = pathname => pathname.startsWith('/api/') ? 'api' : 'static';

function createMetrics(dir = DEFAULT_DIR(), now = Date.now) {
  const file = path.join(dir, 'metrics.db');
  let db = null, timer = null, lastPrune = 0;
  const buffer = { http: [], llm: [], file: [], verify: [], samples: [] };
  const open = create => {
    if (db) return db;
    if (!create && !fs.existsSync(file)) return null;
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    db.exec(SCHEMA);
    return db;
  };
  const schedule = () => { if (!timer) { timer = setTimeout(() => { timer = null; metrics.flush(); }, 1000); timer.unref?.(); } };
  const push = (kind, row) => { if (!enabled()) return; buffer[kind].push(row); if (buffer[kind].length >= 500) metrics.flush(); else schedule(); };
  const num = v => Number.isFinite(Number(v)) ? Number(v) : null;
  const text = (v, n) => v == null ? null : String(v).slice(0, n);

  const metrics = {
    dir, enabled,
    // ---- recording (all best-effort)
    // Fast successful API calls (mostly polling) are sampled at 1 in METRICS_SAMPLE with that weight, so counts stay unbiased
    // and the table stays small; errors, slow calls and everything else are always kept. Static files are recorded only when they fail.
    http({ method, pathname, status, durationMs, userId = null, code = null, error = null, at = now() }) {
      const cls = classOf(pathname), fast = status < 400 && durationMs < 300;
      if (cls === 'static' && status < 400) return;
      const rate = Math.max(1, Math.floor(Number(process.env.METRICS_SAMPLE ?? 10)) || 1);
      if (fast && cls === 'api' && rate > 1 && Math.random() * rate >= 1) return;
      push('http', [at, method, routeOf(pathname), cls, status, durationMs, userId, text(code, 40), text(error, 200), fast && cls === 'api' ? rate : 1]);
    },
    llm({ operationId = null, userId = null, name = '', provider = '', model = '', status = 'ok', durationMs, waitMs = 0, promptTokens = 0, completionTokens = 0, error = null, at = now() }) {
      push('llm', [at, operationId, userId, text(name, 40), text(provider, 40), text(model, 80), status, durationMs, waitMs, Math.round(promptTokens) || 0, Math.round(completionTokens) || 0, text(error, 200)]);
    },
    file({ userId = null, kind, status = 'ok', bytes = 0, receiveMs = null, queueMs = null, extractMs = null, embedMs = null, totalMs = null, error = null, at = now() }) {
      const speed = receiveMs > 0 && bytes > 0 ? bytes / 1024 / (receiveMs / 1000) : null;
      push('file', [at, userId, kind, status, bytes, num(receiveMs), speed, num(queueMs), num(extractMs), num(embedMs), num(totalMs), text(error, 200)]);
    },
    verify({ userId = null, refs = 0, queried = 0, cached = 0, durationMs, status = 'ok', at = now() }) { push('verify', [at, userId, refs, queried, cached, durationMs, status]); },
    sample(row) { push('samples', [row.at || now(), row.rss, row.heap, row.lagP50, row.lagP99, row.cpu, row.load1, row.inflight, row.requests]); },

    flush() {
      if (!Object.values(buffer).some(list => list.length)) return;
      try {
        const d = open(true);
        d.exec('BEGIN');
        try {
          const run = (sql, rows) => { if (!rows.length) return; const st = d.prepare(sql); for (const row of rows) st.run(...row); };
          run('INSERT INTO http_requests (at, method, route, class, status, duration_ms, user_id, code, error, w) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', buffer.http.splice(0));
          run('INSERT INTO llm_calls (at, operation_id, user_id, name, provider, model, status, duration_ms, wait_ms, prompt_tokens, completion_tokens, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', buffer.llm.splice(0));
          run('INSERT INTO file_events (at, user_id, kind, status, bytes, receive_ms, speed_kbps, queue_ms, extract_ms, embed_ms, total_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', buffer.file.splice(0));
          run('INSERT INTO verify_runs (at, user_id, refs, queried, cached, duration_ms, status) VALUES (?, ?, ?, ?, ?, ?, ?)', buffer.verify.splice(0));
          run('INSERT OR REPLACE INTO samples (at, rss, heap, lag_p50, lag_p99, cpu, load1, inflight, requests) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', buffer.samples.splice(0));
          d.exec('COMMIT');
        } catch (error) { d.exec('ROLLBACK'); throw error; }
        if (now() - lastPrune > 6 * 3600000) metrics.prune();
      } catch { for (const key of Object.keys(buffer)) buffer[key].length = 0; }
    },
    prune() {
      lastPrune = now();
      const d = open(false); if (!d) return;
      const cut = now() - retentionDays() * DAY, shortCut = now() - Math.min(30, retentionDays()) * DAY;
      for (const table of ['http_requests', 'llm_calls', 'file_events', 'verify_runs']) d.prepare(`DELETE FROM ${table} WHERE at < ?`).run(cut);
      d.prepare('DELETE FROM samples WHERE at < ?').run(shortCut);
    },
    // Read access for the reports; flushes first so a report always sees the latest data.
    reader() { metrics.flush(); return open(false); },
    clear() { metrics.flush(); const d = open(false); if (!d) return 0; let n = 0; for (const t of ['http_requests', 'llm_calls', 'file_events', 'verify_runs', 'samples']) n += Number(d.prepare(`DELETE FROM ${t}`).run().changes); return n; },
    stop() { clearTimeout(timer); timer = null; metrics.flush(); db?.close(); db = null; },
  };
  return metrics;
}

// ---- process sampler: memory, CPU, event-loop delay and requests in flight, every 30 s
const inflight = { now: 0, requests: 0 };
let samplerTimer = null;
function startSampler(metrics, { intervalMs = 30000 } = {}) {
  if (samplerTimer || !enabled()) return;
  const { monitorEventLoopDelay } = require('node:perf_hooks');
  const histogram = monitorEventLoopDelay({ resolution: 20 }); histogram.enable();
  let lastCpu = process.cpuUsage(), lastAt = Date.now();
  samplerTimer = setInterval(() => {
    const at = Date.now(), cpu = process.cpuUsage(lastCpu), elapsed = Math.max(1, at - lastAt);
    metrics.sample({ at, rss: process.memoryUsage().rss, heap: process.memoryUsage().heapUsed, lagP50: histogram.percentile(50) / 1e6, lagP99: histogram.percentile(99) / 1e6,
      cpu: Math.min(100, (cpu.user + cpu.system) / 1000 / elapsed * 100), load1: os.loadavg()[0], inflight: inflight.now, requests: inflight.requests });
    histogram.reset(); inflight.requests = 0; lastCpu = process.cpuUsage(); lastAt = at;
  }, intervalMs);
  samplerTimer.unref?.();
}
function stopSampler() { clearInterval(samplerTimer); samplerTimer = null; }

let shared = null, sharedDir = null, exitHooked = false;
function defaultMetrics() {
  const dir = DEFAULT_DIR();
  if (!shared || sharedDir !== dir) { shared?.stop(); shared = createMetrics(dir); sharedDir = dir; if (!exitHooked) { exitHooked = true; process.on('exit', () => { try { shared?.flush(); } catch { /* best effort */ } }); } }
  return shared;
}

module.exports = { createMetrics, defaultMetrics, startSampler, stopSampler, inflight, routeOf, classOf, enabled, DAY };
