// Splits an extracted document (paragraphs from the Word/PDF reader) into searchable passages.
// A passage keeps the page it starts on and the heading it sits under, so answers can cite "s. 12".
const Analysis = require('../word-analysis.cjs');

const words = text => text.split(/\s+/).filter(Boolean);
const isHeading = p => /^(?:heading|başlık|baslik|title)/i.test(p.style || '');

// The document's own bibliography is not evidence for what the document says; it is dropped before indexing
// (and so never sent to the embedding service), and so is the abstract.
const REFERENCE_HEADING = /^(?:(?:\d+(?:\.\d+)*|[IVX]+)[.)]?\s*)?(?:kaynak[çc]a(?:\s+listesi)?|kaynaklar|referanslar|yararlan[ıi]lan\s+kaynaklar|references?(?:\s+list)?|bibliography|works\s+cited|literature\s+cited)\s*[:.]?$/i;
const APPENDIX_HEADING = /^(?:(?:\d+[.)]?\s*)?(?:ekler|ek\s*[\dA-Z]+|appendi(?:x|ces)|özgeçmiş|curriculum\s+vitae|dizin|index|teşekkür|acknowledg(?:e)?ments?)\b)/i;
// One bibliography entry: a year in parentheses or after the author, plus a publication marker (DOI, link, volume, pages, "In:").
const referenceLike = text => {
  const t = text.trim();
  if (t.length < 25 || t.length > 900) return false;
  const year = /\(\s*(?:1[6-9]|20)\d{2}[a-z]?\s*\)|[.,]\s*(?:1[6-9]|20)\d{2}[a-z]?[.;,]/.test(t);
  const marker = /doi|https?:\/\/|\bvol\.|\bpp?\.\s*\d|\d+\(\d+\)|(?<![\p{L}])(?:In|Proceedings|Journal|Press|Conference|Dergisi|Yayınları|Üniversitesi)(?![\p{L}])|^\[\d+\]/iu.test(t);
  return (year && marker) || /^\[\d+\]\s/.test(t);
};
function referenceRange(main) {
  const ahead = (from, count) => main.slice(from + 1, from + 1 + count);
  // The last heading that really is followed by entries wins: a table of contents also lists "Kaynakça".
  for (let i = main.length - 1; i >= 0; i--) {
    const text = main[i].text.trim();
    if (text.length > 60 || !REFERENCE_HEADING.test(text)) continue;
    const next = ahead(i, 10);
    if (next.filter(p => referenceLike(p.text)).length < Math.min(3, Math.ceil(next.length / 2) || 1)) continue;
    let end = main.length - 1;
    for (let j = i + 1; j < main.length; j++) {
      const t = main[j].text.trim();
      if (APPENDIX_HEADING.test(t) && t.length < 60 || (isHeading(main[j]) && !referenceLike(t) && !REFERENCE_HEADING.test(t))) { end = j - 1; break; }
    }
    return [i, end];
  }
  // No heading found: a run of entries closing the document is the bibliography.
  // One stray line (a wrapped entry, a page number) inside the run is tolerated.
  let first = main.length, entries = 0, misses = 0;
  for (let i = main.length - 1; i >= 0; i--) {
    if (referenceLike(main[i].text)) { first = i; entries++; misses = 0; } else if (++misses > 1) break;
  }
  return entries >= 5 ? [first, main.length - 1] : null;
}
// The document's own abstract (Özet / Abstract, with its keywords) summarises the paper rather than reporting it,
// so it is dropped before indexing too. The reader still gets a section's full text from the body.
const ABSTRACT_HEADING = /^(?:\d+[.)]?\s*)?(?:abstract|özet|öz)\s*[:.]?$/i;
const ABSTRACT_INLINE = /^(?:abstract|özet|öz)\s*[:.\-—–]\s*\S/i;
const ABSTRACT_END = /^(?:(?:\d+(?:\.\d+)*|[IVX]+)[.)]?\s*)?(?:key\s?words?|index\s+terms|anahtar\s+kelimeler|introduction|giriş|background|literatür|literature\s+review)\b/i;
const KEYWORD_LINE = /^(?:key\s?words?|index\s+terms|anahtar\s+kelimeler)\s*[:\-—–]/i;
function withoutAbstract(main) {
  const out = [];
  let skipping = false, size = 0;
  for (const p of main) {
    const text = p.text.trim();
    if (!skipping && (ABSTRACT_HEADING.test(text) && text.length < 40 || ABSTRACT_INLINE.test(text))) { skipping = true; size = 0; continue; }
    if (skipping) {
      if (KEYWORD_LINE.test(text)) { skipping = false; continue; }
      if (ABSTRACT_END.test(text) || ABSTRACT_HEADING.test(text) || isHeading(p) || size > 600) skipping = false;
      else { size += words(text).length; continue; }
    }
    out.push(p);
  }
  return out;
}
function bodyParagraphs(paragraphs) {
  const main = paragraphs.filter(p => p.part === 'word/document.xml' && p.text && p.text.trim());
  const range = referenceRange(main);
  if (range) return withoutAbstract(main.filter((_, i) => i < range[0] || i > range[1]));
  const found = Analysis.extractReferences(paragraphs);
  if (found.needsRange) return withoutAbstract(main);
  const { start, end } = found.range;
  // start - 1 is the "Kaynakça" heading itself.
  return withoutAbstract(main.filter(p => p.index < start - 1 || p.index > end));
}

