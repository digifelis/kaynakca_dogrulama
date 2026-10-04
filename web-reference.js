/* Shared, conservative web bibliography parsing and comparison. */
(function (root) {
  const clean = value => String(value || '').replace(/\s+/gu, ' ').trim();
  const norm = value => clean(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ı/g, 'i').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const escape = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const trMonths = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
  function dateParts(value) {
    const text = clean(value);
    if (/©|copyright|telif|all rights reserved/i.test(text)) return null;
    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|\b)/);
    const numeric = text.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
    let year, month, day;
    if (iso) { [, year, month, day] = iso.map(Number); if (!month || !day) return null; }
    else if (numeric) { [, day, month, year] = numeric.map(Number); if (!month || !day) return null; }
    else {
      year = Number(text.match(/\b(?:19|20)\d{2}\b/)?.[0]);
      const tokens = norm(text).split(' ');
      month = months.findIndex((m, i) => tokens.some(t => t === norm(m) || t === norm(m.slice(0, 3)) || t === norm(trMonths[i]))) + 1;
      const rest = text.replace(/\b(?:19|20)\d{2}[a-z]?\b/gi, '');
      day = month ? Number(rest.match(/\b\d{1,2}\b/)?.[0]) : 0;
    }
    if (!year || month > 12 || day > 31 || (month && day && new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day)) return null;
    return { year, month: month || null, day: day || null };
  }
  function parse(reference) {
    const raw = String(reference);
    const markdown = raw.match(/\[[^\]]*\]\((https?:\/\/[^\s]+)\)/i);
    const match = raw.match(/https?:\/\/[^\s<>\]]+/i);
    let url = markdown?.[1] || match?.[0];
    if (!url) return null;
    url = url.replace(/[.,;]+$/, '');
    while (url.endsWith(')') && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length) url = url.slice(0, -1);
    if (/^https?:\/\/(?:dx\.)?doi\.org\//i.test(url)) return null;
    const before = clean(raw.slice(0, markdown?.index ?? match.index));
    const dated = before.match(/^(.*?)\s*\(([^)]*(?:\d{4}|t\.y\.|n\.d\.)[^)]*)\)\s*\.?\s*([\s\S]*)$/i);
    return { raw, url, author: clean(dated?.[1]).replace(/\.$/, ''), date: dateParts(dated?.[2]), dateText: dated?.[2] || '', title: clean(dated?.[3] || before).replace(/[.\s]+$/, '') };
  }
  function person(name) {
    const text = clean(name);
    if (text.includes(',')) return text;
    const parts = text.split(' ');
    return parts.length > 1 ? `${parts.pop()}, ${parts.map(p => p[0] + '.').join(' ')}` : text;
  }
  function citation(page) {
    const displayTitle = page.formattedTitle || page.title || '[Başlık bulunamadı]';
    const authors = (page.authors || []).map(a => a.type === 'Organization' ? a.name : person(a.name));
    const author = authors.length > 1 ? authors.slice(0, -1).join(', ') + ', & ' + authors.at(-1) : authors[0] || '';
    const d = dateParts(page.published) || dateParts(page.modified);
    const date = d ? `${d.year}${d.month ? ', ' + months[d.month - 1] + (d.day ? ' ' + d.day : '') : ''}` : 't.y.';
    const site = norm(author) === norm(page.site) ? '' : page.site;
    const prefix = author ? `${author} (${date}). ` : '';
    const stop = /[.!?]$/.test(displayTitle) ? '' : '.';
    const suffix = `${author ? stop : `${stop} (${date}).`}${site ? ' ' + site + '.' : ''} ${page.url}`;
    return { text: prefix + displayTitle + suffix, html: escape(prefix) + '<em>' + escape(displayTitle) + '</em>' + escape(suffix) };
  }
  function compare(reference, page) {
    const input = parse(reference);
    const base = { raw: reference, corrected: reference, status: 'error', statusText: 'Web kontrolü tamamlanamadı', score: null, provider: 'Web sayfası', type: 'web', fallbackNeeded: false, changes: [], warnings: page.warnings || [], sourcesChecked: ['Web sayfası'], url: input?.url, webEvidence: page.evidence || [], checkedAt: page.checkedAt, webRetryAt: page.retryAt || null };
    if (page.state !== 'ok') return { ...base, statusText: ({ deferred: 'Web kotası nedeniyle ertelendi', blocked: 'Web erişimi engellendi', missing: 'Web bağlantısı bulunamadı', unsupported: 'Web türü desteklenmiyor' })[page.state] || base.statusText, reason: page.reason || 'Sayfa künyesi alınamadı; özgün kayıt korundu.' };
    const staleAccess = !!page.staleAccess;
    if (!page.authors?.length && page.site) page = { ...page, authors: [{ name: page.site, type: 'Organization' }], authorFallback: true };
    const title = norm(input.title), found = norm(page.title);
    const siteSuffix = norm(page.site);
    const enteredTitle = siteSuffix && title.endsWith(' ' + siteSuffix) ? title.slice(0, -siteSuffix.length - 1) : title;
    const author = norm(input.author);
    const names = (page.authors || []).map(a => norm(a.type === 'Organization' ? a.name : person(a.name)));
    const authorMatches = !!author && !!names.length && norm(names.join(' ')) === author;
    const publication = dateParts(page.published);
    const d = publication || dateParts(page.modified);
    const dateMatches = !!input.date && !!d && ['year', 'month', 'day'].every(key => !input.date[key] || input.date[key] === d[key]);
    const rows = [
      { field: 'Başlık', input: input.title, found: page.title || '', matches: !!found && enteredTitle === found },
      { field: 'Yazar', input: input.author, found: (page.authors || []).map(a => a.name).join('; '), matches: authorMatches },
      { field: publication ? 'Yayın tarihi' : 'Tarih (güncelleme; yayın tarihi bulunamadı)', input: input.dateText, found: publication ? page.published : page.modified || '', matches: dateMatches },
    ];
    const complete = !!page.title && !!names.length && !!d && !!page.site;
    const verified = complete && !!publication && !page.authorFallback && rows.every(r => r.matches) && !(page.conflicts || []).length;
    const proposal = citation(page);
    const usable = !!page.title && !!names.length && !!d;
    return { ...base, status: verified ? 'verified' : 'review', statusText: staleAccess ? 'Web erişimi engellendi; önceki künye kullanıldı' : verified ? 'Web künyesi doğrulandı' : usable ? 'Web künyesi incelenmeli' : 'Web künyesi kısmen doğrulandı',
      reason: verified ? 'Sayfa başlığı, yazar ve yayın tarihi girişle uyumlu. İçerik iddiaları değerlendirilmedi.' : 'Sayfa bulundu; eksik veya farklı alanları kanıtlarıyla inceleyin. Özgün kaynak korundu. ' + (page.conflicts || []).join('; '),
      corrected: verified ? proposal.text : reference, correctedHtml: verified ? proposal.html : null,
      suggested: proposal.text, suggestedHtml: proposal.html,
      matched: usable ? { type: 'web', title: page.title, author: page.authors.map(a => ({ literal: a.name, ...(a.type === 'Organization' ? { organization: true } : {}) })), year: d.year, month: d.month || null, site: page.site || '', url: page.url, doi: '', provider: 'Web sayfası', webCitation: proposal } : null,
      changes: [...rows.filter(r => !r.matches).map(r => r.field + (r.found ? ' farklı' : ' bulunamadı')), ...(!page.site ? ['Site adı bulunamadı'] : []), ...(page.authorFallback ? ['Kişi yazarı bulunamadı; site adı kullanıldı'] : [])], webFields: rows,
      url: page.url, webPublished: page.published, webModified: page.modified, webCanonical: page.canonical,
      webAuthorFallback: !!page.authorFallback, webRetryAt: page.groqRetryAt || base.webRetryAt, staleAccess,
    };
  }
  function details(result) {
    if (result?.type !== 'web') return '';
    const fields = (result.webFields || []).map(r => `<tr><th>${escape(r.field)}</th><td>${escape(r.input || '—')}</td><td>${escape(r.found || 'Bulunamadı')}</td></tr>`).join('');
    return `<details class="web-evidence"><summary>Web künye kanıtları</summary>${fields ? `<table><thead><tr><th>Alan</th><th>Girdi</th><th>Sayfada bulunan</th></tr></thead><tbody>${fields}</tbody></table>` : ''}${(result.webEvidence || []).map(e => `<p>${escape(e.field)} · ${escape(e.source)}: ${escape(e.value)}</p>`).join('')}${result.webModified ? `<p>Güncelleme: ${escape(result.webModified)} (yayın tarihi bulunamadığında kaynakçada kullanılır)</p>` : ''}${result.webRetryAt ? `<p>Yeniden deneme zamanı: ${escape(new Date(result.webRetryAt).toLocaleString('tr-TR'))}. Yeniden doğrula ile başlatın.</p>` : ''}<p>Web künyesi kontrolü içerik doğruluğunu onaylamaz.</p></details>`;
  }
  const api = { clean, norm, parse, dateParts, citation, compare, details };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReferenceWeb = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
