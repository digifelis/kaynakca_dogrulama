/* CSL styles (csl/styles/*.csl) through citeproc-js, shared by the browser and Node.
   One bibliographic record (the shape the reference engine uses) goes in; per-record citation strings, bibliography entries and notes come out.
   Assets (the style file and the locales) are loaded first: loadAssetsSync(styleId) in Node, await loadAssets(styleId) in the browser. */
(function (root) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const Styles = isNode ? require('./citation-styles.js') : root.CitationStyles;
  const Registry = isNode ? require('./style-registry.js') : root.StyleRegistry;
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const LOCALES = ['en-US', 'tr-TR'];

  // ---- record -> CSL-JSON
  const CSL_TYPES = { article: 'article-journal', book: 'book', chapter: 'chapter', conference: 'paper-conference', report: 'report', web: 'webpage', preprint: 'article' };
  function language(item, style) { return style?.locale ? style.locale.slice(0, 2) : item.language === 'tr' ? 'tr' : 'en'; }
  function toCslItem(item, id, { style, helpers = {}, today } = {}) {
    const kind = Styles.typeOf(item), doi = clean(item.doi).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
    const names = (item.author || []).map(Styles.person).filter(Boolean).map(name => name.literal ? { literal: name.literal } : name.given ? { family: name.family, given: name.given } : { family: name.family });
    const out = { id, type: CSL_TYPES[kind] || 'article-journal', language: language(item, style) };
    if (names.length) out.author = names;
    let title = clean(item.title).replace(/[.]+$/, '');
    if (style?.sentenceCase && kind !== 'book' && kind !== 'report' && !item.keepTitle && helpers.sentenceCase) title = helpers.sentenceCase(title, item.language, item.properNouns);
    out.title = title;
    const year = Number(item.year), month = Number(item.month);
    if (year) out.issued = { 'date-parts': [month >= 1 && month <= 12 ? [year, month] : [year]] };
    if (kind === 'web') {
      out.URL = clean(item.url);
      const site = clean(item.site || item.publisher); if (site) out['container-title'] = site;
      const t = Styles.todayParts(today); out.accessed = { 'date-parts': [[t.year, t.month + 1, t.day]] };
    } else if (kind === 'preprint') {
      out.publisher = 'arXiv'; out.number = clean(item.arxiv); out.URL = `https://arxiv.org/abs/${clean(item.arxiv)}`;
    } else {
      if (clean(item.containerTitle)) {
        out['container-title'] = clean(item.containerTitle);
        const short = Styles.journalAbbreviation(item, { periods: !!style?.abbreviationPeriods });
        if (short.text) out['container-title-short'] = short.text;
      }
      if (clean(item.volume)) out.volume = clean(item.volume);
      if (clean(item.issue)) out.issue = clean(item.issue);
      if (clean(item.pages)) out.page = clean(item.pages).replace(/\s*[-‐‑‒–—]+\s*/g, '-');
      if (clean(item.publisher)) out.publisher = clean(item.publisher);
      if (clean(item.place)) out['publisher-place'] = clean(item.place);
      if (clean(item.edition)) out.edition = clean(item.edition).replace(/\s*(?:ed\.?|edition|baskı)$/i, '');
      if (doi) out.DOI = doi;
    }
    return out;
  }

  // ---- citeproc output -> display
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  const decode = text => text.replace(/&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi, (_, dec, hex, name) => dec ? String.fromCodePoint(+dec) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ENTITIES[name.toLowerCase()]);
  // Superscript numbers (Nature, AMA, ...) become Unicode superscript digits so a plain-text copy still shows them raised.
  const SUPERSCRIPT = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '-': '⁻', '–': '⁻', '+': '⁺', '(': '⁽', ')': '⁾' };
  const raised = html => html.replace(/<sup>([^<]*)<\/sup>/gi, (_, inner) => Array.from(inner).map(char => SUPERSCRIPT[char] || char).join(''));
  const toText = html => decode(raised(html).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  // Only emphasis, strong, superscript, subscript and small caps survive; everything else citeproc adds is dropped.
  function toHtml(html) {
    return html.replace(/<(\/?)([a-z0-9]+)([^>]*)>/gi, (_, close, tag, attrs) => {
      tag = tag.toLowerCase();
      if (tag === 'i') return close ? '</em>' : '<em>';
      if (tag === 'b') return close ? '</strong>' : '<strong>';
      if (tag === 'sup' || tag === 'sub') return `<${close}${tag}>`;
      if (tag === 'span' && /small-caps/i.test(attrs)) return close ? '</span>' : '<span style="font-variant:small-caps">';
      if (tag === 'span' && close) return '</span>';
      return '';
    }).replace(/&#(\d+);/g, (match, code) => code === '38' ? '&amp;' : code === '60' ? '&lt;' : code === '62' ? '&gt;' : String.fromCodePoint(+code)).replace(/\s+/g, ' ').trim();
  }
  // "<div class="csl-entry"><div class="csl-left-margin">1.</div><div class="csl-right-inline">Body</div></div>" -> { label: '1.', body }
  function splitEntry(raw, numeric) {
    const left = raw.match(/<div class="csl-left-margin">([\s\S]*?)<\/div>/), right = raw.match(/<div class="csl-right-inline">([\s\S]*)<\/div>\s*<\/div>\s*$/);
    if (left && right) return { label: toText(left[1]), body: right[1] };
    let body = raw.replace(/^\s*<div[^>]*>/, '').replace(/<\/div>\s*$/, '');
    // Some numbered styles (CSE) print the number inside the entry text.
    const inline = numeric && body.match(/^\s*(\(?\[?\d+[.)\]]?)\s+/);
    if (inline) return { label: inline[1], body: body.slice(inline[0].length) };
    return { label: '', body };
  }

  // ---- assets
  const assetCache = new Map();
  function assetNames(styleId) { const style = Registry.get(styleId); if (!style || style.engine !== 'csl') throw Error('Desteklenmeyen atıf stili: ' + styleId); return style; }
  function loadAssetsSync(styleId) {
    assetNames(styleId);
    if (assetCache.has(styleId)) return assetCache.get(styleId);
    const fs = require('fs'), path = require('path'), dir = path.join(__dirname, 'csl');
    const assets = { style: fs.readFileSync(path.join(dir, 'styles', styleId + '.csl'), 'utf8'), locales: Object.fromEntries(LOCALES.map(code => [code, fs.readFileSync(path.join(dir, 'locales', `locales-${code}.xml`), 'utf8')])) };
    assetCache.set(styleId, assets);
    return assets;
  }
  let browserLoad = null;
  function loadCiteproc() {
    if (root.CSL) return Promise.resolve();
    return browserLoad ||= new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = '/vendor/citeproc.js'; script.onload = resolve; script.onerror = () => reject(Error('citeproc yüklenemedi')); document.head.append(script); });
  }
  async function loadAssets(styleId) {
    assetNames(styleId);
    if (assetCache.has(styleId)) return assetCache.get(styleId);
    await loadCiteproc();
    const get = async url => { const response = await fetch(url); if (!response.ok) throw Error('Stil dosyası alınamadı: ' + url); return response.text(); };
    const [style, ...locales] = await Promise.all([get(`/csl/styles/${styleId}.csl`), ...LOCALES.map(code => get(`/csl/locales/locales-${code}.xml`))]);
    const assets = { style, locales: Object.fromEntries(LOCALES.map((code, index) => [code, locales[index]])) };
    assetCache.set(styleId, assets);
    return assets;
  }
  const isLoaded = styleId => assetCache.has(styleId);

  // ---- rendering
  const citeproc = () => isNode ? require('citeproc') : root.CSL;
  function createEngine(styleId, assets, cslItems, lang) {
    const CSL = citeproc();
    const sys = { retrieveLocale: code => assets.locales[code] || assets.locales[LOCALES.find(l => l.slice(0, 2) === String(code).slice(0, 2))] || assets.locales['en-US'], retrieveItem: id => cslItems[id] };
    const engine = new CSL.Engine(sys, assets.style, lang, true);
    engine.setOutputFormat('html');
    return engine;
  }
  /* records: [{ id, item }]; clusters: [[{ id, locator?, label?, prefix?, suffix?, 'suppress-author'? }]] in text order (default: every record cited once, in order).
     options: { assets, helpers, today }. Returns { citations: [{ html, text }], bibliography: [{ id, html, text, label }], labelPattern, notes: { id: [..] } }. */
  function render(styleId, records, clusters, options = {}) {
    const style = assetNames(styleId), assets = options.assets || loadAssetsSync(styleId);
    const cslItems = {}, notes = {};
    for (const { id, item } of records) {
      cslItems[id] = toCslItem(item, id, { style, helpers: options.helpers, today: options.today });
      const list = notes[id] = [];
      if (!cslItems[id].author) list.push('Yazar bilgisi bulunamadı');
    }
    const engine = createEngine(styleId, assets, cslItems, style.locale || 'en-US');
    const plan = clusters || records.map(({ id }) => [{ id }]);
    const noteStyle = style.family === 'note', strings = new Map(), before = [];
    plan.forEach((cluster, index) => {
      const citation = { citationID: 'c' + index, citationItems: cluster.map(entry => ({ ...entry })), properties: { noteIndex: noteStyle ? index + 1 : 0 } };
      const result = engine.processCitationCluster(citation, before.slice(), []);
      for (const [, text, citationID] of result[1]) strings.set(citationID, text);
      before.push([citation.citationID, citation.properties.noteIndex]);
    });
    const citations = plan.map((_, index) => { const html = strings.get('c' + index) || ''; return { html: toHtml(html), text: toText(html) }; });
    const made = engine.makeBibliography(), bibliography = [];
    let labelPattern = '';
    if (made) {
      const ids = made[0].entry_ids.map(entry => entry[0]);
      made[1].forEach((raw, index) => {
        const { label, body } = splitEntry(raw, style.family === 'numeric');
        bibliography.push({ id: ids[index], html: toHtml(body), text: toText(body), label });
      });
      const first = bibliography.find(entry => entry.id === records[0]?.id);
      if (first?.label && style.family === 'numeric') labelPattern = first.label.replace(/\d+/, '{n}');
    }
    return { citations, bibliography, labelPattern, notes };
  }
  // A citing session for a manuscript: the records in the order they are first cited (that order is the citation number of numbered styles),
  // then cite([{ id, locator?, label? }]) for any group in the text and bibliography() for the list. Needs the style assets loaded.
  function session(styleId, records, options = {}) {
    const style = assetNames(styleId), assets = options.assets || loadAssetsSync(styleId), cslItems = {};
    for (const { id, item } of records) cslItems[id] = toCslItem(item, id, { style, helpers: options.helpers, today: options.today });
    const engine = createEngine(styleId, assets, cslItems, style.locale || 'en-US');
    engine.updateItems(records.map(record => record.id));
    return {
      cite(entries) { const html = engine.makeCitationCluster(entries.map(entry => ({ ...entry }))); return { html: toHtml(html), text: toText(html) }; },
      bibliography() {
        const made = engine.makeBibliography();
        if (!made) return [];
        const ids = made[0].entry_ids.map(entry => entry[0]);
        return made[1].map((raw, index) => { const { label, body } = splitEntry(raw, style.family === 'numeric'); return { id: ids[index], html: toHtml(body), text: toText(body), label }; });
      }
    };
  }

  // Each record on its own, in the given order: what the verification page shows for one reference.
  // { id, text, html, note: { text, html } | null, notes } per record; numbered styles add `label` (the list label of its position).
  function formatEach(styleId, records, options = {}) {
    const rendered = render(styleId, records, null, options), style = Registry.get(styleId);
    const byId = new Map(rendered.bibliography.map(entry => [entry.id, entry]));
    return records.map(({ id }, index) => {
      const entry = byId.get(id), citation = rendered.citations[index];
      const body = entry || citation;
      const label = rendered.labelPattern ? rendered.labelPattern.replace('{n}', index + 1) : '';
      return { id, text: body.text, html: body.html, label, note: style.family === 'note' && entry ? citation : null, notes: rendered.notes[id] || [], style: styleId };
    });
  }
  // One record in a style, in the shape citation-styles.js format() returns.
  // The engine of a style is built once (parsing a style file costs far more than formatting) and reused: updateItems([id]) leaves exactly this record registered.
  const engines = new Map();
  let serial = 0;
  function formatOne(styleId, item, helpers = {}, options = {}) {
    const style = assetNames(styleId), assets = options.assets || loadAssetsSync(styleId);
    let shared = engines.get(styleId);
    if (!shared) engines.set(styleId, shared = { items: {} });
    const id = 'i' + ++serial;
    shared.items[id] = toCslItem(item, id, { style, helpers, today: options.today });
    shared.engine ||= createEngine(styleId, assets, new Proxy({}, { get: (_, key) => shared.items[key] }), style.locale || 'en-US');
    const engine = shared.engine, notes = shared.items[id].author ? [] : ['Yazar bilgisi bulunamadı'];
    engine.updateItems([id]);
    const made = engine.makeBibliography(), cite = engine.makeCitationCluster([{ id }]);
    delete shared.items[id];
    const parts = made ? splitEntry(made[1][0], style.family === 'numeric') : { label: '', body: cite };
    const label = style.family === 'numeric' ? (parts.label ? listLabel(styleId, 1) : '') : '';
    return { text: toText(parts.body), html: toHtml(parts.body), parts: [], notes, style: styleId, label, note: style.family === 'note' && made ? { html: toHtml(cite), text: toText(cite) } : null };
  }

  // The list label of entry n in a numbered style: "1.", "(1)", "[1]" (from a sample record); '' when the style prints none.
  const patterns = new Map();
  const SAMPLE = { type: 'article', author: [{ family: 'Doe', given: 'Jane' }], title: 'Sample', containerTitle: 'Journal', year: 2020, volume: '1', pages: '1-2' };
  function listLabel(styleId, number) {
    if (!patterns.has(styleId)) patterns.set(styleId, render(styleId, [{ id: 'sample', item: SAMPLE }], null, { assets: assetCache.get(styleId) }).labelPattern);
    return patterns.get(styleId).replace('{n}', number);
  }

  const api = { session, listLabel, toCslItem, render, formatEach, formatOne, loadAssets, loadAssetsSync, isLoaded, LOCALES };
  if (isNode) module.exports = api; else root.CslEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
