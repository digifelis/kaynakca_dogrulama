const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
process.env.WORD_ARCHIVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'numbered-'));
const Service = require('../word-service.cjs');
const A = require('../word-analysis.cjs');
const N = require('../word-numeric.cjs');
const Cite = require('../writer-cite.js');
const Manuscript = require('../lib/writer-manuscript.cjs');
const { harness } = require('./helpers/harness.cjs');

const py = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const fixture = JSON.parse(execFileSync(py, [path.join(__dirname, 'numbered-fixture.py')], { encoding: 'utf8' }));
const para = (index, text, extra = {}) => ({ id: 'p' + index, index, part: 'word/document.xml', group: 'body', protected: false, text, ...extra });

// ---------------------------------------------------------------- reading the numbers
test('numbered groups: [1], [1,3], [1-3], [1]–[3], [3, p. 12]; look-alikes are ignored', () => {
  const read = text => N.citationsIn(para(0, text)).map(c => c.number);
  assert.deepEqual(read('Bulgu [1] ve [2, 4].'), [1, 2, 4]);
  assert.deepEqual(read('Bulgu [1-3] ve [5–6].'), [1, 2, 3, 5, 6]);
  assert.deepEqual(read('Bulgu [1]–[3].'), [1, 2, 3]);
  assert.deepEqual(read('Bulgu [3, p. 12] ve [4, s. 3–5].'), [3, 4]);
  assert.deepEqual(read('Örneklem [sic] [n = 25] [Internet] [0] [999999] [5-1].'), [], 'not citations');
  const [first, second] = N.citationsIn(para(0, 'Şu [1,2] gibi.'));
  assert.equal(first.original, '[1,2]'); assert.equal(first.groupFirst, true); assert.equal(second.groupFirst, false); assert.equal(first.start, 3);
});

test('typed list numbers are split off the reference; auto-numbered lists keep their text', () => {
  assert.deepEqual(N.splitLabel('3. Kaya A. Title here.'), { number: 3, prefix: '3. ', body: 'Kaya A. Title here.', form: 'dot' });
  assert.deepEqual(N.splitLabel('[12] A. Kaya, “T,” J., 2020.'), { number: 12, prefix: '[12] ', body: 'A. Kaya, “T,” J., 2020.', form: 'bracket' });
  assert.equal(N.splitLabel('2020. Report title').number, null, 'a year is not a list number');
  assert.equal(N.splitLabel('Kaya, A. (2020). Title.').number, null);
  assert.equal(A.referenceIdentity('1. Zhang K, Lee MJ. Mapping images. J. 2020;1:1-2.').author, 'Zhang');
});

test('style detection: numbered list or numbered citations mean a numbered style, IEEE from the bracketed list', () => {
  const refs = labels => labels.map((raw, i) => ({ id: 'r' + i, raw, ...N.splitLabel(raw) })).map(r => ({ ...r, number: r.number, labelForm: r.form }));
  const body = [para(0, 'Metin [1] ve [2].')];
  assert.equal(N.detectStyle(body, refs(['1. A', '2. B']), { start: 5, end: 9 }), 'vancouver');
  assert.equal(N.detectStyle(body, refs(['[1] A. Zhang, “T,” J., 2020.', '[2] B. Lee, “U,” J., 2021.']), { start: 5, end: 9 }), 'ieee');
  assert.equal(N.detectStyle([para(0, 'Metin (Yılmaz, 2020) ve (Kaya, 2021).')], refs(['Yılmaz, A. (2020). T.', 'Kaya, B. (2021). U.']), { start: 5, end: 9 }), 'apa');
  assert.equal(N.detectStyle([para(0, 'Bir [1] iki [2] üç [3] [4].')], refs(['A. T. J. 2020', 'B. U. J. 2021']), { start: 5, end: 9 }), 'vancouver', 'an auto-numbered list is recognised from the text');
});

