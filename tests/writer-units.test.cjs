const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const Plans = require('../lib/plans.cjs');
const Identity = require('../lib/identity.cjs');
const Cite = require('../writer-cite.js');
const Chunker = require('../lib/writer-chunker.cjs');
const Search = require('../lib/writer-search.cjs');
const Answer = require('../lib/writer-answer.cjs');
const Skills = require('../lib/writer-skills.cjs');
const Manuscript = require('../lib/writer-manuscript.cjs');
const Meta = require('../lib/writer-meta.cjs');
const Gemini = require('../lib/gemini-embed.cjs');
const { createStore } = require('../lib/writer-store.cjs');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'writer-'));
const ID1 = '11111111-2222-4333-8444-555555555555', ID2 = '66666666-7777-4888-8999-000000000000';

test('plan limits throw an upgrade hint naming the next plan and its value', () => {
  Plans.enforce('basic', 'projects', 9);
  assert.throws(() => Plans.enforce('basic', 'projects', 10), e => e.status === 429 && e.code === 'plan_limit'
    && e.upgrade.limit === 'projects' && e.upgrade.value === 10 && e.upgrade.nextPlan === 'premium' && e.upgrade.nextValue > 10 && /Premium/.test(e.message));
  assert.throws(() => Plans.enforce('gold', 'projects', 10_000), e => e.upgrade.nextPlan === null && !/pakete geçerek/.test(e.message));
  assert.equal(Plans.limitsFor('whatever').projects, 10, 'unknown plans fall back to basic');
  assert.deepEqual([Plans.limitsFor('basic').projects, Plans.limitsFor('basic').documentsPerProject, Plans.limitsFor('basic').documentBytes, Plans.limitsFor('basic').questionsPerDay], [10, 20, 50 * 1048576, 200]);
});

test('identity cookie is signed: forged or tampered cookies are replaced, valid ones are reused', () => {
  process.env.WRITER_DATA_DIR = temp(); Identity._reset();
  const headers = {};
  const res = { setHeader: (k, v) => { headers[k] = v; } };
  const first = Identity.resolveUser({ headers: {} }, res);
  assert.equal(first.plan, 'basic'); assert.match(first.userId, /^[a-f0-9]{32}$/);
  assert.match(headers['Set-Cookie'], /HttpOnly; SameSite=Strict/);
  const cookie = headers['Set-Cookie'].split(';')[0];
  const again = Identity.resolveUser({ headers: { cookie } }, { setHeader() { assert.fail('valid cookie must not be reissued'); } });
  assert.equal(again.userId, first.userId);
  const forged = Identity.resolveUser({ headers: { cookie: 'km_uid=' + 'a'.repeat(32) + '.forged' } }, res);
  assert.notEqual(forged.userId, 'a'.repeat(32));
  const tampered = Identity.resolveUser({ headers: { cookie: cookie.replace(/^km_uid=\w{4}/, 'km_uid=ffff') } }, res);
  assert.notEqual(tampered.userId, first.userId);
  Identity.setResolver(() => ({ userId: 'x'.repeat(32), plan: 'gold' }));
  assert.deepEqual(Identity.resolveUser({ headers: {} }, res), { userId: 'x'.repeat(32), plan: 'gold' }, 'a real login can replace the resolver');
  Identity._reset();
});

