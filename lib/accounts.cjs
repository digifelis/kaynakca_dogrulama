// Data access for accounts: users, sessions, one-time tokens, login attempts, plans, settings and the audit trail.
// Pure storage; the rules (passwords, lockout, who may do what) live in auth.cjs.
const crypto = require('node:crypto');
const Plans = require('./plans.cjs');
const { sha256 } = require('./app-db.cjs');

const json = (value, fallback = null) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
const newId = () => crypto.randomBytes(16).toString('hex');

const userRow = r => !r ? null : ({ id: r.id, username: r.username, displayName: r.display_name, email: r.email || null, emailVerified: !!r.email_verified,
  passwordHash: r.password_hash, source: r.source, ldapDn: r.ldap_dn || null, role: r.role, planId: r.plan_id, planExpiresAt: r.plan_expires_at || null,
  status: r.status, mustChangePassword: !!r.must_change_password, createdAt: r.created_at, lastLoginAt: r.last_login_at || null });
const planRow = r => ({ id: r.id, title: r.title, description: r.description, sortOrder: r.sort_order, projects: r.projects, documentsPerProject: r.documents_per_project,
  documentBytes: r.document_bytes, questionsPerDay: r.questions_per_day, monthlyTokens: r.monthly_tokens, active: !!r.active });

