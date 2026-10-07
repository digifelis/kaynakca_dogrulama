const input = document.querySelector('#reference-input');
const countBadge = document.querySelector('#record-count');
const inputHint = document.querySelector('#input-hint');
const verifyButton = document.querySelector('#verify-button');
const clearButton = document.querySelector('#clear-button');
const progressSection = document.querySelector('#progress-section');
const progressBar = document.querySelector('#progress-bar');
const progressLabel = document.querySelector('#progress-label');
const progressValue = document.querySelector('#progress-value');
const resultsSection = document.querySelector('#results-section');
const outputSection = document.querySelector('#output-section');
const resultList = document.querySelector('#result-list');
const summaryStats = document.querySelector('#summary-stats');
const outputText = document.querySelector('#output-text');
const copyButton = document.querySelector('#copy-button');
const copyStatus = document.querySelector('#copy-status');
const stopButton = document.querySelector('#stop-button');
const retryButton = document.querySelector('#retry-button');
const styleSelect = document.querySelector('#style-select');
// APA, Vancouver or IEEE: the verified records are kept as structured data, so the style can change without verifying again.
const STYLE_KEY = 'kaynakca-style', STYLE_NAMES = { apa: 'APA 7', vancouver: 'Vancouver', ieee: 'IEEE', mdpi: 'MDPI' };
let activeStyle = 'apa';
try { const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STYLE_KEY) : null; if (saved in STYLE_NAMES) activeStyle = saved; } catch { /* storage unavailable: APA */ }
let runController = null;
// With the local server the run happens there (queue services or a worker thread); the browser only polls.
let serverMode = false;
let displayedResults = [];
let activeFilter = 'all';
const filterLabels = { all: 'tümü', verified: 'doğrulandı', review: 'incelenmeli', failed: 'bulunamadı', error: 'servis hatası', pending: 'ek kaynak bekliyor' };
const { splitReferences, verifyReference } = ReferenceEngine;

function renderProviderCatalog(config = {}) {
  const catalog = document.querySelector('#provider-catalog');
  if (!catalog || typeof ReferenceProviders === 'undefined') return;
  catalog.innerHTML = ReferenceProviders.descriptors.map(provider => {
    const mode = provider.mode === 'manual' ? 'Manuel kontrol' : provider.mode === 'key' && !config.googleBooksConfigured ? 'API anahtarı bekleniyor' : 'Gerektiğinde otomatik aranır';
    return `<div class="provider-entry"><strong>${escapeHtml(provider.name)}</strong><span>${escapeHtml(mode)}</span><span>${escapeHtml(provider.note)}</span>${provider.url ? `<a href="${escapeHtml(provider.url)}" target="_blank" rel="noreferrer">Kaynağı aç</a>` : ''}</div>`;
  }).join('');
}

const serverReady = typeof window === 'undefined' ? Promise.resolve() : (async () => {
  renderProviderCatalog();
  try {
    const response = await fetch('/api/config', { signal: AbortSignal.timeout(3000) });
    const config = await response.json();
    if (!response.ok || !config.proxy) throw Error('no proxy');
    ReferenceEngine.configure({ proxyUrl: '/api/proxy', googleBooksConfigured: config.googleBooksConfigured });
    serverMode = true;
    renderProviderCatalog(config);
    document.querySelector('#provider-access-note').textContent = config.mode === 'queue'
      ? `Kaynaklar kuyruk üzerinden doğrulama servisine gönderilir (çalışan doğrulama servisi: ${config.services?.verify ?? 0}). Akademik kota beklemeleri otomatik sürer; web kotasında kayıt ertelenir, sonraki deneme zamanı gösterilir.`
      : 'Akademik dizinler ve web sayfaları yerel sunucudan sorgulanır. Akademik kota beklemeleri otomatik sürer; web kotasında kayıt ertelenir, sonraki deneme zamanı gösterilir.';
  } catch {
    document.querySelector('#provider-access-note').textContent = 'Temel tarayıcı erişimi kullanılıyor. Bazı ek dizinler tarayıcıdan erişimi engelleyebilir; tam erişim için uygulamayı node server.cjs ile başlatın.';
  }
})();

