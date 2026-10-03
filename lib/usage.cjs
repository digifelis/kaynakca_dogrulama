// The operation log: every action that costs something (a question, a source being embedded, a content check) is one
// operation with the tokens it used, broken down per model call. Quotas and the admin panel read from here.
// Only metadata is stored (kind, skill name, counts, timings, tokens, errors), never questions, answers or document text.
const crypto = require('node:crypto');
const Context = require('./usage-context.cjs');

const monthStart = (at = Date.now()) => { const d = new Date(at); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const dayStart = (at = Date.now()) => { const d = new Date(at); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
const json = (value, fallback = null) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };

const opRow = r => ({ id: r.id, userId: r.user_id, kind: r.kind, status: r.status, projectId: r.project_id, detail: json(r.detail, null), startedAt: r.started_at, endedAt: r.ended_at,
  durationMs: r.duration_ms, promptTokens: r.prompt_tokens, completionTokens: r.completion_tokens, totalTokens: r.total_tokens, estimated: !!r.estimated, error: r.error });
const placeholders = list => list.map(() => '?').join(',');

function createUsage(appDb, { now = Date.now } = {}) {
  const { q } = appDb;
  const usage = {
    // An operation handle: addCall() is what usage-context.record() reaches while the operation runs.
    begin({ userId = null, kind, projectId = null, detail = null }) {
      const id = crypto.randomUUID(), started = now();
      q('INSERT INTO operations (id, user_id, kind, status, project_id, detail, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, userId, kind, 'running', projectId, detail ? JSON.stringify(detail) : null, started);
      return {
        id, userId,
        addCall(call) {
          const prompt = Math.round(call.prompt || 0), completion = Math.round(call.completion || 0), total = Math.round(call.total || prompt + completion);
          q('INSERT INTO operation_calls (operation_id, kind, provider, model, prompt_tokens, completion_tokens, total_tokens, estimated, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(id, call.kind || 'chat', call.provider || null, call.model || null, prompt, completion, total, call.estimated ? 1 : 0, now());
          q('UPDATE operations SET prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ?, total_tokens = total_tokens + ?, estimated = estimated | ? WHERE id = ?')
            .run(prompt, completion, total, call.estimated ? 1 : 0, id);
        },
        end(status = 'ok', error = null) {
          const ended = now();
          q('UPDATE operations SET status = ?, ended_at = ?, duration_ms = ?, error = ? WHERE id = ?').run(status, ended, ended - started, error ? String(error).slice(0, 300) : null, id);
        },
      };
    },
    // Runs fn as an operation of `userId`. Without a user (anonymous use) fn just runs, nothing is recorded.
    async run(options, fn) {
      if (!options.userId) return fn();
      const op = usage.begin(options);
      try {
        const result = await Context.als.run(op, fn);
        op.end('ok'); return result;
      } catch (error) { op.end(error?.name === 'AbortError' ? 'cancelled' : 'error', error?.message); throw error; }
    },
    // A finished one-step operation (an upload) with no tokens.
    event(options) { if (!options.userId) return null; const op = usage.begin(options); op.end(options.status || 'ok', options.error); return op.id; },

    // ---- quotas
    monthTokens: (userId, at = now()) => q('SELECT COALESCE(SUM(total_tokens), 0) AS n FROM operations WHERE user_id = ? AND started_at >= ?').get(userId, monthStart(at)).n,
    // References sent to the index lookups this month: each verification run records how many it really had to query.
    monthReferences: (userId, at = now()) => q("SELECT COALESCE(SUM(COALESCE(json_extract(detail, '$.queried'), json_extract(detail, '$.references'), 0)), 0) AS n FROM operations WHERE user_id = ? AND kind = 'word-verify' AND started_at >= ?").get(userId, monthStart(at)).n,
    summary(userId) {
      const sum = since => q('SELECT COUNT(*) AS operations, COALESCE(SUM(prompt_tokens),0) AS prompt, COALESCE(SUM(completion_tokens),0) AS completion, COALESCE(SUM(total_tokens),0) AS total FROM operations WHERE user_id = ? AND started_at >= ?').get(userId, since);
      const pick = r => ({ operations: r.operations, promptTokens: r.prompt, completionTokens: r.completion, totalTokens: r.total });
      return { today: pick(sum(dayStart(now()))), month: pick(sum(monthStart(now()))), total: pick(sum(0)) };
    },

    // ---- admin queries
    list({ userId = '', kind = '', status = '', since = 0, until = 0, limit = 50, offset = 0 } = {}) {
      const where = [], values = [];
      for (const [column, value] of [['user_id', userId], ['kind', kind], ['status', status]]) if (value) { where.push(`${column} = ?`); values.push(value); }
      if (since) { where.push('started_at >= ?'); values.push(Number(since)); }
      if (until) { where.push('started_at <= ?'); values.push(Number(until)); }
      const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const total = q(`SELECT COUNT(*) AS n FROM operations ${clause}`).get(...values).n;
      const operations = q(`SELECT * FROM operations ${clause} ORDER BY started_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(...values, Math.min(200, Math.max(1, limit)), Math.max(0, offset)).map(opRow);
      return { total, operations };
    },
    detail(id) {
      const r = q('SELECT * FROM operations WHERE id = ?').get(String(id));
      if (!r) return null;
      const calls = q('SELECT * FROM operation_calls WHERE operation_id = ? ORDER BY id').all(r.id).map(c => ({ kind: c.kind, provider: c.provider, model: c.model,
        promptTokens: c.prompt_tokens, completionTokens: c.completion_tokens, totalTokens: c.total_tokens, estimated: !!c.estimated, at: c.at }));
      return { ...opRow(r), calls };
    },
    stats({ since = 0, until = 0 } = {}) {
      const range = [since || 0, until || now() + 1];
      const totals = q(`SELECT COUNT(*) AS operations, COALESCE(SUM(prompt_tokens),0) AS prompt, COALESCE(SUM(completion_tokens),0) AS completion, COALESCE(SUM(total_tokens),0) AS total,
        COALESCE(SUM(status = 'error'),0) AS errors, COUNT(DISTINCT user_id) AS users FROM operations WHERE started_at >= ? AND started_at <= ?`).get(...range);
      const byKind = q(`SELECT kind, COUNT(*) AS operations, COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(status = 'error'),0) AS errors FROM operations
        WHERE started_at >= ? AND started_at <= ? GROUP BY kind ORDER BY tokens DESC, operations DESC`).all(...range).map(r => ({ kind: r.kind, operations: r.operations, tokens: r.tokens, errors: r.errors }));
      const byModel = q(`SELECT c.provider, c.model, c.kind, COUNT(*) AS calls, COALESCE(SUM(c.prompt_tokens),0) AS prompt, COALESCE(SUM(c.completion_tokens),0) AS completion, COALESCE(SUM(c.total_tokens),0) AS tokens
        FROM operation_calls c WHERE c.at >= ? AND c.at <= ? GROUP BY c.provider, c.model, c.kind ORDER BY tokens DESC`).all(...range)
        .map(r => ({ provider: r.provider, model: r.model, kind: r.kind, calls: r.calls, promptTokens: r.prompt, completionTokens: r.completion, tokens: r.tokens }));
      const byDay = q(`SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch') AS day, COUNT(*) AS operations, COALESCE(SUM(total_tokens),0) AS tokens FROM operations
        WHERE started_at >= ? AND started_at <= ? GROUP BY day ORDER BY day`).all(...range).map(r => ({ day: r.day, operations: r.operations, tokens: r.tokens }));
      const topUsers = q(`SELECT user_id, COUNT(*) AS operations, COALESCE(SUM(total_tokens),0) AS tokens FROM operations WHERE user_id IS NOT NULL AND started_at >= ? AND started_at <= ?
        GROUP BY user_id ORDER BY tokens DESC LIMIT 10`).all(...range).map(r => ({ userId: r.user_id, operations: r.operations, tokens: r.tokens }));
      return { operations: totals.operations, promptTokens: totals.prompt, completionTokens: totals.completion, totalTokens: totals.total, errors: totals.errors, activeUsers: totals.users, byKind, byModel, byDay, topUsers };
    },
    // Tokens per user for the user list.
    monthTokensFor(userIds) {
      if (!userIds.length) return {};
      return Object.fromEntries(q(`SELECT user_id, COALESCE(SUM(total_tokens),0) AS n, COUNT(*) AS ops FROM operations WHERE started_at >= ? AND user_id IN (${placeholders(userIds)}) GROUP BY user_id`)
        .all(monthStart(now()), ...userIds).map(r => [r.user_id, { tokens: r.n, operations: r.ops }]));
    },
    totalTokensFor(userIds) {
      if (!userIds.length) return {};
      return Object.fromEntries(q(`SELECT user_id, COALESCE(SUM(total_tokens),0) AS n FROM operations WHERE user_id IN (${placeholders(userIds)}) GROUP BY user_id`).all(...userIds).map(r => [r.user_id, r.n]));
    },
    // Work that was running when the server stopped will never finish.
    recoverInterrupted: () => q("UPDATE operations SET status = 'interrupted', ended_at = ?, error = 'Sunucu yeniden başladı.' WHERE status = 'running'").run(now()).changes,
  };
  return usage;
}
const noop = { run: (options, fn) => fn(), event: () => null, monthTokens: () => 0, monthReferences: () => 0 };

module.exports = { createUsage, noop, monthStart, dayStart };