test('store: a user can never read, change or delete another user\'s project data', () => {
  const store = createStore(temp());
  const a = 'a'.repeat(32), b = 'b'.repeat(32);
  const pa = store.createProject(a, 'A projesi'), pb = store.createProject(b, 'B projesi');
  const ca = store.createCollection(a, 'A koleksiyonu'); store.setProjectCollections(a, pa.id, [ca.id]);
  const da = store.addDocument(a, ca.id, { fileName: 'a.pdf' });
  store.insertChunks(a, ca.id, da.id, [{ page: 1, text: 'gizli a metni' }]);
  store.setEmbeddings(a, da.id, [{ id: store.chunksToEmbed(a, da.id, 5)[0].id, vector: [1, 0] }]);
  store.updateDocument(a, da.id, { status: 'ready' });
  store.addMessage(a, pa.id, { role: 'user', text: 'soru' });
  store.saveManuscript(a, pa.id, '<p>a</p>', 0);
  // B asks for A's rows by id, in every table
  assert.equal(store.getProject(b, pa.id), null);
  assert.equal(store.getDocument(b, da.id), null);
  assert.deepEqual(store.listDocuments(b, ca.id), []); assert.equal(store.getCollection(b, ca.id), null); assert.deepEqual(store.listCollections(b), []);
  assert.equal(store.renameCollection(b, ca.id, 'x'), false); assert.equal(store.deleteCollection(b, ca.id), false);
  assert.deepEqual(store.setProjectCollections(b, pb.id, [ca.id]), [], 'another user\'s collection cannot be linked');
  assert.deepEqual(store.projectChunks(b, pa.id), []);
  assert.deepEqual(store.listMessages(b, pa.id), []);
  assert.equal(store.getManuscript(b, pa.id).html, '');
  assert.equal(store.renameProject(b, pa.id, 'x'), false);
  assert.equal(store.deleteDocument(b, da.id), false);
  assert.equal(store.deleteProject(b, pa.id), false);
  assert.equal(store.chunkById(b, 1), null);
  // B cannot plant data in A's project either
  assert.throws(() => store.saveManuscript(b, pa.id, '<p>b</p>', 1), /başka bir pencerede/);
  assert.equal(store.projectChunks(a, pa.id).length, 1);
  assert.equal(store.projectChunks(a, pa.id)[0].vector.length, 2);
  // same project id, two users: separate manuscripts
  assert.equal(store.getManuscript(a, pa.id).html, '<p>a</p>');
  assert.deepEqual(store.listProjects(b).map(p => p.title), ['B projesi']);
  assert.equal(store.countProjects(a), 1);
  // deleting A's project removes its messages and manuscript and the link, but not A's collection; deleting the collection removes its sources
  store.addMessage(b, pb.id, { role: 'user', text: 'b soru' });
  assert.equal(store.deleteProject(a, pa.id), true);
  assert.deepEqual(store.projectChunks(a, pa.id), []); assert.ok(store.getDocument(a, da.id)); assert.deepEqual(store.listMessages(a, pa.id), []);
  assert.equal(store.listMessages(b, pb.id).length, 1);
  assert.equal(store.deleteCollection(a, ca.id), true);
  assert.equal(store.getDocument(a, da.id), null); assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n, 0);
  store.close();
});

test('store: stale manuscript saves are refused; interrupted work is marked on restart', () => {
  const store = createStore(temp());
  const u = 'c'.repeat(32), p = store.createProject(u, 'p');
  assert.equal(store.saveManuscript(u, p.id, '<p>1</p>', 0).revision, 1);
  assert.throws(() => store.saveManuscript(u, p.id, '<p>2</p>', 0), e => e.status === 409);
  const d = store.addDocument(u, p.id, { fileName: 'x.pdf' });
  const m = store.addMessage(u, p.id, { role: 'assistant', status: 'working' });
  const saved = store.addDocument(u, p.id, { fileName: 'saved.pdf' });
  store.insertChunks(u, p.id, saved.id, [{ text: 'bir parça' }]); store.updateDocument(u, saved.id, { status: 'embedding' });
  assert.deepEqual(store.recoverInterrupted(), { documents: 2, messages: 1 });
  assert.equal(store.getDocument(u, d.id).status, 'error'); assert.equal(store.getMessage(u, m.id).status, 'error');
  // Passages were already saved: the source stays usable with keyword search and only its embedding is repeated.
  assert.equal(store.getDocument(u, saved.id).status, 'ready'); assert.equal(store.getDocument(u, saved.id).searchMode, 'keyword');
  store.addQuestion(u); store.addQuestion(u); assert.equal(store.questionsToday(u), 2); assert.equal(store.questionsToday('d'.repeat(32)), 0);
  store.close();
});

