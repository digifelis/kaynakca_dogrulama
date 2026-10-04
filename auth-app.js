// Accounts in the browser: sign-in, registration, password reset, forced password change, profile with plan and token usage.
// Other scripts need nothing from this file except that every /api call that comes back 401/403 sends the person to the right screen.
(() => {
  const FORM_PAGES = { giris: 'login', kayit: 'register', 'sifremi-unuttum': 'forgot', 'sifre-sifirla': 'reset', 'parola-degistir': 'change' };
  const PROTECTED = new Set(['word', 'icerik', 'yazim', 'profil', 'admin']);
  // Which area of the plan each page needs (any one of the list opens it).
  const PAGE_FEATURES = { kaynakca: ['reference'], word: ['orphan', 'reference'], icerik: ['content'], yazim: ['writer'] };
  const state = { loaded: false, user: null, config: { registrationOpen: false, ldapEnabled: false, emailEnabled: false }, usage: null };
  const fmt = n => Number(n || 0).toLocaleString('tr-TR');
  const MB = 1024 * 1024;

  // ---- tiny DOM helper: h('div', { class: 'x', onclick }, 'text', child)
  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === false || value == null) continue;
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'class') node.className = value;
      else if (key === 'value') node.value = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child != null && child !== false) node.append(child.nodeType ? child : document.createTextNode(String(child)));
    return node;
  }
  const field = (label, input, hint) => h('label', { class: 'acct-field' }, h('span', {}, label), input, hint ? h('small', {}, hint) : null);
  const input = (name, type = 'text', extra = {}) => h('input', { name, type, autocomplete: type === 'password' ? 'current-password' : 'off', required: true, ...extra });

  // ---- API (same CSRF header as the other pages)
  async function api(method, url, body) {
    const response = await fetch(url, { method, headers: method === 'GET' ? {} : { 'x-word-request': '1', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(Error(data.error || 'İşlem tamamlanamadı.'), { status: response.status, code: data.code, data });
    return data;
  }
  async function refresh() {
    try {
      state.config = await api('GET', '/api/auth/config');
      const me = await api('GET', '/api/auth/me');
      state.user = me.user; state.usage = me.user ? me : null;
    } catch { state.user = null; }
    state.loaded = true;
    renderMenu(); applyFeatures();
    window.dispatchEvent(new CustomEvent('auth-change'));
  }

  // A 401/403 from any API call (the Word or writing pages) sends the person to sign in or to change the password.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await nativeFetch(input, init);
    const target = typeof input === 'string' ? input : input?.url || '';
    if (!response.ok && (response.status === 401 || response.status === 403) && /\/api\/(word|writer|content)/.test(target)) {
      response.clone().json().then(data => {
        if (data.code === 'auth_required' && state.user) { state.user = null; renderMenu(); location.hash = '#/giris?next=' + encodeURIComponent(AppPages.current()); window.dispatchEvent(new CustomEvent('auth-change')); }
        if (data.code === 'password_change_required') { if (state.user) state.user.mustChangePassword = true; location.hash = '#/parola-degistir'; }
      }).catch(() => {});
    }
    return response;
  };

  // ---- routing helpers used by pages.js
  const hashParams = () => new URLSearchParams((location.hash.split('?')[1] || ''));
  function gate(page) {
    if (!state.loaded) return PROTECTED.has(page) || page === 'giris' ? 'wait' : null;
    if (state.user?.mustChangePassword && !(location.hash.startsWith('#/parola-degistir'))) return '#/parola-degistir';
    if (PROTECTED.has(page) && !state.user) return '#/giris?next=' + page;
    if (page === 'admin' && state.user?.role !== 'admin') return '#/profil';
    if (page === 'giris' && state.user && !state.user.mustChangePassword && !location.hash.startsWith('#/parola-degistir')) return '#/profil';
    return null;
  }

  // ---- areas of the plan: a signed-in person lacking an area sees it locked; the public bibliography page needs no plan
  const hasFeature = feature => !state.user || (state.user.features || []).includes(feature);
  const labelOf = feature => state.usage?.plan?.featureCatalog?.find(item => item.id === feature)?.label || feature;
  function lock(page) {
    const needs = PAGE_FEATURES[page];
    if (!needs || !state.loaded || !state.user || needs.some(hasFeature)) return null;
    const upgrade = state.usage?.plan?.upgrades?.[needs[0]];
    return { title: labelOf(needs[0]) + ' paketinizde yok', text: `${labelOf(needs[0])}, ${state.usage?.plan?.title || state.user.plan} paketinde bulunmuyor.` + (upgrade ? ` ${upgrade} pakete geçerek kullanabilirsiniz.` : ' Yöneticinizle iletişime geçin.') };
  }
  function applyFeatures() {
    const missing = !state.user ? [] : Object.values(PAGE_FEATURES).flat().concat(['export', 'web', 'scholar', 'styles']).filter((id, i, all) => all.indexOf(id) === i && !hasFeature(id));
    document.documentElement.dataset.no = missing.join(' ');
    document.querySelectorAll('[data-page-link]').forEach(link => {
      const needs = PAGE_FEATURES[link.dataset.pageLink], locked = !!needs && !!state.user && !needs.some(hasFeature);
      link.classList.toggle('is-locked', locked);
      if (locked) link.title = labelOf(needs[0]) + ' paketinizde yok'; else link.removeAttribute('title');
    });
  }

  // ---- menu in the top bar
  function renderMenu() {
    const box = document.getElementById('account-menu');
    if (!box) return;
    box.replaceChildren();
    const admin = document.querySelector('[data-page-link="admin"]');
    if (admin) admin.hidden = state.user?.role !== 'admin';
    if (!state.loaded) return;
    if (!state.user) { box.append(h('a', { class: 'acct-link', href: '#/giris' }, 'Giriş yap')); return; }
    const used = state.usage?.monthTokens || 0, limit = state.usage?.plan?.limits?.monthlyTokens || 0;
    box.append(
      h('a', { class: 'acct-link', href: '#/profil', title: 'Profil ve kullanım' }, h('span', { class: 'acct-plan' }, state.usage?.plan?.title || state.user.plan), ' ', state.user.displayName || state.user.username),
      limit ? h('span', { class: 'acct-quota', title: `Bu ay ${fmt(used)} / ${fmt(limit)} token` }, '%' + Math.min(100, Math.round(used / limit * 100))) : null,
      h('button', { type: 'button', class: 'text-button', onclick: async () => { await api('POST', '/api/auth/logout', {}).catch(() => {}); state.user = null; state.usage = null; renderMenu(); location.hash = '#/giris'; window.dispatchEvent(new CustomEvent('auth-change')); } }, 'Çıkış'));
  }

  // ---- forms
  function formShell(title, lead, ...body) {
    return h('div', { class: 'acct-card' }, h('h2', {}, title), lead ? h('p', { class: 'acct-lead' }, lead) : null, ...body);
  }
  function form(fields, submitLabel, onSubmit) {
    const message = h('p', { class: 'acct-message', role: 'alert', 'aria-live': 'polite' });
    const button = h('button', { type: 'submit', class: 'copy-button' }, submitLabel);
    const node = h('form', { class: 'acct-form', novalidate: false, onsubmit: async event => {
      event.preventDefault(); message.textContent = ''; message.className = 'acct-message'; button.disabled = true;
      try { await onSubmit(Object.fromEntries(new FormData(node)), message); }
      catch (error) { message.textContent = error.message; message.classList.add('is-error'); if (error.data?.retryAt) message.textContent += ' (' + new Date(error.data.retryAt).toLocaleTimeString('tr-TR') + ' sonrasında tekrar deneyin)'; }
      finally { button.disabled = false; }
    } }, ...fields, message, button);
    return node;
  }
  const success = (message, text) => { message.textContent = text; message.className = 'acct-message is-ok'; };
  const goNext = () => { const next = hashParams().get('next'); location.hash = '#/' + (/^(word|icerik|yazim|profil|admin)$/.test(next || '') ? next : 'yazim'); };

  function loginView() {
    const { config } = state;
    return formShell('Giriş yap', config.ldapEnabled ? 'Kurum (LDAP) hesabınızla ya da Kaynakça Masası hesabınızla giriş yapabilirsiniz.' : 'Hesabınızla giriş yapın. Kaynakça doğrulama sayfası giriş gerektirmez.',
      form([field('Kullanıcı adı veya e-posta', input('username', 'text', { autocomplete: 'username', autofocus: true })), field('Parola', input('password', 'password'))], 'Giriş yap', async data => {
        const result = await api('POST', '/api/auth/login', data); state.user = result.user; await refresh();
        if (state.user?.mustChangePassword) location.hash = '#/parola-degistir'; else goNext();
      }),
      h('p', { class: 'acct-links' }, config.registrationOpen ? h('a', { href: '#/kayit' }, 'Hesap oluştur') : null, config.emailEnabled ? h('a', { href: '#/sifremi-unuttum' }, 'Parolamı unuttum') : null));
  }
  function registerView() {
    if (!state.config.registrationOpen) return formShell('Kayıt kapalı', 'Yeni kayıtlar şu anda kabul edilmiyor. Yöneticinizden hesap isteyebilirsiniz.', h('p', { class: 'acct-links' }, h('a', { href: '#/giris' }, 'Girişe dön')));
    return formShell('Hesap oluştur', 'Kullanıcı adı ve parolanız yeterlidir; e-posta adresini sonra profil sayfasından ekleyebilirsiniz.',
      form([field('Kullanıcı adı', input('username', 'text', { autocomplete: 'username', minlength: 3, maxlength: 64 }), '3–64 karakter: harf, rakam ve . _ @ + -'),
        field('Görünen ad', input('displayName', 'text', { required: false, maxlength: 80 })),
        field('Parola', input('password', 'password', { autocomplete: 'new-password', minlength: 10 }), 'En az 10 karakter; kolay tahmin edilen parolalar kabul edilmez.'),
        field('Parola (tekrar)', input('again', 'password', { autocomplete: 'new-password' }))], 'Hesap oluştur', async data => {
        if (data.password !== data.again) throw Error('Parolalar aynı değil.');
        await api('POST', '/api/auth/register', { username: data.username, displayName: data.displayName, password: data.password }); await refresh(); goNext();
      }), h('p', { class: 'acct-links' }, h('a', { href: '#/giris' }, 'Zaten hesabım var')));
  }
  function forgotView() {
    return formShell('Parolamı unuttum', 'Hesabınıza doğrulanmış bir e-posta adresi eklediyseniz sıfırlama bağlantısı gönderilir.',
      form([field('Kullanıcı adı veya e-posta', input('identifier', 'text', { autocomplete: 'username' }))], 'Bağlantı gönder', async (data, message) => {
        const result = await api('POST', '/api/auth/forgot', data); success(message, result.message);
      }), h('p', { class: 'acct-links' }, h('a', { href: '#/giris' }, 'Girişe dön')));
  }
  function resetView() {
    const token = hashParams().get('token') || '';
    return formShell('Yeni parola belirle', token ? null : 'Bağlantı eksik görünüyor; e-postadaki bağlantıyı yeniden açın.',
      form([field('Yeni parola', input('password', 'password', { autocomplete: 'new-password', minlength: 10 }), 'En az 10 karakter.'), field('Yeni parola (tekrar)', input('again', 'password', { autocomplete: 'new-password' }))], 'Parolayı kaydet', async (data, message) => {
        if (data.password !== data.again) throw Error('Parolalar aynı değil.');
        await api('POST', '/api/auth/reset', { token, password: data.password }); success(message, 'Parolanız değiştirildi. Şimdi giriş yapabilirsiniz.'); setTimeout(() => { location.hash = '#/giris'; }, 1500);
      }));
  }
  function changeView() {
    const forced = !!state.user?.mustChangePassword;
    return formShell('Parolanızı değiştirin', forced ? 'Devam etmeden önce başlangıç parolanızı değiştirmeniz gerekiyor.' : null,
      form([field('Mevcut parola', input('current', 'password')), field('Yeni parola', input('next', 'password', { autocomplete: 'new-password', minlength: 10 }), 'En az 10 karakter.'), field('Yeni parola (tekrar)', input('again', 'password', { autocomplete: 'new-password' }))], 'Parolayı değiştir', async data => {
        if (data.next !== data.again) throw Error('Parolalar aynı değil.');
        await api('POST', '/api/auth/change-password', { current: data.current, next: data.next }); await refresh(); goNext();
      }));
  }
  function mountForm(mode) {
    const box = document.getElementById('page-giris');
    if (!box) return;
    const view = { login: loginView, register: registerView, forgot: forgotView, reset: resetView, change: changeView }[mode] || loginView;
    if (mode === 'change' && !state.user) { location.hash = '#/giris'; return; }
    box.replaceChildren(h('div', { class: 'acct-wrap' }, view()));
    box.querySelector('input')?.focus();
  }

  // ---- profile
  function bar(used, limit) {
    if (!limit) return h('p', { class: 'acct-muted' }, 'Aylık token kotanız sınırsızdır.');
    const share = Math.min(100, used / limit * 100);
    return h('div', {}, h('div', { class: 'acct-meter', role: 'img', 'aria-label': `Aylık kotanın %${Math.round(share)} kadarı kullanıldı` }, h('span', { style: `width:${share}%`, class: share >= 90 ? 'is-hot' : '' })),
      h('p', { class: 'acct-muted' }, `${fmt(used)} / ${fmt(limit)} token (ayın başında sıfırlanır)`));
  }
  async function mountProfile() {
    const box = document.getElementById('page-profil');
    if (!box || !state.user) return;
    let data;
    try { data = await api('GET', '/api/auth/me'); } catch { return; }
    state.user = data.user; state.usage = data; renderMenu(); applyFeatures();
    const { user, plan, usage, monthTokens } = data, limits = plan.limits, emailNote = hashParams().get('email');
    const row = (label, value) => h('tr', {}, h('th', {}, label), h('td', {}, value));
    const profileForm = form([field('Görünen ad', input('displayName', 'text', { value: user.displayName || '', required: false, maxlength: 80 })),
      user.canChangePassword ? field('E-posta (isteğe bağlı)', input('email', 'email', { value: user.email || '', required: false, autocomplete: 'email' }), user.email ? (user.emailVerified ? 'Doğrulandı. Parola sıfırlama bu adrese gönderilir.' : 'Henüz doğrulanmadı.') : 'Parolanızı unutursanız sıfırlama bağlantısı için gerekir.') : h('p', { class: 'acct-muted' }, `Bu hesap dizin (LDAP) tarafından yönetilir${user.email ? ': ' + user.email : ''}.`)],
      'Kaydet', async (values, message) => {
        const result = await api('PATCH', '/api/auth/profile', values); state.user = result.user; renderMenu();
        success(message, result.verificationSent ? 'Kaydedildi. Doğrulama bağlantısı e-posta adresinize gönderildi.' : 'Kaydedildi.');
      });
    box.replaceChildren(h('div', { class: 'acct-wrap acct-wide' },
      h('div', { class: 'acct-card' }, h('h2', {}, 'Profil'),
        emailNote === 'dogrulandi' ? h('p', { class: 'acct-message is-ok' }, 'E-posta adresiniz doğrulandı.') : null, emailNote === 'hata' ? h('p', { class: 'acct-message is-error' }, 'Doğrulama bağlantısı geçersiz veya süresi dolmuş.') : null,
        h('table', { class: 'acct-table' }, row('Kullanıcı adı', user.username), row('Hesap türü', user.source === 'ldap' ? 'Kurum (LDAP)' : 'Yerel'), row('Rol', user.role === 'admin' ? 'Yönetici' : 'Kullanıcı')), profileForm,
        user.email && !user.emailVerified && state.config.emailEnabled ? h('button', { type: 'button', class: 'copy-button btn-secondary', onclick: async event => { event.target.disabled = true; try { await api('POST', '/api/auth/resend-verification', {}); event.target.textContent = 'Gönderildi'; } catch (error) { event.target.textContent = error.message; } } }, 'Doğrulama bağlantısını yeniden gönder') : null,
        user.canChangePassword ? h('p', { class: 'acct-links' }, h('a', { href: '#/parola-degistir' }, 'Parolayı değiştir')) : null),
      h('div', { class: 'acct-card' }, h('h2', {}, 'Paket ve kullanım'),
        h('p', { class: 'acct-plan-line' }, h('strong', {}, plan.title), plan.description ? ' — ' + plan.description : '', user.planExpiresAt ? ` (${new Date(user.planExpiresAt).toLocaleDateString('tr-TR')} tarihine kadar)` : ''),
        bar(monthTokens, limits.monthlyTokens),
        h('table', { class: 'acct-table' },
          row('Bugün', `${fmt(usage?.today.operations)} işlem · ${fmt(usage?.today.totalTokens)} token`), row('Bu ay', `${fmt(usage?.month.operations)} işlem · ${fmt(usage?.month.totalTokens)} token`),
          row('Toplam', `${fmt(usage?.total.operations)} işlem · ${fmt(usage?.total.totalTokens)} token`)),
        h('h3', {}, 'Paket sınırlarınız'),
        h('table', { class: 'acct-table' }, row('Proje', fmt(limits.projects)), row('Projedeki kaynak', fmt(limits.documentsPerProject)), row('Dosya boyutu', Math.round(limits.documentBytes / MB) + ' MB'),
          row('Günlük soru', fmt(limits.questionsPerDay)), row('Aylık token', limits.monthlyTokens ? fmt(limits.monthlyTokens) : 'Sınırsız'),
          row('Belge başına sorgulanacak kaynak', limits.referencesPerDocument ? fmt(limits.referencesPerDocument) : 'Sınırsız'),
          row('Bu ay sorgulanan kaynak', limits.monthlyReferences ? `${fmt(data.monthReferences)} / ${fmt(limits.monthlyReferences)}` : `${fmt(data.monthReferences)} (sınırsız)`),
          row('Kayıtlı Word/PDF belge', limits.wordDocuments ? fmt(limits.wordDocuments) : 'Sınırsız'),
          row('Erişilebilen alanlar', (plan.featureCatalog || []).filter(item => (plan.features || []).includes(item.id)).map(item => item.label).join(', ') || '—')),
        plan.nextPlan ? h('p', { class: 'acct-upgrade' }, `${plan.nextPlan.title} paketinde: ${fmt(plan.nextPlan.limits.projects)} proje, ${plan.nextPlan.limits.monthlyTokens ? fmt(plan.nextPlan.limits.monthlyTokens) + ' token' : 'sınırsız token'}. Paket değişikliği için yöneticinize başvurun.`) : null)));
  }

  window.Auth = { state, gate, lock, hasFeature, api, h, fmt, refresh, mount(page) { if (FORM_PAGES[page]) mountForm(FORM_PAGES[page]); },
    get user() { return state.user; }, get loaded() { return state.loaded; }, FORM_PAGES, hashParams };
  window.addEventListener('app-page-change', event => {
    if (event.detail.page === 'giris') mountForm(FORM_PAGES[location.hash.match(/^#\/([a-z-]+)/)?.[1]] || 'login');
    if (event.detail.page === 'profil') mountProfile();
  });
  // Token usage follows the server without a page reload: the menu badge (and an open profile page) is refreshed every
  // five minutes while the tab is visible, and as soon as a tab that was hidden longer than that comes back.
  const USAGE_REFRESH_MS = 5 * 60 * 1000;
  let lastUsageAt = Date.now(), usageTimer = null;
  async function refreshUsage() {
    if (!state.user || document.hidden) return;
    try {
      const data = await api('GET', '/api/auth/me');
      if (!data.user) return;
      lastUsageAt = Date.now();
      state.user = data.user; state.usage = data; renderMenu();
      // The profile page is rebuilt only when nothing is being typed into it.
      const profile = document.getElementById('page-profil');
      if (profile && !profile.hidden && !profile.contains(document.activeElement)) mountProfile();
    } catch { /* a failed check is simply tried again at the next interval */ }
  }
  function scheduleUsage() { clearInterval(usageTimer); usageTimer = setInterval(refreshUsage, USAGE_REFRESH_MS); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastUsageAt >= USAGE_REFRESH_MS) { refreshUsage(); scheduleUsage(); } });
  scheduleUsage();
  window.Auth.refreshUsage = refreshUsage;
  refresh();
})();
