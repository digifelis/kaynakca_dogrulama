// Writing assistant API (/api/writer/*): source collections, projects that write from chosen collections, questions answered from them, the manuscript.
// Every handler starts from resolveUser(); the user id and plan come only from there, never from the request body.
const path = require('node:path');
const Identity = require('./lib/identity.cjs');
const Plans = require('./lib/plans.cjs');
const Metrics = require('./lib/metrics.cjs');
const Skills = require('./lib/writer-skills.cjs');
const Chunker = require('./lib/writer-chunker.cjs');
const Meta = require('./lib/writer-meta.cjs');
const Search = require('./lib/writer-search.cjs');
const Answer = require('./lib/writer-answer.cjs');
const Manuscript = require('./lib/writer-manuscript.cjs');
const Cite = require('./writer-cite.js');
const Analysis = require('./word-analysis.cjs');
const Cache = require('./lib/cache-store.cjs');

const MAX_TITLE = 120, MAX_QUESTION = 4000, MAX_COLLECTIONS = 200, MAX_IMPORT = 25, SEARCHES_PER_MINUTE = 20;
const SEARCH_LIMIT = () => Math.min(12, Math.max(2, Number(process.env.WRITER_PASSAGES) || 6));
const httpError = (status, message, extra = {}) => Object.assign(Error(message), { status, ...extra });

// Runs at most `size` tasks at once; used so many uploads cannot flood the PDF reader and the embedding quota.
function limiter(size) {
  let active = 0;
  const waiting = [];
  const next = () => { while (active < size && waiting.length) { active++; const { task, resolve } = waiting.shift(); task().finally(() => { active--; next(); }).then(resolve, resolve); } };
  return task => new Promise(resolve => { waiting.push({ task, resolve }); next(); });
}