const examples = {
  web: 'BloombergNews p. (2025, May 8). The AI boom is draining water from the areas that need it most. https://www.bloomberg.com/graphics/2025-ai-impacts-data-centers-water-data/\n\nBhat, D. (2025, August 4). Big Tech is building AI in the desert. The water may not last. Rest of World. https://restofworld.org/2025/gulf-ai-water-crisis/\n\nCulligan Quench. (2026). Average water usage per person in offices. https://quench.culligan.com/blog/average-water-usage-per-person-in-offices/',
  article: 'Vaswani, A., Shazeer, N., Parmar, N., et al. (2017). Attention is all you need. Advances in Neural Information Processing Systems, 30. https://doi.org/10.48550/arXiv.1706.03762\n\nDevlin, J., Chang, M.-W., Lee, K., & Toutanova, K. (2019). BERT: Pre-training of deep bidirectional transformers for language understanding. NAACL.',
  mixed: 'Vaswani, A., Shazeer, N., Parmar, N., et al. (2017). Attention is all you need. Advances in Neural Information Processing Systems, 30.\n\nSinek, S. (2009). Start with why: How great leaders inspire everyone to take action. Portfolio.',
  problem: 'Vaswani, A. (2021). Attention is all you need. Advances in Neural Information Processing Systems, 30. https://doi.org/10.9999/fake-doi-123'
};

function updateCount() {
  const count = splitReferences(input.value).length;
  countBadge.textContent = `${count} kayıt`;
  inputHint.textContent = count ? `${count} kaynak algılandı · tüm kayıtlar işlenecek.` : 'Başlamak için kaynakçanızı yapıştırın.';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
}

const isUnresolved = result => ['error', 'pending'].includes(result?.status);

function renderSummary(results) {
  const unresolved = results.filter(isUnresolved).length;
  retryButton.classList[unresolved ? 'remove' : 'add']('hidden');
  retryButton.disabled = !!runController;
  retryButton.textContent = `Hatalı ve bekleyenleri yeniden sorgula (${unresolved})`;
  summaryStats.innerHTML = Object.entries(filterLabels).map(([status, label]) => {
    const count = status === 'all' ? results.length : results.filter(result => result.status === status).length;
    return `<button type="button" class="summary-stat" data-filter="${status}" aria-pressed="${activeFilter === status}" aria-label="${count} ${label}: sonuçları göster"><strong>${count}</strong><span>${label}</span></button>`;
  }).join('');
}

function setResultFilter(status) {
  if (!(status in filterLabels)) return;
  activeFilter = status;
  renderSummary(displayedResults);
  renderResults(displayedResults);
}

function quotaDetails(result) {
  if (result.status !== 'pending' || !result.pendingRetryAt) return '';
  const at = ReferenceEngine.getPendingRetryAt?.(result) || result.pendingRetryAt;
  const providers = (result.pendingProviders || []).map(item => item.provider).join(', ') || 'Ek kaynaklar';
  const last = result.lastQuery ? ` Son dış sorgu: ${escapeHtml(result.lastQuery.provider)} · ${new Date(result.lastQuery.at).toLocaleTimeString('tr-TR')}.` : '';
  return `<p class="reason retry-detail">Bekleyen servis: ${escapeHtml(providers)}. Sonraki deneme: <time datetime="${new Date(at).toISOString()}">${new Date(at).toLocaleTimeString('tr-TR')}</time>. Yeniden kontrol sayısı: ${result.retryCount || 0}.${last}</p>`;
}