test('chunker keeps pages and headings, drops the bibliography and overlaps passages', () => {
  const sentence = n => `Bu ${n}. cümle araştırmanın bulgularını ayrıntılı biçimde anlatmaktadır ve okuyucuya bilgi verir.`;
  const long = Array.from({ length: 40 }, (_, i) => sentence(i + 1)).join(' ');
  const paragraphs = [
    { id: 'p0', part: 'word/document.xml', index: 0, text: 'Giriş', style: 'Heading1', page: 1 },
    { id: 'p1', part: 'word/document.xml', index: 1, text: long, page: 1 },
    { id: 'p2', part: 'word/document.xml', index: 2, text: 'Sonuç', style: 'Heading1', page: 2 },
    { id: 'p3', part: 'word/document.xml', index: 3, text: 'Kısa sonuç paragrafı burada yer alır ve çalışmanın ana bulgusunu özetler.', page: 2 },
    { id: 'p4', part: 'word/document.xml', index: 4, text: 'Kaynakça', style: 'Heading1', page: 3 },
    { id: 'p5', part: 'word/document.xml', index: 5, text: 'Yılmaz, A. (2020). Gizli kaynak başlığı. Dergi, 1(2), 3-4.', page: 3 },
    { id: 'p6', part: 'word/document.xml', index: 6, text: 'Kaya, B. (2019). Diğer kaynak başlığı. Dergi, 2(1), 5-9.', page: 3 },
  ];
  const chunks = Chunker.chunkParagraphs(paragraphs);
  assert.ok(chunks.length >= 3, 'the long paragraph was split');
  assert.ok(chunks.every(c => c.text.split(/\s+/).length <= 345), 'passages stay near the word budget');
  assert.equal(chunks[0].section, 'Giriş'); assert.equal(chunks[0].page, 1);
  assert.ok(chunks.some(c => c.section === 'Sonuç' && c.page === 2 && /Kısa sonuç/.test(c.text)));
  assert.ok(!chunks.some(c => /Gizli kaynak|Diğer kaynak|Kaynakça/.test(c.text)), 'the document\'s own reference list is not evidence');
  const firstTail = chunks[0].text.split(/\s+/).slice(-10).join(' ');
  assert.ok(chunks[1].text.includes(firstTail), 'consecutive passages overlap');
});

test('search: keywords find Turkish word forms, vectors find meaning, one document cannot fill every slot', () => {
  assert.deepEqual(Search.tokenize('Öğrencilerin motivasyonunu'), ['öğren', 'motiv']);
  const chunks = [
    { id: 1, documentId: 'd1', text: 'Öğrencilerin akademik motivasyonu sınav kaygısı ile ilişkilidir.' },
    { id: 2, documentId: 'd1', text: 'Mikroservis mimarisi kuyruk tabanlı iletişim kullanır.' },
    { id: 3, documentId: 'd2', text: 'Bitki örtüsü iklim değişikliğinden etkilenmektedir.' },
  ];
  assert.equal(Search.rank({ query: 'öğrenci motivasyonu nedir', chunks })[0].id, 1);
  const withVectors = [{ ...chunks[0], vector: Float32Array.from([1, 0]) }, { ...chunks[1], vector: Float32Array.from([0, 1]) }, { ...chunks[2], vector: Float32Array.from([0.6, 0.8]) }];
  const ranked = Search.rank({ query: 'tamamen alakasız sorgu', queryVector: Float32Array.from([0, 1]), chunks: withVectors });
  assert.equal(ranked[0].id, 2, 'embedding similarity ranks when no keyword matches');
  assert.equal(ranked[0].vector, undefined, 'vectors are not passed on');
  const many = Array.from({ length: 10 }, (_, i) => ({ id: i, documentId: 'only', text: 'kuyruk iletişim ' + i }))
    .concat([{ id: 99, documentId: 'other', text: 'kuyruk iletişim diğer kaynak' }]);
  const capped = Search.rank({ query: 'kuyruk iletişim', chunks: many, limit: 8, perDocument: 3 });
  assert.equal(capped.filter(c => c.documentId === 'only').length, 3); assert.ok(capped.some(c => c.documentId === 'other'));
});

test('citations are rendered from the source data: APA 7 author–year, Turkish and English forms, page merging', () => {
  const s = (id, authors, year, extra = {}) => ({ id, fileName: id + '.pdf', meta: { authors, year, title: 'Bir başlık', ...extra } });
  const src = { a: s('a', ['Yılmaz, Ahmet'], '2020'), b: s('b', ['Kaya, B.', 'Demir, C.'], '2019'), c: s('c', ['Ak, D.', 'Bal, E.', 'Cin, F.'], '2021'), n: s('n', [], '', { title: '' }) };
  assert.equal(Cite.renderGroup([{ docId: 'a', page: 12 }], src, 'tr').text, '(Yılmaz, 2020, s. 12)');
  assert.equal(Cite.renderGroup([{ docId: 'b', page: 3 }, { docId: 'b', page: 5 }], src, 'tr').text, '(Kaya ve Demir, 2019, ss. 3, 5)');
  assert.equal(Cite.renderGroup([{ docId: 'b', page: 3 }], src, 'en').text, '(Kaya & Demir, 2019, p. 3)');
  assert.equal(Cite.renderGroup([{ docId: 'c' }], src, 'tr').text, '(Ak vd., 2021)');
  assert.equal(Cite.renderGroup([{ docId: 'c' }], src, 'en').text, '(Ak et al., 2021)');
  assert.equal(Cite.renderGroup([{ docId: 'a', page: 1 }, { docId: 'c' }, { docId: 'b' }], src, 'tr').text, '(Ak vd., 2021; Kaya ve Demir, 2019; Yılmaz, 2020, s. 1)', 'alphabetical, ";" separated');
  const missing = Cite.renderGroup([{ docId: 'n', page: 2 }], src, 'tr');
  assert.ok(missing.incomplete); assert.match(missing.text, /Künye eksik: n/, 'never an invented author');
  assert.ok(Cite.renderGroup([{ docId: 'gone' }], src, 'tr').incomplete);
  assert.equal(Cite.renderGroup([{ docId: 'a' }], { a: s('a', ['Yılmaz, A.'], '') }, 'tr').text, '(Yılmaz, t.y.)');
  // correcting the data changes every rendering of the same token
  const raw = `Önemlidir ${Cite.tokenFor([{ docId: 'a', page: 12 }])}.`;
  assert.equal(Cite.renderText(raw, src, 'tr'), 'Önemlidir (Yılmaz, 2020, s. 12).');
  src.a.meta.year = '2021'; src.a.meta.authors = ['Öztürk, M.'];
  assert.equal(Cite.renderText(raw, src, 'tr'), 'Önemlidir (Öztürk, 2021, s. 12).');
  assert.deepEqual(Cite.parseRefs('a@3|b@'), [{ docId: 'a', page: 3 }, { docId: 'b', page: null }]);
});