// Sentences of an over-long paragraph, regrouped so no passage exceeds the word budget.
function splitLong(text, maxWords) {
  const pieces = [];
  let current = [];
  for (const sentence of Analysis.sentences(text).map(s => s.text)) {
    const size = words(sentence).length;
    if (current.length && words(current.join(' ')).length + size > maxWords) { pieces.push(current.join(' ')); current = []; }
    // A single sentence longer than the budget is cut by words.
    if (size > maxWords) { const all = words(sentence); for (let i = 0; i < all.length; i += maxWords) pieces.push(all.slice(i, i + maxWords).join(' ')); continue; }
    current.push(sentence);
  }
  if (current.length) pieces.push(current.join(' '));
  return pieces;
}

function chunkParagraphs(paragraphs, { maxWords = 300, minWords = 12, overlapWords = 40 } = {}) {
  const chunks = [];
  let section = '', current = null;
  const flush = () => {
    if (current && words(current.text).length >= 8) chunks.push({ page: current.page, section: current.section, text: current.text.trim() });
    // The tail of the finished passage starts the next one, so a claim split at the boundary is still found whole.
    const tail = current ? words(current.text).slice(-overlapWords).join(' ') : '';
    current = null;
    return tail;
  };
  let carry = '';
  for (const p of bodyParagraphs(paragraphs)) {
    const text = p.text.replace(/\s+/g, ' ').trim();
    if (isHeading(p) && text.length < 200) { flush(); carry = ''; section = text; continue; }
    const pieces = words(text).length > maxWords ? splitLong(text, maxWords) : [text];
    for (const piece of pieces) {
      const size = words(piece).length;
      const currentSize = current ? words(current.text).length : 0;
      // A page change closes a passage that is already substantial, so the cited page stays accurate.
      const pageChanged = current && p.page && current.page && p.page !== current.page && currentSize >= minWords;
      if (current && (currentSize + size > maxWords || pageChanged)) carry = flush();
      if (!current) current = { page: p.page || null, section, text: carry ? carry + ' ' : '' };
      current.text += (current.text && !current.text.endsWith(' ') ? ' ' : '') + piece;
      if (!current.page && p.page) current.page = p.page;
    }
  }
  flush();
  return chunks;
}

module.exports = { chunkParagraphs, bodyParagraphs };
