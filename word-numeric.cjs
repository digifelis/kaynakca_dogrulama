// Numbered citations ([1], [1,3], [1-3], [1]–[3], [3, p. 12]) for the Word/PDF checks: Vancouver and IEEE documents.
// The author–year checks live in word-analysis.cjs; this module reads the numbers, matches them to the numbered
// reference list and reports what is wrong with the numbering and with the entries' style.
const NUMERIC_STYLES = new Set(['vancouver', 'ieee']);
const isNumeric = style => NUMERIC_STYLES.has(style);
const STYLE_NAMES = { apa: 'APA 7', vancouver: 'Vancouver', ieee: 'IEEE' };

// A typed list number at the start of a reference: "[3] ", "3. ", "3) ".
const LABEL = /^\s*(?:\[(\d{1,3})\]|(\d{1,3})[.)])\s+(?=\S)/;
function splitLabel(raw) {
  const match = String(raw).match(LABEL);
  if (!match) return { number: null, prefix: '', body: String(raw), form: '' };
  return { number: Number(match[1] || match[2]), prefix: match[0], body: String(raw).slice(match[0].length), form: match[1] ? 'bracket' : 'dot' };
}

// One bracket group: "[1]", "[1,3]", "[1, 3-5]", "[3, p. 12]", or the IEEE range "[1]–[3]".
const GROUP = /\[\s*(\d{1,3}(?:\s*[,;]\s*\d{1,3}|\s*[-–—]\s*\d{1,3})*)\s*(?:,\s*(?:ss?|pp?)\.\s*\d+(?:\s*[-–—]\s*\d+)?)?\s*\](?:\s*[-–—]\s*\[\s*(\d{1,3})\s*\])?/g;
const MAX_RANGE = 200;
function expand(list, rangeEnd) {
  const numbers = [];
  const parts = list.split(/[,;]/).map(part => part.trim()).filter(Boolean);
  for (const part of parts) {
    const range = part.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
    if (range) {
      const a = Number(range[1]), b = Number(range[2]);
      if (b < a || b - a > MAX_RANGE) return null;
      for (let n = a; n <= b; n++) numbers.push(n);
    } else numbers.push(Number(part));
  }
  if (rangeEnd !== undefined && numbers.length === 1) {
    const a = numbers[0], b = Number(rangeEnd);
    if (b < a || b - a > MAX_RANGE) return null;
    numbers.length = 0;
    for (let n = a; n <= b; n++) numbers.push(n);
  }
  return numbers.length && numbers.every(n => n >= 1) ? numbers : null;
}

// The numbered citations of one paragraph, one entry per cited number (a group "[1-3]" gives three).
function citationsIn(p) {
  const found = [];
  for (const match of p.text.matchAll(GROUP)) {
    const numbers = expand(match[1], match[2]);
    if (!numbers) continue;
    const start = match.index, end = start + match[0].length;
    numbers.forEach((number, i) => found.push({ id: `c${p.id}:${start}:${number}`, paragraph: p.id, start, end, original: match[0], number, group: numbers, groupFirst: i === 0,
      year: '', authors: [], authorText: match[0], authorStart: start, authorEnd: end, narrative: false, protected: p.protected, text: match[0] }));
  }
  return found;
}

