/* Writing assistant page. Two views: writing (a project, the collections it uses, questions answered from them, the manuscript editor)
   and source collections (named sets of uploaded PDF/Word sources, managed apart from any project).
   All dynamic text is inserted with textContent or escaped; citations are rendered by WriterCite from the sources' data. */
(() => {
  const $ = id => document.getElementById('wr-' + id);
  if (!$('editor') || !window.WriterCite) return;
  const Cite = window.WriterCite;
  const S = { boot: null, view: 'write', collections: [], collectionId: null, coll: null, projectId: null, data: null, revision: 0, conflict: false, dirty: false, poll: null, saveTimer: null, suggestTimer: null, sourcesSig: '', messagesSig: '', renderLater: false };
  const memory = { get(key) { try { return localStorage.getItem(key); } catch { return null; } }, set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } } };
  const esc = Cite.escapeHtml;
  const Q = { next: null, papers: [], picked: new Set(), added: new Set(), busy: false };   // paper search state
  const planTitle = id => (S.boot?.plans || []).find(plan => plan.id === id)?.title || id;
  const sourcesById = () => Object.fromEntries((S.data?.sources || []).map(source => [source.id, source]));

  async function api(method, path, body, raw) {
    const response = await fetch('/api/writer' + path, { method, headers: method === 'GET' ? {} : { 'x-word-request': '1', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (raw) return response;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(Error(data.error || 'İşlem tamamlanamadı.'), { status: response.status, data });
    return data;
  }
  function say(message, kind = '') {
    const box = $('status');
    box.textContent = message || '';
    box.className = 'status-message' + (kind ? ' wr-' + kind : '');
    // Work in progress (uploading, looking up the künye) shows a spinner before the text.
    if (message && kind === 'busy') { const spin = document.createElement('span'); spin.className = 'wr-spinner'; spin.setAttribute('aria-hidden', 'true'); box.prepend(spin, ' '); }
  }
  const fail = error => say(error.message, error.data?.code === 'plan_limit' ? 'upgrade' : 'error');
  // Two-step destructive buttons: the first click arms, the second confirms.
  function armed(button, action) {
    let timer = null;
    const label = button.textContent;
    button.addEventListener('click', () => {
      if (timer) { clearTimeout(timer); timer = null; button.textContent = label; return action(); }
      button.textContent = 'Emin misiniz? Tekrar tıklayın';
      timer = setTimeout(() => { timer = null; button.textContent = label; }, 4000);
    });
  }
  // Reference text keeps only <em>; any other markup is reduced to its text, then everything is escaped once.
  function safeEmphasis(html) {
    const template = document.createElement('template'); template.innerHTML = String(html || '');
    return [...template.content.childNodes].map(node => node.nodeName === 'EM' ? '<em>' + esc(node.textContent) + '</em>' : esc(node.textContent)).join('');
  }

  // ---- bootstrap and projects
  async function start() {
    try {
      S.boot = await api('GET', '/bootstrap');
      S.collections = S.boot.collections || [];
      renderPlan(); renderSkills(); renderProjectList(); renderCollectionList();
      const remembered = memory.get('wr-collection');
      S.collectionId = S.collections.some(item => item.id === remembered) ? remembered : S.collections[0]?.id || null;
      let id = memory.get('wr-project');
      if (!S.boot.projects.some(project => project.id === id)) id = S.boot.projects[0]?.id;
      if (!id) { id = (await api('POST', '/projects', { title: 'İlk projem' })).project.id; await refreshProjects(); }
      await selectProject(id);
      await applyView();
      if (!S.boot.services.llm) say('LLM servisi yapılandırılmamış; soru sorabilmek için bir LLM anahtarı gerekir.', 'error');
      else if (!S.boot.services.embedding) say('Embedding yapılandırılmamış; kaynaklarda yalnız anahtar kelime araması yapılır.', 'warn');
    } catch (error) { fail(error); }
  }
  function renderPlan() {
    const { plan, usage } = S.boot;
    $('plan').textContent = plan.title + ' paketi';
    $('usage').textContent = `Bugün ${usage.questionsToday}/${usage.limits.questionsPerDay} soru · ${usage.projects}/${usage.limits.projects} proje · belge başına en fazla ${Math.round(usage.limits.documentBytes / 1048576)} MB`;
    $('upload-hint').textContent = `Birden fazla dosya seçebilirsiniz. Koleksiyonda en fazla ${usage.limits.documentsPerProject} belge.`;
  }
  function renderSkills() {
    const select = $('skill'), current = select.value;
    select.innerHTML = '<option value="">Otomatik (soruya göre öner)</option>'
      + S.boot.skills.map(skill => `<option value="${esc(skill.name)}">${esc(skill.title)}</option>`).join('')
      + S.boot.lockedSkills.map(skill => `<option value="" disabled>${esc(skill.title)} — ${esc(planTitle(skill.minPlan))} paket</option>`).join('');
    select.value = [...select.options].some(option => option.value === current) ? current : '';
  }
  function renderProjectList() {
    $('project').innerHTML = S.boot.projects.map(project => `<option value="${esc(project.id)}">${esc(project.title)}</option>`).join('');
    if (S.projectId) $('project').value = S.projectId;
  }
  async function refreshProjects() {
    S.boot.projects = (await api('GET', '/projects')).projects;
    renderProjectList();
  }
  async function selectProject(id) {
    await flushSave();
    clearTimeout(S.poll);
    S.projectId = id; memory.set('wr-project', id);
    S.data = await api('GET', `/projects/${id}`);
    S.revision = S.data.manuscript.revision; S.conflict = false; S.dirty = false; S.sourcesSig = S.messagesSig = '';
    $('editor').innerHTML = S.data.manuscript.html;
    $('saved').textContent = '';
    $('project').value = id;
    renderAll(); schedulePoll();
  }

  // ---- rendering
  function renderLanguage() { if (S.data) $('language').value = S.data.project.language === 'en' ? 'en' : 'tr'; }
  function renderAll() { renderLanguage(); renderPicker(); renderMessages(); refreshCitations(); renderBibliography(); renderUsage(); }
  function renderUsage() {
    if (!S.data) return;
    S.boot.usage = S.data.usage; renderPlan();
    const working = S.data.messages.some(m => m.status === 'working');
    $('ask').disabled = working; $('ask').textContent = working ? 'Yanıt hazırlanıyor…' : 'Sor';
  }
  const TRUST = { verified: ['Künye doğrulandı', 'ok'], confirmed: ['Künye onaylandı', 'ok'], unverified: ['Künye doğrulanmadı', 'warn'] };
  const spinner = label => `<span class="wr-spinner" role="img" aria-label="${esc(label)}"></span>`;
  // What the source is doing right now; a spinner is shown for every kind of background work.
  function sourceWork(source) {
    if (source.status === 'processing') return 'Metin okunuyor ve parçalanıyor…';
    if (source.status === 'embedding') return `Anlamsal arama için hazırlanıyor (embedding)… ${source.embeddedCount}/${source.chunkCount}`;
    if (source.verifying) return 'Künye dizinlerde aranıyor…';
    return '';
  }
  function sourceStatus(source) {
    if (source.status === 'processing') return 'Metin okunuyor ve parçalanıyor…';
    if (source.status === 'embedding') return `Anlamsal arama için hazırlanıyor… ${source.embeddedCount}/${source.chunkCount}`;
    if (source.status === 'error') return source.error || 'İşlenemedi.';
    return `Hazır · ${source.chunkCount} parça${source.pageCount ? ' · ' + source.pageCount + ' sayfa' : ''} · ${source.searchMode === 'semantic' ? 'anlamsal arama' : 'anahtar kelime araması'}`;
  }
  function sourceCard(source) {
    // A badge only for künye the user or an index confirmed; an unconfirmed künye is never demanded.
    const [trustText, trustKind] = TRUST[source.trust] || TRUST.unverified, meta = source.meta || {};
    const badge = source.trust === 'verified' || source.trust === 'confirmed' ? `<span class="wr-badge wr-${trustKind}">${trustText}</span>` : '';
    const field = (name, label, value, area) => `<label class="wr-field">${label}${area ? `<textarea name="${name}" rows="3">${esc(value)}</textarea>` : `<input name="${name}" type="text" value="${esc(value)}">`}</label>`;
    const work = sourceWork(source);
    const warn = source.status === 'ready' && source.error ? `<p class="wr-muted wr-warn-text">${esc(source.error)}</p>` : '';
    return `<article class="wr-source" data-id="${esc(source.id)}">
      <div class="wr-source-head"><strong>${esc(meta.title || source.fileName)}</strong>${badge}</div>
      <p class="wr-muted">${esc(source.fileName)}${['processing', 'embedding'].includes(source.status) ? '' : ' — ' + esc(sourceStatus(source))}</p>${work ? `<p class="wr-work" role="status">${spinner(work)}<span>${esc(work)}</span></p>` : ''}${warn}
      <p class="wr-ref">${esc(source.reference || '')}</p>
      <details><summary>Künyeyi düzenle (isteğe bağlı)</summary><form class="wr-meta" data-id="${esc(source.id)}">
        ${field('title', 'Başlık', meta.title || '')}${field('authors', 'Yazarlar (her satıra bir yazar: Soyad, A.)', (meta.authors || []).join('\n'), true)}
        <div class="wr-row">${field('year', 'Yıl', meta.year || '')}${field('doi', 'DOI', meta.doi || '')}</div>
        ${field('journal', 'Dergi / kitap', meta.journal || '')}
        <div class="wr-row">${field('volume', 'Cilt', meta.volume || '')}${field('issue', 'Sayı', meta.issue || '')}${field('pages', 'Sayfa', meta.pages || '')}</div>
        <div class="wr-row"><button class="copy-button btn-primary" type="submit">Kaydet ve onayla</button><button class="text-button btn-quiet" type="button" data-action="verify"${source.verifying ? ' disabled' : ''}>${source.verifying ? spinner('Aranıyor') + ' ' : ''}Dizinlerde doğrula</button></div>
      </form></details>
      <div class="wr-row">${source.status === 'ready' && source.searchMode === 'keyword' && source.chunkCount ? '<button class="text-button btn-quiet" type="button" data-action="retry">Anlamsal aramayı yeniden dene</button>' : ''}<button class="text-button btn-danger" type="button" data-action="delete">Kaynağı sil</button></div>
    </article>`;
  }
  function renderSources() {
    const sources = S.coll?.sources || [], sig = JSON.stringify(sources);
    if (sig === S.sourcesSig) return;
    // Typing in a künye form is never wiped by a refresh; the render is retried when the field loses focus.
    if ($('sources').contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) { S.renderLater = true; return; }
    S.sourcesSig = sig; S.renderLater = false;
    $('sources').innerHTML = sources.length ? sources.map(sourceCard).join('') : '<p class="wr-muted">Bu koleksiyonda henüz kaynak yok. PDF veya Word dosyası ekleyin.</p>';
  }

  // ---- collections: the chips a project picks from, and the management view
  const countText = (n, word) => `${n} ${word}`;
  function renderPicker() {
    const box = $('picker'), chosen = new Set(S.data?.collectionIds || []);
    if (!S.collections.length) {
      box.innerHTML = '<p class="wr-muted">Henüz koleksiyonunuz yok. Kaynaklarınızı bir koleksiyonda toplayın, sonra burada seçin.</p><a class="copy-button btn-primary wr-cta" href="#/yazim/koleksiyonlar">İlk koleksiyonu oluştur</a>';
      $('picker-hint').textContent = '';
      return;
    }
    box.innerHTML = S.collections.map(item => `<label class="wr-chip${chosen.has(item.id) ? ' wr-chip-on' : ''}"><input type="checkbox" value="${esc(item.id)}"${chosen.has(item.id) ? ' checked' : ''}><span class="wr-chip-name">${esc(item.name)}</span><span class="wr-chip-meta">${esc(countText(item.documents, 'kaynak'))}</span></label>`).join('');
    const sources = S.data?.sources || [], ready = sources.filter(source => source.status === 'ready').length, working = sources.filter(source => ['processing', 'embedding'].includes(source.status) || source.verifying).length;
    $('picker-hint').dataset.busy = working ? '1' : '';
    $('picker-hint').textContent = !chosen.size ? 'Soru sorabilmek için en az bir koleksiyon seçin; birden fazla seçebilirsiniz.'
      : `${chosen.size} koleksiyon seçili · ${ready} kaynak hazır${working ? ` · ${working} kaynak hazırlanıyor` : ''}. Seçimi kaldırırsanız o kaynaklara yapılan atıflar “silinmiş kaynak” görünür.`;
  }
  function renderCollectionList() {
    $('collections-count').textContent = S.collections.length || '';
    $('collection-items').innerHTML = S.collections.map(item => `<li><button type="button" class="wr-collection-item${item.id === S.collectionId ? ' wr-active' : ''}" data-id="${esc(item.id)}"><strong>${esc(item.name)}</strong><span class="wr-muted">${esc(countText(item.documents, 'kaynak'))} · ${esc(countText(item.projects, 'projede'))}</span></button></li>`).join('')
      || '<li class="wr-muted">Henüz koleksiyon yok.</li>';
  }
  function renderCollectionDetail() {
    const has = !!(S.coll && S.collectionId);
    $('collection-empty').hidden = has; $('collection-body').hidden = !has;
    if (!has) { S.sourcesSig = ''; return; }
    $('collection-title').textContent = S.coll.collection.name;
    renderSources();
  }
  async function refreshCollections() {
    S.collections = (await api('GET', '/collections')).collections;
    if (!S.collections.some(item => item.id === S.collectionId)) { S.collectionId = S.collections[0]?.id || null; S.coll = null; }
    renderCollectionList(); renderPicker();
  }
  async function selectCollection(id) {
    S.collectionId = id; memory.set('wr-collection', id || '');
    S.coll = id ? await api('GET', `/collections/${id}`) : null;
    S.sourcesSig = '';
    $('collection-rename-form').hidden = true;
    renderCollectionList(); renderCollectionDetail(); resetSearch();
  }
  // Switching between the two views: the collections view is refreshed when opened, the writing view re-reads the project (its sources follow the collections).
  async function applyView() {
    S.view = location.hash.startsWith('#/yazim/koleksiyonlar') ? 'collections' : 'write';
    $('view-write').hidden = S.view !== 'write'; $('view-collections').hidden = S.view !== 'collections';
    for (const [name, id] of [['write', 'tab-write'], ['collections', 'tab-collections']]) { if (S.view === name) $(id).setAttribute('aria-current', 'page'); else $(id).removeAttribute('aria-current'); }
    clearTimeout(S.poll);
    try {
      if (S.view === 'collections') { await refreshCollections(); await selectCollection(S.collectionId); }
      else if (S.projectId) { await flushSave(); await refreshCollections(); await reload(); }
    } catch (error) { fail(error); }
    schedulePoll();
  }
  function paragraphs(text) {
    const fragment = document.createDocumentFragment();
    for (const block of String(text).split(/\n{2,}/)) {
      const p = document.createElement('p'); p.textContent = block.trim(); if (p.textContent) fragment.append(p);
    }
    return fragment;
  }
  const skillTitle = name => [...S.boot.skills, ...S.boot.lockedSkills].find(skill => skill.name === name)?.title || '';
  function messageNode(message, byId) {
    const node = document.createElement('article');
    node.className = 'wr-msg wr-' + message.role; node.dataset.id = message.id;
    const meta = document.createElement('div'); meta.className = 'wr-msg-meta';
    meta.textContent = (message.role === 'user' ? 'Siz' : 'Asistan') + (message.skill && skillTitle(message.skill) ? ' · ' + skillTitle(message.skill) : '');
    node.append(meta);
    if (message.role === 'user') {
      const p = document.createElement('p'); p.textContent = message.raw; node.append(p);
      const actions = document.createElement('div'); actions.className = 'wr-row';
      actions.innerHTML = '<button class="text-button btn-quiet" type="button" data-action="reask">Tekrar sor</button><button class="text-button btn-quiet" type="button" data-action="copy-question">Kopyala</button>';
      node.append(actions);
      return node;
    }
    if (message.status === 'working') { const p = document.createElement('p'); p.className = 'wr-muted'; p.textContent = message.note || 'Yanıt hazırlanıyor…'; node.append(p); return node; }
    if (message.status === 'error') {
      const p = document.createElement('p'); p.className = 'wr-error-text'; p.textContent = message.error || 'Yanıt üretilemedi.'; node.append(p);
      return node;
    }
    const body = document.createElement('div'); body.className = 'wr-answer';
    body.append(paragraphs(Cite.renderText(message.raw, byId, message.lang))); node.append(body);
    if (message.insufficient) { const p = document.createElement('p'); p.className = 'wr-warn-text'; p.textContent = 'Kaynaklarda bu soru için yeterli bilgi bulunamadı.'; node.append(p); }
    if (message.warning) { const p = document.createElement('p'); p.className = 'wr-warn-text'; p.textContent = message.warning; node.append(p); }
    const actions = document.createElement('div'); actions.className = 'wr-row';
    actions.innerHTML = '<button class="copy-button btn-primary" type="button" data-action="insert">Editöre ekle</button><button class="text-button btn-quiet" type="button" data-action="copy">Kopyala</button>';
    node.append(actions);
    return node;
  }
  function renderMessages() {
    const messages = S.data.messages, byId = sourcesById();
    const sig = JSON.stringify(messages) + JSON.stringify(S.data.sources.map(source => [source.id, source.meta]));
    if (sig === S.messagesSig) return;
    S.messagesSig = sig;
    const box = $('messages'), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.replaceChildren(...(messages.length ? messages.map(message => messageNode(message, byId)) : [Object.assign(document.createElement('p'), { className: 'wr-muted wr-empty', textContent: 'Seçtiğiniz koleksiyonlardaki kaynaklara bir soru sorun; cevap atıflarla birlikte gelir ve isterseniz makalenize eklersiniz.' })]));
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  // ---- editor
  function citeSpan(refs, lang) {
    return `<span class="cite" data-cite="${esc(refs)}" data-lang="${lang === 'en' ? 'en' : 'tr'}" contenteditable="false">${esc(Cite.renderGroup(Cite.parseRefs(refs), sourcesById(), lang).text)}</span>`;
  }
  function answerHtml(message) {
    return String(message.raw).split(/\n{2,}/).map(block => block.trim()).filter(Boolean)
      .map(block => '<p>' + esc(block).replace(Cite.TOKEN, (_, refs) => citeSpan(refs, message.lang)).replace(/\n/g, '<br>') + '</p>').join('');
  }
  function insertIntoEditor(html) {
    const editor = $('editor'), selection = getSelection();
    const template = document.createElement('template'); template.innerHTML = html;
    let anchor = selection.rangeCount && editor.contains(selection.anchorNode) ? selection.anchorNode : null;
    while (anchor && anchor.parentNode !== editor) anchor = anchor.parentNode;
    editor.insertBefore(template.content, anchor ? anchor.nextSibling : null);
    editor.focus(); changed();
  }
  function refreshCitations() {
    const byId = sourcesById();
    for (const span of $('editor').querySelectorAll('span.cite')) {
      const text = Cite.renderGroup(Cite.parseRefs(span.dataset.cite), byId, span.dataset.lang).text;
      if (text && span.textContent !== text) span.textContent = text;
    }
  }
  function renderBibliography() {
    const byId = sourcesById(), ids = [];
    for (const span of $('editor').querySelectorAll('span.cite')) for (const ref of Cite.parseRefs(span.dataset.cite)) if (!ids.includes(ref.docId)) ids.push(ref.docId);
    const entries = ids.map(id => byId[id]).filter(Boolean).map(source => ({ source, entry: Cite.referenceEntry(source) })).sort((a, b) => a.entry.text.localeCompare(b.entry.text, 'tr'));
    $('bib-count').textContent = entries.length;
    $('bib').innerHTML = entries.map(({ source, entry }) => { const [text, kind] = TRUST[source.trust] || TRUST.unverified; return `<li>${safeEmphasis(entry.html)} <span class="wr-badge wr-${kind}">${text}</span></li>`; }).join('') || '<li class="wr-muted">Metne atıf eklendiğinde kaynaklar burada listelenir.</li>';
  }
  function insertBibliography() {
    const byId = sourcesById(), ids = [...new Set([...$('editor').querySelectorAll('span.cite')].flatMap(span => Cite.parseRefs(span.dataset.cite).map(ref => ref.docId)))];
    const entries = ids.map(id => byId[id]).filter(Boolean).map(source => Cite.referenceEntry(source)).sort((a, b) => a.text.localeCompare(b.text, 'tr'));
    if (!entries.length) return say('Önce metne kaynaklı bir cevap ekleyin.', 'warn');
    $('editor').querySelector('[data-bibliography]')?.remove();
    const block = document.createElement('div'); block.dataset.bibliography = '1';
    block.innerHTML = '<h1>Kaynakça</h1>' + entries.map(entry => `<p class="ref">${safeEmphasis(entry.html)}</p>`).join('');
    $('editor').append(block); changed();
  }
  const COMMANDS = { h1: ['formatBlock', 'h1'], h2: ['formatBlock', 'h2'], h3: ['formatBlock', 'h3'], p: ['formatBlock', 'p'], bold: ['bold'], italic: ['italic'], ul: ['insertUnorderedList'], ol: ['insertOrderedList'] };

  // ---- saving the manuscript
  function changed() { S.dirty = true; $('saved').textContent = 'Kaydedilmedi…'; clearTimeout(S.saveTimer); S.saveTimer = setTimeout(save, 1200); renderBibliography(); }
  async function save() {
    clearTimeout(S.saveTimer);
    if (!S.dirty || S.conflict || !S.projectId) return;
    const html = $('editor').innerHTML;
    try {
      const saved = await api('PUT', `/projects/${S.projectId}/manuscript`, { html, revision: S.revision });
      S.revision = saved.revision;
      if ($('editor').innerHTML === html) { S.dirty = false; $('saved').textContent = 'Kaydedildi'; }
      else S.saveTimer = setTimeout(save, 300);
    } catch (error) {
      if (error.status === 409) { S.conflict = true; $('saved').textContent = ''; say('Makale başka bir pencerede değişti; kaydetmek için sayfayı yenileyin.', 'error'); }
      else { $('saved').textContent = 'Kaydedilemedi: ' + error.message; S.saveTimer = setTimeout(save, 5000); }
    }
  }
  const flushSave = () => S.dirty ? save() : Promise.resolve();

  // ---- polling while something is being prepared
  function busy() {
    const working = list => (list || []).some(source => ['processing', 'embedding'].includes(source.status) || source.verifying);
    return S.view === 'collections' ? working(S.coll?.sources) : working(S.data?.sources) || S.data.messages.some(message => message.status === 'working');
  }
  function schedulePoll() {
    clearTimeout(S.poll);
    if (!S.data || !busy()) return;
    S.poll = setTimeout(async () => { try { await reload(); } catch { /* retried below */ } schedulePoll(); }, 1500);
  }
  async function reload() {
    if (S.view === 'collections') {
      if (S.collectionId) S.coll = await api('GET', `/collections/${S.collectionId}`);
      await refreshCollections(); renderCollectionDetail();
      return;
    }
    const data = await api('GET', `/projects/${S.projectId}`);
    S.data = { ...data, manuscript: S.data.manuscript };
    renderAll();
  }

  // ---- events
  $('project').addEventListener('change', event => selectProject(event.target.value).catch(fail));
  function titleForm(initial, onSave) {
    const form = $('title-form'), input = $('title-input');
    form.hidden = false; input.value = initial; input.focus();
    form.onsubmit = async event => { event.preventDefault(); try { await onSave(input.value); form.hidden = true; } catch (error) { fail(error); } };
  }
  $('title-cancel').addEventListener('click', () => { $('title-form').hidden = true; });
  $('new').addEventListener('click', () => titleForm('', async value => { const { project } = await api('POST', '/projects', { title: value }); await refreshProjects(); await selectProject(project.id); say(''); }));
  $('rename').addEventListener('click', () => titleForm(S.data.project.title, async value => { await api('PATCH', `/projects/${S.projectId}`, { title: value }); S.data.project.title = value.trim(); await refreshProjects(); }));
  armed($('delete'), async () => {
    try {
      await api('DELETE', `/projects/${S.projectId}`); await refreshProjects();
      const next = S.boot.projects[0]?.id || (await api('POST', '/projects', { title: 'İlk projem' }).then(result => (refreshProjects(), result.project.id)));
      S.dirty = false; await selectProject(next); say('Proje silindi.');
    } catch (error) { fail(error); }
  });
  // The article language decides the language of every answer, whatever language the question is asked in.
  $('language').addEventListener('change', async event => {
    const language = event.target.value;
    try { await api('PATCH', `/projects/${S.projectId}`, { language }); S.data.project.language = language; say(language === 'en' ? 'Cevaplar artık İngilizce yazılacak.' : 'Cevaplar artık Türkçe yazılacak.', 'ok'); }
    catch (error) { fail(error); renderLanguage(); }
  });
  $('picker').addEventListener('change', async () => {
    const ids = [...$('picker').querySelectorAll('input:checked')].map(input => input.value), boxes = $('picker').querySelectorAll('input');
    boxes.forEach(input => { input.disabled = true; });
    try { await api('PUT', `/projects/${S.projectId}/collections`, { ids }); S.data.collectionIds = ids; await reload(); schedulePoll(); say(''); }
    catch (error) { fail(error); await reload().catch(() => {}); }
  });
  $('collection-new').addEventListener('submit', async event => {
    event.preventDefault();
    const input = $('collection-name'), name = input.value.trim(), keywords = $('collection-keywords').value.trim(); if (!name) return;
    try {
      const { collection } = await api('POST', '/collections', { name }); input.value = ''; $('collection-keywords').value = ''; await refreshCollections(); await selectCollection(collection.id);
      say(`“${collection.name}” koleksiyonu oluşturuldu; şimdi kaynak ekleyin.`, 'ok');
      // Keywords given while creating start the paper search straight away.
      if (keywords) { $('search').open = true; $('search-q').value = keywords; runSearch(false); }
    }
    catch (error) { fail(error); }
  });
  $('collection-items').addEventListener('click', event => {
    const button = event.target.closest('button[data-id]'); if (!button) return;
    selectCollection(button.dataset.id).then(schedulePoll).catch(fail);
  });
  $('collection-rename').addEventListener('click', () => { const form = $('collection-rename-form'); form.hidden = false; $('collection-rename-input').value = S.coll.collection.name; $('collection-rename-input').focus(); });
  $('collection-rename-cancel').addEventListener('click', () => { $('collection-rename-form').hidden = true; });
  $('collection-rename-form').addEventListener('submit', async event => {
    event.preventDefault();
    try { S.coll = await api('PATCH', `/collections/${S.collectionId}`, { name: $('collection-rename-input').value }); $('collection-rename-form').hidden = true; await refreshCollections(); renderCollectionDetail(); }
    catch (error) { fail(error); }
  });
  armed($('collection-delete'), async () => {
    try {
      await api('DELETE', `/collections/${S.collectionId}`); S.collectionId = null; S.coll = null; memory.set('wr-collection', '');
      await refreshCollections(); await selectCollection(S.collectionId); say('Koleksiyon ve kaynakları silindi.');
    } catch (error) { fail(error); }
  });
  window.addEventListener('hashchange', () => { if (started && location.hash.startsWith('#/yazim')) { say(''); applyView(); } });
  // ---- paper search (Semantic Scholar): results are only metadata; the server downloads the chosen open-access PDFs
  const paperLine = p => [(p.authors || []).slice(0, 3).join('; ') + ((p.authors || []).length > 3 ? ' ve ark.' : ''), p.year, p.venue, p.citations ? p.citations + ' atıf' : ''].filter(Boolean).join(' · ');
  function paperHtml(p) {
    const added = Q.added.has(p.paperId), doi = p.doi ? ` · <a href="https://doi.org/${encodeURI(p.doi)}" target="_blank" rel="noopener noreferrer">DOI</a>` : '';
    return `<li class="wr-paper"><label class="wr-paper-pick"><input type="checkbox" data-paper="${esc(p.paperId)}"${p.pdf && !added ? '' : ' disabled'}${Q.picked.has(p.paperId) ? ' checked' : ''}><span class="wr-paper-main"><strong>${esc(p.title || '(başlıksız)')}</strong><span class="wr-muted">${esc(paperLine(p))}${doi}</span></span></label>
      <span class="wr-paper-side">${added ? '<span class="wr-badge wr-ok">Eklendi</span>' : p.pdf ? `<span class="wr-badge wr-ok">PDF var</span><button type="button" class="text-button" data-add="${esc(p.paperId)}">Ekle</button>` : '<span class="wr-badge wr-warn">PDF yok</span>'}</span></li>`;
  }
  function renderSearch() {
    $('search-results').innerHTML = Q.papers.map(paperHtml).join('');
    const importable = Q.papers.filter(p => p.pdf && !Q.added.has(p.paperId));
    $('search-actions').hidden = !Q.papers.length; $('search-more').hidden = Q.next == null;
    $('search-all').checked = !!importable.length && importable.every(p => Q.picked.has(p.paperId));
    syncSearchButtons();
  }
  function syncSearchButtons() {
    const picked = Q.picked.size;
    $('search-import').disabled = !picked || Q.busy; $('search-import').textContent = picked ? `Seçilenleri koleksiyona ekle (${picked})` : 'Seçilenleri koleksiyona ekle';
    for (const button of $('search-results').querySelectorAll('button[data-add]')) button.disabled = Q.busy;
  }
  function resetSearch() { Q.next = null; Q.papers = []; Q.picked.clear(); Q.added.clear(); $('search-results').innerHTML = ''; $('search-note').textContent = ''; $('search-actions').hidden = true; $('search-more').hidden = true; }
  async function runSearch(more) {
    const query = $('search-q').value.trim();
    if (!query) { $('search-note').textContent = 'Aramak için anahtar kelime yazın.'; return; }
    if (!more) { Q.papers = []; Q.picked.clear(); Q.next = null; $('search-results').innerHTML = ''; }
    $('search-note').textContent = 'Semantic Scholar’da aranıyor…';
    try {
      const found = await api('GET', `/scholar/search?q=${encodeURIComponent(query)}&offset=${more ? Q.next || 0 : 0}${$('search-oa').checked ? '' : '&all=1'}`);
      Q.papers = more ? Q.papers.concat(found.papers) : found.papers; Q.next = found.next;
      const withPdf = Q.papers.filter(p => p.pdf).length;
      $('search-note').textContent = found.papers.length || more ? `${Number(found.total).toLocaleString('tr-TR')} sonuç; listelenen ${Q.papers.length} makalenin ${withPdf}’inde açık erişimli PDF var.${found.keyed ? '' : ' Not: Semantic Scholar API anahtarı tanımlı değil; arama düşük ortak sınırla çalışır.'}` : 'Sonuç bulunamadı; anahtar kelimeleri değiştirin veya PDF süzgecini kapatın.';
      renderSearch();
    } catch (error) { $('search-note').textContent = error.message; }
  }
  async function importPapers(ids) {
    Q.busy = true; syncSearchButtons();
    try {
      const skipped = []; let added = 0;
      for (let i = 0; i < ids.length; i += 25) {
        say(`${ids.length} makale indirilmeye hazırlanıyor…`, 'busy');
        const result = await api('POST', `/collections/${S.collectionId}/import`, { paperIds: ids.slice(i, i + 25) });
        added += result.added.length; skipped.push(...result.skipped);
        for (const source of result.added) if (source.meta?.scholarId) Q.added.add(source.meta.scholarId);
        for (const item of result.skipped) if (/Zaten/.test(item.reason)) Q.added.add(item.paperId);
      }
      for (const id of ids) Q.picked.delete(id);
      say(`${added} makale indiriliyor ve işleniyor.${skipped.length ? ' Eklenemeyenler: ' + skipped.map(s => `${s.title.slice(0, 50)} (${s.reason})`).join('; ') : ''}`, skipped.length && !added ? 'error' : 'ok');
    } catch (error) { fail(error); }
    Q.busy = false; renderSearch();
    try { await reload(); schedulePoll(); } catch { /* the next poll retries */ }
  }
  $('search-form').addEventListener('submit', event => { event.preventDefault(); runSearch(false); });
  $('search-oa').addEventListener('change', () => { if ($('search-q').value.trim()) runSearch(false); });
  $('search-more').addEventListener('click', () => runSearch(true));
  $('search-results').addEventListener('change', event => {
    const box = event.target.closest('input[data-paper]'); if (!box) return;
    if (box.checked) Q.picked.add(box.dataset.paper); else Q.picked.delete(box.dataset.paper);
    $('search-all').checked = Q.papers.filter(p => p.pdf && !Q.added.has(p.paperId)).every(p => Q.picked.has(p.paperId)); syncSearchButtons();
  });
  $('search-results').addEventListener('click', event => { const button = event.target.closest('button[data-add]'); if (button) importPapers([button.dataset.add]); });
  $('search-all').addEventListener('change', event => {
    for (const p of Q.papers) if (p.pdf && !Q.added.has(p.paperId)) { if (event.target.checked) Q.picked.add(p.paperId); else Q.picked.delete(p.paperId); }
    renderSearch();
  });
  $('search-import').addEventListener('click', () => importPapers([...Q.picked]));
  const toBase64 = file => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = () => reject(Error('Dosya okunamadı.')); reader.readAsDataURL(file); });
  $('upload').addEventListener('change', async event => {
    const files = [...event.target.files]; event.target.value = '';
    const limit = S.boot.usage.limits.documentBytes;
    for (const file of files) {
      if (file.size > limit) { say(`${file.name}: dosya en fazla ${Math.round(limit / 1048576)} MB olabilir.`, 'error'); continue; }
      try { say(`${file.name} yükleniyor…`, 'busy'); await api('POST', `/collections/${S.collectionId}/sources`, { name: file.name, data: await toBase64(file) }); say(''); }
      catch (error) { fail(error); if (error.data?.code === 'plan_limit') break; }
    }
    await reload(); schedulePoll();
  });
  $('sources').addEventListener('focusout', () => { if (S.renderLater) setTimeout(() => { if (!$('sources').contains(document.activeElement)) { S.sourcesSig = ''; renderSources(); } }, 50); });
  $('sources').addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]'); if (!button) return;
    const id = button.closest('[data-id]').dataset.id, base = `/collections/${S.collectionId}/sources/${id}`;
    try {
      if (button.dataset.action === 'delete') {
        if (button.dataset.armed !== '1') { button.dataset.armed = '1'; button.textContent = 'Emin misiniz? Tekrar tıklayın'; setTimeout(() => { button.dataset.armed = ''; button.textContent = 'Kaynağı sil'; }, 4000); return; }
        await api('DELETE', base); await reload();
      } else if (button.dataset.action === 'retry') { await api('POST', base + '/retry', {}); await reload(); schedulePoll(); }
      else if (button.dataset.action === 'verify') {
        const form = button.closest('form'); await api('PATCH', base, formValues(form)); await api('POST', base + '/verify', {});
        say('Künye dizinlerde aranıyor; sonuç birkaç saniye içinde görünür.', 'busy'); S.sourcesSig = ''; await reload(); schedulePoll();
      }
    } catch (error) { fail(error); }
  });
  const formValues = form => Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, String(value)]));
  $('sources').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target, id = form.dataset.id;
    try { await api('PATCH', `/collections/${S.collectionId}/sources/${id}`, formValues(form)); say('Künye kaydedildi; atıflar ve kaynakça güncellendi.', 'ok'); S.sourcesSig = ''; await reload(); }
    catch (error) { fail(error); }
  });

  $('messages').addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]'); if (!button) return;
    const message = S.data.messages.find(m => m.id === button.closest('[data-id]').dataset.id); if (!message) return;
    if (button.dataset.action === 'reask') {
      const question = $('question'); question.value = message.raw;
      if (message.skill && [...$('skill').options].some(option => option.value === message.skill)) $('skill').value = message.skill;
      question.dispatchEvent(new Event('input')); question.focus(); question.setSelectionRange(question.value.length, question.value.length);
      say('Prompt giriş kutusuna alındı; düzenleyip Sor ile gönderebilirsiniz.', 'ok');
    }
    if (button.dataset.action === 'copy-question') { try { await navigator.clipboard.writeText(message.raw); say('Prompt kopyalandı.', 'ok'); } catch { say('Kopyalanamadı.', 'error'); } }
    if (button.dataset.action === 'insert') { insertIntoEditor(answerHtml(message)); say('Cevap makaleye eklendi.', 'ok'); }
    if (button.dataset.action === 'copy') { try { await navigator.clipboard.writeText(Cite.renderText(message.raw, sourcesById(), message.lang)); say('Cevap kopyalandı.', 'ok'); } catch { say('Kopyalanamadı.', 'error'); } }
  });
  $('form').addEventListener('submit', async event => {
    event.preventDefault();
    const question = $('question').value.trim();
    if (!question || $('ask').disabled) return;
    try {
      await api('POST', `/projects/${S.projectId}/ask`, { question, skill: $('skill').value || undefined, useManuscript: $('use-draft').checked });
      $('question').value = ''; $('suggestion').hidden = true; say('');
      await reload(); schedulePoll();
      const box = $('messages'); box.scrollTop = box.scrollHeight;
    } catch (error) { fail(error); }
  });
  $('question').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('form').requestSubmit(); } });
  $('question').addEventListener('input', () => {
    clearTimeout(S.suggestTimer);
    const text = $('question').value.trim(), hint = $('suggestion');
    if (text.length < 8 || $('skill').value) { hint.hidden = true; return; }
    S.suggestTimer = setTimeout(async () => {
      try { const { skill } = await api('GET', '/suggest?q=' + encodeURIComponent(text)); hint.hidden = !skill; if (skill) hint.textContent = 'Otomatik seçimde kullanılacak skill: ' + skillTitle(skill); } catch { hint.hidden = true; }
    }, 500);
  });
  // The skill's input form is put into the question box; it replaces only an empty box or the previous, untouched form.
  const skillTemplate = name => [...S.boot.skills].find(skill => skill.name === name)?.inputTemplate || '';
  let appliedTemplate = '';
  $('skill').addEventListener('change', () => {
    $('suggestion').hidden = true;
    const question = $('question'), next = skillTemplate($('skill').value);
    if (question.value.trim() && question.value !== appliedTemplate) return;
    question.value = next; appliedTemplate = next;
    if (next) { question.focus(); question.setSelectionRange(next.length, next.length); }
  });
  armed($('clear'), async () => { try { await api('DELETE', `/projects/${S.projectId}/messages`); await reload(); } catch (error) { fail(error); } });

  const editor = $('editor');
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* optional */ }
  editor.addEventListener('input', changed);
  // Pasted text enters as plain text: no foreign markup, styles or scripts reach the manuscript.
  editor.addEventListener('paste', event => { event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain')); });
  editor.addEventListener('drop', event => event.preventDefault());
  document.querySelector('.wr-toolbar').addEventListener('mousedown', event => event.preventDefault());
  document.querySelector('.wr-toolbar').addEventListener('click', event => {
    const command = COMMANDS[event.target.closest('[data-wr-cmd]')?.dataset.wrCmd]; if (!command) return;
    editor.focus(); document.execCommand(command[0], false, command[1] ? '<' + command[1] + '>' : null); changed();
  });
  $('bib-insert').addEventListener('click', insertBibliography);
  $('download').addEventListener('click', async () => {
    try {
      await flushSave();
      const response = await api('GET', `/projects/${S.projectId}/manuscript.docx`, undefined, true);
      if (!response.ok) throw Error((await response.json().catch(() => ({}))).error || 'Dosya indirilemedi.');
      const url = URL.createObjectURL(await response.blob()), link = Object.assign(document.createElement('a'), { href: url, download: (S.data.project.title || 'makale').replace(/[\\/:*?"<>|]+/g, ' ').trim() + '.docx' });
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (error) { fail(error); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });

  // Plan, limits, usage and the skills the plan unlocks follow the server: refreshed every five minutes while the page is
  // visible, and when the tab comes back after being hidden longer than that.
  const BOOT_REFRESH_MS = 5 * 60 * 1000;
  let bootAt = Date.now();
  async function refreshBoot() {
    if (!S.boot || document.hidden || !location.hash.startsWith('#/yazim')) return;
    try {
      const fresh = await api('GET', '/bootstrap');
      bootAt = Date.now();
      S.boot = fresh; S.collections = fresh.collections || S.collections;
      renderPlan(); renderSkills(); renderProjectList(); renderCollectionList(); if (S.data) renderPicker();
    } catch { /* tried again at the next interval */ }
  }
  setInterval(refreshBoot, BOOT_REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - bootAt >= BOOT_REFRESH_MS) refreshBoot(); });

  let started = false;
  const begin = () => { if (!started) { started = true; start(); } };
  window.addEventListener('app-page-change', event => { if (event.detail.page === 'yazim') begin(); });
  if (window.AppPages?.current?.() === 'yazim' || location.hash.startsWith('#/yazim')) begin();
  window.WriterApp = { state: S, citeSpan, answerHtml };
})();