// ---------------------------------------------------------------- the document checks
test('Word analysis of a Vancouver document: unmatched numbers, uncited sources, order, numbering gaps, ranges, entry style', async () => {
  const doc = await Service.python({ operation: 'inspect', ...fixture });
  const ext = A.extractReferences(doc.paragraphs);
  assert.deepEqual(ext.references.map(r => r.number), [1, 2, 3, 5]);
  assert.equal(ext.references[0].raw.startsWith('Zhang K'), true, 'the typed number is not part of the entry');
  assert.equal(A.detectStyle(doc.paragraphs, ext.references, ext.range), 'vancouver');
  const result = A.analyze(doc.paragraphs, ext.references, ext.range, { style: 'vancouver' });
  const types = result.findings.map(f => f.type);
  assert.ok(result.citations.some(c => c.original === '[5]' && c.reference === 'r3'), '[5] is the fifth typed number');
  assert.ok(result.findings.some(f => f.type === 'Kaynakçası olmayan atıf' && f.original.includes('[7')), '[7] has no entry');
  assert.ok(types.includes('Atıf numarası ilk geçiş sırasında değil'));
  assert.ok(result.findings.some(f => f.type === 'Kaynakça numaralandırması bozuk' && /4 numaralı/.test(f.original)), 'the list skips 4');
  const range = result.findings.find(f => f.type === 'Ardışık numaralar aralık olarak yazılabilir');
  assert.equal(range.patch.replacement, '[1-3]'); assert.equal(range.patch.original, '[1,2,3]');
  const style = result.findings.find(f => f.type === 'Kaynakça girdisi Vancouver biçimine uymuyor');
  assert.match(style.original, /^Kaya A, Demir B/); assert.match(style.reviewReason, /üçten fazla yazar/);
  assert.equal(result.findings.filter(f => f.id.startsWith('orphan-')).length, 0, 'every entry is cited at least once');
  // the range suggestion is written into the real file
  const edited = await Service.python({ operation: 'export', ...fixture, patches: [range.patch] });
  assert.match((await Service.python({ operation: 'inspect', data: edited.data })).paragraphs[1].text, /\[1-3\]/);
});

test('an author–year document is not touched by the numbered checks', async () => {
  const paragraphs = [para(0, 'Giriş'), para(1, 'Bulgu (Yılmaz, 2020) ve [1] işareti.'), para(2, 'Kaynakça'), para(3, 'Yılmaz, A. (2020). Örnek araştırma. Dergi, 2, 1–9.')];
  const ext = A.extractReferences(paragraphs);
  const apa = A.analyze(paragraphs, ext.references, ext.range, { style: 'apa' });
  assert.ok(apa.citations.some(c => c.original === '2020' && c.reference === 'r0'));
  assert.ok(!apa.findings.some(f => /numara|biçimine/.test(f.type)));
  assert.equal(A.detectStyle(paragraphs, ext.references, ext.range), 'apa');
});

test('IEEE entries are checked for initials-first authors, quoted titles and the six-author rule', () => {
  assert.deepEqual(N.entryProblems('A. Zhang, M. Lee, and S. Park, “Mapping images,” J. Stuff, vol. 1, no. 2, pp. 3–4, 2020.', 'ieee'), []);
  assert.match(N.entryProblems('Zhang K, Lee M. Mapping images. J Stuff. 2020;1:3-4.', 'ieee').join(' '), /başharf önce/);
  assert.match(N.entryProblems('A. Zhang, “T,” J., vol. 1, 2020.'.replace(/[“”]/g, ''), 'ieee').join(' '), /tırnak/);
  assert.match(N.entryProblems('A. One, B. Two, C. Three, D. Four, E. Five, F. Six, G. Seven, “Many authors here,” J., 2020.', 'ieee').join(' '), /altıdan fazla/);
  assert.deepEqual(N.entryProblems('Zhang K, Lee MJ, Park S. Mapping images from photos. Asia Pac J Tour Res. 2020;25(11):1199-214. doi:10.1/x', 'vancouver'), []);
  assert.match(N.entryProblems('Zhang, K. (2020). Mapping images. J., 1, 2.', 'vancouver').join(' '), /parantez/);
});

