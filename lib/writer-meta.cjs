// Bibliographic data (künye) of an uploaded source: read from the file, then checked against the indexes.
// The result is only a guess until verified or confirmed by the user; the UI shows which.
const Engine = require('../reference-engine.js');
const Analysis = require('../word-analysis.cjs');
const Verification = require('./verification.cjs');
const Backend = require('./backend.cjs');

const GENERIC_TITLE = /^(?:microsoft word\s*-|untitled|adsız|document\d*|belge\d*|slayt|paper|makale|tez|rapor)\b|\.(?:docx?|pdf|tex|indd)$/i;
const YEAR = /\b(19[5-9]\d|20[0-4]\d)\b/;

function splitAuthors(value) {
  return String(value || '').split(/\s*(?:;|\band\b|\bve\b|&|\n)\s*/i).map(v => v.trim()).filter(v => v && v.length < 120 && !/@|^\d/.test(v));
}
function guessTitle(paragraphs, fileMeta) {
  const fromFile = String(fileMeta?.title || '').replace(/\s+/g, ' ').trim();
  if (fromFile.length >= 8 && !GENERIC_TITLE.test(fromFile)) return fromFile.slice(0, 300);
  const candidates = paragraphs.filter(p => p.part === 'word/document.xml').slice(0, 12).map(p => p.text.replace(/\s+/g, ' ').trim());
  const heading = candidates.find((text, i) => /^(?:title|başlık)/i.test(paragraphs[i]?.style || '') && text.length >= 8);
  const first = heading || candidates.find(text => text.length >= 12 && text.length <= 250 && !/^(?:abstract|özet|doi|https?:|©|\d)/i.test(text));
  return (first || '').slice(0, 300);
}
// Authors from the line under the title ("Smith, J. and Brown, K." / "Ahmet Yılmaz ve Ayşe Kaya"); anything that
// does not look like a list of names is ignored, and the result stays "unverified" until the user or an index confirms it.
const ORGANIZATION = /(?:üniversite|university|fakülte|faculty|department|bölüm|institute|enstitü|dergi|journal|hospital|hastane|okul|school|college|akademi|academy|center|merkez)/i;
function guessAuthors(paragraphs, title) {
  const lines = paragraphs.filter(p => p.part === 'word/document.xml').slice(0, 8).map(p => p.text.replace(/\s+/g, ' ').trim());
  const at = title ? lines.findIndex(line => line.startsWith(title.slice(0, 40))) : -1;
  const NAME = /^(?:\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+){1,3}|\p{Lu}[\p{L}'’-]+,\s*(?:\p{Lu}\.\s*){1,3})$/u;
  for (const raw of lines.slice(at + 1, at + 4)) {
    const line = raw.replace(/^(?:published|yayın(?:lanma)?|by|yazar(?:lar)?|authors?)\s*[:.]?\s*(?:\d{4}\.?\s*)?/i, '').replace(/\s*\b(?:19|20)\d\d\b\.?$/, '').replace(/(?<!\b\p{Lu})\.$/u, '').trim();
    if (!line || line.length > 140 || line.split(/\s+/).length > 16) continue;
    const parts = line.split(/\s*(?:;|&|\band\b|\bve\b)\s*/i).flatMap(part => /,\s*(?:\p{Lu}\.\s*){1,3}\s*,/u.test(part + ',') ? part.split(/(?<=\.)\s*,\s*/) : [part]).map(v => v.trim()).filter(Boolean);
    if (parts.length && parts.length <= 8 && parts.every(part => NAME.test(part) && !ORGANIZATION.test(part))) return parts;
  }
  return [];
}
function guessYear(text, fileName) {
  const front = text.slice(0, 2500);
  const marked = front.match(/(?:©|copyright|published|yayın(?:lanma)?|accepted|received)[^\d]{0,30}(?:\d{1,2}\s+\w+\s+)?(19[5-9]\d|20[0-4]\d)/i)?.[1];
  return marked || front.match(YEAR)?.[1] || String(fileName || '').match(YEAR)?.[1] || '';
}

function extract({ paragraphs, fileMeta = {}, fileName = '' }) {
  const front = paragraphs.filter(p => p.part === 'word/document.xml').slice(0, 30).map(p => p.text).join(' ');
  const doi = Engine.getDoi(front.slice(0, 6000)) || '';
  const title = guessTitle(paragraphs, fileMeta);
  const fileAuthors = splitAuthors(fileMeta.author);
  return {
    title,
    authors: fileAuthors.length ? fileAuthors : guessAuthors(paragraphs, title),
    year: guessYear(front, fileName),
    doi,
    journal: '', publisher: '', volume: '', issue: '', pages: '',
    language: Analysis.isTurkish(front.slice(0, 3000)) ? 'tr' : 'en',
    verified: false, confirmed: false, source: 'auto', provider: '',
  };
}

// With a DOI the record itself is the source of the künye: the query is the bare DOI, so the title, authors and year guessed
// from the file (often wrong) cannot make the lookup fail. Without one, an APA-like line is searched by title.
const doiQuery = meta => meta.doi ? `https://doi.org/${meta.doi}` : '';
// A query in the shape the verification service already understands (an APA-like reference line).
function queryLine(meta) {
  const authors = (meta.authors || []).join(', ');
  return `${authors ? authors + ' ' : ''}(${meta.year || 't.y.'}). ${meta.title || ''}.${meta.doi ? ' https://doi.org/' + meta.doi : ''}`.trim();
}
function fromMatched(meta, result) {
  const m = result.matched || {};
  const authors = (m.author || []).map(a => a.literal ? a.literal : `${a.family || ''}${a.given ? ', ' + a.given : ''}`).filter(Boolean);
  return {
    ...meta,
    title: m.title || meta.title,
    authors: authors.length ? authors : meta.authors,
    year: m.year ? String(m.year) : meta.year,
    doi: m.doi || meta.doi,
    journal: m.containerTitle || '', publisher: m.publisher || '', volume: m.volume ? String(m.volume) : '', issue: m.issue ? String(m.issue) : '', pages: m.pages || '',
    apa: result.suggested || result.corrected || '', apaHtml: result.suggestedHtml || '',
    verified: true, provider: result.provider || '',
  };
}
// Runs one verification and resolves with the updated meta, or null when nothing matched with confidence.
function verify(meta, { port } = {}) {
  return new Promise(resolve => {
    if (!doiQuery(meta) && (!meta.title || meta.title.length < 8)) return resolve(null);
    let run, settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); try { run?.terminate?.(); } catch {} resolve(value); };
    const timer = setTimeout(() => finish(null), 120000);
    try {
      run = Verification.start({ proxy: `http://127.0.0.1:${port}/api/proxy`, references: [doiQuery(meta) || queryLine(meta)], initialResults: [], googleBooksConfigured: !!process.env.GOOGLE_BOOKS_API_KEY }, { queue: Backend.queue() });
    } catch { return finish(null); }
    run.on('message', m => {
      if (m.type === 'result') finish(m.result?.status === 'verified' && m.result.matched ? fromMatched(meta, m.result) : null);
      if (m.type === 'done' || m.type === 'error') finish(null);
    });
    run.on('error', () => finish(null));
  });
}

module.exports = { guessAuthors, extract, verify, queryLine, doiQuery, fromMatched, splitAuthors, guessYear };