test('reference list entries are APA 7; a verified record\'s own formatting is used until the user edits', () => {
  const entry = Cite.referenceEntry({ fileName: 'x.pdf', meta: { authors: ['Yılmaz, Ahmet Can', 'Kaya, B.'], year: '2020', title: 'Eğitimde motivasyon', journal: 'Eğitim Dergisi', volume: '5', issue: '2', pages: '10-20', doi: '10.1/x' } });
  assert.equal(entry.text, 'Yılmaz, A. C., & Kaya, B. (2020). Eğitimde motivasyon. Eğitim Dergisi, 5(2), 10-20. https://doi.org/10.1/x');
  assert.match(entry.html, /<em>Eğitim Dergisi<\/em>, <em>5<\/em>\(2\)/);
  assert.equal(Cite.referenceEntry({ meta: { apa: 'Verified line.', apaHtml: '<em>V</em>' } }).html, '<em>V</em>');
  const noAuthor = Cite.referenceEntry({ fileName: 'x.pdf', meta: { title: 'Kurumsal rapor', year: '2018', publisher: 'Bakanlık' } });
  assert.equal(noAuthor.text, 'Kurumsal rapor. (2018). Bakanlık.');
  assert.equal(Cite.trust({ verified: true }), 'verified'); assert.equal(Cite.trust({ confirmed: true }), 'confirmed'); assert.equal(Cite.trust({}), 'unverified');
});

test('model markers become source tokens; unknown ids are dropped, never guessed', () => {
  const chunks = [{ documentId: 'd1', page: 4 }, { documentId: 'd2', page: 9 }, { documentId: 'd1', page: 7 }];
  const text = Answer.applyCitations('Birinci iddia [P1]. İkinci iddia [P2][P3] ve üçüncü [P1, P2]; uydurma [P9] kalmamalı.', chunks);
  assert.equal(text, 'Birinci iddia {{c:d1@4}}. İkinci iddia {{c:d2@9|d1@7}} ve üçüncü {{c:d1@4|d2@9}}; uydurma kalmamalı.');
  assert.equal(Answer.applyCitations('Atıfsız metin.', chunks), 'Atıfsız metin.');
  // Variant spellings of a marker must not leak into the text as raw "p1".
  assert.equal(Answer.applyCitations('A [p1, P3] B (P2) C [P1–P2].', chunks), 'A {{c:d1@4|d1@7}} B {{c:d2@9}} C {{c:d1@4|d2@9}}.');
  // A passage named as the sentence subject becomes the author label (the cite token follows at the clause end).
  const sources = { d1: { meta: { authors: ['Kızıldere Gökyer, A.', 'Özen, B.'] } } };
  assert.equal(Answer.applyCitations('P1, kenti vurgular [P1]. P2 amaçlar [P2].', chunks, sources, 'tr'), 'Kızıldere Gökyer ve Özen, kenti vurgular {{c:d1@4}}. kaynak amaçlar {{c:d2@9}}.');
  const skill = Skills.parse(fs.readFileSync(path.join(__dirname, '../skills/giris-yaz.md'), 'utf8'), 'giris-yaz.md');
  const req = Answer.request({ skill, question: 'Giriş yaz', chunks: [{ documentId: 'd1', page: 2, section: 'Giriş', text: 'x'.repeat(5000) }], sourcesById: { d1: { fileName: 'a.pdf', meta: { authors: ['Yılmaz, A.'], year: '2020', title: 'T' } } }, history: [{ role: 'user', text: 'önce' }], draft: 'taslak' });
  const user = JSON.parse(req.user);
  assert.equal(user.passages[0].id, 'P1'); assert.equal(user.passages[0].text.length, 1800); assert.equal(user.draft, 'taslak');
  assert.match(req.system, /untrusted data/); assert.match(req.system, /SKILL: Giriş bölümü yaz/); assert.equal(req.name, 'writer_answer');
});

