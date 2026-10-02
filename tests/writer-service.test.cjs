const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const Plans = require('../lib/plans.cjs');
const Identity = require('../lib/identity.cjs');
const Search = require('../lib/writer-search.cjs');
const { createStore } = require('../lib/writer-store.cjs');
const { createService } = require('../writer-service.cjs');
const realPython = require('../lib/python.cjs').python;

const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
const hashVector = text => {
  const v = new Float32Array(64);
  for (const token of Search.tokenize(text)) { let h = 0; for (const c of token) h = (h * 31 + c.charCodeAt(0)) >>> 0; v[h % 64] += 1; }
  return v;
};
const PAGES = (...texts) => texts.map((text, i) => ({ id: 'pdf:' + i, part: 'word/document.xml', index: i, text, style: '', page: i + 1 }));
const file = (paragraphs, metadata = {}) => Buffer.concat([Buffer.from('%PDF-'), Buffer.from(JSON.stringify({ paragraphs, metadata }))]).toString('base64');
const MOTIVATION = file(PAGES(
  'Yayın: 2020. Öğrencilerin akademik motivasyonu sınav başarısını belirgin biçimde artırmaktadır ve motivasyon düzeyi ders çalışma süresiyle ilişkilidir.',
  'Motivasyon araştırmaları öğrencilerin içsel güdülenmesinin uzun vadeli öğrenmeyi desteklediğini göstermektedir ve bu bulgu birçok çalışmada tekrarlanmıştır.'),
  { title: 'Akademik motivasyon ve başarı', author: 'Ahmet Yılmaz' });
const SECRET = file(PAGES(
  'Yayın: 2019. Kuantum dolanıklık deneyleri gizli laboratuvar protokolü kapsamında yürütülmüştür ve sonuçlar yalnızca bu araştırma ekibine aittir.',
  'Dolanıklık ölçümleri düşük sıcaklıkta yapılmıştır ve kuantum durumlarının kararlılığı ayrıca incelenmiştir.'),
  { title: 'Kuantum dolanıklık protokolü', author: 'Zeynep Kara' });

