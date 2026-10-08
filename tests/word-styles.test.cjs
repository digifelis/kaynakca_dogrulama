const test = require('node:test');
const assert = require('node:assert/strict');
const Analysis = require('../word-analysis.cjs');

let counter = 0;
const para = (text, extra = {}) => ({ id: 'word/document.xml:' + counter, part: 'word/document.xml', index: counter++, text, protected: false, paragraphLocked: false, group: 'word/document.xml', style: '', sup: [], ...extra });
const note = (text) => ({ id: 'word/footnotes.xml:' + counter, part: 'word/footnotes.xml', index: counter++, text, protected: false, paragraphLocked: false, group: 'word/footnotes.xml:1', style: '', sup: [] });
function run(paragraphs, style) {
  const { references, range } = Analysis.extractReferences(paragraphs);
  const result = Analysis.analyze(paragraphs, references, range, { style });
  return { references, ...result };
}
const types = findings => findings.map(finding => finding.type);

test('Chicago author–date: "(Zhang and Lee 2021)" without a comma matches the reference', () => {
  counter = 0;
  const paragraphs = [para('Giriş'), para('Protein katlanması incelendi (Zhang and Lee 2021) ve başka bir çalışma (Yılmaz 2019).'), para('Kaynakça'),
    para('Zhang, Kai, and Min Jae Lee. 2021. “Deep Learning for Protein Folding.” Journal of Molecular Biology 433 (5): 1199–214.'), para('Yılmaz, Ahmet. 2019. Osmanlı Tarihi. İstanbul: Kronik.')];
  const out = run(paragraphs, 'chicago-author-date');
  assert.equal(out.references.length, 2);
  assert.deepEqual(out.references.map(r => r.authors), [['Zhang', 'Lee'], ['Yılmaz']]);
  assert.equal(out.citations.length, 2);
  assert.ok(out.citations.every(c => c.reference && !c.issue), JSON.stringify(out.citations.map(c => [c.authorText, c.issue])));
  assert.ok(!types(out.findings).includes('Kaynakçası olmayan atıf'));
});

test('without the commaless option the same text is not read as a citation', () => {
  counter = 0;
  const paragraphs = [para('Metin (Zhang and Lee 2021).'), para('Kaynakça'), para('Zhang, K., & Lee, M. (2021). Başlık. Dergi, 1(1), 1-2.')];
  const { references, range } = Analysis.extractReferences(paragraphs);
  assert.equal(Analysis.analyze(paragraphs, references, range, { style: 'apa' }).citations.length, 0);
});

test('MLA: author and page without a year', () => {
  counter = 0;
  const paragraphs = [para('Bu görüş savunuldu (Yılmaz 45) ve eleştirildi (Zhang and Lee 1199; Kaya 3).'), para('Kaynakça'),
    para('Yılmaz, Ahmet. Osmanlı Tarihi. Kronik, 2019.'), para('Zhang, Kai, and Min Jae Lee. “Deep Learning for Protein Folding.” Journal of Molecular Biology, vol. 433, no. 5, 2021, pp. 1199–214.')];
  const out = run(paragraphs, 'modern-language-association');
  const matched = out.citations.filter(c => c.reference);
  assert.equal(matched.length, 2);
  assert.ok(!out.findings.some(f => f.type === 'Taranan metinde atıfı bulunmayan kaynak'), JSON.stringify(types(out.findings)));
});

test('Nature: raised numbers in Word runs and Unicode superscript digits', () => {
  counter = 0;
  const text = 'Birinci iddia1,2 ve ikinci iddia³ yazıldı.';
  const sup = [[text.indexOf('1,2'), text.indexOf('1,2') + 3]];
  const paragraphs = [para(text, { sup }), para('Kaynakça'), para('1. Zhang, K. & Lee, M. J. Deep learning. J. Mol. Biol. 433, 1199–1214 (2021).'), para('2. Yılmaz, A. Osmanlı Tarihi. (Kronik, 2019).'), para('3. Kaya, B. Başka. Nature 5, 1–2 (2020).')];
  const out = run(paragraphs, 'nature');
  assert.deepEqual(out.citations.map(c => c.number), [1, 2, 3]);
  assert.ok(out.citations.every(c => c.reference));
  assert.ok(!types(out.findings).includes('Atıf numarası ilk geçiş sırasında değil'));
});

test('Science: round-bracket numbers', () => {
  counter = 0;
  const paragraphs = [para('İlk (1) ve sonraki (2, 3) bulgular.'), para('Kaynakça'), para('1. K. Zhang, Başlık. J. Mol. Biol. 1, 1 (2021).'), para('2. A. Yılmaz, Başlık. Nature 2, 2 (2019).'), para('3. B. Kaya, Başlık. Nature 3, 3 (2020).')];
  const out = run(paragraphs, 'science');
  assert.deepEqual(out.citations.map(c => c.number), [1, 2, 3]);
  assert.ok(out.citations.every(c => c.reference));
});

test('Chicago notes: footnotes cite the references; an unknown source is reported; "ibid." is ignored', () => {
  counter = 0;
  const paragraphs = [para('Ana metin burada, dipnot işaretleriyle.'), para('Bibliography'),
    para('Yılmaz, Ahmet. Osmanlı Tarihi. İstanbul: Kronik, 2019.'), para('Zhang, Kai, and Min Jae Lee. “Deep Learning for Protein Folding.” Journal of Molecular Biology 433, no. 5 (2021): 1199–214.'),
    note('Kai Zhang and Min Jae Lee, “Deep Learning for Protein Folding,” Journal of Molecular Biology 433, no. 5 (2021): 1200.'), note('Ibid., 1203.'),
    note('Ahmet Yılmaz, Osmanlı Tarihi (İstanbul: Kronik, 2019), 12.'), note('Mehmet Kaya, “Bilinmeyen Bir Kaynak Başlığı,” Dergi 3 (2020): 4.')];
  const out = run(paragraphs, 'chicago-notes-bibliography');
  assert.equal(out.citations.filter(c => c.reference).length, 2);
  const unknown = out.findings.filter(f => f.type === 'Kaynakçası olmayan atıf');
  assert.equal(unknown.length, 1);
  assert.match(unknown[0].original, /Bilinmeyen/);
  assert.ok(!out.findings.some(f => f.type === 'Taranan metinde atıfı bulunmayan kaynak'));
});

test('İSNAD reference: "Soyad, Ad - Soyad, Ad." authors are read', () => {
  counter = 0;
  const paragraphs = [para('Kaynakça'), para('Zhang, Kai - Lee, Min Jae. “Deep learning for protein folding”. Journal of Molecular Biology 433/5 (2021), 1199-1214.')];
  const { references } = Analysis.extractReferences(paragraphs);
  assert.deepEqual(references[0].authors, ['Zhang', 'Lee']);
  assert.equal(references[0].year, '2021');
});