test('skills: real files load, plans filter them, the template is ignored, suggestions are keyword based', () => {
  const all = Skills.load();
  assert.deepEqual(all.problems, [], 'every skill file is valid');
  const names = all.skills.map(s => s.name);
  for (const n of ['genel', 'giris-yaz', 'yontem-yaz', 'bulgular-yaz', 'tartisma-yaz', 'literatur-ozeti', 'kaynak-karsilastir', 'akademik-dil']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('ornek-skill'));
  assert.ok(!Skills.forPlan('basic').some(s => s.name === 'kaynak-karsilastir')); assert.ok(Skills.forPlan('premium').some(s => s.name === 'kaynak-karsilastir'));
  assert.equal(Skills.get('kaynak-karsilastir', 'basic'), null);
  assert.equal(Skills.suggest('Makalenin giriş bölümünü yazar mısın?', 'basic'), 'giris-yaz');
  assert.equal(Skills.suggest('Bu paragrafı akademik dile çevir', 'basic'), 'akademik-dil');
  assert.equal(Skills.suggest('xyz qwerty', 'basic'), 'genel');
  assert.equal(Skills.get('akademik-dil', 'basic').needsSources, false);
  assert.equal(Skills.parse('---\nname: x\n---\n', 'x.md'), null, 'missing title/body is rejected');
  assert.equal(Skills.parse('---\nname: other\ntitle: T\n---\nbody', 'x.md'), null, 'name must match the file');
});

test('manuscript HTML is sanitized, cited sources are listed, DOCX blocks carry current citation text', () => {
  const src = { [ID1]: { id: ID1, fileName: 'a.pdf', meta: { authors: ['Yılmaz, A.'], year: '2020', title: 'Başlık A', verified: true } },
    [ID2]: { id: ID2, fileName: 'b.pdf', meta: { authors: ['Kaya, B.'], year: '2019', title: 'Başlık B', confirmed: true } } };
  const dirty = `<h1 onclick="x()">Başlık</h1><script>alert(1)</script><p style="color:red">Metin <strong>kalın</strong> <span class="cite" data-cite="${ID1}@3" data-lang="tr" contenteditable="false">ESKİ METİN</span>.</p><iframe src="x"></iframe><p>İkinci <em>vurgu</em> ${'<b>'}açık</p><img src=x onerror=y>`;
  const clean = Manuscript.sanitize(dirty);
  assert.ok(!/script|onclick|onerror|iframe|style=|<img/i.test(clean), clean);
  assert.match(clean, /<span class="cite" data-cite="[^"]+@3" data-lang="tr" contenteditable="false">/);
  assert.match(Manuscript.renderCitations(clean, src), /\(Yılmaz, 2020, s\. 3\)/, 'span text is re-rendered from the source');
  assert.deepEqual(Manuscript.citedDocuments(clean), [ID1]);
  assert.equal(Manuscript.sanitize(`<span class="cite" data-cite="not-a-uuid@1">x</span>`), '<span>x</span>', 'malformed citations lose their meaning');
  const bib = Manuscript.bibliography(clean + `<span class="cite" data-cite="${ID2}@1" data-lang="tr">k</span>`, src);
  assert.deepEqual(Object.fromEntries(bib.map(b => [b.id, b.trust])), { [ID2]: 'confirmed', [ID1]: 'verified' });
  assert.deepEqual(bib.map(b => b.text.split(' ')[0]), ['Kaya,', 'Yılmaz,'], 'alphabetical');
  const blocks = Manuscript.toBlocks(clean, src);
  assert.equal(blocks[0].type, 'h1'); assert.ok(blocks.some(b => b.runs.some(r => r.bold && r.text === 'kalın')));
  assert.ok(blocks.some(b => b.runs.map(r => r.text).join('').includes('(Yılmaz, 2020, s. 3)')));
  assert.deepEqual(blocks.slice(-2).map(b => b.type), ['h1', 'ref'], 'the reference list is appended automatically');
  assert.equal(blocks.at(-1).runs.map(r => r.text).join('').startsWith('Yılmaz, A. (2020).'), true);
  assert.equal(Manuscript.toBlocks('<p>Atıfsız</p>', src).some(b => b.type === 'ref'), false);
  assert.equal(Manuscript.plainText('<h1>A</h1><p>B &amp; C</p>'), 'A\nB & C');
});

