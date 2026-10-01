const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
process.env.WORD_ARCHIVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'word-pdf-tests-'));
const S = require('../word-service.cjs'), Store = require('../word-store.cjs'), Analysis = require('../word-analysis.cjs');
const { manuscript, makePdf } = require('./pdf-fixture.cjs');

test('PDF paragraphs drop running headers and page numbers, rejoin page breaks and hyphens, split hanging-indent references', async () => {
  const { paragraphs } = await S.python({ operation: 'inspect_pdf', data: manuscript().toString('base64') });
  const texts = paragraphs.map(p => p.text);
  assert.ok(texts.every(t => !/Journal of Testing Studies/.test(t)), 'running header removed');
  assert.ok(texts.every(t => !/^\d+$/.test(t)), 'page numbers removed');
  assert.ok(texts.some(t => /the page ends here while the sentence is still running \(Lee, 2021\)\./.test(t)), 'paragraph continues across the page break');
  assert.ok(texts.some(t => /international sample/.test(t)), 'line-end hyphen joined');
  assert.equal(paragraphs.find(p => p.text === 'References')?.style, 'Heading');
  const extracted = Analysis.extractReferences(paragraphs);
  assert.equal(extracted.needsRange, false);
  assert.deepEqual(extracted.references.map(r => r.author + ' ' + r.year), ['Brown 2019', 'Lee 2021', 'Smith 2020']);
  assert.match(extracted.references[1].raw, /Computers and Education, 45, 100-115\. https:\/\/doi\.org\/10\.1000\/test\.2021\.1$/);
  const analysis = Analysis.analyze(paragraphs, extracted.references, extracted.range);
  assert.deepEqual(analysis.citations.map(c => c.reference).sort(), ['r0', 'r1', 'r2']);
  assert.deepEqual(analysis.findings, []);
});

test('PDF without a text layer and files that are not PDFs are refused with a clear message', async () => {
  await assert.rejects(S.python({ operation: 'inspect_pdf', data: makePdf([[[72, 700, 'x']]]).toString('base64') }), /OCR/);
  await assert.rejects(S.python({ operation: 'inspect_pdf', data: Buffer.from('not a pdf').toString('base64') }), /Geçerli PDF değil/);
});

test('PDF upload is analysed read-only: no corrected file, no in-document fixes, original stays a PDF', async () => {
  const server = require('../server.cjs').createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port, headers = { 'X-Word-Request': '1', 'Content-Type': 'application/json' };
  const post = (route, data) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(data) });
  let id;
  try {
    const pdf = manuscript();
    let response = await post('/api/word/upload', { name: 'makale.pdf', mode: 'word', data: pdf.toString('base64') });
    const s = await response.json(); id = s.id;
    assert.equal(response.status, 200, JSON.stringify(s));
    assert.equal(s.format, 'pdf');
    assert.equal(s.references.length, 3);
    assert.equal(s.citations.length, 3);
    assert.ok(s.paragraphs.every(p => !p.editable));
    assert.ok(s.findings.every(f => !f.patch));
    response = await fetch(base + '/api/word/' + id + '/download');
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /PDF belgelerine düzeltme yazılamaz/);
    response = await post('/api/word/' + id + '/applymany', { ids: ['x'] });
    assert.equal(response.status, 400);
    response = await fetch(base + '/api/word/' + id + '/original');
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf);
    const list = await (await fetch(base + '/api/word/documents')).json();
    assert.equal(list.documents.find(d => d.id === id).format, 'pdf');
    response = await post('/api/word/upload', { name: 'sahte.pdf', mode: 'word', data: Buffer.from('PK not a pdf').toString('base64') });
    assert.equal(response.status, 400);
    response = await post('/api/word/upload', { name: 'makale.txt', mode: 'word', data: pdf.toString('base64') });
    assert.match((await response.json()).error, /Word \(\.docx\) ve PDF/);
  } finally {
    if (id && S.sessions.has(id)) { Store.remove(id); S.dispose(S.sessions.get(id)); }
    await new Promise(r => server.close(r));
  }
});
