/* The one list of citation styles, shared by the browser and Node.
   family: 'author-date' (author–year in the text, alphabetical list), 'numeric' (numbers in the text, list in the order first cited)
   or 'note' (footnotes, bibliography optional or alphabetical).
   engine: 'native' (formatted by reference-engine.js / citation-styles.js) or 'csl' (csl/styles/<id>.csl through citeproc). */
(function (root) {
  const S = (id, label, family, engine, group, extra = {}) => ({ id, label, family, engine, group, ...extra });
  const STYLES = [
    S('apa', 'APA 7', 'author-date', 'native', 'Genel'),
    S('vancouver', 'Vancouver', 'numeric', 'native', 'Sağlık'),
    S('ieee', 'IEEE', 'numeric', 'native', 'Fen ve mühendislik'),
    S('mdpi', 'MDPI', 'numeric', 'native', 'Fen ve mühendislik'),
    S('isnad-metinici', 'İSNAD 2 (metin içi)', 'author-date', 'csl', 'Türkçe', { locale: 'tr-TR' }),
    S('isnad-dipnotlu', 'İSNAD 2 (dipnotlu)', 'note', 'csl', 'Türkçe', { locale: 'tr-TR' }),
    S('modern-language-association', 'MLA 9', 'author-date', 'csl', 'Genel', { inText: 'author-page' }),
    S('chicago-author-date', 'Chicago / CMOS 18 (yazar-tarih)', 'author-date', 'csl', 'Genel'),
    S('chicago-notes-bibliography', 'Chicago / CMOS 18 (notlar ve kaynakça)', 'note', 'csl', 'Genel'),
    S('chicago-author-date-17th-edition', 'Chicago / CMOS 17 (yazar-tarih)', 'author-date', 'csl', 'Genel'),
    S('chicago-notes-bibliography-17th-edition', 'Chicago / CMOS 17 (notlar ve kaynakça)', 'note', 'csl', 'Genel'),
    S('harvard-cite-them-right', 'Harvard', 'author-date', 'csl', 'Genel'),
    S('american-medical-association', 'AMA', 'numeric', 'csl', 'Sağlık'),
    S('american-chemical-society', 'ACS', 'numeric', 'csl', 'Fen ve mühendislik'),
    S('american-sociological-association', 'ASA', 'author-date', 'csl', 'Sosyal bilimler'),
    S('american-political-science-association', 'APSA (siyaset bilimi)', 'author-date', 'csl', 'Sosyal bilimler'),
    S('cse-citation-sequence', 'CSE 9 (numaralı)', 'numeric', 'csl', 'Fen ve mühendislik'),
    S('cse-name-year', 'CSE 9 (yazar-yıl)', 'author-date', 'csl', 'Fen ve mühendislik'),
    S('oscola', 'OSCOLA (hukuk, dipnotlu)', 'note', 'csl', 'Hukuk'),
    S('apa-6th-edition', 'APA 6', 'author-date', 'csl', 'Genel'),
    S('nature', 'Nature', 'numeric', 'csl', 'Dergi'),
    S('science', 'Science', 'numeric', 'csl', 'Dergi'),
    S('cell', 'Cell', 'numeric', 'csl', 'Dergi'),
    S('the-lancet', 'The Lancet', 'numeric', 'csl', 'Dergi'),
    S('springer-basic-author-date', 'Springer', 'author-date', 'csl', 'Dergi'),
    S('elsevier-harvard', 'Elsevier (Harvard)', 'author-date', 'csl', 'Dergi'),
    S('bmj', 'BMJ', 'numeric', 'csl', 'Dergi'),
    S('plos', 'PLOS', 'numeric', 'csl', 'Dergi')
  ];
  // Styles that print article titles in sentence case, and styles that abbreviate journal names with periods ("J. Am. Chem. Soc."); the rest keep the title as registered.
  const SENTENCE_CASE = new Set(['apa-6th-edition', 'american-medical-association', 'american-chemical-society', 'cse-citation-sequence', 'cse-name-year', 'nature', 'science', 'cell', 'the-lancet', 'bmj', 'plos', 'springer-basic-author-date', 'elsevier-harvard', 'harvard-cite-them-right']);
  const ABBREVIATION_PERIODS = new Set(['american-chemical-society', 'nature', 'science', 'cell']);
  // How a numbered style marks the citation in the text, and how an author–date style writes it: "(Zhang 2021)" without a comma, or author and page only (MLA).
  const MARKS = { vancouver: 'brackets', ieee: 'brackets', mdpi: 'brackets', plos: 'brackets', bmj: 'brackets', science: 'parens',
    'american-medical-association': 'superscript', 'american-chemical-society': 'superscript', 'cse-citation-sequence': 'superscript', nature: 'superscript', cell: 'superscript', 'the-lancet': 'superscript' };
  const COMMALESS = new Set(['chicago-author-date', 'chicago-author-date-17th-edition', 'american-sociological-association', 'american-political-science-association', 'cse-name-year', 'springer-basic-author-date']);
  for (const style of STYLES) { style.mark = MARKS[style.id] || null; style.commaless = COMMALESS.has(style.id); style.authorOnly = style.id === 'modern-language-association'; }
  for (const style of STYLES) { style.sentenceCase = SENTENCE_CASE.has(style.id); style.abbreviationPeriods = ABBREVIATION_PERIODS.has(style.id); }
  const byId = Object.fromEntries(STYLES.map(style => [style.id, style]));
  const get = id => byId[id] || null;
  const has = id => Object.prototype.hasOwnProperty.call(byId, id);
  const ids = () => STYLES.map(style => style.id);
  // The numbered styles that list references in the order they are first cited (native and CSL).
  const isNumeric = id => get(id)?.family === 'numeric';
  const isNote = id => get(id)?.family === 'note';
  const isAuthorDate = id => get(id)?.family === 'author-date';
  const isCsl = id => get(id)?.engine === 'csl';
  const label = id => get(id)?.label || 'APA 7';
  const normalize = (id, fallback = 'apa') => has(id) ? id : fallback;
  // [{ group, styles: [...] }] in the order the groups first appear: for <optgroup>.
  function groups() {
    const out = [];
    for (const style of STYLES) { let g = out.find(item => item.group === style.group); if (!g) out.push(g = { group: style.group, styles: [] }); g.styles.push(style); }
    return out;
  }
  // Fills a <select> with every style (grouped); `extra` options (e.g. Otomatik) come first.
  function fillSelect(select, { extra = [], value } = {}) {
    const doc = select.ownerDocument, current = value ?? select.value;
    select.textContent = '';
    for (const [id, text] of extra) { const option = doc.createElement('option'); option.value = id; option.textContent = text; select.append(option); }
    for (const { group, styles } of groups()) {
      const optgroup = doc.createElement('optgroup'); optgroup.label = group;
      for (const style of styles) { const option = doc.createElement('option'); option.value = style.id; option.textContent = style.label; optgroup.append(option); }
      select.append(optgroup);
    }
    if (current && [...select.options].some(option => option.value === current)) select.value = current;
  }
  const api = { STYLES, get, has, ids, isNumeric, isNote, isAuthorDate, isCsl, label, normalize, groups, fillSelect };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StyleRegistry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
