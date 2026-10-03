const test=require('node:test'),assert=require('node:assert/strict');
const A=require('../word-analysis.cjs');
const p=(text,index=0)=>({id:'word/document.xml:'+index,part:'word/document.xml',index,text,style:'Body',group:'body',protected:false});
const ref=(raw,id='r0')=>({id,raw,...A.referenceIdentity(raw)});
const range={start:100,end:200};
const texts=(s,refs=[])=>A.citationsIn(p(s),refs).map(c=>c.text);

test('Turkish "Yazar, yıl: sayfa" locators are citations',()=>{
 assert.deepEqual(texts('(Akdur, 2000: 1)'),['Akdur, 2000']);
 assert.deepEqual(texts('(Kadıoğlu, 2018: 42)'),['Kadıoğlu, 2018']);
 assert.deepEqual(texts('(Bandura, 1977: 193-194)'),['Bandura, 1977']);
 assert.deepEqual(texts('(Kadıoğlu,2018: 43)'),['Kadıoğlu, 2018']);
 assert.deepEqual(texts('(Everly & Lating, 2021: 718; Mao vd., 2022: 1682)'),['Everly & Lating, 2021','Mao vd., 2022']);
});
test('a page number that looks like a year is not a second citation',()=>{
 assert.deepEqual(texts('(Bandura, 1977: 1982)'),['Bandura, 1977']);
 assert.deepEqual(texts('(Bandura, 1977: 1982-1990)'),['Bandura, 1977']);
});
test('narrative citations accept a page locator',()=>{
 assert.deepEqual(texts('Bandura (1977: 193) öne sürmüştür.'),['Bandura, 1977']);
});
test('prose parentheses with a colon are still not citations',()=>{
 assert.deepEqual(texts('(Tablo 3: 2019 yılı verileri)'),[]);
 assert.deepEqual(texts('(Oran: 2020 yılında)'),[]);
});
test('locator citations match their references, leaving none orphaned',()=>{
 const refs=[ref('Akdur, R. (2000). Afetler. Ankara.'),ref('Bandura, A. (1977). Self-efficacy. Psych Review.','r1')];
 const r=A.analyze([p('Yetersizdir (Akdur, 2000: 1). Davranış (Bandura, 1977: 193-194).')],refs,range);
 assert.equal(r.citations.length,2);assert.ok(r.citations.every(c=>!c.issue));assert.equal(r.findings.length,0);
});
test('a sentence-opening word is not part of a narrative author',()=>{
 const refs=[ref('Ediz, Ç., & Yanık, D. (2024). Başlık burada. Dergi.'),ref('Karazeybek, E., & Özdemir, C. (2023). Başlık burada. Dergi.','r1')];
 const s='Nitekim Ediz ve Yanık (2024) buldu. Ayrıca Karazeybek ve Özdemir (2023) da buldu.';
 const cs=A.citationsIn(p(s),refs);
 assert.deepEqual(cs.map(c=>c.authorText),['Ediz ve Yanık','Karazeybek ve Özdemir']);
 for(const c of cs)assert.equal(s.slice(c.authorStart,c.authorEnd),c.authorText);
 const r=A.analyze([p(s)],refs,range);assert.equal(r.findings.length,0);
});
test('Turkish case suffix on an institution name still matches its reference',()=>{
 const refs=[ref('Afet ve Acil Durum Yönetimi Başkanlığı. (2014). Sözlük. Ankara.')];
 const r=A.analyze([p('Afet ve Acil Durum Yönetimi Başkanlığına (2014) göre acil durum tanımlanır.')],refs,range);
 assert.equal(r.citations[0].reference,'r0');assert.equal(r.findings.length,0);
});
test('an abbreviation declared on one record applies to the same institution',()=>{
 const refs=[ref('Afet ve Acil Durum Yönetimi Başkanlığı. (2014). Sözlük. Ankara.'),ref('Afet ve Acil Durum Yönetimi Başkanlığı (AFAD). (2019). Rapor. Ankara.','r1')];
 const r=A.analyze([p('Tanım budur (AFAD, 2014: 20).')],refs,range);
 assert.equal(r.citations[0].reference,'r0');assert.ok(!r.citations[0].issue);
});

