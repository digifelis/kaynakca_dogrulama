const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const python = require('../lib/python.cjs').python;
const Cite = require('../writer-cite.js');
const Manuscript = require('../lib/writer-manuscript.cjs');

const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
const sources = {
  [A]: { fileName: 'a.pdf', meta: { authors: ['Zhang, Kai', 'Lee, Min Jae'], title: 'Deep learning for protein folding', year: '2021', journal: 'Journal of Molecular Biology', volume: '433', issue: '5', pages: '1199-1214', doi: '10.1000/xyz' } },
  [B]: { fileName: 'b.pdf', meta: { authors: ['Yılmaz, Ahmet'], title: 'Osmanlı Tarihi', year: '2019', publisher: 'Kronik', place: 'İstanbul' } }
};
const span = (refs, text = 'x') => `<span class="cite" data-cite="${refs}" data-lang="tr" contenteditable="false">${text}</span>`;
const html = `<p>İlk iddia${span(A + '@3')} ve ikincisi${span(B + '@')} sonra tekrar${span(A + '@5')}.</p>`;

test('footnote styles number the citations in the text and write one note each, short form on repeats', () => {
  const style = 'chicago-notes-bibliography';
  assert.equal(Cite.isNote(style), true);
  const out = Manuscript.renderCitations(html, sources, style);
  assert.deepEqual([...out.matchAll(/>([⁰¹²³⁴⁵⁶⁷⁸⁹]+)</g)].map(match => match[1]), ['¹', '²', '³']);
  const notes = Manuscript.footnotes(html, sources, style);
  assert.equal(notes.length, 3);
  assert.match(notes[0].text, /^Kai Zhang and Min Jae Lee, “Deep Learning for Protein Folding,” Journal of Molecular Biology 433, no\. 5 \(2021\): 3, https:\/\/doi\.org/);
  assert.match(notes[1].text, /^Ahmet Yılmaz, Osmanlı Tarihi/);
  assert.match(notes[2].text, /^Zhang and Lee, “Deep Learning for Protein Folding,” 5\./);
  assert.match(notes[0].html, /<em>Journal of Molecular Biology<\/em>/);
});

test('the Word export turns the citations into real footnotes', async () => {
  const style = 'isnad-dipnotlu';
  const blocks = Manuscript.toBlocks(html, sources, { style });
  const body = blocks.find(block => block.type === 'p');
  assert.equal(body.runs.filter(run => run.footnote).length, 3);
  assert.ok(!body.runs.some(run => /[¹²³]/.test(run.text)), 'the raised numbers are not duplicated as text');
  assert.ok(blocks.some(block => block.type === 'h1' && block.runs[0].text === 'Kaynakça'));
  const built = await python({ operation: 'build_docx', data: '', blocks });
  const bytes = Buffer.from(built.data, 'base64');
  const names = zipNames(bytes);
  assert.ok(names.includes('word/footnotes.xml') && names.includes('word/settings.xml'));
  const inspected = await python({ operation: 'inspect', data: built.data });
  const notes = inspected.paragraphs.filter(paragraph => paragraph.part === 'word/footnotes.xml' && paragraph.text.trim());
  assert.equal(notes.length, 3);
  assert.match(notes[0].text, /Kai Zhang - Min Jae Lee, “Deep learning for protein folding”/);
});

test('a document without footnotes is built as before', async () => {
  const blocks = Manuscript.toBlocks(html, sources, { style: 'apa' });
  assert.ok(!blocks.some(block => block.runs.some(run => run.footnote)));
  const built = await python({ operation: 'build_docx', data: '', blocks });
  assert.ok(!zipNames(Buffer.from(built.data, 'base64')).includes('word/footnotes.xml'));
});

// File names of a ZIP from its central directory (enough to see which parts exist).
function zipNames(bytes) {
  const names = [];
  let offset = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = bytes.readUInt16LE(end + 10);
  offset = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    names.push(bytes.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extra + comment;
  }
  return names;
}