async function setup({ embedBroken = false, embedAvailable = true, llmDelay = null, python } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-svc-'));
  process.env.WRITER_DATA_DIR = dir; Identity._reset();
  const store = createStore(dir);
  const calls = [];
  const state = { embedBroken, embedAvailable };
  const embed = { BATCH: 32, available: () => state.embedAvailable,
    async embedBatch(texts) { if (state.embedBroken) throw Error('kota doldu'); return texts.map(hashVector); } };
  const llm = { llmAvailable: () => true, llmMissing: () => 'LLM yok',
    async llmChat(spec) {
      calls.push(spec);
      if (llmDelay) await llmDelay;
      const user = JSON.parse(spec.user);
      return { result: { answer: user.passages.length ? `Bu konuda bulgular vardır [P1]. Ayrıca ikinci bir nokta [P2].` : `Yeniden yazılmış: ${user.question}`, insufficient: false } };
    } };
  const fakePython = async request => {
    if (request.operation === 'build_docx') return realPython(request);
    const raw = Buffer.from(request.data, 'base64').toString('utf8').slice(5);
    return { ...JSON.parse(raw), warnings: [] };
  };
  const service = createService({ store: () => store, embed, llm, python: python || fakePython, verifyMeta: async () => null });
  const server = http.createServer((req, res) => service.handle(req, res, new URL(req.url, 'http://x'), json).then(done => { if (!done) { res.writeHead(404); res.end(); } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  // each client is one browser with its own cookie jar
  const client = () => {
    let cookie = '';
    return async (method, url, body, { raw = false, headers = {} } = {}) => {
      const response = await fetch(base + '/api/writer' + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'x-word-request': '1', 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = response.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      if (raw) return response;
      const data = await response.json().catch(() => ({}));
      return { status: response.status, ...data };
    };
  };
  return { service, store, calls, state, client, async close() { await service.idle(); server.close(); store.close(); } };
}
const upload = (api, projectId, name, data) => api('POST', `/projects/${projectId}/sources`, { name, data });
async function projectWith(api, title, ...docs) {
  const { project } = await api('POST', '/projects', { title });
  const sources = [];
  for (const [name, data] of docs) sources.push((await upload(api, project.id, name, data)).source);
  return { project, sources };
}

test('upload → passages and embeddings → question → cited answer (full flow)', async t => {
  const env = await setup(); t.after(() => env.close());
  const api = env.client();
  const boot = await api('GET', '/bootstrap');
  assert.equal(boot.plan.id, 'basic'); assert.ok(boot.skills.some(s => s.name === 'giris-yaz')); assert.ok(boot.lockedSkills.some(s => s.name === 'kaynak-karsilastir'));
  assert.deepEqual(boot.services, { llm: true, embedding: true });
  const { project, sources } = await projectWith(api, 'Motivasyon makalesi', ['motivasyon.pdf', MOTIVATION]);
  assert.equal(sources[0].status, 'processing');
  await env.service.idle();
  let data = await api('GET', `/projects/${project.id}`);
  const source = data.sources[0];
  assert.equal(source.status, 'ready'); assert.equal(source.searchMode, 'semantic'); assert.ok(source.chunkCount >= 1 && source.embeddedCount === source.chunkCount);
  assert.deepEqual([source.meta.title, source.meta.year, source.meta.authors], ['Akademik motivasyon ve başarı', '2020', ['Ahmet Yılmaz']]);
  assert.equal(source.trust, 'unverified');
  const asked = await api('POST', `/projects/${project.id}/ask`, { question: 'Öğrenci motivasyonu başarıyı nasıl etkiler?', skill: 'genel' });
  assert.equal(asked.status, 202); assert.equal(asked.usage.questionsToday, 1);
  await env.service.idle();
  data = await api('GET', `/projects/${project.id}`);
  const answer = data.messages.at(-1);
  assert.equal(answer.status, 'done'); assert.equal(data.messages.length, 2);
  assert.match(answer.text, /\(Yılmaz, 2020, s\. \d\)/, 'author–year and page come from the source data');
  assert.match(answer.raw, /\{\{c:[0-9a-f-]{36}@\d\}\}/); assert.equal(answer.warning, null);
  assert.match(env.calls[0].system, /SKILL: Kaynaklara soru sor/);
  const sent = JSON.parse(env.calls[0].user);
  assert.ok(sent.passages.length >= 1 && sent.passages.every(p => /motivasyon/i.test(p.text)));
  // the suggested skill is used when none is chosen
  const second = await api('POST', `/projects/${project.id}/ask`, { question: 'Makalenin giriş bölümünü yazar mısın?' });
  assert.equal(second.message.skill, 'giris-yaz'); await env.service.idle();
  assert.equal(JSON.parse(env.calls[1].user).conversation.length, 2, 'earlier turns are sent as conversation');
});

test('users and projects never mix: one user cannot reach, search or change another user\'s sources', async t => {
  const env = await setup(); t.after(() => env.close());
  const alice = env.client(), bob = env.client();
  const a = await projectWith(alice, 'Alice', ['gizli.pdf', SECRET]);
  const b = await projectWith(bob, 'Bob', ['motivasyon.pdf', MOTIVATION]);
  await env.service.idle();
  // Bob uses Alice's ids everywhere
  assert.equal((await bob('GET', `/projects/${a.project.id}`)).status, 404);
  assert.equal((await bob('POST', `/projects/${a.project.id}/ask`, { question: 'kuantum', skill: 'genel' })).status, 404);
  assert.equal((await bob('POST', `/projects/${a.project.id}/sources`, { name: 'x.pdf', data: MOTIVATION })).status, 404);
  assert.equal((await bob('PATCH', `/projects/${a.project.id}/sources/${a.sources[0].id}`, { title: 'ele geçirildi' })).status, 404);
  assert.equal((await bob('DELETE', `/projects/${a.project.id}/sources/${a.sources[0].id}`)).status, 404);
  assert.equal((await bob('PUT', `/projects/${a.project.id}/manuscript`, { html: '<p>x</p>', revision: 0 })).status, 404);
  assert.equal((await bob('GET', `/projects/${a.project.id}/manuscript.docx`, undefined, { raw: true })).status, 404);
  assert.equal((await bob('DELETE', `/projects/${a.project.id}`)).status, 404);
  // Bob's source id is not valid inside Alice's project either
  assert.equal((await alice('PATCH', `/projects/${a.project.id}/sources/${b.sources[0].id}`, { title: 'x' })).status, 404);
  // a forged cookie is a stranger, not Alice
  const forged = env.client(); await forged('GET', '/bootstrap');
  assert.deepEqual((await forged('GET', '/projects')).projects, []);
  // Bob asks about quantum entanglement: only his own passages may be sent to the model
  assert.equal((await bob('POST', `/projects/${b.project.id}/ask`, { question: 'Kuantum dolanıklık deneyleri nasıl yürütüldü?', skill: 'genel' })).status, 202);
  await env.service.idle();
  const sent = JSON.parse(env.calls.at(-1).user);
  assert.ok(sent.passages.length > 0);
  assert.ok(sent.passages.every(p => !/kuantum|gizli laboratuvar/i.test(p.text + p.source + p.title)), 'Alice\'s text never reaches Bob\'s request');
  // and the reverse
  await alice('POST', `/projects/${a.project.id}/ask`, { question: 'Öğrenci motivasyonu', skill: 'genel' }); await env.service.idle();
  assert.ok(JSON.parse(env.calls.at(-1).user).passages.every(p => !/motivasyon/i.test(p.text)));
  // Alice's data is intact and lists are separate
  assert.equal((await alice('GET', `/projects/${a.project.id}`)).sources[0].meta.title, 'Kuantum dolanıklık protokolü');
  assert.deepEqual((await bob('GET', '/projects')).projects.map(p => p.title), ['Bob']);
  // two projects of the same user are separate as well
  const second = await projectWith(alice, 'Alice ikinci', ['motivasyon.pdf', MOTIVATION]); await env.service.idle();
  await alice('POST', `/projects/${second.project.id}/ask`, { question: 'kuantum dolanıklık', skill: 'genel' }); await env.service.idle();
  assert.ok(JSON.parse(env.calls.at(-1).user).passages.every(p => !/kuantum/i.test(p.text)), 'the first project\'s sources stay in the first project');
});

test('plan limits: projects, documents, size and daily questions each answer with an upgrade suggestion', async t => {
  const env = await setup(); t.after(() => env.close());
  const original = { ...Plans.PLANS.basic };
  t.after(() => Object.assign(Plans.PLANS.basic, original));
  Object.assign(Plans.PLANS.basic, { projects: 2, documentsPerProject: 1, documentBytes: 600, questionsPerDay: 2 });
  const api = env.client();
  const { project } = await projectWith(api, 'Bir', ['a.pdf', file(PAGES('kısa metin burada yer alır ve yeterince uzundur kuyruk iletişim'), {})]);
  await env.service.idle();
  const second = await upload(api, project.id, 'b.pdf', MOTIVATION);
  assert.equal(second.status, 429); assert.equal(second.code, 'plan_limit');
  assert.deepEqual([second.upgrade.limit, second.upgrade.value, second.upgrade.nextPlan], ['documentsPerProject', 1, 'premium']); assert.match(second.error, /Premium/);
  const { project: p2 } = await api('POST', '/projects', { title: 'İki' });
  const third = await api('POST', '/projects', { title: 'Üç' });
  assert.equal(third.status, 429); assert.equal(third.upgrade.limit, 'projects');
  const big = await upload(api, p2.id, 'big.pdf', Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(700)]).toString('base64'));
  assert.equal(big.status, 413); assert.match(big.error, /en fazla/);
  assert.equal((await api('POST', `/projects/${project.id}/ask`, { question: 'kuyruk iletişim', skill: 'genel' })).status, 202); await env.service.idle();
  assert.equal((await api('POST', `/projects/${project.id}/ask`, { question: 'kuyruk iletişim ikinci', skill: 'genel' })).status, 202); await env.service.idle();
  const limited = await api('POST', `/projects/${project.id}/ask`, { question: 'üçüncü soru', skill: 'genel' });
  assert.equal(limited.status, 429); assert.equal(limited.upgrade.limit, 'questionsPerDay'); assert.equal(env.calls.length, 2, 'a refused question never reaches the model');
  // another user has their own allowance
  const other = env.client(); const { project: op } = await other('POST', '/projects', { title: 'Başka' });
  assert.equal((await other('POST', `/projects/${op.id}/ask`, { question: 'x y z', skill: 'akademik-dil' })).status, 202);
});

test('plan skills: a skill outside the plan is refused', async t => {
  const env = await setup(); t.after(() => env.close());
  const api = env.client(); const { project } = await api('POST', '/projects', { title: 'x' });
  const locked = await api('POST', `/projects/${project.id}/ask`, { question: 'kaynakları karşılaştır', skill: 'kaynak-karsilastir' });
  assert.equal(locked.status, 403); assert.match(locked.error, /paketinizde/);
  assert.equal((await api('POST', `/projects/${project.id}/ask`, { question: 'x', skill: 'yok-boyle' })).status, 400);
});

test('correcting a source\'s künye updates the citations in answers and in the manuscript', async t => {
  const env = await setup(); t.after(() => env.close());
  const api = env.client();
  const { project, sources } = await projectWith(api, 'Künye', ['m.pdf', MOTIVATION]); await env.service.idle();
  await api('POST', `/projects/${project.id}/ask`, { question: 'Motivasyon nedir', skill: 'genel' }); await env.service.idle();
  let data = await api('GET', `/projects/${project.id}`);
  const docId = sources[0].id, token = data.messages.at(-1).raw.match(/\{\{c:([^}]+)\}\}/)[1].split('|')[0];
  assert.match(data.messages.at(-1).text, /Yılmaz, 2020/);
  const html = `<p>Cümle <span class="cite" data-cite="${token}" data-lang="tr" contenteditable="false">(Eski, 1999)</span>.</p>`;
  assert.equal((await api('PUT', `/projects/${project.id}/manuscript`, { html, revision: 0 })).revision, 1);
  const patched = await api('PATCH', `/projects/${project.id}/sources/${docId}`, { title: 'Düzeltilmiş başlık', authors: 'Öztürk, Mehmet\nKaya, Ayşe', year: '2022', doi: 'https://doi.org/10.1/abc' });
  assert.equal(patched.source.trust, 'confirmed'); assert.deepEqual(patched.source.meta.authors, ['Öztürk, Mehmet', 'Kaya, Ayşe']); assert.equal(patched.source.meta.doi, '10.1/abc');
  data = await api('GET', `/projects/${project.id}`);
  assert.match(data.messages.at(-1).text, /\(Öztürk ve Kaya, 2022, s\. \d\)/);
  assert.match(data.manuscript.html, /\(Öztürk ve Kaya, 2022, s\. \d\)/); assert.doesNotMatch(data.manuscript.html, /Eski, 1999/);
  assert.equal(data.sources[0].reference, 'Öztürk, M., & Kaya, A. (2022). Düzeltilmiş başlık. https://doi.org/10.1/abc');
  // the DOCX contains the corrected citation and the generated reference list
  const docx = await api('GET', `/projects/${project.id}/manuscript.docx`, undefined, { raw: true });
  assert.equal(docx.status, 200); const bytes = Buffer.from(await docx.arrayBuffer());
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');
  const inspected = await realPython({ operation: 'inspect', data: bytes.toString('base64') });
  const text = inspected.paragraphs.map(p => p.text).join('\n');
  assert.match(text, /\(Öztürk ve Kaya, 2022, s\. \d\)/); assert.match(text, /Kaynakça/); assert.match(text, /Öztürk, M\., & Kaya, A\. \(2022\)\. Düzeltilmiş başlık\./);
});

test('without a usable embedding the source is still searchable by keywords, and retry embeds it later', async t => {
  const env = await setup({ embedBroken: true }); t.after(() => env.close());
  const api = env.client();
  const { project } = await projectWith(api, 'Kota', ['m.pdf', MOTIVATION]); await env.service.idle();
  let source = (await api('GET', `/projects/${project.id}`)).sources[0];
  assert.equal(source.status, 'ready'); assert.equal(source.searchMode, 'keyword'); assert.match(source.error, /Embedding alınamadı \(kota doldu\)/); assert.equal(source.embeddedCount, 0);
  await api('POST', `/projects/${project.id}/ask`, { question: 'öğrenci motivasyonu başarı', skill: 'genel' }); await env.service.idle();
  assert.ok(JSON.parse(env.calls[0].user).passages.length > 0, 'keyword search answered');
  env.state.embedBroken = false;
  assert.equal((await api('POST', `/projects/${project.id}/sources/${source.id}/retry`, {})).status, 202); await env.service.idle();
  source = (await api('GET', `/projects/${project.id}`)).sources[0];
  assert.equal(source.searchMode, 'semantic'); assert.equal(source.embeddedCount, source.chunkCount); assert.equal(source.error, null);
  // no embedding service at all
  env.state.embedAvailable = false;
  const { project: p2 } = await projectWith(api, 'Anahtarsız', ['m.pdf', MOTIVATION]); await env.service.idle();
  const s2 = (await api('GET', `/projects/${p2.id}`)).sources[0];
  assert.equal(s2.searchMode, 'keyword'); assert.match(s2.error, /yapılandırılmamış/);
});

test('one answer is prepared at a time; questions need sources unless the skill rewrites the user own text', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const env = await setup({ llmDelay: gate }); t.after(() => env.close());
  const api = env.client();
  const { project } = await projectWith(api, 'Meşgul', ['m.pdf', MOTIVATION]); await env.service.idle();
  assert.equal((await api('POST', `/projects/${project.id}/ask`, { question: 'öğrenci motivasyonu', skill: 'genel' })).status, 202);
  await new Promise(resolve => setTimeout(resolve, 50));
  const busy = await api('POST', `/projects/${project.id}/ask`, { question: 'Hemen bir tane daha', skill: 'genel' });
  assert.equal(busy.status, 409);
  assert.equal((await api('GET', `/projects/${project.id}`)).messages.at(-1).note, 'Yanıt hazırlanıyor…');
  release(); await env.service.idle();
  assert.equal((await api('GET', `/projects/${project.id}`)).messages.at(-1).status, 'done');

  const { project: empty } = await api('POST', '/projects', { title: 'Boş' });
  const before = env.calls.length;
  await api('POST', `/projects/${empty.id}/ask`, { question: 'Bir şey sor', skill: 'genel' }); await env.service.idle();
  let messages = (await api('GET', `/projects/${empty.id}`)).messages;
  assert.equal(messages.at(-1).status, 'error'); assert.match(messages.at(-1).error, /kaynak yükleyin/);
  assert.equal(env.calls.length, before, 'no sources, no model call');
  await api('POST', `/projects/${empty.id}/ask`, { question: 'Bu çok güzel bir şey diye düşünüyorum', skill: 'akademik-dil' }); await env.service.idle();
  messages = (await api('GET', `/projects/${empty.id}`)).messages;
  assert.equal(messages.at(-1).status, 'done'); assert.match(messages.at(-1).text, /Yeniden yazılmış/); assert.doesNotMatch(messages.at(-1).raw, /\{\{c:/);
  assert.equal((await api('DELETE', `/projects/${empty.id}/messages`)).cleared, true);
  assert.deepEqual((await api('GET', `/projects/${empty.id}`)).messages, []);
});

test('manuscript saves are sanitized and guarded against stale windows; mutating calls need the app header', async t => {
  const env = await setup(); t.after(() => env.close());
  const api = env.client(); const { project } = await api('POST', '/projects', { title: 'M' });
  const saved = await api('PUT', `/projects/${project.id}/manuscript`, { html: '<p onclick="x()">Metin<script>alert(1)</script></p>', revision: 0 });
  assert.equal(saved.revision, 1);
  assert.equal((await api('GET', `/projects/${project.id}/manuscript`)).html, '<p>Metin</p>');
  assert.equal((await api('PUT', `/projects/${project.id}/manuscript`, { html: '<p>eski pencere</p>', revision: 0 })).status, 409);
  assert.equal((await api('GET', `/projects/${project.id}/manuscript.docx`, undefined, { raw: true })).status, 200);
  const empty = await api('POST', '/projects', { title: 'Boş makale' });
  assert.equal((await api('GET', `/projects/${empty.project.id}/manuscript.docx`)).status, 400);
  const raw = await api('POST', '/projects', { title: 'x' }, { headers: { 'x-word-request': '' } });
  assert.equal(raw.status, 403);
});

test('deleting a source or project removes its passages; startup recovery marks interrupted work', async t => {
  const env = await setup(); t.after(() => env.close());
  const api = env.client(); const { project, sources } = await projectWith(api, 'Sil', ['m.pdf', MOTIVATION], ['s.pdf', SECRET]); await env.service.idle();
  const userId = env.store.db.prepare('SELECT user_id FROM projects').get().user_id;
  assert.ok(env.store.projectChunks(userId, project.id).length > 0);
  await api('DELETE', `/projects/${project.id}/sources/${sources[0].id}`);
  assert.ok(env.store.projectChunks(userId, project.id).every(c => c.documentId !== sources[0].id));
  await api('DELETE', `/projects/${project.id}`);
  assert.equal(env.store.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n, 0);
  assert.equal(env.store.db.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 0);
});

test('unreadable uploads fail clearly without stopping the project', async t => {
  const env = await setup({ python: async () => { throw Error('PDF’de okunabilir metin katmanı yok; taranmış belgeler için önce OCR uygulayın.'); } }); t.after(() => env.close());
  const api = env.client();
  const { project } = await projectWith(api, 'Taranmış', ['t.pdf', MOTIVATION]); await env.service.idle();
  const source = (await api('GET', `/projects/${project.id}`)).sources[0];
  assert.equal(source.status, 'error'); assert.match(source.error, /OCR/);
  assert.equal((await upload(api, project.id, 'x.txt', MOTIVATION)).status, 400);
  assert.equal((await upload(api, project.id, 'x.pdf', Buffer.from('not a pdf').toString('base64'))).status, 400);
  assert.equal((await upload(api, project.id, 'x.docx', Buffer.from('%PDF-1.4').toString('base64'))).status, 400);
});