function createService(options = {}) {
  const deps = {
    store: options.store || (() => require('./lib/writer-store.cjs').defaultStore()),
    embed: options.embed || require('./lib/writer-embed.cjs'),
    llm: options.llm || require('./word-content.cjs'),
    python: options.python || require('./lib/python.cjs').python,
    verifyMeta: options.verifyMeta || Meta.verify,
    // Semantic Scholar search and PDF download (lib/scholar.cjs); tests pass a fake.
    scholar: options.scholar || require('./lib/scholar.cjs'),
    // Operation log with token counts (null without accounts): see lib/usage.cjs.
    usage: options.usage || { run: (o, fn) => fn(), monthTokens: () => 0 },
  };
  const pending = new Set();                 // background work, awaited by idle() in tests
  const controllers = new Map();             // document id -> AbortController
  const verifyingIds = new Set();            // documents whose künye is being looked up (queued or running), shown as a spinner
  // Reading a file (Python) and embedding its passages (Gemini) are different resources: separate limits let the next file
  // be read while the previous one waits for embeddings. WRITER_PROCESS_PARALLEL / WRITER_EMBED_PARALLEL tune them.
  const parallelOf = (name, fallback) => Math.min(8, Math.max(1, Number(process.env[name]) || fallback));
  const processing = limiter(parallelOf('WRITER_PROCESS_PARALLEL', 2)), embedding = limiter(parallelOf('WRITER_EMBED_PARALLEL', 3)), verifying = limiter(1), downloading = limiter(2);
  // limiter() reports a failed task as a resolved value; stage() turns it back into a rejection for the caller.
  const stage = async (slot, task) => { const out = await slot(async () => { try { return { value: await task() }; } catch (error) { return { error }; } }); if (out.error) throw out.error; return out.value; };
  const searches = new Map();                // user id -> times of recent paper searches
  let port = 4173;
  const track = promise => { pending.add(promise); promise.finally(() => pending.delete(promise)); return promise; };
  const db = () => deps.store();

  // ---- views
  // A project's sources are those of the collections linked to it.
  const sourcesOf = (userId, projectId) => db().projectDocuments(userId, projectId);
  const sourceMap = documents => Object.fromEntries(documents.map(d => [d.id, { id: d.id, fileName: d.fileName, meta: d.meta }]));
  const documentView = d => ({ id: d.id, collectionId: d.collectionId, verifying: verifyingIds.has(d.id), fileName: d.fileName, status: d.status, error: d.error, pageCount: d.pageCount, chunkCount: d.chunkCount,
    embeddedCount: d.embeddedCount, searchMode: d.searchMode, meta: d.meta, trust: Cite.trust(d.meta),
    reference: Cite.referenceEntry({ fileName: d.fileName, meta: d.meta }).text, createdAt: d.createdAt });
  const langOf = message => message.flags?.lang === 'en' ? 'en' : 'tr';
  function messageView(m, byId) {
    const hasCitations = Cite.tokenRefs(m.text).length > 0;
    const warning = m.role === 'assistant' && m.status === 'done' && m.skill && Skills.load().skills.find(s => s.name === m.skill)?.needsSources && !m.flags?.insufficient && !hasCitations
      ? 'Yanıtta kaynak atfı bulunmuyor; kaynaklara dayandığından emin olmadan kullanmayın.' : null;
    return { id: m.id, role: m.role, skill: m.skill, status: m.status, error: m.error, upgrade: m.upgrade, createdAt: m.createdAt, note: m.flags?.note || null,
      insufficient: !!m.flags?.insufficient, lang: langOf(m), raw: m.text, text: Cite.renderText(m.text, byId, langOf(m)), warning,
      incomplete: Cite.tokenRefs(m.text).some(ref => Cite.renderGroup([ref], byId, 'tr').incomplete) };
  }
  function usageOf(userId, plan) {
    return { questionsToday: db().questionsToday(userId), projects: db().countProjects(userId), collections: db().countCollections(userId), monthTokens: deps.usage.monthTokens(userId), limits: Plans.limitsFor(plan) };
  }
  function projectPayload(userId, plan, projectId) {
    const project = db().getProject(userId, projectId);
    if (!project) throw httpError(404, 'Proje bulunamadı.');
    const documents = sourcesOf(userId, projectId), byId = sourceMap(documents);
    const manuscript = db().getManuscript(userId, projectId);
    return { project, collectionIds: db().projectCollectionIds(userId, projectId), sources: documents.map(documentView), messages: db().listMessages(userId, projectId).map(m => messageView(m, byId)),
      manuscript: { html: Manuscript.renderCitations(manuscript.html, byId), revision: manuscript.revision, updatedAt: manuscript.updatedAt }, usage: usageOf(userId, plan) };
  }

  function collectionPayload(userId, collectionId) {
    const collection = db().getCollection(userId, collectionId);
    if (!collection) throw httpError(404, 'Koleksiyon bulunamadı.');
    return { collection, sources: db().listDocuments(userId, collectionId).map(documentView) };
  }

  // ---- source processing: extract text and künye, split into passages, embed, then verify the künye in the background
  // Public papers (found through Semantic Scholar) share their embeddings by text: the same passage is never embedded twice.
  // A user's own uploads are never put in the shared cache.
  async function embedRows(doc, rows, options) {
    if (!doc.meta?.scholarId) return deps.embed.embedBatch(rows.map(r => r.text), 'document', options);
    const model = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001', cache = Cache.defaultCache();
    const hits = cache.getEmbeddings(model, rows.map(r => r.text));
    const missing = rows.map((r, i) => i).filter(i => !hits.has(i));
    const fresh = missing.length ? await deps.embed.embedBatch(missing.map(i => rows[i].text), 'document', options) : [];
    cache.putEmbeddings(model, missing.map((i, k) => [rows[i].text, fresh[k]]));
    return rows.map((r, i) => hits.get(i) || fresh[missing.indexOf(i)]);
  }
  async function embedMissing(userId, doc, signal) {
    const noteWait = until => db().updateDocument(userId, doc.id, { error: `Embedding kotası bekleniyor (~${Math.max(1, Math.round((until - Date.now()) / 1000))} sn).` });
    for (;;) {
      const rows = db().chunksToEmbed(userId, doc.id, deps.embed.BATCH);
      if (!rows.length) return;
      const vectors = await embedRows(doc, rows, { signal, onWait: noteWait });
      db().setEmbeddings(userId, doc.id, rows.map((r, i) => ({ id: r.id, vector: Search.normalize(vectors[i]) })));
      db().updateDocument(userId, doc.id, { error: null });
    }
  }
  async function finishEmbedding(userId, doc, signal) {
    if (!deps.embed.available()) return db().updateDocument(userId, doc.id, { status: 'ready', searchMode: 'keyword', error: 'Embedding yapılandırılmamış; yalnız anahtar kelime araması kullanılacak.' });
    db().updateDocument(userId, doc.id, { status: 'embedding' });
    try {
      await embedMissing(userId, doc, signal);
      if (db().getDocument(userId, doc.id)) db().updateDocument(userId, doc.id, { status: 'ready', searchMode: 'semantic', error: null });
    } catch (error) {
      if (signal.aborted || !db().getDocument(userId, doc.id)) return;
      // The passages are saved; keyword search works now and "Yeniden dene" embeds what is missing.
      db().updateDocument(userId, doc.id, { status: 'ready', searchMode: 'keyword', error: `Embedding alınamadı (${error.message}); anahtar kelime araması kullanılacak. Yeniden deneyebilirsiniz.` });
    }
  }
  function verifyInBackground(userId, docId) {
    if (verifyingIds.has(docId)) return;
    verifyingIds.add(docId);
    track(verifying(async () => {
      try {
        const doc = db().getDocument(userId, docId);
        if (!doc || doc.meta.verified || doc.meta.source === 'user') return;
        let found = null;
        try { found = await deps.verifyMeta(doc.meta, { port }); } catch { /* the guess simply stays unverified */ }
        const fresh = db().getDocument(userId, docId);
        // A correction made by the user while the lookup ran wins over the lookup.
        if (found && fresh && fresh.meta.source !== 'user') db().updateDocument(userId, docId, { meta: found });
      } finally { verifyingIds.delete(docId); }
    }));
  }
  async function processDocument(userId, collectionId, doc, buffer, format, limit, known = null, shared = null, trace = null) {
    const controller = new AbortController();
    const t = { start: Date.now(), queueMs: 0, extractMs: 0, embedMs: 0 };
    const record = (status, error) => { try { Metrics.defaultMetrics().file({ userId, kind: trace?.kind || 'source-upload', status, bytes: trace?.bytes ?? buffer.length, receiveMs: trace?.receiveMs ?? null, queueMs: t.queueMs, extractMs: t.extractMs, embedMs: t.embedMs, totalMs: Date.now() - t.start + (trace?.receiveMs || 0), error: error?.message }); } catch { /* best effort */ } };
    controllers.set(doc.id, controller);
    try {
      // The text of a public PDF that was extracted before (by anyone) is reused, so it is neither downloaded nor read again.
      let result = shared?.extraction;
      if (!result) result = await stage(processing, async () => { t.queueMs = Date.now() - t.start; const readAt = Date.now(); const read = await deps.python({ operation: format === 'pdf' ? 'inspect_pdf' : 'inspect', data: buffer.toString('base64'), limit }); if (shared?.key) Cache.defaultCache().putExtraction(shared.key, read); t.extractMs = Date.now() - readAt; return read; });
      if (!db().getDocument(userId, doc.id)) return;
      const chunks = Chunker.chunkParagraphs(result.paragraphs);
      if (!chunks.length) throw Error('Belgede aranabilir metin bulunamadı.');
      const extracted = Meta.extract({ paragraphs: result.paragraphs, fileMeta: result.metadata || {}, fileName: doc.fileName });
      // A paper found through Semantic Scholar already comes with its künye; it replaces what was guessed from the file.
      const meta = known ? { ...extracted, ...Object.fromEntries(Object.entries(known).filter(([, v]) => Array.isArray(v) ? v.length : v)) } : extracted;
      const pages = format === 'pdf' ? (result.metadata?.pages || Math.max(0, ...result.paragraphs.map(p => p.page || 0))) : null;
      db().insertChunks(userId, collectionId, doc.id, chunks);
      db().updateDocument(userId, doc.id, { meta, pageCount: pages });
      const embedAt = Date.now(); await stage(embedding, () => finishEmbedding(userId, doc, controller.signal)); t.embedMs = Date.now() - embedAt;
      record('ok');
      if (db().getDocument(userId, doc.id)) verifyInBackground(userId, doc.id);
    } catch (error) {
      if (db().getDocument(userId, doc.id)) db().updateDocument(userId, doc.id, { status: 'error', error: error.message || 'Belge işlenemedi.' });
      record('error', error);
      throw error;
    } finally { controllers.delete(doc.id); }
  }
  // Embedding a source is an operation of its owner (tokens are estimated from the text size).
  const enqueue = (userId, collectionId, doc, buffer, format, limit, known = null, shared = null, trace = null) => track(
    deps.usage.run({ userId, kind: 'source-process', detail: { format, bytes: buffer.length, collectionId, ...(shared?.extraction ? { cached: true } : {}) } }, () => processDocument(userId, collectionId, doc, buffer, format, limit, known, shared, trace)).catch(() => {}));

  // ---- papers found through Semantic Scholar: the server downloads the open-access PDF, then it goes through the normal source pipeline
  const knownMeta = rec => ({ title: rec.title, authors: rec.authors, year: rec.year, doi: rec.doi, journal: rec.venue, scholarId: rec.paperId, provider: 'Semantic Scholar' });
  const pdfName = rec => ((rec.title || 'makale').replace(/[^\p{L}\p{N} ._-]+/gu, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'makale') + '.pdf';
  function throttleSearch(userId) {
    const now = Date.now(), recent = (searches.get(userId) || []).filter(t => now - t < 60000);
    if (recent.length >= SEARCHES_PER_MINUTE) throw httpError(429, 'Çok sık arama yaptınız; bir dakika sonra yeniden deneyin.');
    recent.push(now); searches.set(userId, recent);
  }
  const importPaper = (userId, collectionId, doc, rec, limits) => track(downloading(async () => {
    const fail = message => { if (db().getDocument(userId, doc.id)) db().updateDocument(userId, doc.id, { status: 'error', error: 'PDF indirilemedi: ' + message }); };
    const key = 'scholar:' + rec.paperId, extraction = Cache.defaultCache().getExtraction(key);
    if (extraction) { if (db().getDocument(userId, doc.id)) await enqueue(userId, collectionId, doc, Buffer.alloc(0), 'pdf', limits.documentBytes, knownMeta(rec), { key, extraction }); return; }
    let buffer; const downloadAt = Date.now();
    try {
      buffer = await deps.scholar.download(rec.pdfUrl, { maxBytes: limits.documentBytes });
      if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw Error('bağlantı bir PDF dosyası döndürmedi (yayıncı sayfası olabilir).');
    } catch (error) { try { Metrics.defaultMetrics().file({ userId, kind: 'scholar-import', status: 'error', receiveMs: Date.now() - downloadAt, totalMs: Date.now() - downloadAt, error: error.message }); } catch { /* best effort */ } return fail(error.message || 'bilinmeyen hata'); }
    if (!db().getDocument(userId, doc.id)) return;
    await enqueue(userId, collectionId, doc, buffer, 'pdf', limits.documentBytes, knownMeta(rec), { key }, { kind: 'scholar-import', bytes: buffer.length, receiveMs: Date.now() - downloadAt });
  }).catch(() => {}));

  // ---- questions
  function history(userId, projectId, byId, skipIds) {
    return db().listMessages(userId, projectId, 40).filter(m => m.status === 'done' && !skipIds.includes(m.id))
      .map(m => ({ role: m.role, text: Cite.renderText(m.text, byId, langOf(m)) }));
  }
  async function runAsk(userId, plan, projectId, reply, { question, skill, useManuscript, questionId }) {
    const language = db().getProject(userId, projectId)?.language === 'en' ? 'en' : 'tr';
    const update = fields => db().updateMessage(userId, reply.id, fields);
    try {
      const documents = sourcesOf(userId, projectId).filter(d => d.status === 'ready'), byId = sourceMap(documents);
      const all = db().projectChunks(userId, projectId);
      if (skill.needsSources && !all.length) throw httpError(400, 'Önce projeye kaynak içeren bir koleksiyon bağlayın ve kaynakların işlenmesini bekleyin.');
      const asked = history(userId, projectId, byId, [reply.id, questionId]);
      // A short follow-up ("bunu kısalt") is searched together with the previous question.
      const lastQuestion = [...asked].reverse().find(m => m.role === 'user')?.text || '';
      const query = question.split(/\s+/).length <= 6 && lastQuestion ? `${lastQuestion} ${question}` : question;
      let queryVector = null;
      if (all.length && deps.embed.available() && all.some(c => c.vector)) {
        try { queryVector = Search.normalize((await deps.embed.embedBatch([query], 'query', { onWait: until => update({ flags: { note: `Embedding kotası bekleniyor (~${Math.max(1, Math.round((until - Date.now()) / 1000))} sn).` } }) }))[0]); }
        catch { /* keyword search still works */ }
      }
      const chunks = skill.needsSources ? Search.rank({ query, queryVector, chunks: all, limit: SEARCH_LIMIT() }) : [];
      const draft = useManuscript ? Manuscript.plainText(db().getManuscript(userId, projectId).html) : '';
      if (!deps.llm.llmAvailable()) throw httpError(503, deps.llm.llmMissing());
      update({ flags: { note: 'Yanıt hazırlanıyor…' } });
      const spec = Answer.request({ skill, question, chunks, sourcesById: byId, history: asked, draft, language });
      const { result } = await deps.llm.llmChat(spec, new AbortController().signal,
        until => update({ flags: { note: `LLM kotası bekleniyor (~${Math.max(1, Math.round((until - Date.now()) / 1000))} sn).` } }));
      const raw = typeof result?.answer === 'string' ? result.answer : '';
      if (!raw.trim()) throw Error('Model boş yanıt döndürdü; tekrar deneyin.');
      const text = skill.needsSources ? Answer.applyCitations(raw, chunks) : raw.trim();
      update({ text, status: 'done', error: null, flags: { insufficient: !!result.insufficient, lang: language } });
    } catch (error) {
      const wait = error.quota && error.retryAt ? ` ${Math.max(1, Math.round((error.retryAt - Date.now()) / 1000))} saniye sonra tekrar deneyin.` : '';
      update({ status: 'error', error: (error.message || 'Yanıt üretilemedi.') + wait, flags: {} });
      throw error;
    }
  }
  function startAsk(userId, plan, projectId, input) {
    const question = String(input.question || '').trim();
    if (!question || question.length > MAX_QUESTION) throw httpError(400, `Soru boş olamaz ve en fazla ${MAX_QUESTION} karakter olabilir.`);
    const skill = Skills.get(input.skill || Skills.suggest(question, plan), plan);
    if (!skill) {
      const locked = Skills.load().skills.find(s => s.name === input.skill);
      throw httpError(locked ? 403 : 400, locked ? 'Bu skill paketinizde bulunmuyor; üst pakete geçerek kullanabilirsiniz.' : 'Skill bulunamadı.');
    }
    if (!db().getProject(userId, projectId)) throw httpError(404, 'Proje bulunamadı.');
    if (db().listMessages(userId, projectId, 10).some(m => m.status === 'working')) throw httpError(409, 'Önceki yanıt hazırlanıyor; bitmesini bekleyin.');
    Plans.enforce(plan, 'questionsPerDay', db().questionsToday(userId));
    Plans.enforce(plan, 'monthlyTokens', deps.usage.monthTokens(userId));
    db().addQuestion(userId);
    const asked = db().addMessage(userId, projectId, { role: 'user', text: question, skill: skill.name });
    const reply = db().addMessage(userId, projectId, { role: 'assistant', skill: skill.name, status: 'working' });
    db().touchProject(userId, projectId);
    track(deps.usage.run({ userId, kind: 'ask', projectId, detail: { skill: skill.name, draft: input.useManuscript === true } },
      () => runAsk(userId, plan, projectId, reply, { question, skill, useManuscript: input.useManuscript === true, questionId: asked.id })).catch(() => {}));
    return reply;
  }

  // ---- HTTP
  async function readBody(req, limit) {
    let size = 0; const parts = [];
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw httpError(413, 'İstek çok büyük.'); parts.push(chunk); }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch { throw httpError(400, 'Geçersiz JSON.'); }
  }
  const title = value => { const t = String(value || '').replace(/\s+/g, ' ').trim(); if (!t || t.length > MAX_TITLE) throw httpError(400, `Başlık boş olamaz ve en fazla ${MAX_TITLE} karakter olabilir.`); return t; };
  function decodeFile(data, limit) {
    if (typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw httpError(400, 'Geçersiz dosya verisi.');
    const buffer = Buffer.from(data, 'base64');
    if (buffer.length > limit) throw httpError(413, `Dosya en fazla ${Math.round(limit / 1048576)} MB olabilir.`);
    return buffer;
  }
  function metaPatch(current, input) {
    const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const authors = Array.isArray(input.authors) ? input.authors : String(input.authors ?? '').split(/\n|;/);
    const next = { ...current,
      title: text(input.title, 300), authors: authors.map(a => text(a, 120)).filter(Boolean).slice(0, 50), year: text(input.year, 10).replace(/[^0-9a-z.]/gi, ''),
      doi: text(input.doi, 120).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, ''), journal: text(input.journal, 200), publisher: text(input.publisher, 200),
      volume: text(input.volume, 20), issue: text(input.issue, 20), pages: text(input.pages, 40) };
    if (input.language === 'tr' || input.language === 'en') next.language = input.language;
    // The index's own APA line described the old data; it no longer applies to what the user typed.
    delete next.apa; delete next.apaHtml;
    return { ...next, verified: false, confirmed: true, source: 'user' };
  }

  async function handle(req, res, url, json) {
    if (!url.pathname.startsWith('/api/writer')) return false;
    port = req.socket.localPort || port;
    try {
      if (req.method !== 'GET' && req.headers['x-word-request'] !== '1') return json(res, 403, { error: 'Yerel uygulama isteği gerekli.' }), true;
      const { userId, plan } = Identity.requireUser(req, res);
      const route = url.pathname.slice('/api/writer'.length).replace(/\/$/, '');
      let m;

      if (route === '/bootstrap' && req.method === 'GET') {
        const available = Skills.forPlan(plan).map(Skills.publicView), names = new Set(available.map(s => s.name));
        const locked = Skills.load().skills.filter(s => !names.has(s.name)).map(s => ({ name: s.name, title: s.title, description: s.description, minPlan: Skills.publicView(s).minPlan }));
        return json(res, 200, { plan: { id: Plans.known(plan), title: Plans.get(plan).title, nextPlan: Plans.nextPlan(plan) }, plans: Plans.list().map(p => ({ id: p.id, title: p.title })), usage: usageOf(userId, plan),
          skills: available, lockedSkills: locked, defaultSkill: Skills.DEFAULT_SKILL, collections: db().listCollections(userId),
          services: { llm: !!deps.llm.llmAvailable(), embedding: !!deps.embed.available(), scholar: true }, projects: db().listProjects(userId) }), true;
      }
      if (route === '/scholar/search' && req.method === 'GET') {
        throttleSearch(userId);
        let found;
        try { found = await deps.scholar.search(url.searchParams.get('q') || '', { limit: 20, offset: Number(url.searchParams.get('offset')) || 0, openAccessOnly: url.searchParams.get('all') !== '1' }); }
        catch (error) { throw httpError(error.status || 502, error.message || 'Arama yapılamadı.'); }
        return json(res, 200, { ...found, keyed: !!deps.scholar.configured() }), true;
      }
      if ((m = route.match(/^\/collections\/([0-9a-f-]{36})\/import$/)) && req.method === 'POST') {
        const collectionId = m[1];
        if (!db().getCollection(userId, collectionId)) throw httpError(404, 'Koleksiyon bulunamadı.');
        const input = await readBody(req, 16 * 1024);
        const ids = [...new Set((Array.isArray(input.paperIds) ? input.paperIds : []).map(String))].filter(id => /^[0-9a-f]{40}$/.test(id));
        if (!ids.length) throw httpError(400, 'Eklenecek makaleleri seçin.');
        if (ids.length > MAX_IMPORT) throw httpError(400, `Tek seferde en fazla ${MAX_IMPORT} makale eklenebilir.`);
        Plans.enforce(plan, 'monthlyTokens', deps.usage.monthTokens(userId));
        const limits = Plans.limitsFor(plan);
        let records;
        try { records = await deps.scholar.byIds(ids); } catch (error) { throw httpError(error.status || 502, error.message || 'Semantic Scholar kaydı alınamadı.'); }
        const have = db().listDocuments(userId, collectionId);
        const haveIds = new Set(have.map(d => d.meta?.scholarId).filter(Boolean)), haveDois = new Set(have.map(d => String(d.meta?.doi || '').toLowerCase()).filter(Boolean));
        const added = [], skipped = [];
        let count = have.length;
        for (const rec of records) {
          const label = rec.title || rec.paperId, skip = reason => skipped.push({ paperId: rec.paperId, title: label, reason });
          if (rec.missing) { skip('Semantic Scholar kaydı bulunamadı.'); continue; }
          if (haveIds.has(rec.paperId) || (rec.doi && haveDois.has(rec.doi))) { skip('Zaten bu koleksiyonda.'); continue; }
          if (!rec.pdfUrl) { skip('Açık erişimli PDF bulunamadı.'); continue; }
          try { Plans.enforce(plan, 'documentsPerProject', count); } catch (error) { skip(error.message); continue; }
          const doc = db().addDocument(userId, collectionId, { fileName: pdfName(rec), meta: { ...Meta.extract({ paragraphs: [], fileName: '' }), ...knownMeta(rec) } });
          count++; haveIds.add(rec.paperId); if (rec.doi) haveDois.add(rec.doi);
          importPaper(userId, collectionId, doc, rec, limits); added.push(documentView(doc));
        }
        if (added.length) db().touchCollection(userId, collectionId);
        deps.usage.event?.({ userId, kind: 'scholar-import', detail: { requested: ids.length, added: added.length, collectionId } });
        return json(res, 202, { added, skipped }), true;
      }
      if (route === '/suggest' && req.method === 'GET') return json(res, 200, { skill: Skills.suggest(url.searchParams.get('q') || '', plan) }), true;
      if (route === '/collections' && req.method === 'GET') return json(res, 200, { collections: db().listCollections(userId) }), true;
      if (route === '/collections' && req.method === 'POST') {
        const input = await readBody(req, 16 * 1024);
        if (db().countCollections(userId) >= MAX_COLLECTIONS) throw httpError(400, `En fazla ${MAX_COLLECTIONS} koleksiyon oluşturabilirsiniz.`);
        const collection = db().createCollection(userId, title(input.name ?? input.title));
        return json(res, 201, { collection: { ...collection, documents: 0, projects: 0 } }), true;
      }
      if ((m = route.match(/^\/collections\/([0-9a-f-]{36})(\/sources)?(?:\/([0-9a-f-]{36})(?:\/(verify|retry))?)?$/))) {
        const [, collectionId, sourcesPart, sourceId, action] = m;
        if (!db().getCollection(userId, collectionId)) throw httpError(404, 'Koleksiyon bulunamadı.');
        if (!sourcesPart) {
          if (req.method === 'GET') return json(res, 200, collectionPayload(userId, collectionId)), true;
          if (req.method === 'PATCH') { const input = await readBody(req, 16 * 1024); db().renameCollection(userId, collectionId, title(input.name ?? input.title)); return json(res, 200, collectionPayload(userId, collectionId)), true; }
          if (req.method === 'DELETE') {
            for (const d of db().listDocuments(userId, collectionId)) controllers.get(d.id)?.abort();
            db().deleteCollection(userId, collectionId); return json(res, 200, { deleted: true }), true;
          }
        }
        if (sourcesPart && !sourceId && req.method === 'POST') {
          const limits = Plans.limitsFor(plan);
          const receiveAt = Date.now();
          const input = await readBody(req, Math.ceil(limits.documentBytes * 4 / 3) + 4096);
          const receiveMs = Date.now() - receiveAt;
          const name = path.basename(String(input.name || '')).slice(0, 150);
          const format = /\.pdf$/i.test(name) ? 'pdf' : /\.docx$/i.test(name) ? 'docx' : '';
          if (!format) throw httpError(400, 'Yalnız Word (.docx) ve PDF desteklenir; .doc dosyasını Word’de .docx olarak kaydedin.');
          Plans.enforce(plan, 'documentsPerProject', db().countDocuments(userId, collectionId));
          Plans.enforce(plan, 'monthlyTokens', deps.usage.monthTokens(userId));
          const buffer = decodeFile(input.data, limits.documentBytes);
          if (format === 'pdf' ? !buffer.subarray(0, 5).equals(Buffer.from('%PDF-')) : !(buffer[0] === 0x50 && buffer[1] === 0x4b)) throw httpError(400, format === 'pdf' ? 'Geçerli PDF değil.' : 'Geçerli Word dosyası değil.');
          const doc = db().addDocument(userId, collectionId, { fileName: name });
          db().touchCollection(userId, collectionId);
          enqueue(userId, collectionId, doc, buffer, format, limits.documentBytes, null, null, { kind: 'source-upload', bytes: buffer.length, receiveMs });
          return json(res, 202, { source: documentView(doc) }), true;
        }
        if (sourcesPart && sourceId) {
          const doc = db().getDocument(userId, sourceId);
          if (!doc || doc.collectionId !== collectionId) throw httpError(404, 'Kaynak bulunamadı.');
          if (!action && req.method === 'PATCH') {
            const input = await readBody(req, 64 * 1024);
            db().updateDocument(userId, doc.id, { meta: metaPatch(doc.meta, input) });
            return json(res, 200, { source: documentView(db().getDocument(userId, doc.id)) }), true;
          }
          if (!action && req.method === 'DELETE') { controllers.get(doc.id)?.abort(); db().deleteDocument(userId, doc.id); return json(res, 200, { deleted: true }), true; }
          if (action === 'verify' && req.method === 'POST') {
            if (!doc.meta.title && !doc.meta.doi) throw httpError(400, 'Doğrulamak için önce DOI veya başlığı girin.');
            // The user asked for a check: it overrides the "user edited" shortcut but never replaces what was typed unless it matches.
            db().updateDocument(userId, doc.id, { meta: { ...doc.meta, source: 'auto' } });
            verifyInBackground(userId, doc.id);
            return json(res, 202, { source: documentView(db().getDocument(userId, doc.id)) }), true;
          }
          if (action === 'retry' && req.method === 'POST') {
            if (doc.status === 'processing' || doc.status === 'embedding') throw httpError(409, 'Kaynak şu anda işleniyor.');
            if (!doc.chunkCount) throw httpError(400, 'Metin çıkarılamadığı için bu kaynağı yeniden yükleyin.');
            db().updateDocument(userId, doc.id, { status: 'processing', error: null });
            track(deps.usage.run({ userId, kind: 'source-embed', detail: { retry: true, collectionId } }, async () => { const controller = new AbortController(); controllers.set(doc.id, controller); try { await stage(embedding, () => finishEmbedding(userId, doc, controller.signal)); } finally { controllers.delete(doc.id); } }).catch(() => {}));
            return json(res, 202, { source: documentView(db().getDocument(userId, doc.id)) }), true;
          }
        }
      }
      if (route === '/projects' && req.method === 'POST') {
        const input = await readBody(req, 16 * 1024);
        Plans.enforce(plan, 'projects', db().countProjects(userId));
        const project = db().createProject(userId, title(input.title));
        return json(res, 201, { project }), true;
      }
      if (route === '/projects' && req.method === 'GET') return json(res, 200, { projects: db().listProjects(userId) }), true;

      if ((m = route.match(/^\/projects\/([0-9a-f-]{36})(?:\/(ask|messages|manuscript\.docx|manuscript|collections))?$/))) {
        const [, projectId, part] = m;
        if (!db().getProject(userId, projectId)) throw httpError(404, 'Proje bulunamadı.');

        if (!part) {
          if (req.method === 'GET') return json(res, 200, projectPayload(userId, plan, projectId)), true;
          if (req.method === 'PATCH') {
            const input = await readBody(req, 16 * 1024);
            if (input.language !== undefined) { if (!['tr', 'en'].includes(input.language)) throw httpError(400, 'Makale dili Türkçe (tr) veya İngilizce (en) olmalıdır.'); db().setProjectLanguage(userId, projectId, input.language); }
            if (input.title !== undefined || input.language === undefined) db().renameProject(userId, projectId, title(input.title));
            return json(res, 200, { project: db().getProject(userId, projectId) }), true;
          }
          if (req.method === 'DELETE') { db().deleteProject(userId, projectId); return json(res, 200, { deleted: true }), true; }
        }
        // The collections a project writes from; ids that are not the owner's collections are ignored.
        if (part === 'collections' && req.method === 'PUT') {
          const input = await readBody(req, 16 * 1024);
          if (!Array.isArray(input.ids) || input.ids.length > MAX_COLLECTIONS) throw httpError(400, 'Koleksiyon listesi geçersiz.');
          return json(res, 200, { collectionIds: db().setProjectCollections(userId, projectId, input.ids) }), true;
        }
        if (part === 'ask' && req.method === 'POST') {
          const reply = startAsk(userId, plan, projectId, await readBody(req, 128 * 1024));
          return json(res, 202, { message: messageView(reply, {}), usage: usageOf(userId, plan) }), true;
        }
        if (part === 'messages' && req.method === 'DELETE') { db().clearMessages(userId, projectId); return json(res, 200, { cleared: true }), true; }
        if (part === 'manuscript') {
          if (req.method === 'GET') { const ms = db().getManuscript(userId, projectId); return json(res, 200, { html: Manuscript.renderCitations(ms.html, sourceMap(sourcesOf(userId, projectId))), revision: ms.revision, updatedAt: ms.updatedAt }), true; }
          if (req.method === 'PUT') {
            const input = await readBody(req, 3 * 1024 * 1024);
            const saved = db().saveManuscript(userId, projectId, Manuscript.sanitize(input.html), Number(input.revision) || 0);
            return json(res, 200, { revision: saved.revision, updatedAt: saved.updatedAt }), true;
          }
        }
        if (part === 'manuscript.docx' && req.method === 'GET') {
          const blocks = Manuscript.toBlocks(db().getManuscript(userId, projectId).html, sourceMap(sourcesOf(userId, projectId)));
          if (!blocks.length) throw httpError(400, 'Makale boş; önce metin ekleyin.');
          const out = await deps.python({ operation: 'build_docx', data: '', blocks });
          res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Content-Disposition': 'attachment; filename="makale.docx"', 'Cache-Control': 'no-store' });
          return res.end(Buffer.from(out.data, 'base64')), true;
        }
      }
      return json(res, 404, { error: 'İşlem bulunamadı.' }), true;
    } catch (error) {
      json(res, error.status || 400, { error: error.message || 'İşlem tamamlanamadı.', ...(error.code ? { code: error.code } : {}), ...(error.upgrade ? { upgrade: error.upgrade } : {}) });
      return true;
    }
  }
  const idle = async () => { while (pending.size) await Promise.allSettled([...pending]); };
  return { handle, idle, startAsk, projectPayload, processDocument, _deps: deps };
}

let shared = null;
const service = () => shared ||= createService();
// The server swaps in a service wired to the operation log once accounts are on.
function configure(options) { return shared = createService(options); }
module.exports = { createService, configure, handle: (...args) => service().handle(...args), httpError };
