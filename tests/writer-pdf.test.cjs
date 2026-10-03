// The writing assistant with the real Python reader: a real text PDF and a real DOCX go in, passages with pages come out.
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const Identity = require('../lib/identity.cjs');
const Search = require('../lib/writer-search.cjs');
const { createStore } = require('../lib/writer-store.cjs');
const { createService } = require('../writer-service.cjs');
const { python } = require('../lib/python.cjs');
const { makePdf } = require('./pdf-fixture.cjs');

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const lines = (...texts) => texts.map((text, i) => [72, 760 - i * 16, text]);
const PDF = makePdf([
  [...lines('Digital transformation in higher education', 'Published 2021. Smith, J. and Brown, K.', '',
    'Digital learning platforms increased student engagement in universities during the pandemic years and this effect remained stable.',
    'Instructors reported that online tools changed assessment practices and feedback timing across many disciplines.')],
  [...lines('Student engagement was strongly related to the quality of feedback that learners received from their instructors,',
    'and the relation held for large and small classes alike in the studied institutions across several countries.', '',
    'References', 'Smith, J. (2019). A hidden reference title that must not be indexed. Journal of Tests, 1(1), 1-9.')],
]);

async function run(t, buffer, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-pdf-')); process.env.WRITER_DATA_DIR = dir; Identity._reset();
  const store = createStore(dir);
  const service = createService({ store: () => store, python, verifyMeta: async () => null,
    embed: { BATCH: 32, available: () => true, embedBatch: async texts => texts.map(text => { const v = new Float32Array(32); for (const tk of Search.tokenize(text)) v[tk.length % 32]++; return v; }) },
    llm: { llmAvailable: () => true, llmMissing: () => '', llmChat: async () => ({ result: { answer: 'x', insufficient: false } }) } });
  const server = http.createServer((req, res) => service.handle(req, res, new URL(req.url, 'http://x'), json));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); store.close(); });
  let cookie = '';
  const api = async (method, url, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/writer${url}`, { method, headers: { ...(cookie ? { cookie } : {}), 'x-word-request': '1', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie;
    return { status: response.status, ...(await response.json()) };
  };
  const { project } = await api('POST', '/projects', { title: 'Gerçek dosya' });
  const { collection } = await api('POST', '/collections', { name: 'Deneme koleksiyonu' });
  await api('PUT', `/projects/${project.id}/collections`, { ids: [collection.id] });
  const uploaded = await api('POST', `/collections/${collection.id}/sources`, { name, data: buffer.toString('base64') });
  assert.equal(uploaded.status, 202, JSON.stringify(uploaded));
  await service.idle();
  const data = await api('GET', `/projects/${project.id}`);
  const userId = store.db.prepare('SELECT user_id FROM projects').get().user_id;
  return { data, source: data.sources[0], chunks: store.projectChunks(userId, project.id) };
}

test('a real text PDF: passages keep their page, the reference list is not indexed, künye comes from the first page', async t => {
  const { source, chunks } = await run(t, PDF, 'smith.pdf');
  assert.equal(source.status, 'ready', source.error); assert.equal(source.searchMode, 'semantic'); assert.equal(source.pageCount, 2);
  assert.ok(chunks.length >= 1); assert.ok(chunks.every(c => c.vector && c.vector.length === 32));
  // The reader joins a paragraph that continues over a page break; its passage cites the page where it starts.
  assert.ok(chunks.some(c => c.page === 1 && /feedback/.test(c.text) && /Student engagement/.test(c.text)));
  assert.ok(!chunks.some(c => /hidden reference title/.test(c.text)), 'the PDF\'s own bibliography is excluded');
  assert.equal(source.meta.year, '2021'); assert.equal(source.meta.language, 'en'); assert.match(source.meta.title, /Digital transformation/);
});

test('a real DOCX: headings become sections, core properties give the künye, the bibliography is excluded', async t => {
  const run1 = (text, bold) => ({ text, bold });
  const built = await python({ operation: 'build_docx', data: '', blocks: [
    { type: 'h1', runs: [run1('Giriş', true)] },
    { type: 'p', runs: [run1('Öğrencilerin akademik motivasyonu sınav başarısını artırmaktadır ve bu ilişki birçok çalışmada gösterilmiştir. Yayın: 2020.')] },
    { type: 'h1', runs: [run1('Yöntem', true)] },
    { type: 'p', runs: [run1('Çalışmada nicel araştırma deseni kullanılmış ve veriler anket ile toplanmıştır; örneklem rastgele seçilmiştir.')] },
    { type: 'h1', runs: [run1('Kaynakça', true)] },
    { type: 'p', runs: [run1('Yılmaz, A. (2019). Gizli kaynakça kaydı başlığı. Eğitim Dergisi, 2(1), 3-9.')] },
  ] });
  const { source, chunks } = await run(t, Buffer.from(built.data, 'base64'), 'makale.docx');
  assert.equal(source.status, 'ready', source.error); assert.equal(source.pageCount, null);
  assert.deepEqual(chunks.map(c => c.section), ['Giriş', 'Yöntem']);
  assert.ok(chunks.every(c => c.page === null), 'Word files have no reliable page numbers, so none are cited');
  assert.ok(!chunks.some(c => /Gizli kaynakça/.test(c.text)));
  assert.equal(source.meta.year, '2020'); assert.equal(source.meta.language, 'tr');
});