test('künye guessing: DOI, year, title and authors from the file, generic titles ignored', () => {
  const paragraphs = [{ part: 'word/document.xml', index: 0, text: 'Eğitimde dijital dönüşümün etkileri üzerine bir inceleme' }, { part: 'word/document.xml', index: 1, text: 'Ahmet Yılmaz. Yayın: 2021. https://doi.org/10.1234/abc.5678 Bu çalışma eğitim ve teknoloji ilişkisini inceler.' }];
  const meta = Meta.extract({ paragraphs, fileMeta: { title: 'Microsoft Word - belge1.docx', author: 'Ahmet Yılmaz; Ayşe Kaya' }, fileName: 'makale.docx' });
  assert.equal(meta.doi, '10.1234/abc.5678'); assert.equal(meta.year, '2021'); assert.equal(meta.title, 'Eğitimde dijital dönüşümün etkileri üzerine bir inceleme');
  assert.deepEqual(meta.authors, ['Ahmet Yılmaz', 'Ayşe Kaya']); assert.equal(meta.language, 'tr'); assert.equal(meta.verified, false);
  const fromFile = Meta.extract({ paragraphs, fileMeta: { title: 'A study of digital transformation in education' }, fileName: 'x.pdf' });
  assert.equal(fromFile.title, 'A study of digital transformation in education');
  const filled = Meta.fromMatched(meta, { suggested: 'Yılmaz, A. (2021). T.', suggestedHtml: 'Yılmaz, A. (2021). T.', provider: 'Crossref', matched: { title: 'Doğru başlık', year: 2021, doi: '10.1234/abc', author: [{ family: 'Yılmaz', given: 'Ahmet' }], containerTitle: 'Dergi', volume: 3 } });
  assert.equal(filled.verified, true); assert.deepEqual(filled.authors, ['Yılmaz, Ahmet']); assert.equal(filled.volume, '3'); assert.equal(filled.apa, 'Yılmaz, A. (2021). T.');
});

test('gemini embedding: request shape, normalization, quota and error handling (no network)', async () => {
  process.env.GEMINI_API_KEY = 'test-key'; process.env.GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001'; process.env.GEMINI_EMBEDDING_DIM = '128';
  let seen;
  const ok = async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return { ok: true, status: 200, headers: new Headers(), json: async () => ({ embeddings: [{ values: [3, 4, 0, 0] }, { values: [0, 0, 1, 1] }] }) }; };
  const result = await Gemini.embed({ texts: ['a', 'b'], task: 'document' }, { fetchImpl: ok });
  assert.match(seen.url, /models\/gemini-embedding-001:batchEmbedContents$/); assert.equal(seen.init.headers['x-goog-api-key'], 'test-key'); assert.ok(!seen.url.includes('test-key'), 'key stays out of the URL');
  assert.equal(seen.body.requests[0].taskType, 'RETRIEVAL_DOCUMENT'); assert.equal(seen.body.requests[0].outputDimensionality, 128); assert.equal(seen.body.requests.length, 2);
  assert.deepEqual(result.vectors[0], [0.6, 0.8, 0, 0]); assert.ok(Math.abs(Math.hypot(...result.vectors[1]) - 1) < 1e-3);
  await Gemini.embed({ texts: ['q'], task: 'query' }, { fetchImpl: async (u, i) => { seen = { body: JSON.parse(i.body) }; return ok(u, i); } }).catch(() => {});
  assert.equal(seen.body.requests[0].taskType, 'RETRIEVAL_QUERY');
  process.env.GEMINI_EMBEDDING_MODEL = 'gemini-embedding-2';
  await Gemini.embed({ texts: ['soru'], task: 'query' }, { fetchImpl: async (u, i) => { seen = { body: JSON.parse(i.body) }; return ok(u, i); } }).catch(() => {});
  assert.equal(seen.body.requests[0].taskType, undefined); assert.match(seen.body.requests[0].content.parts[0].text, /^task: search result \| query: soru/);
  process.env.GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001';
  const limited = await Gemini.embed({ texts: ['a'], task: 'document' }, { fetchImpl: async () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '7' }), json: async () => ({}) }) });
  assert.ok(limited.quota.retryAt - Date.now() > 5000 && limited.quota.retryAt - Date.now() <= 7500);
  // The key that was just refused with 429 rests in the pool; another key takes the next request.
  process.env.GEMINI_API_KEY = 'test-key-2';
  await assert.rejects(Gemini.embed({ texts: ['a'], task: 'document' }, { fetchImpl: async () => ({ ok: false, status: 400, headers: new Headers(), json: async () => ({ error: { message: 'bad key AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456' } }) }) }), e => /HTTP 400/.test(e.message) && !/AIza/.test(e.message));
  assert.throws(() => Gemini.validate({ texts: [], task: 'document' })); assert.throws(() => Gemini.validate({ texts: ['a'], task: 'x' })); assert.throws(() => Gemini.validate({ texts: ['a'.repeat(13000)], task: 'query' }));
  delete process.env.GEMINI_API_KEY; await assert.rejects(Gemini.embed({ texts: ['a'], task: 'query' }), /GEMINI_API_KEY/);
  assert.equal(Gemini.configured(), false);
});

