const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Registry = require('../style-registry.js');
const Csl = require('../csl-engine.js');

const article = { type: 'article', author: [{ family: 'Zhang', given: 'Kai' }, { family: 'Lee', given: 'Min Jae' }], title: 'Deep learning for protein folding', containerTitle: 'Journal of Molecular Biology', year: 2021, volume: '433', issue: '5', pages: '1199-1214', doi: '10.1000/xyz' };
const book = { type: 'book', author: [{ family: 'Yılmaz', given: 'Ahmet' }], title: 'Osmanlı Tarihi', publisher: 'Kronik', place: 'İstanbul', year: 2019 };
const web = { type: 'web', title: 'Climate report', url: 'https://example.org/r', site: 'Example', year: 2022 };
const records = [{ id: 'a', item: article }, { id: 'b', item: book }, { id: 'c', item: web }];

test('every style in the registry has its file and a valid family', () => {
  assert.equal(Registry.STYLES.length, 28);
  for (const style of Registry.STYLES) {
    assert.ok(['author-date', 'numeric', 'note'].includes(style.family), style.id);
    if (style.engine === 'csl') assert.ok(fs.existsSync(path.join(__dirname, '..', 'csl', 'styles', style.id + '.csl')), style.id);
  }
  for (const code of Csl.LOCALES) assert.ok(fs.existsSync(path.join(__dirname, '..', 'csl', 'locales', `locales-${code}.xml`)));
  assert.equal(Registry.normalize('unknown'), 'apa');
  assert.ok(Registry.isNote('chicago-notes-bibliography') && Registry.isNumeric('nature') && Registry.isAuthorDate('harvard-cite-them-right'));
});

test('every CSL style formats article, book and web records with the authors and the year', () => {
  for (const style of Registry.STYLES.filter(item => item.engine === 'csl')) {
    const [a, b, c] = Csl.formatEach(style.id, records);
    assert.match(a.text, /Zhang/, style.id);
    assert.match(a.text, /2021/, style.id);
    assert.match(b.text, /Yılmaz/, style.id);
    assert.match(c.text, /Climate/i, style.id);
    assert.doesNotMatch(a.html, /<(?!\/?(?:em|strong|sup|sub|span)\b)/, style.id);
  }
});

test('known golden outputs', () => {
  const text = (id, item = article) => Csl.formatOne(id, item).text;
  assert.equal(text('american-medical-association'), 'Zhang K, Lee MJ. Deep learning for protein folding. J Mol Biol. 2021;433(5):1199-1214. doi:10.1000/xyz');
  assert.equal(text('apa-6th-edition'), 'Zhang, K., & Lee, M. J. (2021). Deep learning for protein folding. Journal of Molecular Biology, 433(5), 1199–1214. https://doi.org/10.1000/xyz');
  assert.equal(text('chicago-author-date'), 'Zhang, Kai, and Min Jae Lee. 2021. “Deep Learning for Protein Folding.” Journal of Molecular Biology 433 (5): 1199–214. https://doi.org/10.1000/xyz.');
  assert.equal(text('modern-language-association'), 'Zhang, Kai, and Min Jae Lee. “Deep Learning for Protein Folding.” Journal of Molecular Biology, vol. 433, no. 5, 2021, pp. 1199–214, https://doi.org/10.1000/xyz.');
  assert.match(text('isnad-metinici'), /^Zhang, Kai - Lee, Min Jae\. “Deep learning for protein folding”\. Journal of Molecular Biology 433\/5 \(2021\), 1199-1214\./);
  assert.match(text('isnad-metinici', book), /^Yılmaz, Ahmet\. Osmanlı Tarihi\. İstanbul: Kronik, 2019\./);
});

test('numbered styles give a list label per position', () => {
  const label = (id, n) => { Csl.loadAssetsSync(id); return Csl.listLabel(id, n); };
  assert.equal(label('american-medical-association', 3), '3.');
  assert.equal(label('american-chemical-society', 2), '(2)');
  assert.equal(label('the-lancet', 4), '4');
  assert.equal(label('cse-citation-sequence', 5), '5.');
  const [first, second] = Csl.formatEach('nature', records);
  assert.equal(first.label, '1.');
  assert.doesNotMatch(first.text, /^1\./);
  assert.ok(second);
});

test('note styles give a footnote beside the bibliography entry', () => {
  const [a] = Csl.formatEach('chicago-notes-bibliography', records);
  assert.match(a.note.text, /^Kai Zhang and Min Jae Lee, “Deep Learning for Protein Folding,” Journal of Molecular Biology 433, no\. 5 \(2021\): 1199–214/);
  assert.match(a.text, /^Zhang, Kai, and Min Jae Lee\./);
  assert.match(a.note.html, /<em>Journal of Molecular Biology<\/em>/);
  const [o] = Csl.formatEach('oscola', records);
  assert.match(o.note.text, /^Kai Zhang and Min Jae Lee/);
  const [i] = Csl.formatEach('isnad-dipnotlu', records);
  assert.match(i.note.text, /^Kai Zhang - Min Jae Lee/);
});

test('in-text citations: author-date, superscript numbers, page locators and notes', () => {
  const clusters = [[{ id: 'a', locator: '12', label: 'page' }], [{ id: 'a' }, { id: 'b' }], [{ id: 'a' }]];
  const apa = Csl.render('apa-6th-edition', records, clusters);
  assert.equal(apa.citations[0].text, '(Zhang & Lee, 2021, p. 12)');
  assert.equal(apa.citations[1].text, '(Yılmaz, 2019; Zhang & Lee, 2021)');
  const nature = Csl.render('nature', records, clusters);
  assert.deepEqual(nature.citations.map(c => c.html), ['<sup>1</sup>', '<sup>1,2</sup>', '<sup>1</sup>']);
  const chicago = Csl.render('chicago-notes-bibliography', records, clusters);
  assert.match(chicago.citations[0].text, /^Kai Zhang and Min Jae Lee, “Deep Learning for Protein Folding,” Journal of Molecular Biology 433, no\. 5 \(2021\): 12, https:\/\/doi\.org/);
  assert.match(chicago.citations[2].text, /^Zhang and Lee, “Deep Learning for Protein Folding\.”/);
});

test('titles follow the style: sentence case for medical styles, title case from CSL for Chicago', () => {
  const upper = { ...article, title: 'Deep Learning For Protein Folding' };
  const helpers = { sentenceCase: title => title.charAt(0) + title.slice(1).toLowerCase() };
  assert.match(Csl.formatOne('american-medical-association', upper, helpers).text, /Deep learning for protein folding\./);
  assert.match(Csl.formatOne('chicago-author-date', article).text, /“Deep Learning for Protein Folding\.”/);
});

test('an unknown or native style is refused', () => {
  assert.throws(() => Csl.formatOne('apa', article), /Desteklenmeyen/);
  assert.throws(() => Csl.formatOne('nope', article), /Desteklenmeyen/);
});