test('references without a comma after the surname (Vancouver / initials-first) are parsed',()=>{
 const id=raw=>A.referenceIdentity(raw);
 assert.deepEqual([id('Alghamdi A. A. (2022). The Psychological Challenges. Frontiers.').authors,id('Alghamdi A. A. (2022). The Psychological Challenges.').year],[['Alghamdi'],'2022']);
 assert.deepEqual(id('Bahadır Yılmaz E. (2025). Evaluating the effectiveness. BMC nursing.').authors,['Bahadır Yılmaz']);
 assert.deepEqual(id('Boscarino J, Adams R, Figley C. Dünya Ticaret Merkezi felaketinden sonra. J Nerv Ment Dis. 2011;199(2):91–99.').authors,['Boscarino','Adams','Figley']);
 assert.deepEqual(id('Drayer CS, Cameron DC, Woodward WD, Glass AJ.Toplumsal afetlerde psikolojik ilk yardım. JAMA1954; 156:36-41').authors,['Drayer','Cameron','Woodward','Glass']);
 assert.deepEqual(id('Vernberg E M, Steinberg A M, Jacobs A K, et al. Innovations in disaster mental health. Prof Psychol 2008; 39: 381-8').authors,['Vernberg','Steinberg','Jacobs']);
 assert.deepEqual(id('Pekevski J. First responders and psychological first aid.Journal of Emergency Management 2013; 11: 39-48').authors,['Pekevski']);
 assert.equal(id('Pekevski J. First responders and psychological first aid.Journal of Emergency Management 2013; 11: 39-48').year,'2013');
});
test('comma-style references are not disturbed by the initials-first parser',()=>{
 assert.deepEqual(A.referenceIdentity('Everly, G. & Flynn, B. (2006). Principles. Journal.').authors,['Everly','Flynn']);
 assert.deepEqual(A.referenceIdentity('Kılıç Bayageldi, N., & Şimşek, N. (2022). Development study. Journal.').authors,['Kılıç Bayageldi','Şimşek']);
});
test('typographic hyphens in names match ordinary ones',()=>{
 const refs=[ref('Rodriguez‐Arrastia, M., García‐Martín, M., & Roman, P. (2022). Emotional implications. Journal.')];
 assert.deepEqual(refs[0].authors,['Rodriguez-Arrastia','García-Martín','Roman']);
 const r=A.analyze([p('Sonuçlar (Rodriguez‐Arrastia vd., 2022: 5) gösterir.')],refs,range);
 assert.equal(r.citations[0].reference,'r0');assert.equal(r.findings.length,0);
});
test('"vd" without a period is an abbreviation, not part of the name',()=>{
 const refs=[ref('Minihan, E., Gavin, B., Kelly, B. D. and McNicholas, F. (2020). COVID-19, mental health. Irish Journal.')];
 const r=A.analyze([p('Odaklanır (Minihan vd, 2020: 261). Ayrıca Minihan vd. (2020: 262) belirtir.')],refs,range);
 assert.equal(r.citations.length,2);assert.ok(r.citations.every(c=>c.reference==='r0'&&!c.issue));assert.equal(r.findings.length,0);
});
test('Turkish names of international bodies and "T.C." prefixes match their records',()=>{
 const refs=[ref('World Health Organization. (1948). Summary reports. Geneva.'),ref('T.C. Resmi Gazete. (2021). Yönetmelik. https://www.resmigazete.gov.tr/x','r1'),ref('Inter-Agency Standing Committee (IASC). (2007). Guidelines. Geneva.','r2')];
 const r=A.analyze([p('Sağlık tanımı (DSÖ, 1948: 1). Yasa (Resmi Gazete, 2021). Kılavuz (IASC, 2007).')],refs,range);
 assert.deepEqual(r.citations.map(c=>c.reference),['r0','r1','r2']);assert.equal(r.findings.length,0);
});
test('undated entries numbered t.y.-1 / t.y.-2 are recognised as undated records',()=>{
 const refs=[ref('Afet ve Acil Durum Yönetimi Başkanlığı (AFAD). (t.y.-1). Afet türleri. https://www.afad.gov.tr/a'),ref('Afet ve Acil Durum Yönetimi Başkanlığı. (2014). Sözlük. Ankara.','r1')];
 assert.equal(refs[0].year,'n.d.-1');assert.equal(refs[0].author,'Afet ve Acil Durum Yönetimi Başkanlığı (AFAD)');
 const r=A.analyze([p('Türler (AFAD, t.y.-1). Tanım (AFAD, 2014: 20).')],refs,range);
 assert.deepEqual(r.citations.map(c=>c.reference),['r0','r1']);assert.equal(r.findings.length,0);
});

test('PDF: a parenthesis left open at a page break is not split into two paragraphs',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 process.env.WORD_ARCHIVE_DIR||=fs.mkdtempSync(path.join(os.tmpdir(),'cite-pdf-'));
 const S=require('../word-service.cjs'),{makePdf}=require('./pdf-fixture.cjs');
 const header=[[72,800,'Journal of Testing Studies 12(3) 2024']];
 const pdf=makePdf([
  [...header,[72,760,'Giris'],[72,730,'Bireyler destek aglarina yonlendirilmelidir (Brymer vd., 2006: 6; Everly & Flynn, 2006:'],[290,40,'1']],
  [...header,[72,760,'95; Vernberg vd., 2008: 383; DSO, 2011: 3).'],[72,730,'Sonraki paragraf burada baslar ve devam eder.'],[290,40,'2']]
 ]);
 const {paragraphs}=await S.python({operation:'inspect_pdf',data:pdf.toString('base64')});
 const joined=paragraphs.find(q=>/Everly & Flynn, 2006: 95;/.test(q.text));
 assert.ok(joined,'open parenthesis continues across the page break: '+JSON.stringify(paragraphs.map(q=>q.text)));
 assert.deepEqual(A.citationsIn(joined,[]).map(c=>c.text),['Brymer vd., 2006','Everly & Flynn, 2006','Vernberg vd., 2008','DSO, 2011']);
});

test('a bracketed abbreviation in the citation ("[WFMH]") does not hide the institution',()=>{
 const refs=[ref('World Federation for Mental Health. (2016). Dignity in mental health. London.')];
 const r=A.analyze([p('İlk anılışta (World Federation for Mental Health [WFMH], 2016: 4) denir.')],refs,range);
 assert.equal(r.citations[0].reference,'r0');assert.equal(r.findings.length,0);
});