// The result as the chosen style writes it (APA results are returned unchanged).
const styled = result => activeStyle === 'apa' ? result : ReferenceEngine.restyle(result, activeStyle);
function outputReference(result) {
  const shown = styled(result);
  if (shown === result) return result.appliedCrossrefCitation || result.appliedSuggestion || { text: result.corrected, html: result.correctedHtml };
  // A suggestion the user applied is written in the new style too; a hand-edited web draft stays as typed.
  if (result.appliedSuggestion && (result.type !== 'web' || result.appliedSuggestion.html)) return { text: shown.suggested, html: shown.suggestedHtml };
  if (result.appliedSuggestion) return result.appliedSuggestion;
  return { text: shown.corrected, html: shown.correctedHtml };
}
// Numbered styles list the references in order: "1." (Vancouver, MDPI) or "[1]" (IEEE).
const listPrefix = index => activeStyle === 'ieee' ? `[${index + 1}] ` : activeStyle === 'vancouver' || activeStyle === 'mdpi' ? `${index + 1}. ` : '';

function applySuggestion(index) {
  if (!Number.isInteger(index)) return;
  const result = displayedResults[index];
  if (result?.status !== 'review' || !result.suggested) return;
  const draft = result.type === 'web' ? (result.webDraft ?? result.suggested).trim() : result.suggested;
  if (!draft) return;
  result.appliedSuggestion = result.appliedSuggestion?.text === draft ? null : { text: draft, html: draft === result.suggested ? result.suggestedHtml : null };
  renderResults(displayedResults);
  renderOutput(displayedResults);
  copyStatus.textContent = result.appliedSuggestion ? `${index + 1}. kaydın önerisi düzeltilmiş kaynakçaya uygulandı.` : `${index + 1}. kayıt özgün haliyle çıktıya geri alındı.`;
}

function scholarSearchUrl(result) {
  const parsed = ReferenceEngine.parseReference(result.raw);
  const query = parsed.title ? [parsed.title, parsed.firstAuthor, parsed.year].filter(Boolean).join(' ') : result.raw;
  return `https://scholar.google.com/scholar?hl=tr&q=${encodeURIComponent(query)}`;
}