// ---------------------------------------------------------------- the Word service
test('Word service: a numbered document is detected, restyled suggestions keep the list number, the style can be chosen', async () => {
  const h = await harness({ openAreas: false });
  try {
    const admin = await h.adminClient(), user = await h.register('numara');
    await admin('PUT', '/api/admin/plans/basic', { features: ['reference', 'orphan', 'styles'] });
    const upload = await user('POST', '/api/word/upload', { name: 'numarali.docx', data: fixture.data, mode: 'word' });
    assert.ok(upload.status < 300, JSON.stringify(upload).slice(0, 200));
    const id = upload.id || upload.document?.id;
    let state = await user('GET', `/api/word/${id}`);
    assert.equal(state.citationStyle, 'vancouver'); assert.equal(state.styleAuto, true);
    assert.deepEqual(state.references.map(r => r.number), [1, 2, 3, 5]);
    assert.ok(state.findings.some(f => f.type === 'Atıf numarası ilk geçiş sırasında değil'));
    // choosing APA by hand turns the numbered checks off
    state = await user('POST', `/api/word/${id}/style`, { style: 'apa' });
    assert.equal(state.citationStyle, 'apa'); assert.equal(state.styleAuto, false);
    assert.ok(!state.findings.some(f => f.type === 'Atıf numarası ilk geçiş sırasında değil'));
    assert.equal((await user('POST', `/api/word/${id}/style`, { style: 'chicago' })).status, 400);
    state = await user('POST', `/api/word/${id}/style`, { style: 'auto' });
    assert.equal(state.citationStyle, 'vancouver');
    // a plan without the area reads the same file as author–year
    await admin('PUT', '/api/admin/plans/basic', { features: ['reference', 'orphan'] });
    state = await user('GET', `/api/word/${id}`);
    assert.equal(state.citationStyle, 'vancouver', 'the stored state is only recomputed on the next change');
    const refused = await user('POST', `/api/word/${id}/style`, { style: 'ieee' });
    assert.equal(refused.status, 403); assert.equal(refused.upgrade.feature, 'styles');
    const second = await user('POST', '/api/word/upload', { name: 'numarali2.docx', data: fixture.data, mode: 'word' });
    const again = await user('GET', `/api/word/${second.id || second.document?.id}`);
    assert.equal(again.citationStyle, 'apa', 'without the Vancouver / IEEE area the document is read as author–year');
    assert.ok(!again.findings.some(f => f.type === 'Atıf numarası ilk geçiş sırasında değil'));
  } finally { await h.close(); }
});

// ---------------------------------------------------------------- the writing assistant
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sources = {
  [uuid(1)]: { id: uuid(1), fileName: 'a.pdf', meta: { authors: ['Zhang, Kai', 'Lee, Mei-Jun'], year: '2020', title: 'Mapping destination images from photos', journal: 'Asia Pacific Journal of Tourism Research', volume: '25', issue: '11', pages: '1199–1214', doi: '10.1000/a', verified: true } },
  [uuid(2)]: { id: uuid(2), fileName: 'b.pdf', meta: { authors: ['Smith, John'], year: '2019', title: 'Another study of things', journal: 'Journal of Stuff', volume: '1', issue: '2', pages: '3-4' } },
  [uuid(3)]: { id: uuid(3), fileName: 'c.pdf', meta: { authors: ['Yılmaz, Ayşe'], year: '2018', title: 'Bir kitap başlığı', publisher: 'Yayınevi' } },
};
const span = (...refs) => `<span class="cite" data-cite="${refs.join('|')}" data-lang="tr" contenteditable="false">x</span>`;

test('citations in numbered styles: numbered by first appearance in the manuscript, groups and page locators', () => {
  const ctx = Cite.styleContext('vancouver', [uuid(2), uuid(1), uuid(3)]);
  assert.equal(Cite.renderGroup([{ docId: uuid(1), page: null }], sources, 'tr', ctx).text, '[2]');
  assert.equal(Cite.renderGroup([{ docId: uuid(1) }, { docId: uuid(2) }, { docId: uuid(3) }], sources, 'tr', ctx).text, '[1-3]');
  assert.equal(Cite.renderGroup([{ docId: uuid(2), page: 12 }], sources, 'tr', ctx).text, '[1, s. 12]');
  assert.equal(Cite.renderGroup([{ docId: uuid(2), page: 12 }, { docId: uuid(2), page: 14 }], sources, 'en', ctx).text, '[1, pp. 12, 14]');
  assert.equal(Cite.renderGroup([{ docId: uuid(1) }, { docId: uuid(3) }], sources, 'tr', Cite.styleContext('ieee', [uuid(1), uuid(2), uuid(3)])).text, '[1], [3]');
  assert.equal(Cite.renderGroup([{ docId: 'gone' }], sources, 'tr', ctx).text, '[silinmiş kaynak]');
  assert.equal(Cite.styleContext('apa', [uuid(1)]), null, 'APA stays author–year');
});

