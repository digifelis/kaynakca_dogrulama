/* Shared browser/Node citation helpers for the writing assistant.
   Answers and the manuscript store only source ids and pages ({{c:docId@page|...}} tokens, span.cite[data-cite]);
   the visible APA 7 author–year text is always rendered from the source's current bibliographic data.
   So correcting a source's data updates every citation and the reference list. */
(function (root) {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  const INITIAL = /^\p{Lu}\.?$|^(?:\p{Lu}\.){1,3}$/u;

  // Splits "Yılmaz, A. A.", "Ahmet Yılmaz", "Yılmaz A." or a record into { family, given } (or { literal }).
  function parseName(author) {
    if (author && typeof author === 'object') {
      if (author.literal) return { literal: clean(author.literal) };
      return { family: clean(author.family), given: clean(author.given) };
    }
    const text = clean(author);
    if (!text) return null;
    if (text.includes(',')) { const [family, ...rest] = text.split(','); return { family: clean(family), given: clean(rest.join(' ')) }; }
    const parts = text.split(' ');
    if (parts.length === 1) return { literal: text };
    // "Yılmaz A. B." has the family name first; "Ahmet Yılmaz" last.
    if (parts.slice(1).every(part => INITIAL.test(part))) return { family: parts[0], given: parts.slice(1).join(' ') };
    return { family: parts.at(-1), given: parts.slice(0, -1).join(' ') };
  }
  const names = meta => (meta?.authors || []).map(parseName).filter(Boolean);
  const familyOf = name => name.literal || name.family;
  function initials(given) {
    return clean(given).split(/[\s-]+/).filter(Boolean).map(part => `${part[0].toLocaleUpperCase()}.`).join(' ');
  }
  function bibliographyName(name) {
    if (name.literal) return name.literal;
    const short = initials(name.given);
    return name.family + (short ? `, ${short}` : '');
  }

  const language = lang => lang === 'en' ? 'en' : 'tr';
  function authorLabel(meta, lang) {
    const families = names(meta).map(familyOf).filter(Boolean);
    if (!families.length) return '';
    if (families.length === 1) return families[0];
    if (families.length === 2) return families[0] + (language(lang) === 'tr' ? ' ve ' : ' & ') + families[1];
    return families[0] + (language(lang) === 'tr' ? ' vd.' : ' et al.');
  }
  function pageLabel(pages, lang) {
    const unique = [...new Set(pages.map(Number).filter(page => Number.isInteger(page) && page > 0))].sort((a, b) => a - b);
    if (!unique.length) return '';
    const tr = language(lang) === 'tr';
    return (unique.length > 1 ? (tr ? 'ss. ' : 'pp. ') : (tr ? 's. ' : 'p. ')) + unique.join(', ');
  }
  const shortTitle = title => { const words = clean(title).split(' '); return words.slice(0, 5).join(' ') + (words.length > 5 ? '…' : ''); };
  const fileLabel = source => clean(source?.fileName || '').replace(/\.(pdf|docx)$/i, '') || 'kaynak';

  // One source in a parenthetical: "Yılmaz, 2020, s. 12". Without author and title the entry is flagged incomplete.
  function sourceLabel(source, pages, lang) {
    const meta = source?.meta || {};
    if (!source) return { text: language(lang) === 'tr' ? '[silinmiş kaynak]' : '[deleted source]', incomplete: true, sortKey: '~' };
    const author = authorLabel(meta, lang) || (clean(meta.title) ? `“${shortTitle(meta.title)}”` : '');
    const page = pageLabel(pages, lang);
    if (!author) return { text: `${language(lang) === 'tr' ? 'Künye eksik' : 'Incomplete data'}: ${fileLabel(source)}${page ? ', ' + page : ''}`, incomplete: true, sortKey: '~' + fileLabel(source) };
    const year = clean(meta.year) || (language(lang) === 'tr' ? 't.y.' : 'n.d.');
    return { text: `${author}, ${year}${page ? ', ' + page : ''}`, incomplete: false, sortKey: author.toLocaleLowerCase() };
  }
  // refs: [{ docId, page }]; the same source's pages are merged, groups are ordered alphabetically (APA 7).
  function renderGroup(refs, sourcesById, lang) {
    const byDoc = new Map();
    for (const ref of refs) { if (!byDoc.has(ref.docId)) byDoc.set(ref.docId, []); byDoc.get(ref.docId).push(ref.page); }
    const labels = [...byDoc].map(([docId, pages]) => sourceLabel(sourcesById[docId], pages, lang)).sort((a, b) => a.sortKey.localeCompare(b.sortKey, 'tr'));
    return { text: labels.length ? `(${labels.map(label => label.text).join('; ')})` : '', incomplete: labels.some(label => label.incomplete) };
  }

  // "docId@page|docId@page" <-> [{ docId, page }]
  const parseRefs = value => String(value || '').split('|').map(part => { const [docId, page] = part.split('@'); return docId ? { docId, page: page ? Number(page) : null } : null; }).filter(Boolean);
  const formatRefs = refs => refs.map(ref => ref.docId + '@' + (ref.page || '')).join('|');
  const TOKEN = /\{\{c:([^}]+)\}\}/g;
  const tokenFor = refs => `{{c:${formatRefs(refs)}}}`;
  function renderText(raw, sourcesById, lang) {
    return String(raw || '').replace(TOKEN, (_, value) => renderGroup(parseRefs(value), sourcesById, lang).text);
  }
  const tokenRefs = raw => [...String(raw || '').matchAll(TOKEN)].flatMap(match => parseRefs(match[1]));

  // The APA 7 reference list entry; a verified record's own formatting wins until the user edits the data.
  function referenceEntry(source) {
    const meta = source?.meta || {};
    if (meta.apa && meta.apaHtml) return { text: meta.apa, html: meta.apaHtml };
    const list = names(meta).map(bibliographyName);
    const authors = list.length > 20 ? list.slice(0, 19).join(', ') + ', . . . ' + list.at(-1)
      : list.length > 1 ? list.slice(0, -1).join(', ') + ', & ' + list.at(-1) : list[0] || '';
    const year = clean(meta.year) || 't.y.';
    const title = clean(meta.title) || fileLabel(source);
    const parts = [];
    const add = (text, italic = false) => { if (text) parts.push({ text, italic }); };
    if (authors) { add(`${authors} (${year}). `); add(title, !meta.journal); add(/[.?!]$/.test(title) ? '' : '.'); }
    else { add(title, !meta.journal); add(/[.?!]$/.test(title) ? ' ' : '. '); add(`(${year}).`); }
    if (meta.journal) {
      add(' '); add(clean(meta.journal), true);
      if (meta.volume) { add(', '); add(clean(meta.volume), true); }
      if (meta.issue) add(`(${clean(meta.issue)})`);
      if (meta.pages) add(`, ${clean(meta.pages)}`);
      add('.');
    } else if (meta.publisher) add(` ${clean(meta.publisher)}.`);
    if (meta.doi) add(` https://doi.org/${clean(meta.doi)}`);
    return { text: parts.map(part => part.text).join(''), html: parts.map(part => part.italic ? `<em>${escapeHtml(part.text)}</em>` : escapeHtml(part.text)).join('') };
  }
  // Trust level shown next to every source: verified by an index, confirmed by the user, or still unchecked.
  const trust = meta => meta?.verified ? 'verified' : meta?.confirmed ? 'confirmed' : 'unverified';

  const api = { parseName, authorLabel, pageLabel, sourceLabel, renderGroup, renderText, parseRefs, formatRefs, tokenFor, tokenRefs, referenceEntry, trust, escapeHtml, TOKEN, familyOf: meta => names(meta).map(familyOf) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WriterCite = api;
})(typeof self !== 'undefined' ? self : this);