function renderResults(results) {
  displayedResults = results;
  const visible = results.map((result, index) => ({ result, index })).filter(({ result }) => activeFilter === 'all' || result.status === activeFilter);
  document.querySelector('#results-subtitle').textContent = `${visible.length} / ${results.length} kayıt gösteriliyor · ${filterLabels[activeFilter]}`;
  resultList.innerHTML = visible.map(({ result, index }) => {
    const safeUrl = /^https?:\/\//i.test(result.url || '') ? result.url : '';
    const color = ['error', 'pending'].includes(result.status) ? 'review' : result.status;
    const output = outputReference(result), shown = styled(result);
    return `<article class="result-card ${color}">
      <div class="result-top"><span class="result-number">${String(index + 1).padStart(2, '0')}</span><span class="status-pill ${color}">${escapeHtml(result.statusText)}</span></div>
      <p class="raw-reference">${escapeHtml(result.raw)}</p>
      <p class="matched-reference">${output.html || escapeHtml(output.text)}</p>
      ${result.status === 'review' && result.suggested ? `<p class="reason">${result.appliedSuggestion ? 'Öneri seçiminizle çıktıya uygulandı; otomatik doğrulama durumu değişmedi.' : 'Olası eşleşme (çıktıya uygulanmadı):'}</p>${!result.appliedSuggestion ? `<p class="matched-reference">${shown.suggestedHtml || escapeHtml(shown.suggested)}</p>` : ''}` : ''}
      ${result.status !== 'verified' ? `<div class="result-actions">
        ${result.status === 'review' && result.suggested ? `<button class="result-action apply-suggestion" type="button" data-apply-suggestion="${index}" ${result.type === 'web' && !(result.webDraft ?? result.suggested).trim() ? 'disabled' : ''}>${result.appliedSuggestion && result.appliedSuggestion.text === (result.webDraft ?? result.suggested).trim() ? 'Özgün kayda dön' : 'Çıktıya uygula'}</button>` : ''}
        ${result.status !== 'verified' ? `<a class="result-action scholar-search" href="${escapeHtml(result.type === 'web' ? 'https://www.google.com/search?q=' + encodeURIComponent(result.raw) : scholarSearchUrl(result))}" target="_blank" rel="noopener noreferrer">${result.type === 'web' ? 'Web’de ara' : 'Google Scholar’da ara'} ↗</a>` : ''}
      </div>` : ''}
      ${result.type === 'web' && result.status === 'review' && result.suggested ? `<div class="web-editor"><label for="web-draft-${index}">Kaynakça önerisini düzenle</label><textarea id="web-draft-${index}" data-web-draft="${index}" rows="4" aria-describedby="web-draft-help-${index}">${escapeHtml(result.webDraft ?? result.suggested)}</textarea><p id="web-draft-help-${index}" class="reason">Değişiklikler taslakta tutulur. Son metni kullanmak için “Çıktıya uygula” düğmesine basın. Elle düzenlenen metin düz metin olarak aktarılır.</p></div>` : ''}
      <div class="result-meta"><span>${result.type === 'web' ? 'Alan bazında web kontrolü' : `Eşleşme: <strong>${result.score}/100</strong>`}</span><span>Kaynak: ${escapeHtml(result.provider)}</span>${safeUrl ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noreferrer">Kayıt bağlantısı ↗</a>` : ''}</div>
      ${shown.styleNotes?.length ? `<p class="reason">${escapeHtml(STYLE_NAMES[activeStyle])} notu: ${escapeHtml(shown.styleNotes.join('; '))}.</p>` : ''}
      ${result.changes.length ? `<div class="changes">${result.changes.map(change => `<span class="change-tag">${escapeHtml(change)}</span>`).join('')}</div>` : ''}
        <p class="reason">${escapeHtml(result.appliedSuggestion ? result.reason.replace('Öneri inceleme için gösterildi; özgün kaynak değiştirilmedi.', 'Öneri seçiminizle çıktıya uygulandı.') : result.reason)}</p>
        ${result.debugRequests?.length ? `<details class="debug-panel"><summary>Geçici servis debug bilgisi</summary>${result.debugRequests.map(item => `<p><strong>${escapeHtml(item.provider)}</strong> · HTTP ${escapeHtml(item.status)}<br>API: <code>${escapeHtml(item.url)}</code><br>İstek: <code>${escapeHtml(item.requestUrl)}</code><br>${escapeHtml(item.detail)}</p>`).join('')}</details>` : ''}
        ${quotaDetails(result)}
      ${typeof ReferenceWeb !== 'undefined' ? ReferenceWeb.details(result) : ''}
      ${result.sourcesChecked?.length ? `<p class="reason">Sorgulanan kaynaklar: ${escapeHtml(result.sourcesChecked.join(', '))}</p>` : ''}
      ${result.warnings?.length && result.status !== 'error' ? `<p class="reason">Diğer sorgu uyarıları: ${escapeHtml(result.warnings.join('; '))}</p>` : ''}
      ${result.type !== 'web' && result.status !== 'verified' && typeof ReferenceProviders !== 'undefined' ? `<div class="manual-links">${ReferenceProviders.descriptors.filter(provider => provider.mode === 'manual').map(provider => `<a href="${escapeHtml(provider.url)}" target="_blank" rel="noreferrer">${escapeHtml(provider.name)} — manuel kontrol</a>`).join('')}</div>` : ''}
    </article>`;
  }).join('') || '<p class="empty-results">Bu kategoride kayıt bulunmuyor.</p>';
}

function renderOutput(results) {
  outputText.textContent = results.map((result, index) => listPrefix(index) + outputReference(result).text).join('\n\n');
  outputText.innerHTML = results.map((result, index) => { const output = outputReference(result); return `<p style="margin:0 0 1em">${escapeHtml(listPrefix(index))}${output.html || escapeHtml(output.text)}</p>`; }).join('');
  outputSection.classList.remove('hidden');
}

function waitDuration(retryAt) {
  const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)} dk ${seconds % 60} sn` : `${seconds} sn`;
}
// Shows a server result the way the in-browser run did: queued fallbacks and quota waits stay "pending".
function presentResult(result, batch, index) {
  const shown = { ...result, lastQuery: batch.lastQuery?.[index] };
  if (batch.running && shown.fallbackNeeded && !shown.pendingRetryAt) Object.assign(shown, { status: 'pending', statusText: 'Ek kaynak sırası', reason: 'Crossref taraması tamamlandıktan sonra ek kaynaklarda kontrol edilecek.' });
  else if (shown.pendingRetryAt && shown.status !== 'verified') Object.assign(shown, { status: 'pending', statusText: 'Kota bekleniyor', reason: 'Ek kaynak kotası için yeniden deneme bekliyor. Diğer kayıtların kontrolü devam ediyor; bu kayıt otomatik yeniden sorgulanacak.' });
  return shown;
}
async function verifyOnServer(references, results) {
  const headers = { 'Content-Type': 'application/json', 'X-Word-Request': '1' }, signal = runController.signal;
  const started = await fetch('/api/verify-batches', { method: 'POST', headers, body: JSON.stringify({ references }), signal });
  let batch = await started.json();
  if (!started.ok) throw Error(batch.error || 'Doğrulama başlatılamadı.');
  const id = batch.id;
  signal.addEventListener('abort', () => fetch(`/api/verify-batches/${id}/stop`, { method: 'POST', headers }).catch(() => {}), { once: true });
  references.forEach((raw, index) => { results[index] = { raw, corrected: raw, status: 'pending', statusText: 'Sırada', score: 0, provider: 'Doğrulama kuyruğu', changes: [], reason: 'Doğrulama servisine gönderildi; sırası bekleniyor.' }; });
  let version = -1;
  while (true) {
    if (batch.version !== version) {
      version = batch.version;
      batch.results.forEach((result, index) => { if (result) results[index] = presentResult(result, batch, index); });
      const primary = batch.phase === 'primary';
      progressValue.textContent = `${batch.primaryCompleted} / ${batch.total}`;
      progressBar.style.width = `${(batch.primaryCompleted / batch.total) * 100}%`;
      progressLabel.textContent = batch.wait?.retryAt > Date.now()
        ? `${batch.wait.index === undefined ? 'Ek kaynaklar' : 'Kayıt ' + (batch.wait.index + 1)}: ${batch.wait.provider} kotası için ${waitDuration(batch.wait.retryAt)} bekleniyor; otomatik devam edilecek`
        : primary ? `İlk tarama (akademik / web): kayıt ${Math.min(batch.total, batch.primaryCompleted + 1)} inceleniyor` : 'Ek kaynaklar inceleniyor';
      renderSummary(results);
      renderResults(results);
      renderOutput(results);
    }
    if (!batch.running) {
      if (batch.state === 'stopped') throw Object.assign(Error('İşlem durduruldu'), { name: 'AbortError' });
      if (batch.state === 'error') throw Error(batch.error || 'Doğrulama tamamlanamadı.');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 800));
    if (signal.aborted) throw Object.assign(Error('İşlem durduruldu'), { name: 'AbortError' });
    const response = await fetch(`/api/verify-batches/${id}`, { signal });
    batch = await response.json();
    if (!response.ok) throw Error(batch.error || 'Doğrulama durumu alınamadı.');
  }
}

