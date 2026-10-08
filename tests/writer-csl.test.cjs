const test = require('node:test');
const assert = require('node:assert/strict');
const Cite = require('../writer-cite.js');
const Manuscript = require('../lib/writer-manuscript.cjs');

const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
const sources = {
  [A]: { fileName: 'a.pdf', meta: { authors: ['Zhang, Kai', 'Lee, Min Jae'], title: 'Deep learning for protein folding', year: '2021', journal: 'Journal of Molecular Biology', volume: '433', issue: '5', pages: '1199-1214', doi: '10.1000/xyz' } },
  [B]: { fileName: 'b.pdf', meta: { authors: ['Yılmaz, Ahmet'], title: 'Osmanlı Tarihi', year: '2019', publisher: 'Kronik', place: 'İstanbul' } }
};
const html = `<p>İlk <span class="cite" data-cite="${B}@12" data-lang="tr" contenteditable="false">x</span> ve <span class="cite" data-cite="${A}@3|${B}@" data-lang="tr" contenteditable="false">y</span>.</p>`;

test('CSL author-date styles write the citation and the alphabetical list', () => {
  const out = Manuscript.renderCitations(html, sources, 'apa-6th-edition');
  assert.match(out, /\(Yılmaz, 2019, p\. 12\)/);
  assert.match(out, /\(Yılmaz, 2019; Zhang &amp; Lee, 2021, p\. 3\)/);
  const list = Manuscript.bibliography(html, sources, 'apa-6th-edition');
  assert.deepEqual(list.map(entry => entry.id), [A, B].sort((x, y) => (x === A ? 'Zhang' : 'Yılmaz').localeCompare(y === A ? 'Zhang' : 'Yılmaz', 'tr')));
  assert.match(list[0].text, /^Yılmaz, A\. \(2019\)/);
});

test('CSL numbered styles number in first-citation order with the style\'s own label', () => {
  const out = Manuscript.renderCitations(html, sources, 'nature');
  assert.match(out, />¹</);
  assert.match(out, />¹,²</);
  const list = Manuscript.bibliography(html, sources, 'american-chemical-society');
  assert.deepEqual(list.map(entry => entry.id), [B, A]);
  assert.match(list[0].text, /^\(1\) Yılmaz, A\./);
  assert.match(list[1].text, /^\(2\) Zhang, K\.; Lee, M\. J\./);
  assert.equal(Cite.listLabel('ieee', 2), '[2] ');
});

test('native styles still work through the same context', () => {
  assert.match(Manuscript.renderCitations(html, sources, 'vancouver'), /\[1, s\. 12\]/);
  assert.match(Manuscript.renderCitations(html, sources, 'apa'), /Yılmaz, 2019/);
});
