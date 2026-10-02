// Splits an extracted document (paragraphs from the Word/PDF reader) into searchable passages.
// A passage keeps the page it starts on and the heading it sits under, so answers can cite "s. 12".
const Analysis = require('../word-analysis.cjs');

const words = text => text.split(/\s+/).filter(Boolean);
const isHeading = p => /^(?:heading|başlık|baslik|title)/i.test(p.style || '');

// The document's own bibliography is not evidence for what the document says; it is dropped before indexing.
function bodyParagraphs(paragraphs) {
  const main = paragraphs.filter(p => p.part === 'word/document.xml' && p.text && p.text.trim());
  const found = Analysis.extractReferences(paragraphs);
  if (found.needsRange) return main;
  const { start, end } = found.range;
  // start - 1 is the "Kaynakça" heading itself.
  return main.filter(p => p.index < start - 1 || p.index > end);
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
