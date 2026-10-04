// Admin panel (#/admin): overview, users, plans, operations with token costs, audit trail and settings (registration, LDAP, SMTP).
// The server only ever sends metadata here: counts, kinds, timings, tokens and audit entries, never a user's documents or answers.
(() => {
  const { h, fmt, api } = window.Auth;
  const TABS = [['overview', 'Genel bakış'], ['users', 'Kullanıcılar'], ['plans', 'Paketler'], ['operations', 'İşlemler'], ['reports', 'Raporlar'], ['llm-keys', 'API anahtarları'], ['prompts', 'Model istemleri'], ['skills', "Yazım skill'leri"], ['audit', 'Denetim kaydı'], ['settings', 'Ayarlar']];
  const KINDS = { ask: 'Soru-cevap', 'source-process': 'Kaynak işleme', 'source-embed': 'Kaynak vektörleme', 'content-check': 'İçerik kontrolü', 'word-verify': 'Kaynakça doğrulama', 'word-upload': 'Word yükleme', 'scholar-import': 'Makale içe aktarma' };
  const STATUS = { ok: 'Tamam', error: 'Hata', running: 'Sürüyor', interrupted: 'Yarım kaldı' };
  const kind = value => KINDS[value] || value;
  const when = ms => ms ? new Date(ms).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
  const dur = ms => ms == null ? '—' : ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' sn';
  const MB = 1024 * 1024;
  let scholarNote = null;   // result of the last Semantic Scholar save/test, shown beside its buttons (survives the re-render)
  let tab = 'overview', box = null, filters = { users: { search: '', plan: '', status: '', source: '' }, operations: { user: '', kind: '', status: '' }, audit: { action: '' } };

  const table = (head, rows, empty = 'Kayıt yok.') => rows.length
    ? h('div', { class: 'adm-scroll' }, h('table', { class: 'acct-table adm-table' }, h('thead', {}, h('tr', {}, head.map(c => h('th', {}, c)))), h('tbody', {}, rows)))
    : h('p', { class: 'acct-muted' }, empty);
  const cards = items => h('div', { class: 'adm-cards' }, items.map(([label, value, note]) => h('div', { class: 'adm-card' }, h('span', {}, label), h('strong', {}, value), note ? h('small', {}, note) : null)));
  const bars = (rows, label) => rows.length ? h('div', { class: 'adm-bars', role: 'img', 'aria-label': label }, rows.map(row => {
    const max = Math.max(1, ...rows.map(r => r.value));
    return h('div', { class: 'adm-bar', title: `${row.label}: ${fmt(row.value)}` }, h('span', { style: `height:${Math.max(2, row.value / max * 100)}%` }), h('small', {}, row.label.slice(5)));
  })) : h('p', { class: 'acct-muted' }, 'Henüz veri yok.');
  const select = (name, options, value, onchange) => h('select', { name, onchange: event => onchange(event.target.value) }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  const notice = (parent, text, bad = false) => { const n = h('p', { class: 'acct-message ' + (bad ? 'is-error' : 'is-ok'), role: 'status' }, text); parent.prepend(n); setTimeout(() => n.remove(), 6000); };
  const guard = (parent, fn) => async (...args) => { try { await fn(...args); } catch (error) { notice(parent, error.message, true); } };
  const pageSize = 25;
  const pager = (total, offset, go) => total > pageSize ? h('p', { class: 'adm-pager' }, h('button', { type: 'button', class: 'text-button', disabled: offset === 0, onclick: () => go(Math.max(0, offset - pageSize)) }, '← Önceki'), ` ${offset + 1}–${Math.min(total, offset + pageSize)} / ${fmt(total)} `, h('button', { type: 'button', class: 'text-button', disabled: offset + pageSize >= total, onclick: () => go(offset + pageSize) }, 'Sonraki →')) : null;
  const dialog = (title, ...body) => {
    const node = h('dialog', { class: 'adm-dialog' }, h('header', {}, h('h3', {}, title), h('button', { type: 'button', class: 'copy-button btn-secondary', onclick: () => node.close() }, 'Kapat')), ...body);
    node.addEventListener('close', () => node.remove()); document.body.append(node); node.showModal(); return node;
  };

  // ---- overview
  async function overview(panel) {
    const data = await api('GET', '/api/admin/overview?days=30');
    panel.append(
      cards([['Kullanıcı', fmt(data.users.total), `${fmt(data.users.active)} etkin · ${fmt(data.users.disabled)} devre dışı · ${fmt(data.users.admins)} yönetici`],
        ['Bugünkü token', fmt(data.tokens.today), `${fmt(data.operations.today)} işlem`], ['Bu ayki token', fmt(data.tokens.month), `${fmt(data.operations.month)} işlem`],
        ['Toplam token', fmt(data.tokens.total), `${fmt(data.operations.total)} işlem`], ['Son 30 gün hata', fmt(data.operations.errorsRange), `${fmt(data.operations.range)} işlemden`]]),
      h('p', { class: 'acct-muted' }, `Giriş: yerel ${fmt(data.users.bySource?.find(s => s.source === 'local')?.users)} · LDAP ${fmt(data.users.bySource?.find(s => s.source === 'ldap')?.users)}. LDAP ${data.settings.ldapEnabled ? 'açık' : 'kapalı'}, e-posta ${data.settings.emailEnabled ? 'yapılandırıldı' : 'yapılandırılmadı'}, kayıt ${data.settings.registrationOpen ? 'açık' : 'kapalı'}.`),
      h('h3', {}, 'Günlük token kullanımı (son 30 gün)'), bars(data.byDay.map(d => ({ label: d.day, value: d.tokens })), 'Günlük token kullanımı'),
      h('div', { class: 'adm-grid' },
        h('div', {}, h('h3', {}, 'İşlem türüne göre'), table(['Tür', 'İşlem', 'Token', 'Hata'], data.byKind.map(k => h('tr', {}, h('td', {}, kind(k.kind)), h('td', {}, fmt(k.operations)), h('td', {}, fmt(k.tokens)), h('td', {}, fmt(k.errors)))))),
        h('div', {}, h('h3', {}, 'Pakete göre kullanıcılar'), table(['Paket', 'Kullanıcı'], data.users.byPlan.map(p => h('tr', {}, h('td', {}, p.title), h('td', {}, fmt(p.users))))))),
      h('h3', {}, 'Modele göre token'), table(['Sağlayıcı', 'Model', 'Tür', 'Çağrı', 'Girdi', 'Çıktı', 'Toplam'], data.byModel.map(m => h('tr', {}, h('td', {}, m.provider), h('td', {}, m.model), h('td', {}, m.kind === 'embedding' ? 'Vektör' : 'Sohbet'), h('td', {}, fmt(m.calls)), h('td', {}, fmt(m.promptTokens)), h('td', {}, fmt(m.completionTokens)), h('td', {}, fmt(m.tokens))))),
      h('h3', {}, 'En çok token kullanan kullanıcılar (30 gün)'), table(['Kullanıcı', 'İşlem', 'Token'], data.topUsers.map(u => h('tr', {}, h('td', {}, u.username || '(silinmiş)'), h('td', {}, fmt(u.operations)), h('td', {}, fmt(u.tokens))))),
      h('h3', {}, 'Son hatalar'), table(['Zaman', 'Kullanıcı', 'Tür', 'Hata'], data.recentErrors.map(o => h('tr', {}, h('td', {}, when(o.startedAt)), h('td', {}, o.username || '—'), h('td', {}, kind(o.kind)), h('td', {}, o.error || ''))), 'Hata kaydı yok.'));
  }

  // ---- users
  const planOptions = plans => plans.map(p => [p.id, p.title]);
  async function users(panel, offset = 0) {
    const f = filters.users, plans = (await api('GET', '/api/admin/plans')).plans, query = new URLSearchParams({ ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), limit: pageSize, offset });
    const data = await api('GET', '/api/admin/users?' + query);
    const refresh = () => render();
    panel.append(
      h('div', { class: 'adm-toolbar' },
        h('input', { type: 'search', placeholder: 'Ad, kullanıcı adı veya e-posta ara', value: f.search, onchange: event => { f.search = event.target.value.trim(); refresh(); } }),
        select('plan', [['', 'Tüm paketler'], ...planOptions(plans)], f.plan, v => { f.plan = v; refresh(); }),
        select('status', [['', 'Tüm durumlar'], ['active', 'Etkin'], ['disabled', 'Devre dışı']], f.status, v => { f.status = v; refresh(); }),
        select('source', [['', 'Tüm hesap türleri'], ['local', 'Yerel'], ['ldap', 'LDAP']], f.source, v => { f.source = v; refresh(); }),
        h('button', { type: 'button', class: 'copy-button', onclick: () => createUser(plans, refresh) }, 'Kullanıcı ekle')),
      table(['Kullanıcı', 'Tür', 'Paket', 'Bu ay token', 'Toplam token', 'Proje / kaynak', 'Son giriş', 'Durum', ''], data.users.map(u => h('tr', { class: u.status === 'disabled' ? 'is-off' : '' },
        h('td', {}, h('strong', {}, u.username), u.role === 'admin' ? ' ★' : '', u.email ? h('small', { class: 'adm-sub' }, u.email + (u.emailVerified ? ' ✓' : '')) : null),
        h('td', {}, u.source === 'ldap' ? 'LDAP' : 'Yerel'), h('td', {}, u.plan + (u.planExpiresAt ? ' · ' + new Date(u.planExpiresAt).toLocaleDateString('tr-TR') : '')),
        h('td', {}, fmt(u.monthTokens) + (u.monthlyTokenLimit ? ' / ' + fmt(u.monthlyTokenLimit) : '')), h('td', {}, fmt(u.totalTokens)), h('td', {}, `${fmt(u.projects)} / ${fmt(u.documents)}`),
        h('td', {}, when(u.lastLoginAt)), h('td', {}, u.status === 'disabled' ? 'Devre dışı' : 'Etkin'),
        h('td', {}, h('button', { type: 'button', class: 'text-button', onclick: () => userDetail(u.id, plans, refresh) }, 'Yönet')))), 'Kullanıcı bulunamadı.'),
      pager(data.total, offset, next => { panel.replaceChildren(); users(panel, next); }));
  }
  function createUser(plans, done) {
    const status = h('div', {}), f = h('form', { class: 'acct-form', onsubmit: guard(status, async event => {
      event.preventDefault(); const v = Object.fromEntries(new FormData(f));
      const result = await api('POST', '/api/admin/users', { username: v.username, displayName: v.displayName, email: v.email || undefined, planId: v.planId, role: v.role });
      d.close(); done(); showSecret('Geçici parola', result.user.username, result.temporaryPassword);
    }) },
      h('label', { class: 'acct-field' }, h('span', {}, 'Kullanıcı adı'), h('input', { name: 'username', required: true, minlength: 3 })), h('label', { class: 'acct-field' }, h('span', {}, 'Görünen ad'), h('input', { name: 'displayName' })),
      h('label', { class: 'acct-field' }, h('span', {}, 'E-posta (isteğe bağlı)'), h('input', { name: 'email', type: 'email' })),
      h('label', { class: 'acct-field' }, h('span', {}, 'Paket'), select('planId', planOptions(plans), plans[0]?.id, () => {})), h('label', { class: 'acct-field' }, h('span', {}, 'Rol'), select('role', [['user', 'Kullanıcı'], ['admin', 'Yönetici']], 'user', () => {})),
      h('p', { class: 'acct-muted' }, 'Rastgele bir geçici parola üretilir; kullanıcı ilk girişte değiştirmek zorundadır.'), h('button', { type: 'submit', class: 'copy-button' }, 'Oluştur'));
    const d = dialog('Kullanıcı ekle', status, f);
  }
  function showSecret(title, username, password) {
    if (!password) return;
    dialog(title, h('p', {}, `${username} için geçici parola yalnızca bir kez gösterilir:`), h('p', {}, h('code', { class: 'adm-secret' }, password)), h('p', { class: 'acct-muted' }, 'Kullanıcıya güvenli bir yolla iletin; ilk girişte değiştirmesi istenecek.'));
  }
  async function userDetail(id, plans, done) {
    const data = await api('GET', '/api/admin/users/' + id), u = data.user, status = h('div', {});
    const act = (label, fn, className = 'copy-button btn-secondary') => h('button', { type: 'button', class: className, onclick: guard(status, fn) }, label);
    const patch = async body => { await api('PATCH', '/api/admin/users/' + id, body); d.close(); done(); };
    const expiry = h('input', { type: 'date', value: u.planExpiresAt ? new Date(u.planExpiresAt).toISOString().slice(0, 10) : '' });
    const d = dialog(u.username, status,
      h('p', { class: 'acct-muted' }, `${u.source === 'ldap' ? 'LDAP' : 'Yerel'} hesap · kayıt ${when(u.createdAt)} · son giriş ${when(u.lastLoginAt)} · ${fmt(u.activeSessions)} açık oturum · ${fmt(u.projects)} proje, ${fmt(u.documents)} kaynak`),
      h('p', {}, `Bu ay ${fmt(data.usage.month.totalTokens)}${u.monthlyTokenLimit ? ' / ' + fmt(u.monthlyTokenLimit) : ''} token · toplam ${fmt(data.usage.total.totalTokens)} token · ${fmt(data.usage.total.operations)} işlem`),
      h('div', { class: 'adm-toolbar' }, h('label', {}, 'Paket ', select('planId', planOptions(plans), u.planId, v => { u._plan = v; })), h('label', {}, 'Bitiş ', expiry),
        act('Paketi kaydet', async () => patch({ planId: u._plan || u.planId, planExpiresAt: expiry.value ? new Date(expiry.value + 'T23:59:59').getTime() : null }))),
      h('div', { class: 'adm-toolbar' }, act(u.role === 'admin' ? 'Yöneticiliği kaldır' : 'Yönetici yap', () => patch({ role: u.role === 'admin' ? 'user' : 'admin' })),
        act(u.status === 'disabled' ? 'Hesabı etkinleştir' : 'Hesabı devre dışı bırak', () => patch({ status: u.status === 'disabled' ? 'active' : 'disabled' })),
        act('Oturumları kapat', async () => { const r = await api('POST', `/api/admin/users/${id}/logout`, {}); notice(status, `${r.revoked} oturum kapatıldı.`); }),
        u.source === 'local' ? act('Parolayı sıfırla', async () => { if (!confirm('Parola sıfırlansın mı? Tüm oturumlar kapanır.')) return; const r = await api('POST', `/api/admin/users/${id}/reset-password`, {}); d.close(); showSecret('Yeni geçici parola', u.username, r.temporaryPassword); }) : null,
        act('Sil', async () => { if (!confirm(`${u.username} ve tüm projeleri/belgeleri kalıcı olarak silinsin mi? Token geçmişi kalır.`)) return; await api('DELETE', '/api/admin/users/' + id); d.close(); done(); }, 'copy-button btn-danger')),
      h('h3', {}, 'Son işlemler'), table(['Zaman', 'Tür', 'Durum', 'Token'], data.operations.map(o => h('tr', {}, h('td', {}, when(o.startedAt)), h('td', {}, kind(o.kind)), h('td', {}, STATUS[o.status] || o.status), h('td', {}, fmt(o.totalTokens)))), 'İşlem yok.'));
  }

  // ---- plans
  async function plans(panel) {
    const data = (await api('GET', '/api/admin/plans')).plans;
    panel.append(h('div', { class: 'adm-toolbar' }, h('button', { type: 'button', class: 'copy-button', onclick: () => editPlan(null, data) }, 'Yeni paket')),
      table(['Sıra', 'Kod', 'Ad', 'Proje', 'Kaynak/proje', 'Dosya', 'Günlük soru', 'Aylık token', 'Kaynak/belge sorgu', 'Aylık sorgu', 'Word/PDF belge', 'Kullanıcı', 'Durum', ''], data.map(p => h('tr', {}, h('td', {}, p.sortOrder), h('td', {}, h('code', {}, p.id)), h('td', {}, h('strong', {}, p.title), p.description ? h('small', { class: 'adm-sub' }, p.description) : null),
        h('td', {}, fmt(p.projects)), h('td', {}, fmt(p.documentsPerProject)), h('td', {}, Math.round(p.documentBytes / MB) + ' MB'), h('td', {}, fmt(p.questionsPerDay)), h('td', {}, p.monthlyTokens ? fmt(p.monthlyTokens) : 'Sınırsız'),
        h('td', {}, p.referencesPerDocument ? fmt(p.referencesPerDocument) : 'Sınırsız'), h('td', {}, p.monthlyReferences ? fmt(p.monthlyReferences) : 'Sınırsız'), h('td', {}, p.wordDocuments ? fmt(p.wordDocuments) : 'Sınırsız'),
        h('td', {}, fmt(p.users)), h('td', {}, p.active ? 'Etkin' : 'Pasif'), h('td', {}, h('button', { type: 'button', class: 'text-button', onclick: () => editPlan(p, data) }, 'Düzenle'))))),
      h('p', { class: 'acct-muted' }, 'Paketlerin sırası yükseltme önerisini ve skill erişimini belirler (sıra ne kadar büyükse paket o kadar üsttedir). Aylık token, belge başına sorgulanacak kaynak, aylık sorgulanan kaynak ve kayıtlı Word/PDF belge sayısı 0 ise sınırsızdır.'));
  }
  function editPlan(plan, all) {
    const status = h('div', {}), mk = (label, name, value, type = 'text', extra = {}) => h('label', { class: 'acct-field' }, h('span', {}, label), h('input', { name, type, value: value ?? '', required: name !== 'description', ...extra }));
    const f = h('form', { class: 'acct-form', onsubmit: guard(status, async event => {
      event.preventDefault(); const v = Object.fromEntries(new FormData(f));
      const body = { title: v.title, description: v.description, sortOrder: Number(v.sortOrder), projects: Number(v.projects), documentsPerProject: Number(v.documentsPerProject), documentBytes: Math.round(Number(v.documentMb) * MB), questionsPerDay: Number(v.questionsPerDay), monthlyTokens: Number(v.monthlyTokens), referencesPerDocument: Number(v.referencesPerDocument), monthlyReferences: Number(v.monthlyReferences), wordDocuments: Number(v.wordDocuments), active: v.active === 'on' };
      if (plan) await api('PUT', '/api/admin/plans/' + plan.id, body); else await api('POST', '/api/admin/plans', { ...body, id: v.id });
      d.close(); render();
    }) },
      plan ? null : mk('Paket kodu', 'id', '', 'text', { pattern: '[a-z0-9][a-z0-9-]{1,29}', title: 'Küçük harf, rakam ve tire' }), mk('Ad', 'title', plan?.title), mk('Açıklama', 'description', plan?.description),
      mk('Sıra', 'sortOrder', plan?.sortOrder ?? (Math.max(0, ...all.map(p => p.sortOrder)) + 1), 'number'), mk('Proje sayısı', 'projects', plan?.projects ?? 10, 'number', { min: 1 }), mk('Projedeki kaynak sayısı', 'documentsPerProject', plan?.documentsPerProject ?? 20, 'number', { min: 1 }),
      mk('En büyük dosya (MB)', 'documentMb', plan ? Math.round(plan.documentBytes / MB) : 50, 'number', { min: 1, max: 200 }), mk('Günlük soru', 'questionsPerDay', plan?.questionsPerDay ?? 200, 'number', { min: 1 }),
      mk('Aylık token (0 = sınırsız)', 'monthlyTokens', plan?.monthlyTokens ?? 0, 'number', { min: 0 }),
      mk('Belge başına sorgulanacak kaynak (0 = sınırsız)', 'referencesPerDocument', plan?.referencesPerDocument ?? 150, 'number', { min: 0 }), mk('Aylık sorgulanan kaynak (0 = sınırsız)', 'monthlyReferences', plan?.monthlyReferences ?? 1000, 'number', { min: 0 }),
      mk('Kayıtlı Word/PDF belge sayısı (0 = sınırsız)', 'wordDocuments', plan?.wordDocuments ?? 20, 'number', { min: 0 }),
      h('label', { class: 'acct-check' }, h('input', { type: 'checkbox', name: 'active', checked: plan ? plan.active : true }), ' Yeni atamalar için etkin'),
      h('button', { type: 'submit', class: 'copy-button' }, 'Kaydet'),
      plan ? h('button', { type: 'button', class: 'copy-button btn-danger', onclick: guard(status, async () => {
        const others = all.filter(p => p.id !== plan.id), target = plan.users ? prompt(`Bu pakette ${plan.users} kullanıcı var. Taşınacakları paketin kodu (${others.map(p => p.id).join(', ')}):`) : '';
        if (plan.users && !target) return; if (!plan.users && !confirm('Paket silinsin mi?')) return;
        await api('DELETE', `/api/admin/plans/${plan.id}${target ? '?reassign=' + encodeURIComponent(target) : ''}`); d.close(); render();
      }) }, 'Paketi sil') : null);
    const d = dialog(plan ? plan.title + ' paketi' : 'Yeni paket', status, f);
  }

  // ---- operations
  async function operations(panel, offset = 0) {
    const f = filters.operations, query = new URLSearchParams({ ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), limit: pageSize, offset });
    const data = await api('GET', '/api/admin/operations?' + query);
    panel.append(h('div', { class: 'adm-toolbar' },
      h('input', { type: 'search', placeholder: 'Kullanıcı adı', value: f.user, onchange: event => { f.user = event.target.value.trim(); render(); } }),
      select('kind', [['', 'Tüm türler'], ...Object.entries(KINDS)], f.kind, v => { f.kind = v; render(); }), select('status', [['', 'Tüm durumlar'], ...Object.entries(STATUS)], f.status, v => { f.status = v; render(); })),
      table(['Zaman', 'Kullanıcı', 'Tür', 'Durum', 'Süre', 'Girdi', 'Çıktı', 'Toplam token', ''], data.operations.map(o => h('tr', {}, h('td', {}, when(o.startedAt)), h('td', {}, o.username || '—'), h('td', {}, kind(o.kind)), h('td', {}, STATUS[o.status] || o.status),
        h('td', {}, dur(o.durationMs)), h('td', {}, fmt(o.promptTokens)), h('td', {}, fmt(o.completionTokens)), h('td', {}, fmt(o.totalTokens) + (o.estimated ? ' ~' : '')),
        h('td', {}, h('button', { type: 'button', class: 'text-button', onclick: () => operationDetail(o.id) }, 'Ayrıntı')))), 'İşlem kaydı yok.'),
      h('p', { class: 'acct-muted' }, '~ işareti, sağlayıcının token sayısı bildirmediği ve tahmin edilen çağrıları içerir.'), pager(data.total, offset, next => { panel.replaceChildren(); operations(panel, next); }));
  }
  async function operationDetail(id) {
    const { operation: o } = await api('GET', '/api/admin/operations/' + id);
    dialog(`${kind(o.kind)} — ${o.username || ''}`, h('p', { class: 'acct-muted' }, `${when(o.startedAt)} · ${STATUS[o.status] || o.status} · ${dur(o.durationMs)} · toplam ${fmt(o.totalTokens)} token`), o.error ? h('p', { class: 'acct-message is-error' }, o.error) : null,
      table(['Zaman', 'Çağrı', 'Sağlayıcı', 'Model', 'Girdi', 'Çıktı', 'Toplam'], o.calls.map(c => h('tr', {}, h('td', {}, when(c.at)), h('td', {}, c.kind === 'embedding' ? 'Vektör' : 'Sohbet'), h('td', {}, c.provider), h('td', {}, c.model), h('td', {}, fmt(c.promptTokens)), h('td', {}, fmt(c.completionTokens)), h('td', {}, fmt(c.totalTokens) + (c.estimated ? ' ~' : '')))), 'Model çağrısı yok.'));
  }

  // ---- audit
  async function audit(panel, offset = 0) {
    const f = filters.audit, query = new URLSearchParams({ ...(f.action ? { action: f.action } : {}), limit: pageSize, offset });
    const data = await api('GET', '/api/admin/audit?' + query);
    panel.append(h('div', { class: 'adm-toolbar' }, select('action', [['', 'Tüm eylemler'], ['auth.', 'Hesap eylemleri'], ['admin.user', 'Kullanıcı yönetimi'], ['admin.plan', 'Paket yönetimi'], ['admin.settings', 'Ayar değişiklikleri']], f.action, v => { f.action = v; render(); })),
      table(['Zaman', 'Yapan', 'Eylem', 'Hedef', 'Ayrıntı', 'IP'], data.entries.map(e => h('tr', {}, h('td', {}, when(e.at)), h('td', {}, e.actorName || '—'), h('td', {}, h('code', {}, e.action)), h('td', {}, e.targetType ? `${e.targetType}` : ''),
        h('td', {}, e.detail ? h('small', {}, JSON.stringify(e.detail).slice(0, 200)) : ''), h('td', {}, e.ip || ''))), 'Denetim kaydı boş.'), pager(data.total, offset, next => { panel.replaceChildren(); audit(panel, next); }));
  }

  // ---- LLM provider keys (Groq, OpenRouter, Gemini). The server never sends a key value, only its last four characters.
  const PROVIDER_NOTES = { groq: 'Sohbet (kaynakça ve içerik denetimi, yazım yardımcısı yanıtları, web künyesi).', openrouter: 'Groq dolduğunda ücretsiz modellerle yedek sohbet sağlayıcısı.', gemini: 'Yazım yardımcısının embedding (vektörleme) isteklerinde kullanılır.' };
  const KEY_STATUS = { active: ['Etkin', 'is-ok'], cooling: ['Dinleniyor', 'is-warn'], limited: ['Sınıra ulaştı', 'is-warn'], disabled: ['Pasif', 'is-off'], invalid: ['Geçersiz', 'is-error'] };
  let keyTimer = null;
  const left = ms => { const s = Math.max(0, Math.ceil((ms - Date.now()) / 1000)); return s >= 3600 ? Math.floor(s / 3600) + ' sa ' + Math.floor(s % 3600 / 60) + ' dk' : s >= 60 ? Math.floor(s / 60) + ' dk ' + (s % 60) + ' sn' : s + ' sn'; };
  async function llmKeys(panel) {
    const status = h('div', {}), list = h('div', { class: 'adm-keys' });
    let data = null;
    const reload = async () => { data = await api('GET', '/api/admin/llm-keys'); draw(); };
    const act = fn => guard(status, async (...args) => { await fn(...args); await reload(); });
    const limitText = key => [key.rpm ? key.rpm + '/dk' : null, key.rpd ? key.rpd + '/gün' : null].filter(Boolean).join(' · ') || 'Kendi sınırı yok';
    function edit(key) {
      const form = h('form', { class: 'acct-form', onsubmit: act(async event => {
        event.preventDefault(); const v = Object.fromEntries(new FormData(form));
        const body = { label: v.label, group: v.group, rpm: v.rpm === '' ? null : Number(v.rpm), rpd: v.rpd === '' ? null : Number(v.rpd) }; if (v.key) body.key = v.key;
        await api('PATCH', '/api/admin/llm-keys/' + key.id, body); dialogNode.close(); notice(status, 'Kaydedildi.');
      }) },
      h('label', { class: 'acct-field' }, h('span', {}, 'Etiket'), h('input', { name: 'label', value: key.label, maxlength: 60 })),
      h('label', { class: 'acct-field' }, h('span', {}, 'Grup (aynı sağlayıcı hesabındaki anahtarlar)'), h('input', { name: 'group', value: key.group || '', maxlength: 40 })),
      h('label', { class: 'acct-field' }, h('span', {}, 'Dakikalık istek sınırı'), h('input', { name: 'rpm', type: 'number', min: 0, value: key.rpm ?? '' })),
      h('label', { class: 'acct-field' }, h('span', {}, 'Günlük istek sınırı'), h('input', { name: 'rpd', type: 'number', min: 0, value: key.rpd ?? '' })),
      h('label', { class: 'acct-field' }, h('span', {}, 'Yeni anahtar (değiştirmek için)'), h('input', { name: 'key', type: 'password', autocomplete: 'new-password', placeholder: '…' + key.last4 + ' (değiştirmek için yazın)' })),
      h('button', { type: 'submit', class: 'copy-button' }, 'Kaydet (yeni anahtar önce sınanır)'));
      const dialogNode = dialog(key.providerName + ' anahtarını düzenle', form);
    }
    function row(key) {
      const [statusLabel, statusClass] = KEY_STATUS[key.status] || [key.status, ''];
      const detail = key.status === 'invalid' ? key.invalidReason : key.restUntil ? 'Yaklaşık ' + left(key.restUntil) + ' sonra yeniden denenecek.' : '';
      const readOnly = key.source === 'env';
      return h('tr', {},
        h('td', {}, h('strong', {}, key.label), key.group ? h('small', { class: 'acct-muted' }, ' · grup ' + key.group) : null, h('br'), h('small', { class: 'acct-muted' }, readOnly ? '.env dosyasından' : '…' + key.last4)),
        h('td', {}, h('span', { class: 'adm-badge ' + statusClass }, statusLabel), detail ? h('br') : null, detail ? h('small', { class: 'acct-muted' }, detail) : null),
        h('td', {}, limitText(key)),
        h('td', {}, `${fmt(key.today.requests)} istek`, h('br'), h('small', { class: 'acct-muted' }, `${fmt(key.today.tokens)} token · ${fmt(key.today.fail)} hata`)),
        h('td', {}, `${fmt(key.total.ok)} başarılı · ${fmt(key.total.fail)} hata`, h('br'), h('small', { class: 'acct-muted' }, `${fmt(key.total.promptTokens + key.total.completionTokens)} token`)),
        h('td', {}, key.lastError ? h('small', { title: key.lastError }, when(key.lastErrorAt) + ' · ' + key.lastError.slice(0, 60)) : '—', key.lastTest ? h('br') : null,
          key.lastTest ? h('small', { class: 'acct-muted' }, 'Son test: ' + (key.lastTest.ok ? 'başarılı' : 'başarısız') + ' · ' + when(key.lastTest.at)) : null),
        h('td', { class: 'adm-actions' },
          h('button', { type: 'button', class: 'text-button', onclick: act(async () => { const r = await api('POST', `/api/admin/llm-keys/${key.id}/test`); notice(status, (key.label + ': ') + r.message, !r.ok); }) }, 'Test et'),
          readOnly ? null : h('button', { type: 'button', class: 'text-button', onclick: act(async () => { await api('PATCH', '/api/admin/llm-keys/' + key.id, { enabled: !key.enabled }); }) }, key.enabled ? 'Pasifleştir' : 'Etkinleştir'),
          readOnly ? null : h('button', { type: 'button', class: 'text-button', onclick: () => edit(key) }, 'Düzenle'),
          h('button', { type: 'button', class: 'text-button', onclick: act(async () => { if (!confirm(readOnly ? `${key.label} (…${key.last4}) havuzdan kaldırılsın mı? .env dosyası değişmez; anahtar yalnızca kullanılmaz.` : `${key.label} (…${key.last4}) kalıcı olarak silinsin mi?`)) return; await api('DELETE', '/api/admin/llm-keys/' + key.id); notice(status, 'Silindi.'); }) }, 'Sil')));
    }
    function draw() {
      list.replaceChildren(...Object.entries(data.summary).map(([provider, sum]) => {
        const keys = data.keys.filter(k => k.provider === provider);
        return h('section', {}, h('h3', {}, ({ groq: 'Groq', openrouter: 'OpenRouter', gemini: 'Gemini' }[provider] || provider) + ` — ${sum.available}/${sum.total} anahtar kullanılabilir`), h('p', { class: 'acct-muted' }, PROVIDER_NOTES[provider] || ''),
          table(['Anahtar', 'Durum', 'Sınırlar', 'Bugün', 'Toplam', 'Son durum', ''], keys.map(row), 'Bu sağlayıcı için anahtar yok. Aşağıdan ekleyin.'));
      }));
    }
    const form = h('form', { class: 'acct-form', onsubmit: guard(status, async event => {
      event.preventDefault(); const v = Object.fromEntries(new FormData(form));
      const body = { provider: v.provider, label: v.label, key: v.key, group: v.group, rpm: v.rpm === '' ? null : Number(v.rpm), rpd: v.rpd === '' ? null : Number(v.rpd) };
      const button = form.querySelector('button[type=submit]'); button.disabled = true;
      try { const r = await api('POST', '/api/admin/llm-keys', body); form.reset(); notice(status, r.test.quota ? 'Anahtar eklendi (şu an kotası dolu görünüyor).' : 'Anahtar sınandı ve eklendi.'); await reload(); } finally { button.disabled = false; }
    }) },
    h('label', { class: 'acct-field' }, h('span', {}, 'Sağlayıcı'), select('provider', [['groq', 'Groq'], ['openrouter', 'OpenRouter'], ['gemini', 'Gemini (embedding)']], 'groq', () => {})),
    h('label', { class: 'acct-field' }, h('span', {}, 'Etiket'), h('input', { name: 'label', maxlength: 60, placeholder: 'ör. Ayşe hesabı' })),
    h('label', { class: 'acct-field' }, h('span', {}, 'API anahtarı'), h('input', { name: 'key', type: 'password', required: true, autocomplete: 'new-password', spellcheck: 'false' })),
    h('label', { class: 'acct-field' }, h('span', {}, 'Grup (isteğe bağlı)'), h('input', { name: 'group', maxlength: 40, placeholder: 'Aynı sağlayıcı hesabına ait anahtarlar için ortak ad' })),
    h('label', { class: 'acct-field' }, h('span', {}, 'Dakikalık istek sınırı (isteğe bağlı)'), h('input', { name: 'rpm', type: 'number', min: 0 })),
    h('label', { class: 'acct-field' }, h('span', {}, 'Günlük istek sınırı (isteğe bağlı)'), h('input', { name: 'rpd', type: 'number', min: 0 })),
    h('button', { type: 'submit', class: 'copy-button' }, 'Anahtarı sına ve ekle'));
    await reload();
    panel.append(status,
      h('p', { class: 'acct-muted' }, `Anahtarlar sırayla kullanılır; bir anahtarın kotası dolunca beklemeden sıradaki anahtara geçilir. Panelden eklenenler önce, .env dosyasındakiler sonra denenir. Değerler şifreli saklanır ve bir daha gösterilmez. ${data.mode === 'queue' ? 'Anahtarlar LLM servisinde tutulur ve şifreli olarak ona iletilir.' : ''} Ücretsiz katman sınırları çoğu sağlayıcıda hesap başınadır: aynı hesaptan alınan anahtarlar kotayı artırmaz, bu yüzden gerçekten ayrı hesapların anahtarlarını ekleyin veya aynı hesabınkileri aynı gruba koyun.`),
      list, h('h3', {}, 'Anahtar ekle'), form);
    // The status and rest times change on their own; refresh while this tab stays on screen.
    clearInterval(keyTimer);
    keyTimer = setInterval(() => { if (!list.isConnected) return clearInterval(keyTimer); if (!document.querySelector('dialog.adm-dialog')) api('GET', '/api/admin/llm-keys').then(next => { data = next; draw(); }, () => {}); }, 10000);
  }

  // ---- model prompts. Each one has a built-in default; saving overrides it, "Varsayılana dön" removes the override.
  async function prompts(panel) {
    const status = h('div', {});
    const data = await api('GET', '/api/admin/prompts');
    const card = prompt => {
      const area = h('textarea', { rows: 12, maxlength: data.maxChars, spellcheck: 'false', class: 'adm-prompt' }, prompt.content);
      const badge = h('span', { class: 'adm-badge ' + (prompt.customized ? 'is-warn' : 'is-off') }, prompt.customized ? 'Özelleştirilmiş' : 'Varsayılan');
      const count = h('small', { class: 'acct-muted' });
      const sync = () => { count.textContent = `${fmt(area.value.length)} / ${fmt(data.maxChars)} karakter` + (prompt.placeholders.length ? ' · zorunlu: ' + prompt.placeholders.join(' ') : ''); };
      area.addEventListener('input', sync); sync();
      const apply = next => { prompt = next; area.value = next.content; badge.className = 'adm-badge ' + (next.customized ? 'is-warn' : 'is-off'); badge.textContent = next.customized ? 'Özelleştirilmiş' : 'Varsayılan'; sync(); };
      return h('details', { class: 'acct-card adm-section' }, h('summary', {}, h('h3', {}, prompt.title + ' '), badge),
        h('p', { class: 'acct-muted' }, prompt.description, ' ', h('code', {}, prompt.id)), area, count,
        h('div', { class: 'adm-toolbar' },
          h('button', { type: 'button', class: 'copy-button', onclick: guard(status, async () => { const r = await api('PUT', '/api/admin/prompts/' + prompt.id, { content: area.value }); apply(r.prompt); notice(status, 'Kaydedildi. Yeni istek hemen bu metni kullanır.'); }) }, 'Kaydet'),
          h('button', { type: 'button', class: 'copy-button btn-secondary', onclick: () => { area.value = prompt.defaultContent; sync(); } }, 'Varsayılanı yükle (kaydetmeden)'),
          h('button', { type: 'button', class: 'copy-button btn-secondary', onclick: guard(status, async () => { if (!confirm('Özelleştirme kaldırılsın ve yerleşik metin kullanılsın mı?')) return; const r = await api('DELETE', '/api/admin/prompts/' + prompt.id); apply(r.prompt); notice(status, 'Varsayılana dönüldü.'); }) }, 'Varsayılana dön')));
    };
    const areas = [...new Set(data.prompts.map(p => p.area))];
    panel.append(status, h('p', { class: 'acct-muted' }, 'Bunlar modele gönderilen sistem iletileridir (istemler). Değişiklik sunucuyu yeniden başlatmadan, sonraki isteklerden itibaren geçerlidir. Kullanıcıların sorusu ve kaynak metinleri istemlere sistem tarafından eklenir; burada yalnız talimat metni düzenlenir. Yanlış bir istem doğrulama sonuçlarını bozabilir; emin değilseniz "Varsayılana dön" ile geri alın.'),
      ...areas.flatMap(name => [h('h3', {}, name), ...data.prompts.filter(p => p.area === name).map(card)]));
  }

  // ---- writing assistant skills (skills/*.md files, with the edits made here laid over them)
  const ORIGIN = { file: ['Dosya', 'is-off'], edited: ['Düzenlendi', 'is-warn'], custom: ['Panelden eklendi', 'is-ok'], hidden: ['Gizli', 'is-error'] };
  async function skills(panel) {
    const status = h('div', {});
    let data = null;
    const reload = async () => { data = await api('GET', '/api/admin/skills'); draw(); };
    const act = fn => guard(status, async (...args) => { await fn(...args); await reload(); });
    const planName = id => data.plans.find(p => p.id === id)?.title || id || data.plans[0]?.title || '—';
    function edit(skill) {
      const creating = !skill;
      skill = skill || { name: '', title: '', description: '', minPlan: '', keywords: [], needsSources: true, instruction: '', inputTemplate: '' };
      const form = h('form', { class: 'acct-form', onsubmit: act(async event => {
        event.preventDefault(); const v = Object.fromEntries(new FormData(form));
        const body = { title: v.title, description: v.description, minPlan: v.minPlan, keywords: v.keywords, needsSources: !!v.needsSources, instruction: v.instruction, inputTemplate: v.inputTemplate };
        if (creating) await api('POST', '/api/admin/skills', { ...body, name: v.name }); else await api('PUT', '/api/admin/skills/' + skill.name, body);
        node.close(); notice(status, 'Kaydedildi.');
      }) },
      h('label', { class: 'acct-field' }, h('span', {}, 'Ad (dosya adı; küçük harf, rakam, "-")'), h('input', { name: 'name', value: skill.name, required: true, maxlength: 40, pattern: '[a-z0-9-]{1,40}', readonly: !creating })),
      h('label', { class: 'acct-field' }, h('span', {}, 'Başlık (kullanıcıya görünür)'), h('input', { name: 'title', value: skill.title, required: true, maxlength: 120 })),
      h('label', { class: 'acct-field' }, h('span', {}, 'Açıklama'), h('input', { name: 'description', value: skill.description, maxlength: 300 })),
      h('label', { class: 'acct-field' }, h('span', {}, 'En düşük paket'), select('minPlan', [['', 'İlk paket'], ...data.plans.map(p => [p.id, p.title])], skill.minPlan || '', () => {})),
      h('label', { class: 'acct-field' }, h('span', {}, 'Anahtar sözcükler (virgülle; skill önerisi için)'), h('input', { name: 'keywords', value: (skill.keywords || []).join(', ') })),
      h('label', { class: 'acct-check' }, h('input', { type: 'checkbox', name: 'needsSources', checked: skill.needsSources }), ' Kaynak pasajı gerektirir (kapalıysa yalnız kullanıcının kendi metnini yeniden yazar)'),
      h('label', { class: 'acct-field' }, h('span', {}, 'Talimat metni'), h('textarea', { name: 'instruction', rows: 14, required: true, maxlength: 8000, class: 'adm-prompt' }, skill.instruction)),
      h('label', { class: 'acct-field' }, h('span', {}, 'Girdi formu (isteğe bağlı; skill seçilince soru alanına otomatik gelir, kullanıcı doldurur ya da siler)'), h('textarea', { name: 'inputTemplate', rows: 6, maxlength: 2000, class: 'adm-prompt', placeholder: 'Örn. satırlar: Konu: / Araştırma sorusu: / Amaç:' }, skill.inputTemplate || '')),
      h('small', { class: 'acct-muted' }, 'Atıflar sistem tarafından eklenir; talimata atıf biçimi yazmayın. Kaynak parçaları [P1], [P2] gibi kimliklerle anılır.'),
      h('button', { type: 'submit', class: 'copy-button' }, 'Kaydet'));
      const node = dialog(creating ? 'Yeni skill' : skill.title + ' — düzenle', form);
    }
    function row(skill) {
      const [label, cls] = ORIGIN[skill.origin] || [skill.origin, ''];
      const hidden = skill.origin === 'hidden';
      return h('tr', {},
        h('td', {}, h('strong', {}, skill.title), h('br'), h('small', { class: 'acct-muted' }, skill.name)),
        h('td', {}, skill.description || '—'),
        h('td', {}, planName(skill.minPlan), h('br'), h('small', { class: 'acct-muted' }, skill.needsSources ? 'Kaynaklı' : 'Kendi metni')),
        h('td', {}, h('span', { class: 'adm-badge ' + cls }, label), skill.updatedAt ? h('br') : null, skill.updatedAt ? h('small', { class: 'acct-muted' }, when(skill.updatedAt) + (skill.updatedBy ? ' · ' + skill.updatedBy : '')) : null),
        h('td', { class: 'adm-actions' },
          h('button', { type: 'button', class: 'text-button', onclick: () => edit(skill) }, hidden ? 'Düzenle ve geri getir' : 'Düzenle'),
          hidden ? h('button', { type: 'button', class: 'text-button', onclick: act(async () => { await api('POST', `/api/admin/skills/${skill.name}/reset`); notice(status, 'Geri getirildi.'); }) }, 'Geri getir') : null,
          skill.origin === 'edited' ? h('button', { type: 'button', class: 'text-button', onclick: act(async () => { if (!confirm('Düzenleme atılsın ve dosyadaki sürüm kullanılsın mı?')) return; await api('POST', `/api/admin/skills/${skill.name}/reset`); notice(status, 'Dosya sürümüne dönüldü.'); }) }, 'Dosyaya dön') : null,
          hidden || skill.name === data.defaultSkill ? null : h('button', { type: 'button', class: 'text-button', onclick: act(async () => { if (!confirm(skill.hasFile ? `"${skill.title}" kullanıcılardan gizlensin mi? (Dosya silinmez; sonra geri getirilebilir.)` : `"${skill.title}" kalıcı olarak silinsin mi?`)) return; await api('DELETE', '/api/admin/skills/' + skill.name); notice(status, 'Kaldırıldı.'); }) }, skill.hasFile ? 'Gizle' : 'Sil')));
    }
    const holder = h('div', {});
    function draw() {
      holder.replaceChildren(table(['Skill', 'Açıklama', 'Paket', 'Kaynak', ''], data.skills.map(row), 'Skill yok.'),
        data.problems.length ? h('p', { class: 'acct-message is-error' }, 'Okunamayan skill dosyaları: ' + data.problems.join(', ')) : null);
    }
    await reload();
    panel.append(status, h('p', { class: 'acct-muted' }, 'Skill\'ler yazım yardımcısının cevap biçimini belirleyen talimatlardır. Dosyalar (skills/*.md) varsayılandır; burada yaptığınız düzenleme dosyanın üzerine yazılmaz, onun yerine geçer ve sunucuyu yeniden başlatmadan uygulanır. Kullanıcılar skill\'leri düzenleyemez; yalnız paketlerinin izin verdiklerinden seçer.'),
      h('div', { class: 'adm-toolbar' }, h('button', { type: 'button', class: 'copy-button', onclick: () => edit(null) }, 'Yeni skill')), holder);
  }

  // ---- settings
  async function settings(panel) {
    const data = await api('GET', '/api/admin/settings'), status = h('div', {});
    data.scholar = (await api('GET', '/api/admin/settings/scholar')).scholar;
    const text = (label, name, value, extra = {}) => h('label', { class: 'acct-field' }, h('span', {}, label), h('input', { name, value: value ?? '', ...extra }));
    const check = (label, name, value) => h('label', { class: 'acct-check' }, h('input', { type: 'checkbox', name, checked: !!value }), ' ' + label);
    const section = (title, lead, fields, save, extra) => { const f = h('form', { class: 'acct-form', onsubmit: guard(status, async event => { event.preventDefault(); await save(Object.fromEntries(new FormData(f)), f); notice(status, 'Kaydedildi.'); }) }, ...fields, h('button', { type: 'submit', class: 'copy-button' }, 'Kaydet'), extra); return h('details', { class: 'acct-card adm-section', open: true }, h('summary', {}, h('h3', {}, title)), lead ? h('p', { class: 'acct-muted' }, lead) : null, f); };
    const g = data.general, l = data.ldap, s = data.smtp;
    const mappings = (l.groupMappings || []).map(m => `${m.group} = ${m.admin ? 'admin' : m.plan}`).join('\n');
    const parseMappings = value => value.split('\n').map(line => line.trim()).filter(Boolean).map(line => { const at = line.lastIndexOf('='), group = line.slice(0, at).trim(), target = line.slice(at + 1).trim(); return target === 'admin' ? { group, admin: true } : { group, plan: target }; });
    const ldapForm = section('LDAP girişi', 'Kurum hesaplarıyla giriş. Servis hesabı parolası şifrelenerek saklanır ve bir daha gösterilmez.', [
      check('LDAP girişini etkinleştir', 'enabled', l.enabled), text('Sunucu adresi', 'url', l.url, { placeholder: 'ldaps://ldap.kurum.edu.tr:636', required: false }), check('StartTLS kullan (ldap:// için)', 'startTls', l.startTls), check('Sertifikayı doğrula', 'rejectUnauthorized', l.rejectUnauthorized !== false),
      text('Servis hesabı (bind DN)', 'bindDn', l.bindDn, { required: false }), text('Servis hesabı parolası', 'bindPassword', '', { type: 'password', autocomplete: 'new-password', required: false, placeholder: l.bindPasswordSet ? '(kayıtlı — değiştirmek için yazın)' : '' }),
      text('Arama tabanı (base DN)', 'baseDn', l.baseDn, { required: false, placeholder: 'ou=people,dc=kurum,dc=edu,dc=tr' }), text('Kullanıcı filtresi', 'userFilter', l.userFilter || '(uid={username})', { required: false }),
      text('Kullanıcı adı özniteliği', 'usernameAttr', l.usernameAttr || 'uid', { required: false }), text('E-posta özniteliği', 'emailAttr', l.emailAttr || 'mail', { required: false }), text('Ad özniteliği', 'nameAttr', l.nameAttr || 'cn', { required: false }), text('Grup özniteliği', 'groupAttr', l.groupAttr || 'memberOf', { required: false }),
      h('label', { class: 'acct-field' }, h('span', {}, 'Varsayılan paket'), select('defaultPlan', [['', 'Sistem varsayılanı'], ...data.plans.map(p => [p.id, p.title])], l.defaultPlan || '', () => {})),
      check('Paketi her girişte gruplardan güncelle', 'syncPlan', l.syncPlan !== false),
      h('label', { class: 'acct-field' }, h('span', {}, 'Grup eşlemeleri'), h('textarea', { name: 'groupMappings', rows: 5, placeholder: 'cn=gold,ou=groups,dc=kurum = gold\ncn=yoneticiler,ou=groups,dc=kurum = admin' }, mappings), h('small', {}, 'Her satır: grup (DN ya da yalnız ad) = paket kodu veya admin. En yüksek paket kazanır.'))],
      async (v, f) => { const body = { ...v, enabled: !!v.enabled, startTls: !!v.startTls, rejectUnauthorized: !!v.rejectUnauthorized, syncPlan: !!v.syncPlan, groupMappings: parseMappings(v.groupMappings || '') }; if (!body.bindPassword) delete body.bindPassword; await api('PUT', '/api/admin/settings/ldap', body); },
      h('div', { class: 'adm-toolbar' }, h('button', { type: 'button', class: 'copy-button btn-secondary', onclick: guard(status, async () => {
        const username = prompt('İsteğe bağlı: bir kullanıcı adıyla da deneyin (boş bırakabilirsiniz):') || '', password = username ? prompt('Bu kullanıcının parolası (kaydedilmez):') || '' : '';
        const r = await api('POST', '/api/admin/settings/ldap/test', { username, password }); dialog('LDAP bağlantı sınaması', h('p', { class: r.ok ? 'acct-message is-ok' : 'acct-message is-error' }, r.ok ? 'Başarılı.' : 'Başarısız.'), h('ul', {}, (r.steps || []).map(step => h('li', {}, `${step.ok ? '✓' : '✗'} ${step.name}${step.detail ? ' — ' + step.detail : ''}`))));
      }) }, 'Bağlantıyı sına (kayıtlı ayarlarla)')));
    const scholarMsg = h('p', { class: 'acct-message', role: 'status', hidden: !scholarNote });
    const showScholar = (text, bad = false) => { scholarNote = { text, bad }; scholarMsg.hidden = false; scholarMsg.textContent = text; scholarMsg.className = 'acct-message ' + (bad ? 'is-error' : 'is-ok'); };
    if (scholarNote) showScholar(scholarNote.text, scholarNote.bad);
    const scholarForm = section('Semantic Scholar (makale arama)', 'Yazım yardımcısında anahtar kelimeyle makale aramak ve açık erişimli PDF\'leri koleksiyona eklemek için. Anahtar şifrelenerek saklanır ve bir daha gösterilmez; kaydederken Semantic Scholar\'a sınanır. Anahtar yoksa ortak ve düşük sınırlı anahtarsız erişim kullanılır.', [
      text('API anahtarı', 'key', '', { type: 'password', autocomplete: 'new-password', required: false, spellcheck: 'false', placeholder: data.scholar?.keySet ? '(kayıtlı: …' + data.scholar.last4 + ' — değiştirmek için yazın)' : data.scholar?.envKey ? '(.env dosyasındaki anahtar kullanılıyor)' : '' })],
      async v => { if (!v.key) throw Error('Kaydetmek için bir API anahtarı yazın.'); const r = await api('PUT', '/api/admin/settings/scholar', { key: v.key }); scholarNote = r.test?.ok ? { text: 'Anahtar sınandı ve kaydedildi: ' + r.test.message, bad: false } : { text: 'Anahtar kaydedildi ancak şu an sınanamadı: ' + r.test?.message, bad: true }; render(); },
      h('div', { class: 'adm-toolbar' }, h('button', { type: 'button', class: 'copy-button btn-secondary', onclick: async event => { const button = event.currentTarget; button.disabled = true; showScholar('Sınanıyor…'); try { const r = await api('POST', '/api/admin/settings/scholar/test'); showScholar((r.ok ? 'Başarılı: ' : 'Başarısız: ') + r.message, !r.ok); } catch (error) { showScholar('Sınama yapılamadı: ' + error.message, true); } finally { button.disabled = false; } } }, 'Kayıtlı anahtarı sına'),
        data.scholar?.keySet ? h('button', { type: 'button', class: 'copy-button btn-secondary', onclick: guard(status, async () => { if (!confirm('Kayıtlı Semantic Scholar anahtarı silinsin mi?')) return; await api('PUT', '/api/admin/settings/scholar', { clear: true }); scholarNote = { text: 'Anahtar silindi.', bad: false }; render(); }) }, 'Anahtarı sil') : null, scholarMsg));
    const emb = (await api('GET', '/api/admin/settings/embedding')).embedding;
    const embedMsg = h('p', { class: 'acct-message', role: 'status', hidden: true });
    const showEmbed = (message, bad = false) => { embedMsg.hidden = false; embedMsg.textContent = message; embedMsg.className = 'acct-message ' + (bad ? 'is-error' : 'is-ok'); };
    const embedBody = f => { const v = Object.fromEntries(new FormData(f)); return { provider: v.provider, url: v.url, model: v.model, queryPrefix: v.queryPrefix, passagePrefix: v.passagePrefix, batch: Number(v.batch) || 8, concurrency: Number(v.concurrency) || 4, timeoutSec: Number(v.timeoutSec) || 60, apiKey: v.apiKey, clearApiKey: !!v.clearApiKey }; };
    const embedForm = section('Embedding (yazım yardımcısı)', 'Kaynak belgelerin anlamsal araması için vektör üretici. "Gemini" mevcut altyapıyı kullanır; "TEI" kendi sunucunuzdaki Text Embeddings Inference konteynerini çağırır. Aynı belge parçası için farklı modellerin vektörleri karşılaştırılamaz: seçimi değiştirdiğinizde daha önce eklenmiş belgeler anahtar kelime aramasıyla aranmaya devam eder; anlamsal arama için onları yeniden ekleyin.', [
      h('label', { class: 'acct-field' }, h('span', {}, 'Sağlayıcı'), select('provider', [['gemini', 'Gemini (API anahtar havuzu)'], ['tei', 'TEI (kendi sunucum)']], emb.provider, () => {})),
      h('label', { class: 'acct-field' }, h('span', {}, 'TEI sunucu adresleri (her satıra bir adres)'), h('textarea', { name: 'url', rows: 3, spellcheck: 'false', placeholder: 'http://TEI_SUNUCU_IP:8082' + String.fromCharCode(10) + 'http://TEI_SUNUCU_IP:8083' }, emb.url)),
      text('Model adı (etiket; önbellek ve kayıtlarda görünür)', 'model', emb.model, { required: false, placeholder: 'multilingual-e5-small', maxlength: 80 }),
      text('Belge parçası öneki', 'passagePrefix', emb.passagePrefix, { required: false, maxlength: 40 }),
      text('Sorgu öneki', 'queryPrefix', emb.queryPrefix, { required: false, maxlength: 40 }),
      text('Parti boyutu (tek istekteki metin sayısı)', 'batch', emb.batch, { type: 'number', min: 1, max: 64 }),
      text('Eşzamanlı istek (sunucu başına)', 'concurrency', emb.concurrency, { type: 'number', min: 1, max: 8 }),
      text('Zaman aşımı (sn)', 'timeoutSec', emb.timeoutSec, { type: 'number', min: 5, max: 600 }),
      text('Erişim anahtarı (TEI --api-key kullanıyorsa; isteğe bağlı)', 'apiKey', '', { type: 'password', autocomplete: 'new-password', required: false, spellcheck: 'false', placeholder: emb.apiKeySet ? '(kayıtlı — değiştirmek için yazın)' : '' }),
      emb.apiKeySet ? check('Kayıtlı erişim anahtarını sil', 'clearApiKey', false) : null,
      h('small', { class: 'acct-muted' }, 'E5 modelleri için önekler "passage: " ve "query: " olmalıdır (sondaki boşluk önemli); BGE-M3 gibi önek istemeyen modellerde ikisini de boşaltın. Birden fazla adres yazarsanız istekler en az meşgul sunucuya dağıtılır, ulaşılamayan sunucu kısa süre atlanır; hepsinde aynı model ve aynı önekler olmalıdır. Adresler, web sunucusundan erişilebilen TEI sunucularının adresleridir (sunucuyu --port 8082 ile başlatın; portu güvenlik duvarıyla yalnız web sunucusuna açın). Bu sağlayıcı seçiliyken kota beklemesi ve belge sırası sınırı yoktur; sunucu gücü sınırdır.'),
      embedMsg].filter(Boolean),
    async (v, f) => { const r = await api('PUT', '/api/admin/settings/embedding', embedBody(f)); showEmbed(r.embedding.provider === 'tei' ? 'TEI etkin: ' + r.embedding.url.split(String.fromCharCode(10)).filter(Boolean).length + ' sunucu.' : 'Gemini kullanılıyor.'); },
    h('div', { class: 'adm-toolbar' }, h('button', { type: 'button', class: 'copy-button btn-secondary', onclick: async event => {
      const button = event.currentTarget, f = button.closest('details').querySelector('form'); button.disabled = true; showEmbed('Sınanıyor…');
      try { const r = await api('POST', '/api/admin/settings/embedding/test', embedBody(f)); showEmbed((r.ok ? 'Başarılı: ' : 'Başarısız: ') + r.message, !r.ok); } catch (error) { showEmbed('Sınama yapılamadı: ' + error.message, true); } finally { button.disabled = false; }
    } }, 'Bağlantıyı sına (kaydetmeden)')));
    const smtpForm = section('E-posta (SMTP)', 'Adres doğrulama ve parola sıfırlama iletileri için.', [
      text('Sunucu', 'host', s.host, { required: false }), text('Port', 'port', s.port || 587, { type: 'number', required: false }), check('Doğrudan TLS (465)', 'secure', s.secure), check('STARTTLS iste', 'requireTls', s.requireTls !== false),
      text('Kullanıcı', 'user', s.user, { required: false }), text('Parola', 'pass', '', { type: 'password', autocomplete: 'new-password', required: false, placeholder: s.passSet ? '(kayıtlı — değiştirmek için yazın)' : '' }),
      text('Gönderen', 'from', s.from, { required: false, placeholder: 'Kaynakça Masası <noreply@kurum.edu.tr>' })],
      async v => { const body = { ...v, port: v.port ? Number(v.port) : 587, secure: !!v.secure, requireTls: !!v.requireTls }; if (!body.pass) delete body.pass; await api('PUT', '/api/admin/settings/smtp', body); },
      h('div', { class: 'adm-toolbar' }, h('button', { type: 'button', class: 'copy-button btn-secondary', onclick: guard(status, async () => {
        const to = prompt('Test iletisi hangi adrese gönderilsin?'); if (!to) return; const r = await api('POST', '/api/admin/settings/smtp/test', { to }); notice(status, r.ok ? 'Test iletisi gönderildi.' : 'Gönderilemedi: ' + r.error, !r.ok);
      }) }, 'Test iletisi gönder')));
    const cacheStats = await api('GET', '/api/admin/cache');
    const CACHE_NAMES = { verification: 'Doğrulanmış kaynak kayıtları', fulltext: 'Yayın tam metinleri', extraction: 'Açık erişimli PDF metinleri', embedding: 'Embedding vektörleri' };
    const mb = bytes => bytes < 1048576 ? Math.round(bytes / 1024) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB';
    const cacheSection = h('details', { class: 'acct-card adm-section', open: true }, h('summary', {}, h('h3', {}, 'Önbellek (herkesin ortak kullandığı genel kayıtlar)')),
      h('p', { class: 'acct-muted' }, 'Daha önce doğrulanmış kaynak kayıtları, edinilmiş yayın metinleri, açık erişimli PDF metinleri ve onların embedding\'leri burada saklanır; aynı sorgu yeniden dış servislere gönderilmez. Kullanıcıların kendi yüklediği belgeler asla buraya konmaz. Önbellekten gelen kaynaklar da kullanıcının paket kotasından düşer. En çok ' + mb(cacheStats.maxBytes) + ' tutulur, dolunca en eski kullanılanlar silinir.' + (cacheStats.enabled ? '' : ' Önbellek şu an kapalı (CACHE_ENABLED=false).')),
      table(['Tür', 'Kayıt', 'Boyut', 'Kullanım (isabet)', ''], cacheStats.kinds.map(k => h('tr', {}, h('td', {}, CACHE_NAMES[k.kind]), h('td', {}, fmt(k.entries)), h('td', {}, mb(k.bytes)), h('td', {}, fmt(k.hits)),
        h('td', {}, h('button', { type: 'button', class: 'text-button', disabled: !k.entries, onclick: guard(status, async () => { if (!confirm(CACHE_NAMES[k.kind] + ' silinsin mi? Bunlar gerektiğinde yeniden sorgulanır.')) return; const r = await api('DELETE', '/api/admin/cache/' + k.kind); notice(status, r.removed + ' kayıt silindi.'); render(); }) }, 'Temizle'))))));
    panel.append(status,
      section('Genel', null, [check('Yeni kayıtlara izin ver', 'registrationOpen', g.registrationOpen), h('label', { class: 'acct-field' }, h('span', {}, 'Yeni hesapların paketi'), select('defaultPlan', [['', 'İlk paket'], ...data.plans.map(p => [p.id, p.title])], g.defaultPlan || '', () => {}))],
        async v => { await api('PUT', '/api/admin/settings/general', { registrationOpen: !!v.registrationOpen, defaultPlan: v.defaultPlan }); }), ldapForm, scholarForm, embedForm, smtpForm, cacheSection);
  }

  const reports = panel => window.AdminReports.mount(panel, { h, fmt, api, table, cards, when, dur });
  const VIEWS = { overview, users, plans, operations, reports, 'llm-keys': llmKeys, prompts, skills, audit, settings };
  async function render() {
    if (!box) return;
    clearInterval(keyTimer);
    box.replaceChildren(h('div', { class: 'acct-wrap acct-wide' }, h('h2', {}, 'Yönetim paneli'),
      h('div', { class: 'adm-tabs', role: 'tablist' }, TABS.map(([key, label]) => h('button', { type: 'button', role: 'tab', class: 'adm-tab', 'aria-selected': String(key === tab), onclick: () => { tab = key; render(); } }, label))),
      h('p', { class: 'acct-muted' }, 'Bu panel yalnızca üst veri gösterir (sayılar, türler, süreler, token ve denetim kaydı); kullanıcıların belgelerini veya yanıtlarını içermez.')));
    const panel = h('div', { class: 'adm-panel', role: 'tabpanel' }); box.firstChild.append(panel);
    try { await VIEWS[tab](panel); } catch (error) { panel.append(h('p', { class: 'acct-message is-error' }, error.message)); }
  }
  window.addEventListener('app-page-change', event => { if (event.detail.page === 'admin') { box = document.getElementById('page-admin'); render(); } });
})();
