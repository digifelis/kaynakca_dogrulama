const test = require('node:test');
const assert = require('node:assert/strict');
const { extractReferences, afterReferences } = require('../word-analysis.cjs');

const paragraphs = lines => lines.map((text, index) => ({ index, id: 'p' + index, text, part: 'word/document.xml' }));
const refs = ['Smith, J. (2020). Title one here. Journal of X, 1(2), 3-4.', 'Doe, A. (2019). Another title. Journal of Y, 5(1), 10-20.'];

test('sections printed after the reference list are not references', () => {
  for (const heading of ['Extended Summary', 'Genişletilmiş Özet', 'Funding', 'Author Contributions:', 'Data Availability Statement', 'Conflicts of Interest', 'Teşekkür', 'Supplementary Materials']) {
    const result = extractReferences(paragraphs(['Kaynakça', ...refs, heading, 'Bu çalışma 2020 yılında yazılmış uzun bir metindir.']));
    assert.equal(result.references.length, 2, heading);
  }
});

test('a reference that merely starts with such a word stays a reference', () => {
  assert.equal(afterReferences('Funding, A. (2020). Title of a paper. Journal, 1(2), 3-4.'), false);
  assert.equal(afterReferences('Genişletilmiş Özet: ' + 'uzun metin '.repeat(30)), true);
});
