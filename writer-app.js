/* Writing assistant page: projects, uploaded sources, questions answered from them, and the manuscript editor.
   All dynamic text is inserted with textContent or escaped; citations are rendered by WriterCite from the sources' data. */
(() => {
  const $ = id => document.getElementById('wr-' + id);
  if (!$('editor') || !window.WriterCite) return;
  const Cite = window.WriterCite;
  const S = { boot: null, projectId: null, data: null, revision: 0, conflict: false, dirty: false, poll: null, saveTimer: null, suggestTimer: null, sourcesSig: '', messagesSig: '', renderLater: false };
  const memory = { get(key) { try { return localStorage.getItem(key); } catch { return null; } }, set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } } };
  const esc = Cite.escapeHtml;
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
      renderPlan(); renderSkills(); renderProjectList();
      $('consent').checked = memory.get('wr-consent') === '1';
      $('upload').disabled = !$('consent').checked;
      let id = memory.get('wr-project');
      if (!S.boot.projects.some(project => project.id === id)) id = S.boot.projects[0]?.id;
      if (!id) { id = (await api('POST', '/projects', { title: 'İlk projem' })).project.id; await refreshProjects(); }
      await selectProject(id);
      if (!S.boot.services.llm) say('LLM servisi yapılandırılmamış; soru sorabilmek için bir LLM anahtarı gerekir.', 'error');
      else if (!S.boot.services.embedding) say('Embedding yapılandırılmamış; kaynaklarda yalnız anahtar kelime araması yapılır.', 'warn');
    } catch (error) { fail(error); }
  }
  function renderPlan() {
    const { plan, usage } = S.boot;
    $('plan').textContent = plan.title + ' paketi';
    $('usage').textContent = `Bugün ${usage.questionsToday}/${usage.limits.questionsPerDay} soru · ${usage.projects}/${usage.limits.projects} proje · belge başına en fazla ${Math.round(usage.limits.documentBytes / 1048576)} MB`;
    $('upload-hint').textContent = `Birden fazla dosya seçebilirsiniz. Projede en fazla ${usage.limits.documentsPerProject} belge.`;
  }
  function renderSkills() {
    const select = $('skill'), current = select.value;
    select.innerHTML = '<option value="">Otomatik (soruya göre öner)</option>'
      + S.boot.skills.map(skill => `<option value="${esc(skill.name)}">${esc(skill.title)}</option>`).join('')
      + S.boot.lockedSkills.map(skill => `<option value="" disabled>${esc(skill.title)} — ${esc(planTitle(skill.minPlan))} paket</option>`).join('');
    select.value = [...select.options].some(option => option.value === current) ? current : '';
  }
  function renderProjectList() {
    $('project').innerHTML = S.boot.projects.map(project => `<option value="${esc(project.id)}">${esc(project.title)} (${project.documents})</option>`).join('');
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
  function renderAll() { renderSources(); renderMessages(); renderBibliography(); renderUsage(); }
  function renderUsage() {
    if (!S.data) return;
    S.boot.usage = S.data.usage; renderPlan();
    const working = S.data.messages.some(m => m.status === 'working');
    $('ask').disabled = working; $('ask').textContent = working ? 'Yanıt hazırlanıyor…' : 'Sor';
  }
  const TRUST = { verified: ['Künye doğrulandı', 'ok'], confirmed: ['Künye onaylandı', 'ok'], unverified: ['Künye doğrulanmadı', 'warn'] };
  function sourceStatus(source) {
    if (source.status === 'processing') return 'Metin okunuyor ve parçalanıyor…';
    if (source.status === 'embedding') return `Anlamsal arama için hazırlanıyor… ${source.embeddedCount}/${source.chunkCount}`;
    if (source.status === 'error') return source.error || 'İşlenemedi.';
    return `Hazır · ${source.chunkCount} parça${source.pageCount ? ' · ' + source.pageCount + ' sayfa' : ''} · ${source.searchMode === 'semantic' ? 'anlamsal arama' : 'anahtar kelime araması'}`;
  }
  function sourceCard(source) {
    const [trustText, trustKind] = TRUST[source.trust] || TRUST.unverified, meta = source.meta || {};
    const field = (name, label, value, area) => `<label class="wr-field">${label}${area ? `<textarea name="${name}" rows="3">${esc(value)}</textarea>` : `<input name="${name}" type="text" value="${esc(value)}">`}</label>`;
    const warn = source.status === 'ready' && source.error ? `<p class="wr-muted wr-warn-text">${esc(source.error)}</p>` : '';
    return `<article class="wr-source" data-id="${esc(source.id)}">
      <div class="wr-source-head"><strong>${esc(meta.title || source.fileName)}</strong><span class="wr-badge wr-${trustKind}">${trustText}</span></div>
      <p class="wr-muted">${esc(source.fileName)} — ${esc(sourceStatus(source))}</p>${warn}
      <p class="wr-ref">${esc(source.reference || '')}</p>
      <details><summary>Künyeyi düzenle</summary><form class="wr-meta" data-id="${esc(source.id)}">
        ${field('title', 'Başlık', meta.title || '')}${field('authors', 'Yazarlar (her satıra bir yazar: Soyad, A.)', (meta.authors || []).join('\n'), true)}
        <div class="wr-row">${field('year', 'Yıl', meta.year || '')}${field('doi', 'DOI', meta.doi || '')}</div>
        ${field('journal', 'Dergi / kitap', meta.journal || '')}
        <div class="wr-row">${field('volume', 'Cilt', meta.volume || '')}${field('issue', 'Sayı', meta.issue || '')}${field('pages', 'Sayfa', meta.pages || '')}</div>
        <div class="wr-row"><button class="copy-button btn-primary" type="submit">Kaydet ve onayla</button><button class="text-button btn-quiet" type="button" data-action="verify">Dizinlerde doğrula</button></div>
      </form></details>
      <div class="wr-row">${source.status === 'ready' && source.searchMode === 'keyword' && source.chunkCount ? '<button class="text-button btn-quiet" type="button" data-action="retry">Anlamsal aramayı yeniden dene</button>' : ''}<button class="text-button btn-danger" type="button" data-action="delete">Kaynağı sil</button></div>
    </article>`;
  }
  function renderSources() {
    const sources = S.data.sources, sig = JSON.stringify(sources);
    if (sig === S.sourcesSig) return;
    // Typing in a künye form is never wiped by a refresh; the render is retried when the field loses focus.
    if ($('sources').contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) { S.renderLater = true; return; }
    S.sourcesSig = sig; S.renderLater = false;
    $('sources').innerHTML = sources.length ? sources.map(sourceCard).join('') : '<p class="wr-muted">Henüz kaynak yok. PDF veya Word dosyası ekleyin.</p>';
    refreshCitations(); renderBibliography();
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
    if (message.role === 'user') { const p = document.createElement('p'); p.textContent = message.raw; node.append(p); return node; }
    if (message.status === 'working') { const p = document.createElement('p'); p.className = 'wr-muted'; p.textContent = message.note || 'Yanıt hazırlanıyor…'; node.append(p); return node; }
    if (message.status === 'error') {
      const p = document.createElement('p'); p.className = 'wr-error-text'; p.textContent = message.error || 'Yanıt üretilemedi.'; node.append(p);
      return node;
    }
    const body = document.createElement('div'); body.className = 'wr-answer';
    body.append(paragraphs(Cite.renderText(message.raw, byId, message.lang))); node.append(body);
    if (message.insufficient) { const p = document.createElement('p'); p.className = 'wr-warn-text'; p.textContent = 'Kaynaklarda bu soru için yeterli bilgi bulunamadı.'; node.append(p); }
    if (message.warning) { const p = document.createElement('p'); p.className = 'wr-warn-text'; p.textContent = message.warning; node.append(p); }
    if (Cite.renderText(message.raw, byId, message.lang) && Cite.tokenRefs(message.raw).some(ref => Cite.renderGroup([ref], byId, 'tr').incomplete)) {
      const p = document.createElement('p'); p.className = 'wr-warn-text'; p.textContent = 'Bazı atıflarda künye eksik; kaynağın künyesini düzenleyin.'; node.append(p);
    }
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
    box.replaceChildren(...(messages.length ? messages.map(message => messageNode(message, byId)) : [Object.assign(document.createElement('p'), { className: 'wr-muted wr-empty', textContent: 'Kaynaklarınıza bir soru sorun; cevap atıflarla birlikte gelir ve isterseniz makalenize eklersiniz.' })]));
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
    return S.data.sources.some(source => ['processing', 'embedding'].includes(source.status)) || S.data.messages.some(message => message.status === 'working');
  }
  function schedulePoll() {
    clearTimeout(S.poll);
    if (!S.data || !busy()) return;
    S.poll = setTimeout(async () => { try { await reload(); } catch { /* retried below */ } schedulePoll(); }, 1500);
  }
  async function reload() {
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
  $('consent').addEventListener('change', event => { memory.set('wr-consent', event.target.checked ? '1' : '0'); $('upload').disabled = !event.target.checked; });
  const toBase64 = file => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = () => reject(Error('Dosya okunamadı.')); reader.readAsDataURL(file); });
  $('upload').addEventListener('change', async event => {
    const files = [...event.target.files]; event.target.value = '';
    const limit = S.boot.usage.limits.documentBytes;
    for (const file of files) {
      if (file.size > limit) { say(`${file.name}: dosya en fazla ${Math.round(limit / 1048576)} MB olabilir.`, 'error'); continue; }
      try { say(`${file.name} yükleniyor…`); await api('POST', `/projects/${S.projectId}/sources`, { name: file.name, data: await toBase64(file) }); say(''); }
      catch (error) { fail(error); if (error.data?.code === 'plan_limit') break; }
    }
    await reload(); schedulePoll(); refreshProjects();
  });
  $('sources').addEventListener('focusout', () => { if (S.renderLater) setTimeout(() => { if (!$('sources').contains(document.activeElement)) { S.sourcesSig = ''; renderSources(); } }, 50); });
  $('sources').addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]'); if (!button) return;
    const id = button.closest('[data-id]').dataset.id, base = `/projects/${S.projectId}/sources/${id}`;
    try {
      if (button.dataset.action === 'delete') {
        if (button.dataset.armed !== '1') { button.dataset.armed = '1'; button.textContent = 'Emin misiniz? Tekrar tıklayın'; setTimeout(() => { button.dataset.armed = ''; button.textContent = 'Kaynağı sil'; }, 4000); return; }
        await api('DELETE', base); await reload(); refreshProjects();
      } else if (button.dataset.action === 'retry') { await api('POST', base + '/retry', {}); await reload(); schedulePoll(); }
      else if (button.dataset.action === 'verify') {
        const form = button.closest('form'); await api('PATCH', base, formValues(form)); await api('POST', base + '/verify', {});
        say('Künye dizinlerde aranıyor; sonuç birkaç saniye içinde görünür.'); await reload(); setTimeout(async () => { try { await reload(); say(''); } catch { /* ignore */ } }, 6000);
      }
    } catch (error) { fail(error); }
  });
  const formValues = form => Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, String(value)]));
  $('sources').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target, id = form.dataset.id;
    try { await api('PATCH', `/projects/${S.projectId}/sources/${id}`, formValues(form)); say('Künye kaydedildi; atıflar ve kaynakça güncellendi.', 'ok'); S.sourcesSig = ''; await reload(); refreshCitations(); changed(); }
    catch (error) { fail(error); }
  });

  $('messages').addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]'); if (!button) return;
    const message = S.data.messages.find(m => m.id === button.closest('[data-id]').dataset.id); if (!message) return;
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
  $('skill').addEventListener('change', () => { $('suggestion').hidden = true; });
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

  let started = false;
  const begin = () => { if (!started) { started = true; start(); } };
  window.addEventListener('app-page-change', event => { if (event.detail.page === 'yazim') begin(); });
  if (window.AppPages?.current?.() === 'yazim' || location.hash.startsWith('#/yazim')) begin();
  window.WriterApp = { state: S, citeSpan, answerHtml };
})();
