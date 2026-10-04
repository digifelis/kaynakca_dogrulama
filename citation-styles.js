/* Vancouver (NLM / ICMJE) and IEEE reference formatting, shared by the browser and Node.
   One bibliographic record (the shape the reference engine and the writing assistant both use) goes in; text, italic-marked HTML and notes come out.
   Numbered styles list the references in the order they are first cited, so the list number is added by the caller ("1." / "[1]"). */
(function (root) {
  const VANCOUVER_AUTHOR_LIMIT = 3;   // more authors: the first three and "et al."
  const IEEE_AUTHOR_LIMIT = 6;        // more authors: the first one and "et al."
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

  // ---- names
  const ORGANISATION = /\b(?:university|universit[äey]|institute|organi[sz]ation|association|ministry|committee|group|agency|council|society|department|center|centre|bureau|foundation|company|ltd|inc|board|network|consortium|laboratory|news|press|media|times|institution|corporation|corp|bank|party|union|office|authority|üniversitesi|bakanlığı|başkanlığı|müdürlüğü|kurumu|derneği|enstitüsü|ajansı|komisyonu|vakfı|birliği)\b/i;
  const PARTICLE = /^(?:van|von|de|der|den|del|della|di|da|du|la|le|al|el|bin|ibn|ten|ter|dos|das)$/i;
  // { family, given } | { literal } for one author record or one "Kai Zhang" / "Zhang, Kai" string.
  function person(author) {
    if (!author) return null;
    if (typeof author === 'string') author = { literal: author };
    if (author.family) return { family: clean(author.family), given: clean(author.given) };
    if (author.organization) return { literal: clean(author.literal || author.name) };
    const literal = clean(author.literal || author.name);
    if (!literal) return null;
    if (literal.includes(',') && !ORGANISATION.test(literal)) { const [family, ...rest] = literal.split(','); return { family: clean(family), given: clean(rest.join(' ')) }; }
    const words = literal.split(' ');
    if (words.length < 2 || words.length > 4 || ORGANISATION.test(literal) || /[\d:&]/.test(literal)) return { literal };
    // "Ahmet Yılmaz", "Maria van der Berg": the family name is the last word plus the particles before it.
    let start = words.length - 1;
    while (start > 1 && PARTICLE.test(words[start - 1])) start--;
    return { family: words.slice(start).join(' '), given: words.slice(0, start).join(' ') };
  }
  // "Mehmet Ali", "J.R.R.", "M.-W.", "Jean-Pierre" -> ['M', 'A'], ['J', 'R', 'R'], ['M', 'W'], ['J', 'P']
  function initialsOf(given) {
    const letters = [];
    for (const token of clean(given).split(/[\s-]+/).filter(Boolean)) {
      if (/^(?:\p{L}\.)+$/u.test(token)) { for (const part of token.split('.').filter(Boolean)) letters.push(part); continue; }
      if (/^\p{Ll}/u.test(token) && PARTICLE.test(token)) continue;
      letters.push(Array.from(token)[0]);
    }
    return letters.map(letter => letter.toLocaleUpperCase('tr'));
  }
  const vancouverName = name => name.literal || (name.family + (initialsOf(name.given).length ? ' ' + initialsOf(name.given).join('') : ''));
  const ieeeName = name => name.literal || ((initialsOf(name.given).length ? initialsOf(name.given).map(i => i + '.').join(' ') + ' ' : '') + name.family);
  function people(item) { return (item.author || []).map(person).filter(Boolean); }
  function vancouverAuthors(item) {
    const list = people(item).map(vancouverName);
    return list.length > VANCOUVER_AUTHOR_LIMIT ? list.slice(0, VANCOUVER_AUTHOR_LIMIT).join(', ') + ', et al.' : list.join(', ');
  }
  function ieeeAuthors(item) {
    const list = people(item).map(ieeeName);
    if (list.length > IEEE_AUTHOR_LIMIT) return list[0] + ' et al.';
    return list.length > 2 ? list.slice(0, -1).join(', ') + ', and ' + list.at(-1) : list.join(' and ');
  }

  // ---- journal abbreviations (ISO 4 / NLM style, from the common title words); Crossref's own short title wins when it has one
  const ABBREVIATIONS = Object.fromEntries(`academy:Acad academic:Acad advanced:Adv advances:Adv agricultural:Agric agriculture:Agric american:Am analysis:Anal analytical:Anal annals:Ann annual:Annu applied:Appl archives:Arch architecture:Archit art:Art arts:Arts asian:Asian assessment:Assess association:Assoc associations:Assoc astronomy:Astron behavioral:Behav behaviour:Behav behavior:Behav biochemistry:Biochem biological:Biol biology:Biol biomedical:Biomed british:Br bulletin:Bull business:Bus cancer:Cancer cardiovascular:Cardiovasc chemical:Chem chemistry:Chem civil:Civ climate:Clim climatic:Clim clinical:Clin cognitive:Cogn communication:Commun communications:Commun comparative:Comp computational:Comput computer:Comput computers:Comput computing:Comput conference:Conf conservation:Conserv contemporary:Contemp control:Control crystal:Cryst cultural:Cult culture:Cult current:Curr data:Data design:Des development:Dev developmental:Dev diabetes:Diabetes disease:Dis diseases:Dis earth:Earth ecological:Ecol ecology:Ecol economic:Econ economics:Econ education:Educ educational:Educ electrical:Electr electronic:Electron emergency:Emerg energy:Energy engineering:Eng environment:Environ environmental:Environ epidemiology:Epidemiol european:Eur evaluation:Eval experimental:Exp food:Food forest:For forestry:For frontiers:Front general:Gen genetic:Genet genetics:Genet geographical:Geogr geography:Geogr geological:Geol geology:Geol geophysical:Geophys global:Glob health:Health history:Hist historical:Hist human:Hum humanities:Humanit hydrological:Hydrol hydrology:Hydrol imaging:Imaging immunology:Immunol industrial:Ind information:Inf innovation:Innov institute:Inst intelligence:Intell interdisciplinary:Interdiscip international:Int investigation:Investig journal:J journals:J knowledge:Knowl laboratory:Lab language:Lang learning:Learn letters:Lett linguistics:Linguist literature:Lit machine:Mach management:Manag marine:Mar materials:Mater mathematical:Math mathematics:Math measurement:Meas mechanical:Mech medical:Med medicine:Med methods:Methods modelling:Model modeling:Model molecular:Mol national:Natl natural:Nat network:Netw networks:Netw neural:Neural neuroscience:Neurosci nursing:Nurs nutrition:Nutr oncology:Oncol operations:Oper optical:Opt organic:Org pacific:Pac pediatrics:Pediatr pharmacology:Pharmacol philosophy:Philos physical:Phys physics:Phys planning:Plan policy:Policy political:Polit politics:Polit population:Popul practice:Pract proceedings:Proc processing:Process professional:Prof psychological:Psychol psychology:Psychol public:Public quarterly:Q regional:Reg rehabilitation:Rehabil remote:Remote report:Rep reports:Rep research:Res resources:Resour review:Rev reviews:Rev rural:Rural science:Sci sciences:Sci scientific:Sci security:Secur sensing:Sens social:Soc society:Soc sociology:Sociol software:Softw statistical:Stat statistics:Stat strategic:Strateg studies:Stud study:Stud surgery:Surg sustainability:Sustain sustainable:Sustain systems:Syst teaching:Teach technical:Tech technological:Technol technology:Technol theoretical:Theor theory:Theory tourism:Tour transactions:Trans transport:Transp transportation:Transp university:Univ urban:Urban water:Water world:World`.split(/\s+/).map(pair => pair.split(':')));
  const DROPPED = new Set(['a', 'an', 'the', 'and', 'of', 'for', 'in', 'on', 'at', 'to', 'with', 'by', 'from', '&', 'de', 'la', 'le', 'et', 'und', 've']);
  // { text, source }: source is 'registered' (from the index record), 'rule' (made from the title words) or 'none' (unchanged).
  function journalAbbreviation(item, { periods = false } = {}) {
    const full = clean(item.containerTitle);
    if (!full) return { text: '', source: 'none' };
    const strip = value => periods ? value : value.replace(/[.,]/g, '');
    if (clean(item.shortContainer)) return { text: strip(clean(item.shortContainer)), source: 'registered' };
    const words = full.split(' ');
    if (words.length === 1) return { text: full, source: 'none' };
    let changed = false;
    const out = [];
    for (const word of words) {
      const plain = word.replace(/[.,:;]+$/, ''), lower = plain.toLocaleLowerCase('en');
      if (DROPPED.has(lower) && out.length) { changed = true; continue; }
      if (ABBREVIATIONS[lower] && plain === plain.replace(/^./, c => c.toLocaleUpperCase('en'))) { out.push(ABBREVIATIONS[lower] + (periods && ABBREVIATIONS[lower].length < plain.length ? '.' : '')); changed = true; continue; }
      out.push(plain);
    }
    return { text: out.join(' '), source: changed ? 'rule' : 'none' };
  }

  // ---- pieces
  const dash = value => clean(value).replace(/\s*[-‐‑‒–—]+\s*/g, '-');
  // NLM drops the leading digits the two page numbers share: 1199-1214 -> 1199-214, S45-S52 -> S45-52.
  function vancouverPages(pages) {
    const text = dash(pages);
    const match = text.match(/^([A-Za-z]*)(\d+)-([A-Za-z]*)(\d+)$/);
    if (!match) return text;
    const [, startPrefix, start, endPrefix, end] = match;
    if (end.length < start.length || endPrefix && endPrefix !== startPrefix) return text;
    let same = 0;
    while (same < start.length - 1 && start[same] === end[same] && end.length - same > 1) same++;
    return `${startPrefix}${start}-${end.slice(same)}`;
  }
  function ieeePages(pages) {
    const text = clean(pages).replace(/\s*[-‐‑‒–—]+\s*/g, '–');
    return /^\p{L}?\d+–\p{L}?\d+$/u.test(text) ? 'pp. ' + text : /^\d+$/.test(text) ? 'p. ' + text : text;
  }
  const MONTHS_EN = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];
  const MONTHS_NLM = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ordinal = value => { const n = Number(value); if (!Number.isInteger(n) || n < 1) return clean(value).replace(/\.$/, ''); const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
  const edition = item => { const text = clean(item.edition); return text && Number(text) > 1 ? `${ordinal(text)} ed.` : /ed\.?$/i.test(text) ? text.replace(/\.?$/, '.') : text ? text + ' ed.' : ''; };
  function todayParts(today) { const d = today ? new Date(today) : new Date(); return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() }; }
  const typeOf = item => item.arxiv ? 'preprint' : item.type === 'web' ? 'web' : /^(?:book|monograph|edited-book|reference-book)$/.test(item.type || '') || (!item.containerTitle && item.publisher && !/article|chapter|proceedings/.test(item.type || '')) ? 'book'
    : /chapter/.test(item.type || '') ? 'chapter' : /proceedings/.test(item.type || '') ? 'conference' : item.type === 'report' || item.type === 'posted-content' ? 'report' : 'article';

  // A title that is already mixed-case keeps its capitals; in Vancouver an article title is written in sentence case.
  function articleTitle(item, helpers) {
    const title = clean(item.title).replace(/[.]+$/, '');
    return item.keepTitle || !helpers.sentenceCase ? title : helpers.sentenceCase(title, item.language, item.properNouns);
  }
  const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with', 'via', 'vs']);
  // IEEE capitalises the major words; words that already carry capitals (BERT, iPhone) are left alone.
  function ieeeTitle(title) {
    const words = clean(title).replace(/[.]+$/, '').split(' ');
    return words.map((word, i) => {
      if (/\p{Lu}.*\p{Lu}|\p{Ll}\p{Lu}|\d/u.test(word)) return word;
      const lower = word.toLocaleLowerCase('en'), previous = words[i - 1] || '';
      if (i > 0 && SMALL.has(lower) && !/[:.!?]$/.test(previous)) return lower;
      return word.replace(/^([^\p{L}]*)(\p{L})/u, (_, lead, letter) => lead + letter.toLocaleUpperCase('en'));
    }).join(' ');
  }

  function Builder() {
    const parts = [];
    const add = (text, italic = false) => { if (text) parts.push({ text: String(text), italic }); };
    return { parts, add, text: () => parts.map(part => part.text).join(''), html: () => parts.map(part => part.italic ? `<em>${escapeHtml(part.text)}</em>` : escapeHtml(part.text)).join('') };
  }
  const endWithStop = text => /[.!?]$/.test(text) ? text : text + '.';

  // ---- Vancouver
  function vancouver(item, helpers = {}, options = {}) {
    const b = Builder(), notes = [], kind = typeOf(item), authors = vancouverAuthors(item);
    const year = clean(item.year), doi = clean(item.doi).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
    const cited = () => { const t = todayParts(options.today); return `[cited ${t.year} ${MONTHS_NLM[t.month]} ${t.day}]`; };
    if (authors) b.add(endWithStop(authors) + ' ');
    else notes.push('Yazar bilgisi bulunamadı');
    const title = kind === 'book' || kind === 'report' ? clean(item.title).replace(/[.]+$/, '') : articleTitle(item, helpers);
    if (kind === 'web') {
      b.add(`${title} [Internet]. `);
      const site = clean(item.site || item.publisher);
      b.add(`${site ? site + '; ' : ''}${year || 'n.d.'} ${cited()}. Available from: ${clean(item.url)}`);
    } else if (kind === 'preprint') {
      b.add(`${endWithStop(title)} arXiv [Preprint]. ${year || 'n.d.'} ${cited()}. Available from: https://arxiv.org/abs/${item.arxiv}`);
    } else if (kind === 'book') {
      b.add(endWithStop(title));
      const ed = edition(item); if (ed) b.add(' ' + ed);
      const place = clean(item.place), publisher = clean(item.publisher);
      b.add(` ${place && publisher ? place + ': ' : ''}${publisher ? publisher + '; ' : ''}${year || 'n.d.'}.`);
    } else if (kind === 'report') {
      b.add(endWithStop(title));
      const place = clean(item.place), publisher = clean(item.publisher || item.containerTitle);
      b.add(` ${place && publisher ? place + ': ' : ''}${publisher ? publisher + '; ' : ''}${year || 'n.d.'}.`);
    } else if (kind === 'chapter' || kind === 'conference') {
      b.add(endWithStop(title) + ` In: ${clean(item.containerTitle)}${item.containerTitle && !/[.!?]$/.test(item.containerTitle) ? '.' : ''} `);
      const place = clean(item.place), publisher = clean(item.publisher);
      if (kind === 'chapter' && publisher) b.add(`${place ? place + ': ' : ''}${publisher}; `);
      b.add(`${year || 'n.d.'}.`);
      if (item.pages) b.add(` p. ${vancouverPages(item.pages)}.`);
    } else {
      b.add(endWithStop(title) + ' ');
      const journal = journalAbbreviation(item);
      if (journal.text) {
        b.add(journal.text + '. ');
        if (journal.source !== 'registered' && clean(item.containerTitle).split(' ').length > 1) notes.push(journal.source === 'rule' ? 'Dergi kısaltması başlık sözcüklerinden üretildi; NLM kataloğuyla karşılaştırın' : 'Dergi kısaltması bulunamadı; tam ad kullanıldı');
      }
      b.add(`${year || 'n.d.'}${item.volume ? ';' + clean(item.volume) : ''}${item.issue ? '(' + clean(item.issue) + ')' : ''}${item.pages ? ':' + vancouverPages(item.pages) : ''}.`);
    }
    if (doi) b.add(` doi:${doi}`);
    return { text: b.text(), html: b.html(), parts: b.parts, notes, style: 'vancouver' };
  }

  // ---- IEEE
  function ieee(item, helpers = {}, options = {}) {
    const b = Builder(), notes = [], kind = typeOf(item), authors = ieeeAuthors(item);
    const year = clean(item.year), doi = clean(item.doi).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
    const month = Number(item.month) >= 1 && Number(item.month) <= 12 ? MONTHS_EN[Number(item.month) - 1] + ' ' : '';
    const quoted = text => { const title = ieeeTitle(text); return `“${title}${/[?!]$/.test(title) ? '' : ','}” `; };
    const tail = pieces => pieces.filter(Boolean).join(', ');
    if (!authors) notes.push('Yazar bilgisi bulunamadı');
    if (kind === 'web') {
      const t = todayParts(options.today), site = clean(item.site || item.publisher);
      if (authors) b.add(authors + ', ');
      b.add(quoted(item.title));
      b.add(`${site ? site + '. ' : ''}${clean(item.url)} (accessed ${MONTHS_EN[t.month]} ${t.day}, ${t.year}).`);
    } else if (kind === 'preprint') {
      if (authors) b.add(authors + ', ');
      b.add(quoted(item.title)); b.add(`arXiv:${item.arxiv}, ${year || 'n.d.'}.`);
    } else if (kind === 'book' || kind === 'report') {
      if (authors) b.add(authors + ', ');
      b.add(clean(item.title).replace(/[.]+$/, ''), true);
      const ed = edition(item); if (ed) b.add(', ' + ed.replace(/\.$/, ''));
      const place = clean(item.place), publisher = clean(item.publisher || item.containerTitle);
      b.add(`. ${place && publisher ? place + ': ' : ''}${publisher ? publisher + ', ' : ''}${year || 'n.d.'}.`);
    } else if (kind === 'chapter' || kind === 'conference') {
      if (authors) b.add(authors + ', ');
      b.add(quoted(item.title)); b.add('in ');
      b.add(clean(item.containerTitle), true);
      const place = clean(item.place), publisher = clean(item.publisher);
      b.add(', ' + tail([kind === 'chapter' && publisher ? `${place ? place + ': ' : ''}${publisher}` : place, month + (year || 'n.d.'), item.pages ? ieeePages(item.pages) : '', doi ? 'doi: ' + doi : '']) + '.');
    } else {
      if (authors) b.add(authors + ', ');
      b.add(quoted(item.title));
      const journal = journalAbbreviation(item, { periods: true });
      if (journal.text) {
        b.add(journal.text, true);
        if (journal.source !== 'registered' && clean(item.containerTitle).split(' ').length > 1) notes.push(journal.source === 'rule' ? 'Dergi kısaltması başlık sözcüklerinden üretildi; IEEE kısaltma listesiyle karşılaştırın' : 'Dergi kısaltması bulunamadı; tam ad kullanıldı');
      }
      b.add((journal.text ? ', ' : '') + tail([item.volume ? 'vol. ' + clean(item.volume) : '', item.issue ? 'no. ' + clean(item.issue) : '', item.pages ? ieeePages(item.pages) : '', month + (year || 'n.d.'), doi ? 'doi: ' + doi : '']) + '.');
    }
    if (kind !== 'article' && kind !== 'chapter' && kind !== 'conference' && doi && kind !== 'web') b.add(` doi: ${doi}.`);
    return { text: b.text(), html: b.html(), parts: b.parts, notes, style: 'ieee' };
  }

  const STYLES = { vancouver, ieee };
  const isNumeric = style => style === 'vancouver' || style === 'ieee';
  // Plain text, italic HTML and notes of one record in the chosen style (APA is produced by the reference engine / writer-cite).
  function format(item, style, helpers, options) {
    const build = STYLES[style];
    if (!build) throw Error('Desteklenmeyen atıf stili: ' + style);
    return build(item || {}, helpers || {}, options || {});
  }
  // The label of list entry `number` and of an in-text citation.
  const listLabel = (style, number) => style === 'ieee' ? `[${number}]` : `${number}.`;
  const citationLabel = number => `[${number}]`;
  // [1,2,3,5] -> Vancouver "[1-3,5]", IEEE "[1]–[3], [5]"; a locator ("s. 12", "p. 12") goes after a single number: "[3, s. 12]".
  function citationGroup(style, numbers, { locator = '' } = {}) {
    const sorted = [...new Set(numbers.map(Number).filter(n => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
    if (!sorted.length) return '';
    const where = locator && sorted.length === 1 ? ', ' + locator : '';
    const runs = [];
    for (const n of sorted) { const last = runs.at(-1); if (last && n === last[1] + 1) last[1] = n; else runs.push([n, n]); }
    if (style === 'ieee') return runs.map(([a, b]) => b - a >= 2 ? `[${a}]–[${b}]` : b > a ? `[${a}], [${b}]` : `[${a}${where}]`).join(', ');
    return `[${runs.map(([a, b]) => b - a >= 2 ? `${a}-${b}` : b > a ? `${a},${b}` : `${a}`).join(',')}${where}]`;
  }

  const api = { format, vancouver, ieee, person, initialsOf, vancouverPages, journalAbbreviation, isNumeric, listLabel, citationLabel, citationGroup, ieeeTitle,
    STYLES: ['apa', 'vancouver', 'ieee'], VANCOUVER_AUTHOR_LIMIT, IEEE_AUTHOR_LIMIT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CitationStyles = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