// Style of the document: a numbered reference list or numbered citations in the text mean a numbered style.
function detectStyle(paragraphs, references, range, authorYearCount = () => 0) {
  const labelled = references.filter(r => r.number != null);
  if (references.length >= 2 && labelled.length / references.length >= .6) {
    const bracket = labelled.filter(r => r.labelForm === 'bracket').length / labelled.length >= .6 || references.some(r => /[“"][^”"]{8,}[”"]/.test(r.raw) && /^(?:\p{Lu}\.[\s-]*)+\p{Lu}/u.test(r.raw));
    return bracket ? 'ieee' : 'vancouver';
  }
  let numeric = 0, authorYear = 0;
  for (const p of paragraphs) {
    if (p.part === 'word/document.xml' && range && p.index >= range.start && p.index <= range.end) continue;
    numeric += citationsIn(p).filter(c => c.groupFirst).length;
    authorYear += authorYearCount(p);
  }
  return numeric >= 3 && numeric > authorYear ? 'vancouver' : 'apa';
}

// Matches one numbered citation to the list. A list without typed numbers (a Word auto-numbered list) is numbered by position.
function match(c, references) {
  const ref = references.find((r, i) => (r.number ?? i + 1) === c.number);
  if (!ref) { c.issue = 'Kaynakçası olmayan atıf'; return null; }
  c.reference = ref.id; c.authors = ref.authors.map(a => String(a)); c.year = ref.year; c.authorText = ref.author;
  return ref;
}

// Problems of the whole numbering: order of first citation, gaps and repeats in the list, groups that should be written as a range.
function numberingFindings(citations, references, style) {
  const findings = [];
  let highest = 0;
  const seen = new Set();
  for (const c of citations) {
    if (seen.has(c.number)) continue;
    seen.add(c.number);
    if (c.number !== highest + 1) {
      const ahead = c.number > highest + 1;
      findings.push({ id: `order-${c.id}`, type: 'Atıf numarası ilk geçiş sırasında değil', paragraph: c.paragraph, location: c.location, original: `${c.original} içindeki [${c.number}]`,
        reviewReason: ahead ? `${STYLE_NAMES[style]} stilinde kaynaklar ilk anıldıkları sırayla numaralanır; [${c.number}] ilk kez geçerken sıradaki numara [${highest + 1}] olmalıydı.`
          : `[${c.number}] ilk kez geçiyor, ancak metinde daha büyük numaralar (en çok [${highest}]) önce kullanılmış; numaralar 1, 2, 3… sırasıyla ilk kez anılmalıdır.` });
    }
    highest = Math.max(highest, c.number);
  }
  const labelled = references.filter(r => r.number != null);
  if (labelled.length) {
    const counts = new Map();
    for (const r of labelled) counts.set(r.number, (counts.get(r.number) || 0) + 1);
    for (const [number, count] of counts) if (count > 1) findings.push({ id: `refnum-dup-${number}`, type: 'Kaynakça numaralandırması bozuk', reference: labelled.find(r => r.number === number).id, original: `[${number}] numarası ${count} kayıtta kullanılmış` });
    const top = Math.max(...counts.keys());
    for (let n = 1; n <= top; n++) if (!counts.has(n)) findings.push({ id: `refnum-gap-${n}`, type: 'Kaynakça numaralandırması bozuk', original: `Kaynakçada ${n} numaralı kayıt yok` });
  }
  if (style === 'vancouver') {
    for (const c of citations) {
      if (!c.groupFirst || c.issue || c.group.length < 3 || !/,/.test(c.original) || /[-–—]/.test(c.original)) continue;
      const sorted = [...c.group].sort((a, b) => a - b);
      if (sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1)) {
        const replacement = `[${sorted[0]}-${sorted.at(-1)}]`;
        findings.push({ id: c.id, type: 'Ardışık numaralar aralık olarak yazılabilir', citation: c.id, paragraph: c.paragraph, location: c.location, original: c.original,
          patch: { paragraph: c.paragraph, start: c.start, end: c.end, original: c.original, replacement }, reviewReason: `Ardışık numaralar ${replacement} biçiminde yazılır.` });
      }
    }
  }
  return findings;
}

// What the list entry's wording says about the style it is written in; the verified record's own formatting is the suggestion.
function entryProblems(body, style) {
  const text = String(body).trim(), problems = [];
  if (style === 'vancouver') {
    const authors = text.split(/\.\s+/)[0];
    if (/\(\s*(?:18|19|20)\d{2}[a-z]?\s*\)/.test(text.slice(0, 200))) problems.push('yıl APA gibi parantez içinde; Vancouver’da "Yıl;Cilt(Sayı):sayfa" yazılır');
    if (/^\p{Lu}[\p{L}'’-]+,\s*\p{Lu}\./u.test(text)) problems.push('yazar adı "Soyad Başharfler" (noktasız, virgülsüz) olmalı');
    else if (/\s\p{Lu}\.(?:\s|,|$)/u.test(authors)) problems.push('başharfler noktasız yazılmalı');
    const names = authors.replace(/\bet al\.?$/i, '').split(/,\s*/).filter(Boolean);
    if (names.length > 3 && !/\bet al\.?/i.test(authors)) problems.push('üçten fazla yazar var; ilk üç yazar ve "et al." yazılmalı');
    if (/https?:\/\/(?:dx\.)?doi\.org\//i.test(text)) problems.push('DOI "doi:10.xxxx" biçiminde yazılmalı');
  } else if (style === 'ieee') {
    const quoted = text.search(/[“"]/);
    const authors = quoted > 0 ? text.slice(0, quoted) : text.split(/\.\s+(?=\p{Lu})/u)[0];
    if (!/^(?:\p{Lu}\.[\s-]*){1,4}\p{Lu}[\p{L}'’-]+/u.test(text)) problems.push('yazar adı "A. Soyad" (başharf önce) biçiminde olmalı');
    if (quoted < 0 && /\b(?:vol|pp?)\./i.test(text)) problems.push('makale başlığı çift tırnak içinde olmalı');
    const names = authors.replace(/\bet al\.?/i, '').split(/,\s*|\s+and\s+/).filter(name => name.trim());
    if (names.length > 6 && !/\bet al\.?/i.test(authors)) problems.push('altıdan fazla yazar var; ilk yazar ve "et al." yazılmalı');
  }
  return problems;
}
function styleFindings(references, style) {
  const findings = [];
  for (const r of references) {
    const problems = entryProblems(r.effectiveRaw || r.raw, style);
    if (problems.length) findings.push({ id: `refstyle-${r.id}`, type: `Kaynakça girdisi ${STYLE_NAMES[style]} biçimine uymuyor`, reference: r.id, original: r.raw, reviewReason: problems.join('; ') + '.' });
  }
  return findings;
}

module.exports = { isNumeric, STYLE_NAMES, splitLabel, citationsIn, detectStyle, match, numberingFindings, entryProblems, styleFindings, expand };
