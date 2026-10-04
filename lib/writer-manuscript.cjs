// The manuscript is HTML produced by the editor (a small, known set of tags). This module sanitizes it,
// reads out the plain text and the cited sources, and converts it to DOCX blocks. No HTML parser dependency:
// the editor only emits headings, paragraphs, lists, bold/italic and citation spans.
const Cite = require('../writer-cite.js');

const ALLOWED = new Set(['h1', 'h2', 'h3', 'p', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'br', 'span', 'div', 'section']);
const MAX_HTML = 2 * 1024 * 1024;
const decode = text => text.replace(/&(?:amp|lt|gt|quot|#039|#39|nbsp);/g, v => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#039;': "'", '&#39;': "'", '&nbsp;': ' ' }[v]));
const escape = Cite.escapeHtml;

// Tokenizes into text and tags; unknown tags, scripts, event handlers and styles are dropped on the way out.
function tokens(html) {
  const out = [];
  const pattern = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)\s*(\/?)>|([^<]+)|</g;
  let match;
  while ((match = pattern.exec(html))) {
    if (match[5] !== undefined) out.push({ text: match[5] });
    else if (match[2]) out.push({ tag: match[2].toLowerCase(), close: !!match[1], attrs: match[3] || '' });
  }
  return out;
}
function attribute(attrs, name) {
  const found = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return found ? decode(found[1] ?? found[2]) : '';
}

// Only structure and the citation/bibliography markers survive; everything else is rebuilt from scratch.
function sanitize(html) {
  const value = String(html || '');
  if (value.length > MAX_HTML) throw Object.assign(Error('Makale metni çok büyük.'), { status: 413 });
  const stack = [];
  let out = '', skip = 0;
  for (const token of tokens(value)) {
    if (token.text !== undefined) { if (!skip) out += escape(decode(token.text)); continue; }
    if (['script', 'style', 'iframe', 'object', 'embed', 'template'].includes(token.tag)) { skip += token.close ? -1 : 1; if (skip < 0) skip = 0; continue; }
    if (skip || !ALLOWED.has(token.tag)) continue;
    if (token.tag === 'br') { out += '<br>'; continue; }
    if (token.close) {
      const at = stack.lastIndexOf(token.tag);
      if (at >= 0) { while (stack.length > at) out += `</${stack.pop()}>`; }
      continue;
    }
    let attrs = '';
    if (token.tag === 'span' && /\bcite\b/.test(attribute(token.attrs, 'class'))) {
      const refs = Cite.formatRefs(Cite.parseRefs(attribute(token.attrs, 'data-cite')).filter(ref => /^[a-f0-9-]{36}$/.test(ref.docId)));
      attrs = refs ? ` class="cite" data-cite="${escape(refs)}" data-lang="${attribute(token.attrs, 'data-lang') === 'en' ? 'en' : 'tr'}" contenteditable="false"` : '';
      if (!refs) { stack.push('span'); out += '<span>'; continue; }
    } else if (token.tag === 'div' && attribute(token.attrs, 'data-bibliography')) attrs = ' data-bibliography="1"';
    else if (token.tag === 'p' && /\bref\b/.test(attribute(token.attrs, 'class'))) attrs = ' class="ref"';
    stack.push(token.tag); out += `<${token.tag}${attrs}>`;
  }
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}

// Renders each citation span's text from the sources' current data (so a corrected künye shows everywhere).
function renderCitations(html, sourcesById, style = 'apa') {
  // Numbered styles number the sources in the order they are first cited, so the whole manuscript is read first.
  const ctx = Cite.styleContext(style, citedDocuments(html));
  return html.replace(/<span class="cite" data-cite="([^"]*)" data-lang="(tr|en)"([^>]*)>[\s\S]*?<\/span>/g, (_, refs, lang, rest) =>
    `<span class="cite" data-cite="${refs}" data-lang="${lang}"${rest}>${escape(Cite.renderGroup(Cite.parseRefs(decode(refs)), sourcesById, lang, ctx).text)}</span>`);
}
function citedDocuments(html) {
  const ids = [];
  for (const match of String(html).matchAll(/data-cite="([^"]*)"/g)) for (const ref of Cite.parseRefs(decode(match[1]))) if (!ids.includes(ref.docId)) ids.push(ref.docId);
  return ids;
}
const plainText = html => decode(String(html || '').replace(/<\/(?:p|h[1-3]|li|div)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).replace(/\n{3,}/g, '\n\n').trim();

// The reference list for the cited sources: alphabetical in APA 7, in the order of first citation (numbered "1." / "[1]") in Vancouver and IEEE.
function bibliography(html, sourcesById, style = 'apa') {
  const numbered = Cite.isNumeric(style), ids = citedDocuments(html).filter(id => sourcesById[id]);
  const entries = ids.map((id, index) => {
    const source = sourcesById[id], entry = Cite.referenceEntry(source, style), prefix = !numbered ? '' : style === 'ieee' ? `[${index + 1}] ` : `${index + 1}. `;
    return { id, number: numbered ? index + 1 : null, text: prefix + entry.text, html: escape(prefix) + entry.html, notes: entry.notes || [], trust: Cite.trust(source.meta),
      incomplete: Cite.renderGroup([{ docId: id }], { [id]: source }, 'tr').incomplete };
  });
  return numbered ? entries : entries.sort((a, b) => a.text.localeCompare(b.text, 'tr'));
}

// DOCX blocks: [{ type: h1|h2|h3|p|li|ol|ref, runs: [{ text, bold, italic }] }]
function toBlocks(html, sourcesById, { appendBibliography = true, heading = 'Kaynakça', style = 'apa' } = {}) {
  const clean = renderCitations(sanitize(html), sourcesById, style);
  const blocks = [];
  let current = null, bold = 0, italic = 0, list = [], counter = 0, inBibliography = 0;
  const start = type => { current = { type, runs: [] }; };
  const end = () => { if (current && current.runs.some(r => r.text.trim())) blocks.push(current); current = null; };
  for (const token of tokens(clean)) {
    if (token.text !== undefined) {
      if (!current) start('p');
      const text = decode(token.text);
      if (text) current.runs.push({ text, bold: bold > 0, italic: italic > 0 });
      continue;
    }
    const { tag, close } = token;
    if (['h1', 'h2', 'h3', 'p'].includes(tag)) {
      end();
      if (!close) { start(tag === 'p' && /\bref\b/.test(attribute(token.attrs, 'class')) ? 'ref' : tag); }
    } else if (tag === 'ul' || tag === 'ol') { end(); if (!close) { list.push(tag); counter = 0; } else list.pop(); }
    else if (tag === 'li') { end(); if (!close) { start(list.at(-1) === 'ol' ? 'ol' : 'li'); if (current.type === 'ol') current.runs.push({ text: `${++counter}. ` }); } }
    else if (tag === 'div' && attribute(token.attrs, 'data-bibliography')) inBibliography += close ? -1 : 1;
    else if (tag === 'strong' || tag === 'b') bold += close ? -1 : 1;
    else if (tag === 'em' || tag === 'i') italic += close ? -1 : 1;
    else if (tag === 'br') { if (!current) start('p'); current.runs.push({ text: '\n' }); }
  }
  end();
  if (appendBibliography && !/data-bibliography/.test(clean)) {
    const entries = bibliography(clean, sourcesById, style);
    if (entries.length) {
      blocks.push({ type: 'h1', runs: [{ text: heading }] });
      for (const entry of entries) {
        const runs = [];
        for (const part of entry.html.split(/(<em>[\s\S]*?<\/em>)/)) {
          if (!part) continue;
          const italicPart = part.startsWith('<em>');
          runs.push({ text: decode(part.replace(/<\/?em>/g, '')), italic: italicPart });
        }
        blocks.push({ type: 'ref', runs });
      }
    }
  }
  return blocks;
}

module.exports = { sanitize, renderCitations, citedDocuments, plainText, bibliography, toBlocks };