test('authors are read from the line under the title only when it looks like a list of names', () => {
  const para = (...texts) => texts.map((text, i) => ({ part: 'word/document.xml', index: i, text }));
  assert.deepEqual(Meta.guessAuthors(para('Digital transformation in higher education', 'Published 2021. Smith, J. and Brown, K.', 'Digital learning platforms increased engagement.'), 'Digital transformation in higher education'), ['Smith, J.', 'Brown, K.']);
  assert.deepEqual(Meta.guessAuthors(para('Eğitimde dijital dönüşüm', 'Ahmet Yılmaz ve Ayşe Kaya'), 'Eğitimde dijital dönüşüm'), ['Ahmet Yılmaz', 'Ayşe Kaya']);
  assert.deepEqual(Meta.guessAuthors(para('Eğitimde dijital dönüşüm', 'Bu çalışma eğitimde dijital dönüşümü incelemektedir ve sonuçlar açıklanmıştır.'), 'Eğitimde dijital dönüşüm'), []);
  assert.deepEqual(Meta.guessAuthors(para('Başlık burada', 'Ankara Üniversitesi Eğitim Fakültesi, 2020'), 'Başlık burada'), [], 'an affiliation line is not an author list');
});

test('chunker: the bibliography never reaches the passages (heading variants, table of contents, no heading), appendices stay', () => {
  const Chunker = require('../lib/writer-chunker.cjs');
  const para = (texts) => texts.map((text, i) => ({ part: 'word/document.xml', index: i, text, page: 1 + Math.floor(i / 5), style: '' }));
  const body = ['Giriş', 'Bu çalışma öğrenci motivasyonunun akademik başarı üzerindeki etkisini uzun bir süre boyunca inceleyen bir araştırmadır ve bulgular açıktır.'];
  const refs = ['Yılmaz, A. (2020). Motivasyon ve başarı. Eğitim Dergisi, 12(3), 45–60. https://doi.org/10.1/abc', 'Smith, J., & Brown, K. (2019). Digital learning. Journal of Tests, 4(1), 1-9.',
    'Kaya, B. (2018). Başarı. Ankara: Nobel Yayınları.', 'Doe, J. (2017). In Proceedings of the Big Conference (pp. 10-20). Springer.', 'Lee, C. (2021). Another title here. Computers & Education, 5(2), 100-120. doi:10.2/xyz'];
  const indexed = parts => Chunker.chunkParagraphs(para(parts)).map(c => c.text).join('\n');
  for (const heading of ['Kaynakça', '7. KAYNAKLAR', 'Referanslar', 'Works Cited', 'References']) {
    const text = indexed([...body, heading, ...refs]);
    assert.match(text, /motivasyonunun/); assert.doesNotMatch(text, /Journal of Tests|Nobel/, heading);
  }
  assert.doesNotMatch(indexed(['İçindekiler', 'Kaynakça 45', ...body, 'Kaynakça', ...refs]), /Journal of Tests/, 'table of contents entry is not the bibliography');
  assert.doesNotMatch(indexed([...body, ...refs]), /Journal of Tests|Nobel/, 'closing run of entries without a heading');
  const appendix = indexed([...body, 'Kaynakça', ...refs, 'Ek 1', 'Ek anket soruları metni burada yer alan uzun bir paragraftır ve indekslenmelidir.']);
  assert.match(appendix, /Ek anket/); assert.doesNotMatch(appendix, /Journal of Tests/);
  assert.match(indexed([...body, 'Kaynakça', ...refs, 'Ekonomi', 'Ekonomi başlığı altında kalan ve indekslenmesi gereken yeterince uzun bir paragraf metni.']), /Ekonomi başlığı/);
});