async function runVerification() {
  if (verifyButton.disabled) return;
  const references = splitReferences(input.value);
  if (!references.length) { input.focus(); inputHint.textContent = 'Önce en az bir kaynak yapıştırın.'; return; }
  verifyButton.disabled = true;
  runController = new AbortController();
  stopButton.disabled = false;
  input.disabled = true;
  clearButton.disabled = true;
  const exampleButtons = document.querySelectorAll('.example-button');
  exampleButtons.forEach(button => { button.disabled = true; });
  verifyButton.textContent = 'Kontrol ediliyor…';
  progressSection.classList.remove('hidden');
  resultsSection.classList.remove('hidden');
  outputSection.classList.add('hidden');
  progressBar.style.width = '0%';
  resultList.innerHTML = '';
  copyStatus.textContent = '';
  const results = [];
  const queryHistory = new Map();
  let currentIndex = 0;
  renderSummary(results);
  try {
    await serverReady;
    if (serverMode) await verifyOnServer(references, results);
    else {
    ReferenceEngine.configure({ signal: runController.signal, onRequest: event => {
      queryHistory.set(currentIndex, event);
      if (results[currentIndex]?.status === 'pending') {
        results[currentIndex].lastQuery = event;
        results[currentIndex].statusText = 'Yeniden sorgulanıyor';
        renderResults(results);
      }
    }, onRetry: ({ provider, remainingMs, waiting }) => {
      const seconds = Math.ceil(remainingMs / 1000);
      const duration = seconds >= 60 ? `${Math.floor(seconds / 60)} dk ${seconds % 60} sn` : `${seconds} sn`;
      progressLabel.textContent = waiting ? `Kayıt ${currentIndex + 1}: ${provider} kotası için ${duration} bekleniyor; otomatik devam edilecek` : `Kayıt ${currentIndex + 1}: ${provider} sorgusu yeniden deneniyor`;
    } });
    for (let index = 0; index < references.length; index += 1) {
      currentIndex = index;
      progressLabel.textContent = `İlk tarama (akademik / web): kayıt ${index + 1} inceleniyor`;
      progressValue.textContent = `${index} / ${references.length}`;
      results.push(await verifyReference(references[index], { primaryOnly: true }));
      results[index].lastQuery = queryHistory.get(index);
      if (results[index].fallbackNeeded) {
        results[index].status = 'pending';
        results[index].statusText = 'Ek kaynak sırası';
        results[index].reason = 'Crossref taraması tamamlandıktan sonra ek kaynaklarda kontrol edilecek.';
      }
      progressBar.style.width = `${((index + 1) / references.length) * 100}%`;
      progressValue.textContent = `${index + 1} / ${references.length}`;
      renderSummary(results);
      renderResults(results);
    }
    renderOutput(results);
    ReferenceEngine.configure({ deferQuota: true });
    let unresolved = results.map((result, index) => result.fallbackNeeded ? index : -1).filter(index => index >= 0);
    while (unresolved.length) {
      for (const index of unresolved) {
        currentIndex = index;
        const nextAt = ReferenceEngine.getPendingRetryAt?.(results[index]) || results[index].pendingRetryAt;
        if (nextAt > Date.now()) { results[index].pendingRetryAt = nextAt; continue; }
        progressLabel.textContent = `Ek kaynaklar: kayıt ${index + 1} inceleniyor`;
        const retryCount = (results[index].retryCount || 0) + (results[index].pendingRetryAt ? 1 : 0);
        results[index] = await verifyReference(references[index]);
        results[index].retryCount = retryCount;
        results[index].lastQuery = queryHistory.get(index);
        if (results[index].pendingRetryAt && results[index].status !== 'verified') {
          results[index].status = 'pending';
          results[index].statusText = 'Kota bekleniyor';
          results[index].reason = 'Ek kaynak kotası için yeniden deneme bekliyor. Diğer kayıtların kontrolü devam ediyor; bu kayıt otomatik yeniden sorgulanacak.';
        }
        renderSummary(results);
        renderResults(results);
        renderOutput(results);
      }
      unresolved = unresolved.filter(index => results[index].status !== 'verified' && results[index].pendingRetryAt);
      if (unresolved.length) {
        currentIndex = unresolved[0];
        for (const index of unresolved) results[index].pendingRetryAt = ReferenceEngine.getPendingRetryAt?.(results[index]) || results[index].pendingRetryAt;
        renderResults(results);
        await ReferenceEngine.waitForRetry(Math.min(...unresolved.map(index => results[index].pendingRetryAt)));
        // Rotate priority so a repeatedly limited first record cannot starve others.
        unresolved.push(unresolved.shift());
      }
    }
    }
    progressValue.textContent = `${references.length} / ${references.length}`;
    progressBar.style.width = '100%';
    progressLabel.textContent = 'Kontrol tamamlandı';
  } catch (error) {
    const stopped = error.name === 'AbortError';
    progressLabel.textContent = stopped ? 'İşlem durduruldu; tamamlanan sonuçlar korundu.' : 'İşlem durdu; kalan kayıtlar özgün haliyle korundu.';
    for (const result of results.filter(result => result.status === 'pending')) {
      result.status = 'error';
      result.statusText = 'Kontrol tamamlanamadı';
      result.reason = stopped ? 'İşlem kullanıcı tarafından durduruldu. Ek kaynak kontrolü tamamlanmadı; kaynak özgün haliyle korundu.' : 'Ek kaynak kontrolü tamamlanmadı; kaynak özgün haliyle korundu.';
    }
    for (let index = results.length; index < references.length; index += 1) {
      results.push({ raw: references[index], corrected: references[index], status: 'error', statusText: 'Kontrol tamamlanamadı', score: 0, provider: stopped ? 'İşlem durduruldu' : 'İşlem hatası', changes: [], reason: stopped ? 'İşlem kullanıcı tarafından durduruldu. Kaynak özgün haliyle korundu.' : 'İşlem tamamlanamadı. Kaynak özgün haliyle korundu; tekrar deneyin.' });
    }
  } finally {
    ReferenceEngine.configure({ signal: null, onRetry: null, onRequest: null, deferQuota: false });
    runController = null;
    stopButton.disabled = true;
    renderSummary(results);
    renderResults(results);
    renderOutput(results);
    verifyButton.disabled = false;
    input.disabled = false;
    clearButton.disabled = false;
    exampleButtons.forEach(button => { button.disabled = false; });
    verifyButton.textContent = 'Yeniden doğrula';
  }
}

