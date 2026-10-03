// /api/auth/*: sign-in, registration, profile, e-mail verification and password reset.
// Mutating calls need the app header (same CSRF rule as the other APIs) and the session cookie is SameSite=Strict.
const Plans = require('./lib/plans.cjs');

const httpError = (status, message, code) => Object.assign(Error(message), { status, code });

function createAuthService({ auth, usage = null, trustProxy = process.env.TRUST_PROXY === '1' } = {}) {
  const ip = req => (trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || '';
  const context = req => ({ ip: ip(req), ua: String(req.headers['user-agent'] || '') });
  async function readBody(req, limit = 64 * 1024) {
    let size = 0; const parts = [];
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw httpError(413, 'İstek çok büyük.'); parts.push(chunk); }
    try { const body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); return body && typeof body === 'object' ? body : {}; } catch { throw httpError(400, 'Geçersiz JSON.'); }
  }
  // The signed-in user's plan with its limits and what they have used: shown on the profile page.
  function usageView(user) {
    const plan = Plans.get(user.plan), next = Plans.nextPlan(user.plan);
    const summary = usage?.summary?.(user.id) || null;
    return { plan: { id: plan.id, title: plan.title, description: plan.description, limits: Plans.limitsFor(plan.id), nextPlan: next ? { id: next, title: Plans.get(next).title, limits: Plans.limitsFor(next) } : null },
      planExpiresAt: user.planExpiresAt, usage: summary, monthTokens: summary?.month.totalTokens ?? 0, monthReferences: usage?.monthReferences?.(user.id) ?? 0 };
  }

  async function handle(req, res, url, json) {
    if (!url.pathname.startsWith('/api/auth')) return false;
    try {
      const route = url.pathname.slice('/api/auth'.length).replace(/\/$/, '');
      const ctx = context(req);
      if (req.method !== 'GET' && req.headers['x-word-request'] !== '1') return json(res, 403, { error: 'Yerel uygulama isteği gerekli.' }), true;
      const found = auth.userFromRequest(req), session = found && auth.publicUser(found.user);

      if (route === '/config' && req.method === 'GET') return json(res, 200, { ...auth.config(), loggedIn: !!session }), true;
      if (route === '/me' && req.method === 'GET') return json(res, 200, { user: session, ...(session ? usageView(session) : {}) }), true;
      if (route === '/usage' && req.method === 'GET') { if (!session) throw httpError(401, 'Giriş gerekli.', 'auth_required'); return json(res, 200, usageView(session)), true; }

      if (route === '/login' && req.method === 'POST') {
        const result = await auth.login(await readBody(req), ctx);
        return json(res, 200, { user: result.user }, { 'Set-Cookie': auth.sessionCookie(result.token, req) }), true;
      }
      if (route === '/register' && req.method === 'POST') {
        const result = await auth.register(await readBody(req), ctx);
        return json(res, 201, { user: result.user }, { 'Set-Cookie': auth.sessionCookie(result.token, req) }), true;
      }
      if (route === '/logout' && req.method === 'POST') {
        await auth.logout(found?.token, { ...ctx, actor: found?.user });
        return json(res, 200, { loggedOut: true }, { 'Set-Cookie': auth.sessionCookie('', req, { clear: true }) }), true;
      }
      if (route === '/verify-email' && req.method === 'GET') {
        let target = '/#/profil?email=dogrulandi';
        try { auth.verifyEmail(url.searchParams.get('token'), ctx); } catch { target = '/#/profil?email=hata'; }
        res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' }); res.end(); return true;
      }
      if (route === '/forgot' && req.method === 'POST') {
        const body = await readBody(req);
        await auth.forgotPassword(body.identifier, ctx, req);
        return json(res, 200, { ok: true, message: 'Bu bilgilerle doğrulanmış bir e-posta adresi kayıtlıysa sıfırlama bağlantısı gönderildi.' }), true;
      }
      if (route === '/reset' && req.method === 'POST') { await auth.resetPassword(await readBody(req), ctx); return json(res, 200, { ok: true }), true; }

      // everything below needs a session
      if (!found) throw httpError(401, 'Bu işlem için giriş yapmalısınız.', 'auth_required');
      if (route === '/change-password' && req.method === 'POST') {
        const user = await auth.changePassword(found.user, await readBody(req), { ...ctx, actor: found.user }, found.token);
        return json(res, 200, { user }), true;
      }
      if (found.user.mustChangePassword) throw httpError(403, 'Devam etmeden önce parolanızı değiştirmelisiniz.', 'password_change_required');
      if (route === '/profile' && req.method === 'PATCH') return json(res, 200, await auth.updateProfile(found.user, await readBody(req), { ...ctx, actor: found.user }, req)), true;
      if (route === '/resend-verification' && req.method === 'POST') { await auth.sendVerification(found.user, { ...ctx, actor: found.user }, req); return json(res, 200, { ok: true }), true; }
      return json(res, 404, { error: 'İşlem bulunamadı.' }), true;
    } catch (error) {
      json(res, error.status || 400, { error: error.message || 'İşlem tamamlanamadı.', ...(error.code ? { code: error.code } : {}), ...(error.retryAt ? { retryAt: error.retryAt } : {}) });
      return true;
    }
  }
  return { handle, usageView };
}

module.exports = { createAuthService };