test('künye lookup: a DOI is queried alone, so wrong guesses from the file cannot hide the record', () => {
  const Meta = require('../lib/writer-meta.cjs');
  const guess = { title: 'Şablon başlığı', authors: ['Yanlış, A.'], year: '2019', doi: '10.3390/en16010286' };
  assert.equal(Meta.doiQuery(guess), 'https://doi.org/10.3390/en16010286');
  assert.equal(Meta.doiQuery({ ...guess, doi: '' }), '');
  assert.match(Meta.queryLine({ ...guess, doi: '' }), /Yanlış, A\. \(2019\)\. Şablon başlığı\./);
  const record = { matched: { title: 'Gerçek başlık', author: [{ family: 'Ahluwalia', given: 'Rajesh K.' }], year: 2023, doi: '10.3390/en16010286', containerTitle: 'Energies', volume: 16, issue: 1, pages: '286' }, suggested: 'APA satırı', provider: 'Crossref' };
  const filled = Meta.fromMatched(guess, record);
  assert.deepEqual([filled.title, filled.authors, filled.year, filled.journal, filled.volume, filled.issue, filled.pages, filled.verified],
    ['Gerçek başlık', ['Ahluwalia, Rajesh K.'], '2023', 'Energies', '16', '1', '286', true]);
});

test('chunker: the abstract and its keywords never reach the passages, the body does', () => {
  const Chunker = require('../lib/writer-chunker.cjs');
  const para = texts => texts.map((text, i) => ({ part: 'word/document.xml', index: i, text, page: 1, style: '' }));
  const indexed = texts => Chunker.chunkParagraphs(para(texts)).map(c => c.text).join('\n');
  const abstract = 'Bu özet metni çalışmanın genel amacını ve yöntemini kısaca anlatan ve indekslenmemesi gereken uzun bir paragraftır.';
  const body = 'Gövde metni öğrenci motivasyonunun akademik başarı üzerindeki etkisini uzun bir süre boyunca inceleyen bir araştırmanın bulgularını anlatır.';
  const tr = indexed(['Özet', abstract, 'Anahtar kelimeler: motivasyon; başarı', 'Abstract', 'This abstract summarises the study aims and methods in several words.', 'Keywords: motivation', '1. Giriş', body]);
  assert.match(tr, /Gövde metni/); assert.doesNotMatch(tr, /Bu özet metni|abstract summarises|motivasyon; başarı/);
  assert.doesNotMatch(indexed(['Abstract: ' + abstract, 'Introduction', body]), /Bu özet metni/);
  assert.match(indexed(['Giriş', body]), /Gövde metni/);
});

test('answer requests stay small: repeated passage overlap is sent once, history and draft are cut', () => {
  const Answer = require('../lib/writer-answer.cjs'), Skills = require('../lib/writer-skills.cjs');
  const words = (from, n) => Array.from({ length: n }, (_, i) => 'kelime' + (from + i)).join(' ');
  const first = { documentId: 'd1', page: 1, text: words(0, 80) }, second = { documentId: 'd1', page: 1, text: words(40, 80) }, other = { documentId: 'd2', page: 1, text: words(40, 80) };
  const skill = Skills.load().skills.find(sk => sk.name === 'genel');
  const sources = { d1: { fileName: 'a.pdf', meta: {} }, d2: { fileName: 'b.pdf', meta: {} } };
  const history = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: (i % 2 ? 'cevap ' : 'soru ') + 'uzun '.repeat(400) + i }));
  const spec = Answer.request({ skill, question: 'Soru?', chunks: [first, second, other], sourcesById: sources, history, draft: 'x'.repeat(9000) });
  const body = JSON.parse(spec.user);
  assert.equal(body.passages[0].text, first.text, 'the first passage is complete');
  assert.equal(body.passages[1].text, words(80, 40), 'the second one starts after the 40 repeated words');
  assert.equal(body.passages[2].text, other.text, 'overlap is only removed between passages of the same source');
  assert.equal(body.conversation.length, 4); assert.ok(body.conversation.every(m => m.text.length <= (m.role === 'user' ? 502 : 602)));
  assert.equal(body.draft.length, 3500);
});