// Re-queries only the records left as service error or waiting for additional sources.
async function retryUnresolved() {
  if (runController) return;
  const results = displayedResults;
  const targets = results.map((result, index) => isUnresolved(result) ? index : -1).filter(index => index >= 0);
  if (!targets.length) return;
  await serverReady;
  runController = new AbortController();
  const controls = [verifyButton, clearButton, input, ...document.querySelectorAll('.example-button')];
  controls.forEach(control => { control.disabled = true; });
  stopButton.disabled = false;
  progressSection.classList.remove('hidden');
  progressBar.style.width = '0%';
  copyStatus.textContent = '';
  let current = 0, stopped = false;
  ReferenceEngine.configure({ signal: runController.signal, onRetry: ({ provider, remainingMs, waiting }) => {
    const seconds = Math.ceil(remainingMs / 1000);
    const duration = seconds >= 60 ? `${Math.floor(seconds / 60)} dk ${seconds % 60} sn` : `${seconds} sn`;
    progressLabel.textContent = waiting ? `Kayıt ${current + 1}: ${provider} kotası için ${duration} bekleniyor; otomatik devam edilecek` : `Kayıt ${current + 1}: ${provider} sorgusu yeniden deneniyor`;
  } });
  try {
    for (let position = 0; position < targets.length; position += 1) {
      current = targets[position];
      progressLabel.textContent = `Yeniden sorgu: kayıt ${current + 1} inceleniyor`;
      progressValue.textContent = `${position} / ${targets.length}`;
      try {
        const retryCount = (results[current].retryCount || 0) + 1;
        results[current] = await verifyReference(results[current].raw);
        results[current].retryCount = retryCount;
      } catch (error) {
        if (error.name === 'AbortError') { stopped = true; break; }
        results[current] = { ...results[current], status: 'error', statusText: 'Kontrol tamamlanamadı', reason: 'Yeniden sorgu tamamlanamadı; kaynak özgün haliyle korundu.' };
      }
      progressBar.style.width = `${((position + 1) / targets.length) * 100}%`;
      progressValue.textContent = `${position + 1} / ${targets.length}`;
      renderSummary(results);
      renderResults(results);
      renderOutput(results);
    }
    progressLabel.textContent = stopped ? 'Yeniden sorgu durduruldu; tamamlanan sonuçlar korundu.' : 'Yeniden sorgu tamamlandı';
  } finally {
    ReferenceEngine.configure({ signal: null, onRetry: null });
    runController = null;
    stopButton.disabled = true;
    controls.forEach(control => { control.disabled = false; });
    renderSummary(results);
    renderResults(results);
    renderOutput(results);
  }
}