test('manuscript: citations and the reference list follow the style; the list is in citation order, not alphabetical', () => {
  const html = `<p>Birinci ${span(uuid(2) + '@3')} ikinci ${span(uuid(1) + '@')} tekrar ${span(uuid(2) + '@')} ve ${span(uuid(1) + '@', uuid(3) + '@')}.</p>`;
  const vancouver = Manuscript.renderCitations(html, sources, 'vancouver');
  assert.deepEqual([...vancouver.matchAll(/>([^<]*)<\/span>/g)].map(m => m[1]), ['[1, s. 3]', '[2]', '[1]', '[2-3]'.replace('2-3', '2,3')]);
  const list = Manuscript.bibliography(html, sources, 'vancouver');
  assert.deepEqual(list.map(e => e.number), [1, 2, 3]);
  assert.match(list[0].text, /^1\. Smith J\. Another study of things\. J Stuff\. 2019;1\(2\):3-4\.$/);
  assert.match(list[1].text, /^2\. Zhang K, Lee MJ\. Mapping destination images from photos\. Asia Pac J Tour Res\. 2020;25\(11\):1199-214\. doi:10\.1000\/a$/);
  assert.match(list[2].text, /^3\. Yılmaz A\. Bir kitap başlığı\. Yayınevi; 2018\.$/);
  const ieee = Manuscript.bibliography(html, sources, 'ieee');
  assert.match(ieee[1].text, /^\[2\] K\. Zhang and M\. J\. Lee, “Mapping Destination Images from Photos,” Asia Pac\. J\. Tour\. Res\., vol\. 25, no\. 11, pp\. 1199–1214, 2020, doi: 10\.1000\/a\.$/);
  assert.match(ieee[1].html, /<em>Asia Pac\. J\. Tour\. Res\.<\/em>/);
  const apa = Manuscript.bibliography(html, sources, 'apa');
  assert.deepEqual(apa.map(e => e.number), [null, null, null]); assert.ok(apa[0].text.startsWith('Smith') || apa[0].text.startsWith('Yılmaz') || apa[0].text.startsWith('Zhang'));
  assert.deepEqual(apa.map(e => e.text), [...apa.map(e => e.text)].sort((a, b) => a.localeCompare(b, 'tr')), 'APA stays alphabetical');
  // the DOCX gets the numbered list too
  const blocks = Manuscript.toBlocks(html, sources, { style: 'vancouver' });
  assert.ok(blocks.some(b => b.type === 'h1' && b.runs[0].text === 'Kaynakça'));
  assert.deepEqual(blocks.filter(b => b.type === 'ref').map(b => b.runs.map(r => r.text).join('').slice(0, 3)), ['1. ', '2. ', '3. ']);
  assert.match(blocks[0].runs.map(r => r.text).join(''), /\[1, s\. 3\].*\[2\].*\[1\]/);
});

test('writer: the project style is stored, needs the Vancouver / IEEE area, and rewrites the manuscript view', async () => {
  const h = await harness({ openAreas: false });
  try {
    const admin = await h.adminClient(), user = await h.register('stil');
    await admin('PUT', '/api/admin/plans/basic', { features: ['reference', 'orphan', 'writer'] });
    const { project } = await user('POST', '/api/writer/projects', { title: 'Makale' });
    assert.equal(project.citationStyle, 'apa');
    const refused = await user('PATCH', `/api/writer/projects/${project.id}`, { citationStyle: 'vancouver' });
    assert.equal(refused.status, 403); assert.equal(refused.upgrade.feature, 'styles');
    assert.equal((await user('PATCH', `/api/writer/projects/${project.id}`, { citationStyle: 'chicago' })).status, 400);
    await admin('PUT', '/api/admin/plans/basic', { features: ['reference', 'orphan', 'writer', 'styles'] });
    const changed = await user('PATCH', `/api/writer/projects/${project.id}`, { citationStyle: 'ieee' });
    assert.equal(changed.status, 200); assert.equal(changed.project.citationStyle, 'ieee'); assert.equal(changed.project.title, 'Makale', 'the title is untouched');
    assert.equal((await user('GET', `/api/writer/projects/${project.id}`)).project.citationStyle, 'ieee');
    const back = await user('PATCH', `/api/writer/projects/${project.id}`, { citationStyle: 'apa' });
    assert.equal(back.project.citationStyle, 'apa');
  } finally { await h.close(); }
});
