const Engine = require('./reference-engine.js');
const norm = Engine.normalizeTitle;
const YEAR = '(?:(?:18|19|20)\\d{2}[a-z]?|t\\.\\s*y\\.|n\\.\\s*d\\.)';
const yearPattern = new RegExp(YEAR, 'gi');
const years = text => Array.from(text.matchAll(new RegExp(YEAR, 'gi')));
const yearKey = value => value.toLowerCase().replace(/\s/g, '').replace(/^t\.y\.$/, 'n.d.');
const cleanName = value => String(value).replace(/['’]s\b/gi, '').replace(/\bet\s+al\.?|\bvd\.|\bve\s+ark\.?|\bve\s+diğerleri/gi, '').replace(/[,\.\s]+$/, '').trim();
const nameKey = value => norm(cleanName(value));
const heading = p => /^(?:heading|ba[şs]?l[iı]?k|balk)\s*\d*/i.test(p.style||'') || /^(?:introduction|discussion|conclusion|conclusions|abstract|giriş|sonuç|tartışma)$/i.test(p.text.trim());
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function aliases(r) {
  const values=[r.author];
  const abbreviation=r.author.match(/\(([\p{Lu}\d-]{2,})\)/u)?.[1];
  if(abbreviation) values.push(abbreviation,r.author.replace(/\s*\([^)]*\)/g,''));
  // Explicitly identifiable suffix, not a general institution/publisher equivalence.
  if(/\s+AI$/i.test(r.author))values.push(r.author.replace(/\s+AI$/i,''));
  return values;
}
function publicationKeys(raw) {
  const keys=[];const doi=Engine.getDoi(raw);if(doi)keys.push('doi:'+doi.toLowerCase());
  const arxiv=raw.match(/(?:arxiv\s*:\s*|arxiv\.org\/(?:abs|pdf)\/|10\.48550\/arxiv\.)(\d{4}\.\d{4,5})(?:v\d+)?/i)?.[1];
  if(arxiv)keys.push('arxiv:'+arxiv);
  for(const m of raw.matchAll(/https?:\/\/[^\s<>]+/g))try{const u=new URL(m[0].replace(/[.,;)]*$/,''));if(u.pathname.replace(/\/$/,'')&&!/doi\.org$|arxiv\.org$/i.test(u.hostname))keys.push('url:'+u.hostname.toLowerCase().replace(/^www\./,'')+u.pathname.replace(/\/$/,''));}catch{}
  return keys;
}
function referenceIdentity(raw) {
  // Prefer the publication date in parentheses; initials such as Bui, N. D. Q.
  // must not be mistaken for the undated marker n.d.
  const date = new RegExp('\\(\\s*('+YEAR+')(?=\\s*[,)])','i').exec(raw);
  const y = date ? Object.assign([date[1]], {index:date.index+date[0].indexOf(date[1])}) : years(raw).find(value=>/^\d/.test(value[0]));
  const prefix = raw.slice(0, y?.index ?? raw.length).replace(/\(\s*$/, '').trim();
  const authors = Array.from(prefix.matchAll(/(?:^|[,;&]\s*|\band\s+)([\p{L}][\p{L}'’\s-]*?),\s*[\p{Lu}](?:\.|[\p{Lu}]*(?=\s*[,;&(]|$))/gu)).map(m => m[1].trim());
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
    for(const raw of lines)refs.push({id:'r'+refs.length,raw,paragraphs:[p.id],protected:p.protected||lines.length>1});
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
  const names=[...new Set(references.flatMap(r=>[...r.authors,...aliases(r)]))].sort((a,b)=>b.length-a.length);
  const proper="(?<![\\p{L}])(?:(?:de|van|von|der|den)\\s+)*[\\p{Lu}][\\p{L}'’–-]*(?:\\s+[\\p{Lu}][\\p{L}'’–-]*)*";
  const ending="(?:\\s+(?:et\\s+al\\.?|vd\\.|ve\\s+ark\\.?|ve\\s+diğerleri))?(?:['’]s)?";
  const known=names.map(n=>before.match(new RegExp('(?<![\\p{L}])'+escaped(n)+ending+'$','iu'))).find(Boolean);
  const fallback=before.match(new RegExp(proper+ending+'$','u'));
  let value=(known||fallback)?.[0]||'';
  // Walk the complete comma/conjunction list, retaining its first author and offsets.
  while(value){const parsed=citationAuthors(value);if(references.some(r=>r.authors.length>1&&r.authors.length===parsed.length&&r.authors.every((a,i)=>nameKey(a)===parsed[i])))break;
    const prefix=before.slice(0,before.length-value.length);const connector=prefix.match(/(?:,\s*(?:(?:and|ve|&)\s*)?|\s+(?:and|ve|&)\s*)$/);if(!connector)break;
    const left=prefix.slice(0,connector.index);const prior=left.match(new RegExp(proper+'$','u'));if(!prior)break;value=prior[0]+connector[0]+value;
  }
  return value.replace(/^The\s+/,'');
}
function citationsIn(p, references) {
  const citations = [];
  for (const par of p.text.matchAll(/\(([^()]*)\)/g)) {
    if (/kişisel iletişim|personal communication/i.test(par[1]) || /\b\d{4}\s*[-–—]\s*\d{4}\b/.test(par[1])) continue;
    let segOffset = par.index + 1;
    for (const segment of par[1].split(';')) {
      const ys = years(segment); if (!ys.length) { segOffset += segment.length+1; continue; }
      let authorText = segment.slice(0, ys[0].index).replace(/[,\s]+$/, '').trim();
      let narrative = false; let authorStart = segOffset + segment.indexOf(authorText);
      if (!authorText) {
        narrative = true;
        const before = p.text.slice(0,par.index).trimEnd();
        authorText = narrativeAuthor(before,references);
        authorStart = before.length-authorText.length;
      }
      // Parenthetical prose/target years and units are not author–year citations.
      const tail=segment.slice(ys[0].index).replace(new RegExp(YEAR,'gi'),'').replace(/[,\s]|(?:s\.|pp?\.)\s*\d+(?:[-–]\d+)?/gi,'');
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
function distance(a,b) {
  const rows = Array.from({length:a.length+1},(_,i)=>[i]);
  for(let j=1;j<=b.length;j++) rows[0][j]=j;
  for(let i=1;i<=a.length;i++) for(let j=1;j<=b.length;j++) rows[i][j]=Math.min(rows[i-1][j]+1,rows[i][j-1]+1,rows[i-1][j-1]+(a[i-1]!==b[j-1]));
  return rows[a.length][b.length];
}
function analyze(paragraphs, references, range) {
  const citations = [], findings = [], matched = new Set(), history = new Map();
  for (const p of paragraphs) {
    if (p.part === 'word/document.xml' && p.index >= range.start && p.index <= range.end) continue;
    if (heading(p)) { history.set(p.group, []); continue; }
    const ss = sentences(p.text); const preceding = history.get(p.group) || [];
    for (const c of citationsIn(p, references)) {
      const sentence = Math.max(0, ss.findIndex(s=>c.start>=s.start && c.start<s.end));
      c.sentence = ss[sentence]?.text || p.text;
      c.context = [...preceding, ...ss.slice(0,sentence+1).map(s=>s.text)].slice(-4);
      c.location = `${p.part === 'word/document.xml' ? 'Ana metin' : p.part.includes('footnotes') ? 'Dipnot' : 'Sonnot'} · paragraf ${p.index+1}`;
      const byAuthor = references.filter(r => aliases(r).some(a=>nameKey(a)===c.authors[0]));
      const exact = byAuthor.filter(r => r.year===c.year);
      let ref;
      if(exact.length===1) ref=exact[0];
      else if(exact.length>1) {c.issue='Belirsiz eşleşme: aynı yazar ve yıl için birden fazla kayıt.';exact.forEach(r=>matched.add(r.id));c.candidates=exact.map(r=>r.id);}
      else if(byAuthor.length===1) { ref=byAuthor[0]; c.issue='Yıl uyuşmazlığı'; c.reviewReason='Aynı yazar farklı bir yayına veya ön baskıya ait olabilir. Yayın sürümünü seçip eşleşmeyi kabul edin.'; }
      else if(byAuthor.length>1) c.issue='Yıl eşleşmiyor; birden fazla yayın adayı var.';
      else {
        const fuzzy = references.filter(r => r.year===c.year && c.authors[0]?.length>=5 && distance(norm(r.author),c.authors[0])===1);
        if(fuzzy.length===1) { c.candidate=fuzzy[0].id; c.issue='Olası yazar yazım uyuşmazlığı; yayın kimliğini kontrol edin.';
          const suffix=c.authorText.match(/\s+(?:et\s+al\.|vd\.|ve\s+ark\.?|ve\s+diğerleri)\s*$/i)?.[0]||'';
          c.patch={paragraph:p.id,start:c.authorStart,end:c.authorEnd,original:c.authorText,replacement:fuzzy[0].author+suffix}; }
        else c.issue='Kaynakçası olmayan atıf';
      }
      if(ref) {
        c.reference=ref.id; matched.add(ref.id);
        const abbreviated=/\bet\s+al\b|\bvd\.|\bve\s+ark\.?|\bve\s+diğerleri/i.test(c.authorText);
        const groupMismatch=c.authors.length>1&&c.authors.some((a,i)=>a!==norm(ref.authors[i]||'')) || c.authors.length===1&&ref.authors.length>1&&!abbreviated;
        if(groupMismatch && !c.issue) {
          c.issue='Yazar grubu uyuşmazlığı; eşleşmeyi kontrol edin.';
          c.patch={paragraph:p.id,start:c.authorStart,end:c.authorEnd,original:c.authorText,replacement:ref.authors.length>2?ref.author+(isTurkish(p.text)?' ve ark.':' et al.'):ref.authors.join(' & ')};
        }
      }
      if(c.protected) { delete c.patch; c.issue=(c.issue ? c.issue+' · ' : '')+'Alan kodu/korunan öğe: yalnız raporlama.'; }
      if(c.issue) findings.push({id:c.id,type:c.issue,citation:c.id,paragraph:c.paragraph,reference:c.reference||c.candidate,location:c.location,original:c.text,patch:c.patch,reviewReason:c.reviewReason});
      citations.push(c);
    }
    history.set(p.group,[...preceding,...ss.map(s=>s.text)].slice(-3));
  }
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
module.exports={isTurkish,extractReferences,referenceIdentity,citationsIn,analyze,sentences,publicationKeys};
