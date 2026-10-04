const Engine = require('./reference-engine.js');
const Numeric = require('./word-numeric.cjs');
const norm = Engine.normalizeTitle;
const YEAR = '(?:(?:18|19|20)\\d{2}[a-z]?|t\\.\\s*y\\.(?:-\\d+)?|n\\.\\s*d\\.(?:-\\d+)?)';
const yearPattern = new RegExp(YEAR, 'gi');
const years = text => Array.from(text.matchAll(new RegExp(YEAR, 'gi')));
const yearKey = value => value.toLowerCase().replace(/\s/g, '').replace(/^t\.y\.(-\d+)?$/, 'n.d.$1');
// An undated citation ("t.y.") also fits a numbered undated record ("t.y.-1").
const yearFits = (cited, listed) => cited === listed || (cited === 'n.d.' && /^n\.d\.-\d+$/.test(listed));
const cleanName = value => String(value).replace(/\s*\[[^\]]*\]/g, '').replace(/['’]s\b/gi, '').replace(/\bet\s+al\.?|\bvd\b\.?|\bve\s+ark\.?|\bve\s+diğerleri/gi, '').replace(/[,\.\s]+$/, '').trim();
const nameKey = value => norm(cleanName(value));
const heading = p => /^(?:heading|ba[şs]?l[iı]?k|balk)\s*\d*/i.test(p.style||'') || /^(?:introduction|discussion|conclusion|conclusions|abstract|giriş|sonuç|tartışma)$/i.test(p.text.trim());
// Sentence openers that start with a capital but are not part of an author name.
const OPENER = /^(?:Nitekim|Ayrıca|Ancak|Fakat|Ama|Üstelik|Hatta|Keza|Yine|Dolayısıyla|Örneğin|Bununla|Bunun|Buna|Çünkü|Oysa|Similarly|However|Moreover|Furthermore|Additionally|Also|Thus|Therefore|Indeed|Notably)\s+/u;
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Names under which one body is cited; keys are in nameKey form.
const BODY_NAMES = [
  ['world health organization','dunya saglik orgutu','dso','who'],
  ['inter agency standing committee','iasc'],
  ['world federation for mental health','dunya ruh sagligi federasyonu','wfmh']
];
const abbreviationOf =author => author.match(/\(([\p{Lu}\d-]{2,})\)/u)?.[1];
const bareAuthor = author => author.replace(/\s*\([^)]*\)/g,'').trim();
function aliases(r, all = []) {
  const values=[r.author];
  const abbreviation=abbreviationOf(r.author);
  if(abbreviation) values.push(abbreviation,bareAuthor(r.author));
  else {
    // An abbreviation declared on another record of the same institution
    // ("... Başkanlığı (AFAD)") also names this record.
    const own=nameKey(r.author);
    for(const other of all){const short=abbreviationOf(other.author);if(short&&nameKey(bareAuthor(other.author))===own)values.push(short);}
  }
  // Explicitly identifiable suffix, not a general institution/publisher equivalence.
  if(/\s+AI$/i.test(r.author))values.push(r.author.replace(/\s+AI$/i,''));
  // Official-body prefix and the bilingual names of international bodies.
  const plain=r.author.replace(/^T\.\s*C\.\s+/i,'');
  if(plain!==r.author)values.push(plain);
  const own=nameKey(bareAuthor(plain));
  for(const group of BODY_NAMES)if(group.some(n=>own===n||own.startsWith(n+' ')))values.push(...group);
  return values;
}
function publicationKeys(raw) {
  const keys=[];const doi=Engine.getDoi(raw);if(doi)keys.push('doi:'+doi.toLowerCase());
  const arxiv=raw.match(/(?:arxiv\s*:\s*|arxiv\.org\/(?:abs|pdf)\/|10\.48550\/arxiv\.)(\d{4}\.\d{4,5})(?:v\d+)?/i)?.[1];
  if(arxiv)keys.push('arxiv:'+arxiv);
  for(const m of raw.matchAll(/https?:\/\/[^\s<>]+/g))try{const u=new URL(m[0].replace(/[.,;)]*$/,''));if(u.pathname.replace(/\/$/,'')&&!/doi\.org$|arxiv\.org$/i.test(u.hostname))keys.push('url:'+u.hostname.toLowerCase().replace(/^www\./,'')+u.pathname.replace(/\/$/,''));}catch{}
  return keys;
}
// "Alghamdi A. A.", "Bahadır Yılmaz E.", "Boscarino J, Adams R, Figley C.",
// "Drayer CS, ... Glass AJ.Title": surname first, initials without a comma.
const INITIALS_FIRST = /^([\p{Lu}][\p{L}'’-]*(?:\s+[\p{L}'’-]+)*?)\s+(?:\p{Lu}{1,4}\.?|(?:\p{Lu}\.?\s?){1,3})(?=\s*\p{Lu}\p{Ll}|\s*$)/u;
function initialsFirstAuthors(prefix) {
  const parts = prefix.split(/,\s*/);
  // "Surname, G. & Surname, B." has initials after the comma: not this style.
  if (parts.length > 1 && /^\p{Lu}\.?(?:\s|&|$)/u.test(parts[1])) return null;
  const names = [];
  for (const part of parts) {
    const m = part.trim().replace(/^(?:and|ve|&)\s+/i, '').match(INITIALS_FIRST);
    if (!m) break;
    names.push(m[1].trim());
  }
  return names.length ? names : null;
}
function referenceIdentity(raw) {
  // A typed list number ("1. ", "[1] ") belongs to the numbering, not to the author or the title.
  raw = Numeric.splitLabel(raw).body;
  // Prefer the publication date in parentheses; initials such as Bui, N. D. Q.
  // must not be mistaken for the undated marker n.d.
  const date = new RegExp('\\(\\s*('+YEAR+')(?=\\s*[,)])','i').exec(raw);
  const y = date ? Object.assign([date[1]], {index:date.index+date[0].indexOf(date[1])}) : years(raw).find(value=>/^\d/.test(value[0]));
  const prefix = raw.slice(0, y?.index ?? raw.length).replace(/\(\s*$/, '').replace(/[‐-―−]/g, '-').trim();
  // Initials may be spaced ("D. J."), glued ("SY.") or without periods ("DJ"); a
  // list connector ("and", "ve", "&") belongs to the separator, not the surname.
  const authors = initialsFirstAuthors(prefix) || Array.from(prefix.matchAll(/(?:^|[,;&]\s*|\b(?:and|ve)\s+)([\p{L}][\p{L}'’\s-]*?),\s*[\p{Lu}](?:\.|[\p{Lu}]+\.?|(?=\s*[,;&(]|$))/gu)).map(m => m[1].trim().replace(/^(?:and|ve|&)\s+/i, ''));
  if (!authors.length) authors.push(prefix.replace(/[,.(\s]+$/, ''));
  return { authors, author: authors[0], year: y ? yearKey(y[0]) : '', title: Engine.parseReference(raw).title };
}
function extractReferences(paragraphs, range) {
  const main = paragraphs.filter(p => p.part === 'word/document.xml');
  const headings = main.filter(p => /^(kaynakça|kaynaklar|references|bibliography)\s*[:.]?$/i.test(p.text.trim()));
  const start = range?.start ?? (headings.length === 1 ? headings[0].index + 1 : -1);
  let end = range?.end ?? (main.length ? main.at(-1).index : -1);
  if (!range && start >= 0) {
    const next = main.find(p => p.index >= start && (heading(p) || /^(ekler|appendix|appendices)\b/i.test(p.text.trim())));
    if (next) end = next.index - 1;
  }
  const refs = [];
  for (const p of main.filter(p => p.index >= start && p.index <= end && p.text.trim())) {
    // Each explicit Word paragraph/line break starts a reference. Visual wrapping
    // does not introduce a newline in the extracted paragraph text.
    const lines=p.text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
    for(const line of lines){const label=Numeric.splitLabel(line);refs.push({id:'r'+refs.length,raw:label.body,paragraphs:[p.id],protected:p.protected||lines.length>1,...(label.number!=null?{number:label.number,prefix:label.prefix,labelForm:label.form}:{})});}
  }
  refs.forEach(r => Object.assign(r, referenceIdentity(r.raw)));
  return { references: refs, range: { start, end }, headings: headings.map(p => p.index), needsRange: start < 0 || !refs.length };
}
function sentences(text) {
  const result = []; let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!/[.!?]/.test(text[i])) continue;
    if (text[i] === '.' && (/\d/.test(text[i-1] || '') && /\d/.test(text[i+1] || '') || /(?:\b[A-ZÇĞİÖŞÜ]|\bet al|\bvd|\bark|\bs|\bpp|\bp|\bt|\by|\bn|\bd|\bDr|\bProf)$/.test(text.slice(0,i)))) continue;
    if (i+1 !== text.length && !/\s/.test(text[i+1])) continue;
    const value = text.slice(start, i+1).trim(); if (value) result.push({ text: value, start, end: i+1 }); start = i+1;
  }
  if (text.slice(start).trim()) result.push({ text: text.slice(start).trim(), start, end: text.length });
  return result;
}
function citationAuthors(value) {
  return cleanName(value).split(/\s*(?:,|&|\bve\b|\band\b)\s*/).map(v => nameKey(v)).filter(Boolean);
}
function narrativeAuthor(before,references) {
  const names=[...new Set(references.flatMap(r=>[...r.authors,...aliases(r,references)]))].sort((a,b)=>b.length-a.length);
  const proper="(?<![\\p{L}])(?:(?:de|van|von|der|den)\\s+)*[\\p{Lu}][\\p{L}'’–-]*(?:\\s+[\\p{Lu}][\\p{L}'’–-]*)*";
  const ending="(?:\\s+(?:et\\s+al\\.?|vd\\.?|ve\\s+ark\\.?|ve\\s+diğerleri))?(?:['’]s)?";
  const known=names.map(n=>before.match(new RegExp('(?<![\\p{L}])'+escaped(n)+ending+'$','iu'))).find(Boolean);
  const fallback=before.match(new RegExp(proper+ending+'$','u'));
  let value=(known||fallback)?.[0]||'';
  // Walk the complete comma/conjunction list, retaining its first author and offsets.
  while(value){const parsed=citationAuthors(value);if(references.some(r=>r.authors.length>1&&r.authors.length===parsed.length&&r.authors.every((a,i)=>nameKey(a)===parsed[i])))break;
    const prefix=before.slice(0,before.length-value.length);const connector=prefix.match(/(?:,\s*(?:(?:and|ve|&)\s*)?|\s+(?:and|ve|&)\s*)$/);if(!connector)break;
    const left=prefix.slice(0,connector.index);const prior=left.match(new RegExp(proper+'$','u'));if(!prior)break;prior[0]=prior[0].replace(OPENER,'');if(!prior[0])break;
    // When the name already belongs to a listed reference, extend the list only
    // with a name that is itself a reference author or keeps it a run of that
    // reference's authors: a sentence opener ("Similarly, Madusanka (2016)") is not a co-author;
    // an "and"/"ve" connector is always a list, so a misspelled co-author still joins.
    const extended=citationAuthors(prior[0]+connector[0]+value);
    const known=references.some(r=>r.authors.some(a=>nameKey(a)===parsed[0]));
    if(known&&!/(?:and|ve|&)\s*$/i.test(connector[0])&&!references.some(r=>r.authors.some(a=>nameKey(a)===extended[0]))&&!references.some(r=>{const keys=r.authors.map(nameKey);return keys.some((_,i)=>extended.every((a,j)=>keys[i+j]===a));}))break;
    value=prior[0]+connector[0]+value;
  }
  return value.replace(/^The\s+/,'').replace(OPENER,'');
}
function citationsIn(p, references) {
  const citations = [];
  for (const par of p.text.matchAll(/\(([^()]*)\)/g)) {
    if (/kişisel iletişim|personal communication/i.test(par[1]) || /\b\d{4}\s*[-–—]\s*\d{4}\b/.test(par[1].replace(/:\s*\d+(?:\s*[-–]\s*\d+)?/g,''))) continue;
    let segOffset = par.index + 1;
    for (const segment of par[1].split(';')) {
      // A page number after the year ("2000: 1", "1977: 1982-1990") is not a year.
      const ys = years(segment).filter(y=>y.index===0 || !/(?::\s*|\d\s*[-–]\s*)$/.test(segment.slice(0,y.index))); if (!ys.length) { segOffset += segment.length+1; continue; }
      let authorText = segment.slice(0, ys[0].index).replace(/[,\s]+$/, '').trim();
      let narrative = false; let authorStart = segOffset + segment.indexOf(authorText);
      if (!authorText) {
        narrative = true;
        const before = p.text.slice(0,par.index).trimEnd();
        authorText = narrativeAuthor(before,references);
        authorStart = before.length-authorText.length;
      }
      // Parenthetical prose/target years and units are not author–year citations.
      const tail=segment.slice(ys[0].index).replace(/:\s*\d+(?:\s*[-–]\s*\d+)?/g,'').replace(new RegExp(YEAR,'gi'),'').replace(/[,\s]|(?:s\.|pp?\.)\s*\d+(?:[-–]\d+)?/gi,'');
      if(tail || (!narrative && (!/,\s*$/.test(segment.slice(0,ys[0].index)) || !/^(?:(?:de|van|von)\s+)?\p{Lu}/u.test(authorText)))){segOffset+=segment.length+1;continue;}
      if (!authorText || /\d/.test(authorText) || authorText.length > 110) { segOffset += segment.length+1; continue; }
      for (const y of ys) {
        const start = segOffset+y.index;
        citations.push({ id: 'c'+p.id+':'+start, paragraph: p.id, start, end: start+y[0].length,
          year: yearKey(y[0]), original: y[0], authorText, authorStart, authorEnd: authorStart+authorText.length,
          authors: citationAuthors(authorText), narrative, protected: p.protected, text: `${authorText}, ${y[0]}` });
      }
      segOffset += segment.length+1;
    }
  }
  return citations;
}
// Turkish case/possessive suffix on a cited name: "Başkanlığına" for "Başkanlığı".
const SUFFIX = /^(?:y?[ae]|n[ae]|[iu]|in|un|nin|nun|d[ae]n?|t[ae]n?|nd[ae]n?|yla|yle|la|le|si|su|ni|nu|yi|yu)$/;
function suffixed(key, name) {
  return name.length>=4 && key.length>name.length && key.startsWith(name) && SUFFIX.test(key.slice(name.length));
}
function distance(a,b) {
  const rows = Array.from({length:a.length+1},(_,i)=>[i]);
  for(let j=1;j<=b.length;j++) rows[0][j]=j;
  for(let i=1;i<=a.length;i++) for(let j=1;j<=b.length;j++) rows[i][j]=Math.min(rows[i-1][j]+1,rows[i][j-1]+1,rows[i-1][j-1]+(a[i-1]!==b[j-1]));
  return rows[a.length][b.length];
}
// options.style: 'apa' (author–year, the default), 'vancouver' or 'ieee' (numbered citations).
function analyze(paragraphs, references, range, options = {}) {
  const numeric = Numeric.isNumeric(options.style);
  const citations = [], findings = [], matched = new Set(), history = new Map();
  for (const p of paragraphs) {
    if (p.part === 'word/document.xml' && p.index >= range.start && p.index <= range.end) continue;
    if (heading(p)) { history.set(p.group, []); continue; }
    const ss = sentences(p.text); const preceding = history.get(p.group) || [];
    for (const c of (numeric ? Numeric.citationsIn(p) : citationsIn(p, references))) {
      const sentence = Math.max(0, ss.findIndex(s=>c.start>=s.start && c.start<s.end));
      c.sentence = ss[sentence]?.text || p.text;
      c.context = [...preceding, ...ss.slice(0,sentence+1).map(s=>s.text)].slice(-4);
      c.location = `${p.part === 'word/document.xml' ? 'Ana metin' : p.part.includes('footnotes') ? 'Dipnot' : 'Sonnot'} · paragraf ${p.index+1}`;
      if (numeric) { if (Numeric.match(c, references)) matched.add(c.reference); }
      else {
      // An institution name may itself contain "ve"/"and" ("Afet ve Acil Durum Yönetimi
      // Başkanlığı"): when the whole text names a record, it is one author, not a list.
      const whole = nameKey(c.authorText);
      if (c.authors.length>1 && references.some(r=>aliases(r,references).some(a=>nameKey(a)===whole||suffixed(whole,nameKey(a))))) c.authors=[whole];
      let byAuthor = references.filter(r => aliases(r,references).some(a=>nameKey(a)===c.authors[0]));
      if(!byAuthor.length && c.authors.length===1) byAuthor = references.filter(r => aliases(r,references).some(a=>suffixed(c.authors[0],nameKey(a))));
      const exact = byAuthor.filter(r => yearFits(c.year, r.year));
      let ref;
      if(exact.length===1) ref=exact[0];
      else if(exact.length>1) {c.issue='Belirsiz eşleşme: aynı yazar ve yıl için birden fazla kayıt.';exact.forEach(r=>matched.add(r.id));c.candidates=exact.map(r=>r.id);}
      else if(byAuthor.length===1) { ref=byAuthor[0]; c.issue='Yıl uyuşmazlığı'; c.reviewReason='Aynı yazar farklı bir yayına veya ön baskıya ait olabilir. Yayın sürümünü seçip eşleşmeyi kabul edin.'; }
      else if(byAuthor.length>1) c.issue='Yıl eşleşmiyor; birden fazla yayın adayı var.';
      else {
        // One-letter author typo: the year must agree, or — for a group citation —
        // the remaining authors must match (the entry may be dated differently, e.g. n.d.).
        const sameRest=r => c.authors.length>1 && c.authors.length===r.authors.length && c.authors.slice(1).every((a,i)=>a===nameKey(r.authors[i+1]));
        const fuzzy = references.filter(r => (r.year===c.year || sameRest(r)) && c.authors[0]?.length>=5 && distance(norm(r.author),c.authors[0])===1);
        if(fuzzy.length===1) { c.candidate=fuzzy[0].id; matched.add(fuzzy[0].id); c.issue='Olası yazar yazım uyuşmazlığı; yayın kimliğini kontrol edin.';
          const suffix=c.authorText.match(/\s+(?:et\s+al\.|vd\.|ve\s+ark\.?|ve\s+diğerleri)\s*$/i)?.[0]||'';
          if(fuzzy[0].year!==c.year)c.reviewReason=`Kaynakçadaki kayıt ${fuzzy[0].year||'tarihsiz'} yılıyla yer alıyor; metin içi yılı (${c.year}) da kontrol edin.`;
          c.patch={paragraph:p.id,start:c.authorStart,end:c.authorEnd,original:c.authorText,replacement:c.authors.length>1&&c.authors.length===fuzzy[0].authors.length&&!suffix?c.authorText.replace(new RegExp('^'+escaped(c.authorText.split(/\s*(?:,|&|ve|and)\s*/)[0])),fuzzy[0].author):fuzzy[0].author+suffix}; }
        else c.issue='Kaynakçası olmayan atıf';
      }
      if(ref) {
        c.reference=ref.id; matched.add(ref.id);
        const abbreviated=/\bet\s+al\b|\bvd\b|\bve\s+ark\.?|\bve\s+diğerleri/i.test(c.authorText);
        const groupMismatch=c.authors.length>1&&c.authors.some((a,i)=>a!==norm(ref.authors[i]||'')) || c.authors.length===1&&ref.authors.length>1&&!abbreviated;
        if(groupMismatch && !c.issue) {
          c.issue='Yazar grubu uyuşmazlığı; eşleşmeyi kontrol edin.';
          c.patch={paragraph:p.id,start:c.authorStart,end:c.authorEnd,original:c.authorText,replacement:ref.authors.length>2?ref.author+(isTurkish(p.text)?' ve ark.':' et al.'):ref.authors.join(' & ')};
        }
      }
      }
      if(c.protected) { delete c.patch; c.issue=(c.issue ? c.issue+' · ' : '')+'Alan kodu/korunan öğe: yalnız raporlama.'; }
      if(c.issue) findings.push({id:c.id,type:c.issue,citation:c.id,paragraph:c.paragraph,reference:c.reference||c.candidate,location:c.location,original:c.text,patch:c.patch,reviewReason:c.reviewReason});
      citations.push(c);
    }
    history.set(p.group,[...preceding,...ss.map(s=>s.text)].slice(-3));
  }
  if (numeric) findings.push(...Numeric.numberingFindings(citations, references, options.style), ...Numeric.styleFindings(references, options.style));
  for(const r of references) {
    if(!matched.has(r.id)) findings.push({id:'orphan-'+r.id,type:'Taranan metinde atıfı bulunmayan kaynak',reference:r.id,original:r.raw});
    const keys=publicationKeys(r.effectiveRaw||r.raw);
    const duplicates=references.filter(x=>x.id!==r.id && (norm(x.raw)===norm(r.raw)||publicationKeys(x.effectiveRaw||x.raw).some(k=>keys.includes(k))));
    if(duplicates.length) findings.push({id:'duplicate-'+r.id,type:'Yinelenen kaynakça kaydı',reference:r.id,related:duplicates.map(x=>x.id),original:r.raw});
  }
  return {citations,findings};
}
function isTurkish(text) {
 const words=String(text).toLowerCase().match(/[\p{L}]+/gu)||[];
 const tr=words.filter(w=>['bir','bu','ve','ile','için','olarak','çalışma','göre','bulgular','sonuçlar','araştırma'].includes(w)).length;
 const en=words.filter(w=>['the','a','and','of','in','to','for','is','this','with','study','according'].includes(w)).length;
 return tr>en || (tr===en && /[çğıöşü]/i.test(text));
}
// The style a document is written in: 'apa', 'vancouver' or 'ieee' (from a numbered list or numbered citations).
const detectStyle=(paragraphs,references,range)=>Numeric.detectStyle(paragraphs,references,range,p=>citationsIn(p,references).length);
module.exports={detectStyle,isTurkish,extractReferences,referenceIdentity,citationsIn,analyze,sentences,publicationKeys};
