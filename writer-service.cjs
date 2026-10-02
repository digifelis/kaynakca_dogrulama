// Writing assistant API (/api/writer/*): projects, uploaded sources, questions answered from those sources, the manuscript.
// Every handler starts from resolveUser(); the user id and plan come only from there, never from the request body.
const path = require('node:path');
const Identity = require('./lib/identity.cjs');
const Plans = require('./lib/plans.cjs');
const Skills = require('./lib/writer-skills.cjs');
const Chunker = require('./lib/writer-chunker.cjs');
const Meta = require('./lib/writer-meta.cjs');
const Search = require('./lib/writer-search.cjs');
const Answer = require('./lib/writer-answer.cjs');
const Manuscript = require('./lib/writer-manuscript.cjs');
const Cite = require('./writer-cite.js');
const Analysis = require('./word-analysis.cjs');

const MAX_TITLE = 120, MAX_QUESTION = 4000;
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
  };
  const pending = new Set();                 // background work, awaited by idle() in tests
  const controllers = new Map();             // document id -> AbortController
  const processing = limiter(2), verifying = limiter(1);
  let port = 4173;
  const track = promise => { pending.add(promise); promise.finally(() => pending.delete(promise)); return promise; };
  const db = () => deps.store();

  // ---- views
  const sourcesOf = (userId, projectId) => db().listDocuments(userId, projectId);
  const sourceMap = documents => Object.fromEntries(documents.map(d => [d.id, { id: d.id, fileName: d.fileName, meta: d.meta }]));
  const documentView = d => ({ id: d.id, fileName: d.fileName, status: d.status, error: d.error, pageCount: d.pageCount, chunkCount: d.chunkCount,
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
    return { questionsToday: db().questionsToday(userId), projects: db().countProjects(userId), limits: Plans.limitsFor(plan) };
  }
  function projectPayload(userId, plan, projectId) {
    const project = db().getProject(userId, projectId);
    if (!project) throw httpError(404, 'Proje bulunamadı.');
    const documents = sourcesOf(userId, projectId), byId = sourceMap(documents);
    const manuscript = db().getManuscript(userId, projectId);
    return { project, sources: documents.map(documentView), messages: db().listMessages(userId, projectId).map(m => messageView(m, byId)),
      manuscript: { html: Manuscript.renderCitations(manuscript.html, byId), revision: manuscript.revision, updatedAt: manuscript.updatedAt }, usage: usageOf(userId, plan) };
  }

  // ---- source processing: extract text and künye, split into passages, embed, then verify the künye in the background
  async function embedMissing(userId, doc, signal) {
    const noteWait = until => db().updateDocument(userId, doc.id, { error: `Embedding kotası bekleniyor (~${Math.max(1, Math.round((until - Date.now()) / 1000))} sn).` });
    for (;;) {
      const rows = db().chunksToEmbed(userId, doc.id, deps.embed.BATCH);
      if (!rows.length) return;
      const vectors = await deps.embed.embedBatch(rows.map(r => r.text), 'document', { signal, onWait: noteWait });
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
    track(verifying(async () => {
      const doc = db().getDocument(userId, docId);
      if (!doc || doc.meta.verified || doc.meta.source === 'user') return;
      let found = null;
      try { found = await deps.verifyMeta(doc.meta, { port }); } catch { /* the guess simply stays unverified */ }
      const fresh = db().getDocument(userId, docId);
      // A correction made by the user while the lookup ran wins over the lookup.
      if (found && fresh && fresh.meta.source !== 'user') db().updateDocument(userId, docId, { meta: found });
    }));
  }
  async function processDocument(userId, projectId, doc, buffer, format, limit) {
    const controller = new AbortController();
    controllers.set(doc.id, controller);
    try {
      const result = await deps.python({ operation: format === 'pdf' ? 'inspect_pdf' : 'inspect', data: buffer.toString('base64'), limit });
      if (!db().getDocument(userId, doc.id)) return;
      const chunks = Chunker.chunkParagraphs(result.paragraphs);
      if (!chunks.length) throw Error('Belgede aranabilir metin bulunamadı.');
      const meta = Meta.extract({ paragraphs: result.paragraphs, fileMeta: result.metadata || {}, fileName: doc.fileName });
      const pages = format === 'pdf' ? (result.metadata?.pages || Math.max(0, ...result.paragraphs.map(p => p.page || 0))) : null;
      db().insertChunks(userId, projectId, doc.id, chunks);
      db().updateDocument(userId, doc.id, { meta, pageCount: pages });
      await finishEmbedding(userId, doc, controller.signal);
      if (db().getDocument(userId, doc.id)) verifyInBackground(userId, doc.id);
    } catch (error) {
      if (db().getDocument(userId, doc.id)) db().updateDocument(userId, doc.id, { status: 'error', error: error.message || 'Belge işlenemedi.' });
    } finally { controllers.delete(doc.id); }
  }
  const enqueue = (...args) => track(processing(() => processDocument(...args)));

  // ---- questions
  function history(userId, projectId, byId, skipIds) {
    return db().listMessages(userId, projectId, 40).filter(m => m.status === 'done' && !skipIds.includes(m.id))
      .map(m => ({ role: m.role, text: Cite.renderText(m.text, byId, langOf(m)) }));
  }
  async function runAsk(userId, plan, projectId, reply, { question, skill, useManuscript, questionId }) {
    const update = fields => db().updateMessage(userId, reply.id, fields);
    try {
      const documents = sourcesOf(userId, projectId).filter(d => d.status === 'ready'), byId = sourceMap(documents);
      const all = db().projectChunks(userId, projectId);
      if (skill.needsSources && !all.length) throw httpError(400, 'Önce bu projeye kaynak yükleyin ve işlenmesini bekleyin.');
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
      const spec = Answer.request({ skill, question, chunks, sourcesById: byId, history: asked, draft });
      const { result } = await deps.llm.llmChat(spec, new AbortController().signal,
        until => update({ flags: { note: `LLM kotası bekleniyor (~${Math.max(1, Math.round((until - Date.now()) / 1000))} sn).` } }));
      const raw = typeof result?.answer === 'string' ? result.answer : '';
      if (!raw.trim()) throw Error('Model boş yanıt döndürdü; tekrar deneyin.');
      const text = skill.needsSources ? Answer.applyCitations(raw, chunks) : raw.trim();
      update({ text, status: 'done', error: null, flags: { insufficient: !!result.insufficient, lang: Analysis.isTurkish(text.replace(Cite.TOKEN, '')) ? 'tr' : 'en' } });
    } catch (error) {
      const wait = error.quota && error.retryAt ? ` ${Math.max(1, Math.round((error.retryAt - Date.now()) / 1000))} saniye sonra tekrar deneyin.` : '';
      update({ status: 'error', error: (error.message || 'Yanıt üretilemedi.') + wait, flags: {} });
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
    db().addQuestion(userId);
    const asked = db().addMessage(userId, projectId, { role: 'user', text: question, skill: skill.name });
    const reply = db().addMessage(userId, projectId, { role: 'assistant', skill: skill.name, status: 'working' });
    db().touchProject(userId, projectId);
    track(runAsk(userId, plan, projectId, reply, { question, skill, useManuscript: input.useManuscript === true, questionId: asked.id }));
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
      const { userId, plan } = Identity.resolveUser(req, res);
      const route = url.pathname.slice('/api/writer'.length).replace(/\/$/, '');
      let m;

      if (route === '/bootstrap' && req.method === 'GET') {
        const available = Skills.forPlan(plan).map(Skills.publicView), names = new Set(available.map(s => s.name));
        const locked = Skills.load().skills.filter(s => !names.has(s.name)).map(s => ({ name: s.name, title: s.title, description: s.description, plans: s.plans }));
        return json(res, 200, { plan: { id: Plans.known(plan), title: Plans.PLANS[Plans.known(plan)].title, nextPlan: Plans.nextPlan(plan) }, usage: usageOf(userId, plan),
          skills: available, lockedSkills: locked, defaultSkill: Skills.DEFAULT_SKILL,
          services: { llm: !!deps.llm.llmAvailable(), embedding: !!deps.embed.available() }, projects: db().listProjects(userId) }), true;
      }
      if (route === '/suggest' && req.method === 'GET') return json(res, 200, { skill: Skills.suggest(url.searchParams.get('q') || '', plan) }), true;
      if (route === '/projects' && req.method === 'POST') {
        const input = await readBody(req, 16 * 1024);
        Plans.enforce(plan, 'projects', db().countProjects(userId));
        const project = db().createProject(userId, title(input.title));
        return json(res, 201, { project }), true;
      }
      if (route === '/projects' && req.method === 'GET') return json(res, 200, { projects: db().listProjects(userId) }), true;

      if ((m = route.match(/^\/projects\/([0-9a-f-]{36})(?:\/(sources|ask|messages|manuscript\.docx|manuscript))?(?:\/([0-9a-f-]{36})(?:\/(verify|retry))?)?$/))) {
        const [, projectId, part, sourceId, action] = m;
        if (!db().getProject(userId, projectId)) throw httpError(404, 'Proje bulunamadı.');

        if (!part) {
          if (req.method === 'GET') return json(res, 200, projectPayload(userId, plan, projectId)), true;
          if (req.method === 'PATCH') { const input = await readBody(req, 16 * 1024); db().renameProject(userId, projectId, title(input.title)); return json(res, 200, { project: db().getProject(userId, projectId) }), true; }
          if (req.method === 'DELETE') {
            for (const d of sourcesOf(userId, projectId)) controllers.get(d.id)?.abort();
            db().deleteProject(userId, projectId); return json(res, 200, { deleted: true }), true;
          }
        }
        if (part === 'sources' && !sourceId && req.method === 'POST') {
          const limits = Plans.limitsFor(plan);
          const input = await readBody(req, Math.ceil(limits.documentBytes * 4 / 3) + 4096);
          const name = path.basename(String(input.name || '')).slice(0, 150);
          const format = /\.pdf$/i.test(name) ? 'pdf' : /\.docx$/i.test(name) ? 'docx' : '';
          if (!format) throw httpError(400, 'Yalnız Word (.docx) ve PDF desteklenir; .doc dosyasını Word’de .docx olarak kaydedin.');
          Plans.enforce(plan, 'documentsPerProject', db().countDocuments(userId, projectId));
          const buffer = decodeFile(input.data, limits.documentBytes);
          if (format === 'pdf' ? !buffer.subarray(0, 5).equals(Buffer.from('%PDF-')) : !(buffer[0] === 0x50 && buffer[1] === 0x4b)) throw httpError(400, format === 'pdf' ? 'Geçerli PDF değil.' : 'Geçerli Word dosyası değil.');
          const doc = db().addDocument(userId, projectId, { fileName: name });
          db().touchProject(userId, projectId);
          enqueue(userId, projectId, doc, buffer, format, limits.documentBytes);
          return json(res, 202, { source: documentView(doc) }), true;
        }
        if (part === 'sources' && sourceId) {
          const doc = db().getDocument(userId, sourceId);
          if (!doc || doc.projectId !== projectId) throw httpError(404, 'Kaynak bulunamadı.');
          if (!action && req.method === 'PATCH') {
            const input = await readBody(req, 64 * 1024);
            db().updateDocument(userId, doc.id, { meta: metaPatch(doc.meta, input) });
            return json(res, 200, { source: documentView(db().getDocument(userId, doc.id)) }), true;
          }
          if (!action && req.method === 'DELETE') { controllers.get(doc.id)?.abort(); db().deleteDocument(userId, doc.id); return json(res, 200, { deleted: true }), true; }
          if (action === 'verify' && req.method === 'POST') {
            if (!doc.meta.title) throw httpError(400, 'Doğrulamak için önce başlığı girin.');
            // The user asked for a check: it overrides the "user edited" shortcut but never replaces what was typed unless it matches.
            db().updateDocument(userId, doc.id, { meta: { ...doc.meta, source: 'auto' } });
            verifyInBackground(userId, doc.id);
            return json(res, 202, { source: documentView(db().getDocument(userId, doc.id)) }), true;
          }
          if (action === 'retry' && req.method === 'POST') {
            if (doc.status === 'processing' || doc.status === 'embedding') throw httpError(409, 'Kaynak şu anda işleniyor.');
            if (!doc.chunkCount) throw httpError(400, 'Metin çıkarılamadığı için bu kaynağı yeniden yükleyin.');
            db().updateDocument(userId, doc.id, { status: 'processing', error: null });
            track(processing(async () => { const controller = new AbortController(); controllers.set(doc.id, controller); try { await finishEmbedding(userId, doc, controller.signal); } finally { controllers.delete(doc.id); } }));
            return json(res, 202, { source: documentView(db().getDocument(userId, doc.id)) }), true;
          }
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
module.exports = { createService, handle: (...args) => service().handle(...args), httpError };