input.addEventListener('input', updateCount);
resultList.addEventListener('input', event => {
  const field = event.target.closest('[data-web-draft]');
  if (!field) return;
  const index = Number(field.dataset.webDraft), result = displayedResults[index];
  if (!result || result.type !== 'web' || result.status !== 'review') return;
  result.webDraft = field.value;
  const button = document.querySelector(`[data-apply-suggestion="${index}"]`);
  if (button) {
    button.disabled = !field.value.trim();
    button.textContent = result.appliedSuggestion?.text === field.value.trim() ? 'Özgün kayda dön' : 'Çıktıya uygula';
  }
});
resultList.addEventListener('click', event => {
  const button = event.target.closest('[data-apply-suggestion]');
  if (button) applySuggestion(Number(button.dataset.applySuggestion));
});
summaryStats.addEventListener('click', event => {
  const button = event.target.closest('[data-filter]');
  if (button) setResultFilter(button.dataset.filter);
});
// The style list follows the plan: Vancouver and IEEE belong to plans with that area (a visitor without an account is not held to a plan).
function syncStyleAccess() {
  if (!styleSelect || !styleSelect.querySelectorAll) return;
  const allowed = typeof window === 'undefined' || !window.Auth?.hasFeature || window.Auth.hasFeature('styles');
  styleSelect.querySelectorAll('option').forEach(option => { if (option.value !== 'apa') { option.disabled = !allowed; option.textContent = STYLE_NAMES[option.value] + (allowed ? '' : ' (paketinizde yok)'); } });
  if (!allowed && activeStyle !== 'apa') setStyle('apa');
  styleSelect.value = activeStyle;
}
function setStyle(style) {
  activeStyle = style in STYLE_NAMES ? style : 'apa';
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(STYLE_KEY, activeStyle); } catch { /* the choice is simply not remembered */ }
  if (displayedResults.length) { renderResults(displayedResults); renderOutput(displayedResults); }
}
if (styleSelect) {
  styleSelect.value = activeStyle;
  styleSelect.addEventListener?.('change', () => setStyle(styleSelect.value));
}
if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('auth-change', syncStyleAccess);
syncStyleAccess();
clearButton.addEventListener('click', () => {
  input.value = '';
  displayedResults = [];
  activeFilter = 'all';
  updateCount();
  input.focus();
  resultsSection.classList.add('hidden');
  outputSection.classList.add('hidden');
  progressSection.classList.add('hidden');
});
verifyButton.addEventListener('click', runVerification);
retryButton.addEventListener('click', retryUnresolved);
stopButton.addEventListener('click', () => runController?.abort());
document.querySelectorAll('.example-button').forEach(button => button.addEventListener('click', () => {
  input.value = examples[button.dataset.example];
  updateCount();
  input.focus();
}));
copyButton.addEventListener('click', async () => {
  const plain = [...outputText.querySelectorAll('p')].map(paragraph => paragraph.textContent).join('\n\n');
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([outputText.innerHTML], { type: 'text/html' }), 'text/plain': new Blob([plain], { type: 'text/plain' }) })]);
      copyStatus.textContent = 'Kaynakça italik biçimlendirmesiyle kopyalandı. Word’e yapıştırırken kaynak biçimlendirmesini koruyun.';
    } else {
      await navigator.clipboard.writeText(plain);
      copyStatus.textContent = 'Düz metin kopyalandı; bu tarayıcı biçimli kopyalamayı desteklemiyor.';
    }
  }
  catch {
    try { await navigator.clipboard.writeText(plain); copyStatus.textContent = 'Düz metin kopyalandı; biçimli kopyalama engellendiği için italikler korunamadı.'; }
    catch { copyStatus.textContent = 'Kopyalama engellendi; metni seçip kopyalayabilirsiniz.'; }
  }
});
updateCount();