function createAccounts(appDb, { now = Date.now } = {}) {
  const { q, transaction } = appDb;
  const accounts = {
    appDb,

    // ---- plans (the provider behind lib/plans.cjs)
    plans: {
      list: () => q('SELECT * FROM plans ORDER BY sort_order, id').all().map(planRow),
      get: id => { const r = q('SELECT * FROM plans WHERE id = ?').get(String(id)); return r ? planRow(r) : null; },
      // Seeds the defaults only into an empty table: edits made in the admin panel are never overwritten.
      seedDefaults() {
        if (q('SELECT COUNT(*) AS n FROM plans').get().n) return;
        Plans.DEFAULTS.forEach((p, i) => accounts.plans.save({ ...p, sortOrder: i + 1, active: true }));
      },
      save(plan) {
        q(`INSERT INTO plans (id, title, description, sort_order, projects, documents_per_project, document_bytes, questions_per_day, monthly_tokens, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description, sort_order = excluded.sort_order, projects = excluded.projects,
             documents_per_project = excluded.documents_per_project, document_bytes = excluded.document_bytes, questions_per_day = excluded.questions_per_day,
             monthly_tokens = excluded.monthly_tokens, active = excluded.active`)
          .run(plan.id, plan.title, plan.description || '', plan.sortOrder, plan.projects, plan.documentsPerProject, plan.documentBytes, plan.questionsPerDay, plan.monthlyTokens || 0, plan.active === false ? 0 : 1);
        return accounts.plans.get(plan.id);
      },
      remove: id => q('DELETE FROM plans WHERE id = ?').run(String(id)).changes > 0,
      usersOn: id => q('SELECT COUNT(*) AS n FROM users WHERE plan_id = ?').get(String(id)).n,
      reassign: (from, to) => q('UPDATE users SET plan_id = ? WHERE plan_id = ?').run(to, from).changes,
    },

    // ---- users
    users: {
      create({ username, displayName = '', email = null, emailVerified = false, passwordHash = null, source = 'local', ldapDn = null, role = 'user', planId, planExpiresAt = null, mustChangePassword = false }) {
        const id = newId();
        q(`INSERT INTO users (id, username, display_name, email, email_verified, password_hash, source, ldap_dn, role, plan_id, plan_expires_at, must_change_password, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, username, displayName, email, emailVerified ? 1 : 0, passwordHash, source, ldapDn, role, planId || Plans.all()[0]?.id || 'basic', planExpiresAt, mustChangePassword ? 1 : 0, now());
        return accounts.users.byId(id);
      },
      byId: id => userRow(q('SELECT * FROM users WHERE id = ?').get(String(id))),
      byUsername: username => userRow(q('SELECT * FROM users WHERE username = ?').get(String(username))),
      byVerifiedEmail: email => userRow(q('SELECT * FROM users WHERE email = ? AND email_verified = 1').get(String(email))),
      summary() {
        const one = sql => q(sql).get().n;
        return { total: one('SELECT COUNT(*) AS n FROM users'), active: one("SELECT COUNT(*) AS n FROM users WHERE status = 'active'"), disabled: one("SELECT COUNT(*) AS n FROM users WHERE status = 'disabled'"),
          admins: one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"), unverifiedEmail: one('SELECT COUNT(*) AS n FROM users WHERE email IS NOT NULL AND email_verified = 0'),
          byPlan: q('SELECT plan_id AS id, COUNT(*) AS n FROM users GROUP BY plan_id').all().map(r => ({ planId: r.id, users: r.n })),
          bySource: q('SELECT source, COUNT(*) AS n FROM users GROUP BY source').all().map(r => ({ source: r.source, users: r.n })) };
      },
      countAdmins: () => q("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").get().n,
      count: () => q('SELECT COUNT(*) AS n FROM users').get().n,
      update(id, fields) {
        const columns = { displayName: 'display_name', email: 'email', emailVerified: 'email_verified', passwordHash: 'password_hash', ldapDn: 'ldap_dn', role: 'role',
          planId: 'plan_id', planExpiresAt: 'plan_expires_at', status: 'status', mustChangePassword: 'must_change_password', lastLoginAt: 'last_login_at', username: 'username' };
        const sets = [], values = [];
        for (const [key, column] of Object.entries(columns)) {
          if (fields[key] === undefined) continue;
          sets.push(`${column} = ?`);
          values.push(typeof fields[key] === 'boolean' ? (fields[key] ? 1 : 0) : fields[key]);
        }
        if (sets.length) q(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values, String(id));
        return accounts.users.byId(id);
      },
      delete: id => q('DELETE FROM users WHERE id = ?').run(String(id)).changes > 0,
      // Search and paging for the admin list.
      list({ search = '', role = '', status = '', planId = '', source = '', limit = 50, offset = 0, sort = 'created_at', direction = 'desc' } = {}) {
        const where = [], values = [];
        if (search) { where.push('(username LIKE ? ESCAPE \'\\\' OR display_name LIKE ? ESCAPE \'\\\' OR email LIKE ? ESCAPE \'\\\')'); const like = `%${String(search).replace(/[%_\\]/g, m => '\\' + m)}%`; values.push(like, like, like); }
        for (const [column, value] of [['role', role], ['status', status], ['plan_id', planId], ['source', source]]) if (value) { where.push(`${column} = ?`); values.push(value); }
        const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const order = ['created_at', 'last_login_at', 'username'].includes(sort) ? sort : 'created_at';
        const total = q(`SELECT COUNT(*) AS n FROM users ${clause}`).get(...values).n;
        const rows = q(`SELECT * FROM users ${clause} ORDER BY ${order} ${direction === 'asc' ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`).all(...values, Math.min(200, Math.max(1, limit)), Math.max(0, offset)).map(userRow);
        return { total, users: rows };
      },
    },

    // ---- sessions: only a hash of the cookie token is stored
    sessions: {
      create(userId, { ip = '', ua = '', ttlMs }) {
        const token = crypto.randomBytes(32).toString('base64url'), t = now();
        q('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?)').run(sha256(token), userId, t, t + ttlMs, t, ip.slice(0, 80), ua.slice(0, 200));
        return token;
      },
      find(token) {
        const r = q('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
        return r ? { hash: r.token_hash, userId: r.user_id, createdAt: r.created_at, expiresAt: r.expires_at, lastSeen: r.last_seen } : null;
      },
      extend: (token, expiresAt) => q('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?').run(now(), expiresAt, sha256(token)),
      revoke: token => q('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token)).changes,
      revokeUser: (userId, exceptToken = null) => q('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, exceptToken ? sha256(exceptToken) : '').changes,
      countForUser: userId => q('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?').get(userId, now()).n,
      purgeExpired: () => q('DELETE FROM sessions WHERE expires_at < ?').run(now()).changes,
    },

    // ---- one-time tokens (email verification, password reset): single use, hashed at rest
    tokens: {
      create(userId, kind, { email = null, ttlMs }) {
        const token = crypto.randomBytes(32).toString('base64url');
        q('DELETE FROM tokens WHERE user_id = ? AND kind = ?').run(userId, kind);
        q('INSERT INTO tokens (token_hash, user_id, kind, email, expires_at) VALUES (?, ?, ?, ?, ?)').run(sha256(token), userId, kind, email, now() + ttlMs);
        return token;
      },
      // Looks at a token without using it (so a rejected new password does not burn the reset link).
      peek(token, kind) {
        const r = q('SELECT * FROM tokens WHERE token_hash = ? AND kind = ?').get(sha256(token), kind);
        return !r || r.used_at || r.expires_at < now() ? null : { userId: r.user_id, email: r.email };
      },
      consume(token, kind) {
        const r = q('SELECT * FROM tokens WHERE token_hash = ? AND kind = ?').get(sha256(token), kind);
        if (!r || r.used_at || r.expires_at < now()) return null;
        q('UPDATE tokens SET used_at = ? WHERE token_hash = ?').run(now(), r.token_hash);
        return { userId: r.user_id, email: r.email };
      },
    },

    // ---- failed-login counters
    attempts: {
      get: key => q('SELECT fails, locked_until FROM login_attempts WHERE key = ?').get(key) || { fails: 0, locked_until: 0 },
      fail(key, { max, lockMs }) {
        const row = accounts.attempts.get(key), fails = (row.locked_until && row.locked_until < now() ? 0 : row.fails) + 1;
        const lockedUntil = fails >= max ? now() + lockMs * Math.min(6, 2 ** Math.floor((fails - max) / max)) : 0;
        q(`INSERT INTO login_attempts (key, fails, locked_until, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until, updated_at = excluded.updated_at`).run(key, fails, lockedUntil, now());
        return { fails, lockedUntil };
      },
      clear: key => q('DELETE FROM login_attempts WHERE key = ?').run(key),
    },

    // ---- settings (JSON values; secrets inside are sealed by the caller)
    settings: {
      get(key, fallback = null) { const r = q('SELECT value FROM settings WHERE key = ?').get(key); return r ? json(r.value, fallback) : fallback; },
      set(key, value) { q('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, JSON.stringify(value), now()); },
    },

    // ---- audit trail: who did what, never the content of user work
    audit: {
      log({ actorId = null, actorName = null, action, targetType = null, targetId = null, detail = null, ip = null }) {
        q('INSERT INTO audit_log (at, actor_id, actor_name, action, target_type, target_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(now(), actorId, actorName, action, targetType, targetId, detail ? JSON.stringify(detail) : null, ip ? String(ip).slice(0, 80) : null);
      },
      list({ action = '', actor = '', since = 0, until = 0, limit = 100, offset = 0 } = {}) {
        const where = [], values = [];
        if (action) { where.push('action LIKE ?'); values.push(action.replace(/[%_]/g, '') + '%'); }
        if (actor) { where.push('(actor_id = ? OR actor_name = ?)'); values.push(actor, actor); }
        if (since) { where.push('at >= ?'); values.push(Number(since)); }
        if (until) { where.push('at <= ?'); values.push(Number(until)); }
        const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const total = q(`SELECT COUNT(*) AS n FROM audit_log ${clause}`).get(...values).n;
        const entries = q(`SELECT * FROM audit_log ${clause} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`).all(...values, Math.min(500, Math.max(1, limit)), Math.max(0, offset))
          .map(r => ({ id: r.id, at: r.at, actorId: r.actor_id, actorName: r.actor_name, action: r.action, targetType: r.target_type, targetId: r.target_id, detail: json(r.detail, null), ip: r.ip }));
        return { total, entries };
      },
    },
    transaction,
  };
  return accounts;
}

module.exports = { createAccounts, newId };
