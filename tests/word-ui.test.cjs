const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../word-app.js'), 'utf8');

async function ui() {
  const elements = new Map(), events = new Map(), requests = [], blobs = [], sessions = new Map(), timers = [];
  let uploads=0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', value: '', dataset: {}, disabled: false,
      classList: { toggle() {}, add() {}, remove() {} }, focus() {}, scrollIntoView() {}, querySelectorAll: () => [],
      querySelector: () => ({ focus() {} }), addEventListener: (name, handler) => events.set(id + ':' + name, handler) });
    return elements.get(id);
  };
  const paragraph = 'Önceki cümle. Yılmaz (2020) bulgusu <script>örnek</script>.';
  const state = { id: 'test', name: 'test.docx', groqConfigured: true, job: { running: false }, range: { start: 1, end: 2 }, applied: [], warnings: [],
    paragraphs: [{ id: 'p1', index: 0, part: 'word/document.xml', text: paragraph }, { id: 'p2', index: 1, part: 'word/document.xml', text: 'Yılmaz kaynakça' }],
    references: [{ id: 'r1', raw: 'Yılmaz kaynakça', paragraphs: ['p2'] }, { id: 'r2', raw: 'Yetim yayın', paragraphs: ['p2'] }],
    citations: [{ id: 'c1', text: 'Yılmaz (2020)', paragraph: 'p1', authorStart: 14, end: 27, context: ['Önceki cümle.', 'Yılmaz (2020) bulgusu.'], content: { verdict: 'supported', explanation: 'Destek kanıtı' } },
      { id: 'c2', text: 'Yetim atıf (2023)', paragraph: 'p1', context: ['Yetim atıf cümlesi.'] }],
    findings: [{ id: 'year-c1', citation: 'c1', paragraph: 'p1', type: 'Yıl uyuşmazlığı', original: 'Yılmaz 2020', patch: { original: '2020', replacement: '2021' } },
      { id: 'missing-c2', citation: 'c2', paragraph: 'p1', type: 'Kaynakçası olmayan atıf', original: 'Yetim atıf' },
      { id: 'orphan-r2', reference: 'r2', type: 'Atıfsız kaynakça', original: 'Yetim yayın' }] };
  const document = { getElementById: element, createElement: () => ({ click() {} }) };
  vm.runInNewContext(source, { document, Blob, Uint8Array, btoa, setTimeout: (fn, ms) => { timers.push({ fn, ms: ms || 0 }); return timers.length; }, clearTimeout() {},
    URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:test'; }, revokeObjectURL() {} },
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      if(url==='/api/word/documents')return {ok:true,json:async()=>({documents:[]})};
      let result;
      if(url.endsWith('/upload')) { result=JSON.parse(JSON.stringify(state));result.id='session-'+(++uploads);result.name=JSON.parse(options.body).name;sessions.set(result.id,result); }
      else { result=sessions.get(url.split('/')[3]);if(url.endsWith('/verify'))result.job.running=true;if(url.endsWith('/stop')){result.job.running=false;result.autoPaused=true;} }
      return { ok: true, json: async () => JSON.parse(JSON.stringify(result)) };
    } });
  element('word-upload').files = [{ name: 'test.docx', size: 1, arrayBuffer: async () => new ArrayBuffer(1) }];
  await events.get('word-upload:change')();
  const dispatch = (type, target) => events.get('word-panel:' + type)({ target });
  const click = (selector, dataset) => dispatch('click', { closest: s => s === selector ? { dataset } : null });
  const search = text => { element('word-search').value = text; events.get('word-search:input')(); };
  return { element, events, requests, blobs, sessions, timers, click, dispatch, search };
}

test('Word review separates orphan lists and renders escaped inline paragraphs', async () => {
  const u = await ui();
  assert.match(u.element('word-findings').innerHTML, /year-c1/);
  assert.doesNotMatch(u.element('word-findings').innerHTML, /missing-c2|orphan-r2/);
  assert.match(u.element('word-orphan-citations').innerHTML, /missing-c2/);
  assert.match(u.element('word-orphan-references').innerHTML, /orphan-r2/);
  assert.match(u.element('word-findings').innerHTML, /İlgili paragrafı göster/);
  assert.doesNotMatch(u.element('word-citations').innerHTML, /Paragrafı editörde göster|Bu bağlamla incele/);
  assert.match(u.element('word-findings').innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(u.element('word-findings').innerHTML, /<script>/);
  assert.equal((u.element('word-summary').innerHTML.match(/data-view=/g) || []).length, 4);
});

test('Word search and content filters keep separate counts and paragraph drawers', async () => {
  const u = await ui();
  u.dispatch('toggle', { dataset: { drawer: 'issues-paragraph-year-c1' }, open: true });
  u.search('Yılmaz');
  assert.match(u.element('word-findings').innerHTML, /data-drawer="issues-paragraph-year-c1" open/);
  u.click('[data-view]', { view: 'evidence' });
  assert.equal(u.element('word-search').value, '');
  u.click('[data-filter]', { filter: 'supported' });
  assert.match(u.element('word-citations').innerHTML, /data-citation="c1"/);
  assert.doesNotMatch(u.element('word-citations').innerHTML, /data-citation="c2"/);
  assert.match(u.element('word-orphan-citations').innerHTML, /missing-c2/);
  u.click('[data-view]', { view: 'issues' });
  assert.match(u.element('word-findings').innerHTML, /data-drawer="issues-paragraph-year-c1" open/);
});

test('Word kaynakça kayıtları kontrol özeti durumlarına göre filtrelenir', async () => {
  const u = await ui();
  u.click('[data-view]', { view: 'references' });
  assert.match(u.element('word-reference-summary').innerHTML, /data-reference-filter="all"/);
  assert.match(u.element('word-reference-summary').innerHTML, /data-reference-filter="pending"/);
  u.click('[data-reference-filter]', { referenceFilter: 'pending' });
  assert.match(u.element('word-references').innerHTML, /word-reference-r1/);
  assert.match(u.element('word-references').innerHTML, /word-reference-r2/);
});

test('alternatif PDF sürüm beyanı kaynak kartında açıkça gösterilir', async()=>{
  const u=await ui(),saved=u.sessions.get('session-1');
  saved.references[0].pdf={access:'Açık erişim PDF · alternatif yayın sürümü',needsConfirmation:true,preview:'Sürümü kontrol edin.',versionNotice:'This is a non-peer reviewed preprint submitted to EarthArXiv.'};
  await u.events.get('word-stop:click')();u.click('[data-view]',{view:'references'});
  assert.match(u.element('word-references').innerHTML,/PDF sürüm uyarısı/);
  assert.match(u.element('word-references').innerHTML,/This is a non-peer reviewed preprint submitted to EarthArXiv\./);
});
test('alternatif PDF onayı atıf kartından aynı atfı yeniden inceleyerek gönderilir',async()=>{
 const u=await ui(),saved=u.sessions.get('session-1');saved.citations[0].reference='r1';saved.citations[0].content={verdict:'unassessable',explanation:'PDF’nin yayın kimliğini ve sürümünü önizleyip kabul edin.',claims:[]};saved.references[0].pdf={needsConfirmation:true,access:'Açık erişim PDF · alternatif yayın sürümü'};
 await u.events.get('word-stop:click')();u.click('[data-view]',{view:'evidence'});assert.match(u.element('word-citations').innerHTML,/Bu PDF sürümünü kabul et ve yeniden incele/);
 u.click('[data-action]',{action:'confirmcheck',id:'r1',citationId:'c1'});await Promise.resolve();await Promise.resolve();
 const request=u.requests.find(r=>r.url.endsWith('/confirm'));assert.deepEqual(JSON.parse(request.body),{reference:'r1',citation:'c1'});
});

test('arka plan kaynak kotası güvenli debug ayrıntılarıyla gösterilir', async () => {
  const u=await ui(),saved=u.sessions.get('session-1'),retryAt=Date.now()+360000;
  saved.referenceJob={running:true,pending:1,provider:'CORE',retryAt,lastWait:{provider:'CORE',retryAt,receivedAt:Date.now()},debug:[{index:1,reference:'Yılmaz kaynakça',statusText:'Kota bekleniyor',provider:'CORE',pendingRetryAt:retryAt,sourcesChecked:['Crossref','CORE'],warnings:['CORE: HTTP 429'],debugRequests:[{provider:'CORE',status:429,url:'https://api.core.ac.uk/v3/search/works',requestUrl:'http://127.0.0.1:4173/api/proxy',detail:'sorgu kotası'}]}]};
  saved.job={running:true,kind:'content',message:'Groq hız/kota beklemesi; otomatik devam edilecek',completed:12,total:71,retryAt:Date.now()+1000};
  saved.debugEvents=[{id:'e1',at:Date.now(),scope:'reference',kind:'response',provider:'CORE',status:429,index:1,url:'https://api.core.ac.uk/v3/search/works',record:'Yılmaz kaynakça'},{id:'e2',at:Date.now(),scope:'groq',kind:'wait',provider:'Groq',status:429,retryAt:Date.now()+29000}];
  await u.events.get('word-stop:click')();
  assert.match(u.element('word-query-monitor-summary').innerHTML,/12 \/ 71/);
  assert.match(u.element('word-query-monitor-summary').innerHTML,/1 kaynak bekliyor/);
  assert.match(u.element('word-query-monitor-log').innerHTML,/CORE/);
  assert.match(u.element('word-query-monitor-log').innerHTML,/HTTP 429/);
  assert.match(u.element('word-query-monitor-log').innerHTML,/Yılmaz kaynakça/);
});

test('Word selected corrections survive searching and list navigation', async () => {
  const u = await ui();
  u.dispatch('change', { dataset: { patch: 'year-c1' }, checked: true });
  u.search('does not exist');
  u.click('[data-view]', { view: 'orphan-references' });
  await u.events.get('word-applymany:click')();
  const request = u.requests.find(r => r.url.endsWith('/applymany'));
  assert.deepEqual(JSON.parse(request.body).ids, ['year-c1']);
  u.click('[data-view]', { view: 'issues' });
  assert.match(u.element('word-findings').innerHTML, /data-patch="year-c1" checked/);
});

test('Word report includes all lists even when searching and filtering', async () => {
  const u = await ui();
  u.click('[data-view]', { view: 'evidence' });
  u.click('[data-filter]', { filter: 'supported' });
  u.search('Yılmaz');
  u.events.get('word-report:click')();
  const report = await u.blobs[0].text();
  for (const id of ['year-c1', 'missing-c2', 'orphan-r2']) assert.ok(report.includes('data-finding="' + id + '"'));
  for (const id of ['c1', 'c2']) assert.ok(report.includes('data-citation="' + id + '"'));
  assert.match(report, /Yetim yayın/);
});

test('independent content upload, jobs, replacement and deletion never target the orphan document', async () => {
  const u=await ui();
  u.dispatch('change',{dataset:{patch:'year-c1'},checked:true});
  u.element('content-upload').files=[{name:'content-only.docx',size:1,arrayBuffer:async()=>new ArrayBuffer(1)}];
  await u.events.get('content-upload:change')();
  assert.match(u.element('content-message').textContent,/content-only.docx/);
  assert.match(u.element('word-message').textContent,/test.docx/);
  assert.equal(u.requests.filter(r=>r.method==='DELETE').length,0);
  assert.match(u.element('content-citations').innerHTML,/id="content-citation-c1"/);
  assert.doesNotMatch(u.element('content-citations').innerHTML,/id="word-/);
  await u.events.get('word-verify:click')();
  assert.equal(u.element('word-upload').disabled,true);
  assert.equal(u.element('content-upload').disabled,false);
  await u.events.get('content-upload:change')();
  assert.equal(u.requests.filter(r=>r.method==='DELETE').length,0);
  await u.events.get('content-delete:click')();
  assert.equal(u.requests.filter(r=>r.method==='DELETE').at(-1).url,'/api/word/session-3');
  await u.events.get('word-stop:click')();
  assert.ok(u.requests.some(r=>r.url==='/api/word/session-1/stop'));
  assert.match(u.element('word-findings').innerHTML,/data-patch="year-c1" checked/);
  assert.match(u.element('word-message').textContent,/test.docx/);
});

test('content check flushes pending paragraph edits before starting the pipeline',async()=>{
 const u=await ui();
 u.element('content-upload').files=[{name:'editable.docx',size:1,arrayBuffer:async()=>new ArrayBuffer(1)}];
 await u.events.get('content-upload:change')();
 u.events.get('content-editor:input')({target:{dataset:{paragraph:'p1'},value:'Changed paragraph (Yılmaz, 2020).'}});
 assert.match(u.element('content-save-status').textContent,/Kaydedilmemiş/);
 await u.events.get('content-content:click')();
 const saves=u.requests.filter(r=>r.url.endsWith('/paragraph'));
 assert.equal(saves.length,1);assert.equal(JSON.parse(saves[0].body).text,'Changed paragraph (Yılmaz, 2020).');
 const check=u.requests.findIndex(r=>r.url.endsWith('/check'));
 assert.ok(check>u.requests.indexOf(saves[0]));
 assert.equal(saves[0].url,'/api/word/session-2/paragraph');
 assert.match(u.element('word-message').textContent,/test.docx/);
});

test('verified bibliography differences have a separate filter and textual similarity',async()=>{
 const u=await ui(),saved=u.sessions.get('session-1');
 saved.references[0].verification={status:'verified',statusText:'Doğrulandı',suggested:'Yılmaz düzeltilmiş kaynakça',matched:{}};
 saved.references[1].verification={status:'verified',statusText:'Doğrulandı',suggested:'Yetim yayın',matched:{}};
 await u.events.get('word-stop:click')();u.click('[data-view]',{view:'references'});
 assert.match(u.element('word-references').innerHTML,/Doğrulandı – düzeltme gerekli/);
 assert.match(u.element('word-references').innerHTML,/Künye benzerliği: <strong>100\/100/);
 u.click('[data-reference-filter]',{referenceFilter:'correction'});
 const changed=u.element('word-references').innerHTML;
 assert.match(changed,/word-reference-r1/);assert.doesNotMatch(changed,/word-reference-r2/);
 assert.match(changed,/Künye benzerliği: <strong>\d{1,2}\/100/);
 u.click('[data-reference-filter]',{referenceFilter:'verified'});
 const same=u.element('word-references').innerHTML;
 assert.match(same,/word-reference-r2/);assert.doesNotMatch(same,/word-reference-r1|Öneri:|Kaynakçada düzeltmeyi uygula/);
 saved.references[0].accepted=true;
 await u.events.get('word-stop:click')();
 u.click('[data-reference-filter]',{referenceFilter:'correction'});
 assert.doesNotMatch(u.element('word-references').innerHTML,/word-reference-r1/);
});

test('Word citation offers editable paragraph and submits document edit',async()=>{
 const u=await ui(),saved=u.sessions.get('session-1');saved.paragraphs[0].editable=true;
 await u.events.get('word-stop:click')();
 assert.match(u.element('word-citations').innerHTML,/Paragrafı elle düzenle/);
 assert.match(u.element('word-citations').innerHTML,/Paragrafı Word belgesine kaydet/);
 u.dispatch('input',{dataset:{wordParagraph:'p1'},value:'Yılmaz (2020) elle düzenlendi.'});
 u.click('[data-action]',{action:'saveparagraph',id:'p1'});
 for(let i=0;i<10;i++)await Promise.resolve();
 const request=u.requests.find(r=>r.url.endsWith('/paragraph'));
 assert.ok(request);assert.equal(JSON.parse(request.body).text,'Yılmaz (2020) elle düzenlendi.');
});

test('Word issue inspection opens a dialog without changing the list',async()=>{
 const u=await ui();let opened=false;
 u.element('word-inspection').showModal=()=>{opened=true;};
 const navigation=u.element('word-summary').innerHTML;
 u.click('[data-inspect]',{inspect:'c1'});
 assert.equal(opened,true);
 assert.equal(u.element('word-summary').innerHTML,navigation);
 assert.match(u.element('word-inspection-body').innerHTML,/Seçilen eşleşmeyi kabul et/);
 assert.doesNotMatch(u.element('word-citations').innerHTML,/data-citation="c1"/);
 await u.events.get('word-inspection:close')();
 u.search('');
 assert.match(u.element('word-citations').innerHTML,/data-citation="c1"/);
});
test('Kaynakları doğrula Word sayfasında görünür bir ilerleme çubuğu gösterir', async () => {
 const u = await ui();
 assert.equal(u.element('word-progress').innerHTML, '', 'doğrulama başlamadan çubuk gösterilmez');
 const session = u.sessions.get('session-1');
 session.referenceJob = { running: true, completed: 1, seen: 1, total: 2, pending: 0 };
 session.references[0].verification = { status: 'verified' };
 session.job = { running: true, kind: 'references', message: 'Kaynak 1 sorgulandı; 1/2 kayda bakıldı' };
 await u.events.get('word-verify:click')();
 const html = u.element('word-progress').innerHTML;
 assert.match(html, /<progress id="word-stage-references"[^>]*max="2" value="1"/);
 assert.match(html, /1 \/ 2 sorgulandı · %50/);
 assert.match(html, /1 kayıt kesinleşti/);
 assert.match(html, /Kaynak 1 sorgulandı/);
 assert.match(html, /is-active/);
});
test('İçerik sayfasında Durdur sonrası otomatik denetim yeniden başlamaz', async () => {
 const u = await ui();
 u.element('content-upload').files = [{ name: 'durdur.docx', size: 1, arrayBuffer: async () => new ArrayBuffer(1) }];
 await u.events.get('content-upload:change')();
 const session = u.sessions.get('session-2');
 Object.assign(session, { checks: { references: true, citations: true, llm: true }, checksStarted: true });
 session.citations.push({ id: 'c3', text: 'Yılmaz (2020)', paragraph: 'p1', reference: 'r1', context: ['Yılmaz (2020) bulgusu.'] });
 const runZeroTimers = async () => { for (const timer of u.timers.splice(0)) if (!timer.ms) await timer.fn(); };
 u.timers.length = 0;
 await u.events.get('content-stop:click')();
 await runZeroTimers();
 const stopAt = u.requests.findIndex(r => r.url === '/api/word/session-2/stop');
 assert.ok(stopAt >= 0);
 assert.deepEqual(u.requests.slice(stopAt).filter(r => r.url.endsWith('/check')).map(r => r.url), []);
 session.autoPaused = false;
 await u.events.get('content-content:click')();
 assert.equal(JSON.parse(u.requests.filter(r => r.url.endsWith('/check')).at(-1).body).auto, undefined, 'kullanıcının başlattığı denetim otomatik sayılmaz');
});
test('PDF belgesinde düzeltilmiş dosya indirme ve toplu düzeltme gizlenir, salt okunur notu gösterilir', async () => {
 const u = await ui();
 assert.equal(u.element('word-download').hidden, false);
 assert.equal(u.element('word-format-note').hidden, true);
 u.sessions.get('session-1').format = 'pdf';
 await u.events.get('word-verify:click')();
 assert.equal(u.element('word-download').hidden, true);
 assert.equal(u.element('word-applymany').hidden, true);
 assert.equal(u.element('word-format-note').hidden, false);
 assert.match(u.element('word-format-note').textContent, /salt okunur/);
});
test('Kaynak kimliği kabul edilen düzeltme gerekli kayıt Doğrulandı listesine geçer', async () => {
 const u = await ui();
 const session = u.sessions.get('session-1');
 session.references[0].verification = { status: 'verified', statusText: 'Doğrulandı', matched: { title: 'Yılmaz' }, suggested: 'Yılmaz, A. (2020). Tamamen farklı biçimlenmiş künye. Dergi, 1(2), 3-4.' };
 await u.events.get('word-verify:click')();
 const summary = () => u.element('word-reference-summary').innerHTML;
 assert.match(summary(), /aria-label="1 doğrulandı – düzeltme gerekli:/);
 assert.match(summary(), /aria-label="0 doğrulandı:/);
 session.references[0].confirmed = true;
 await u.events.get('word-verify:click')();
 assert.match(summary(), /aria-label="0 doğrulandı – düzeltme gerekli:/);
 assert.match(summary(), /aria-label="1 doğrulandı:/);
 assert.match(u.element('word-references').innerHTML, /kaynak kimliği sizin tarafınızdan kabul edildi/);
});
test('İnceleme gerekli kaynakta önerilen künye textarea içinde gelir ve Öneriyi kullan düzenlenmiş metni gönderir', async () => {
 const u = await ui();
 const session = u.sessions.get('session-1');
 session.references[0].verification = { status: 'review', statusText: 'İncelenmeli', matched: { title: 'Yılmaz' }, suggested: 'Yılmaz, A. (2020). Önerilen başlık. Dergi, 1(2), 3-4.' };
 session.references[1].verification = { status: 'verified', statusText: 'Doğrulandı', matched: { title: 'Yetim' }, suggested: 'Yetim, B. (2019). Dizin künyesi. Dergi, 2, 5-6.' };
 await u.events.get('word-verify:click')();
 const html = u.element('word-references').innerHTML;
 assert.match(html, /<textarea data-reference-draft="r1"[^>]*>Yılmaz, A\. \(2020\)\. Önerilen başlık\. Dergi, 1\(2\), 3-4\.<\/textarea>/);
 assert.match(html, /<textarea data-reference-draft="r2"/, 'düzeltme gerekli kayıtta da textarea var');
 assert.equal((html.match(/data-action="usesuggestion"/g) || []).length, 2);
 u.events.get('word-panel:input')({ target: { dataset: { referenceDraft: 'r1' }, value: 'Yılmaz, A. (2020). Kullanıcı düzeltmesi. Dergi, 1(2), 3-4.' } });
 u.click('[data-action]', { action: 'usesuggestion', id: 'r1' });
 await new Promise(r => setImmediate(r));
 const apply = u.requests.find(r => r.url.endsWith('/apply'));
 assert.deepEqual(JSON.parse(apply.body), { id: 'bib-r1', text: 'Yılmaz, A. (2020). Kullanıcı düzeltmesi. Dergi, 1(2), 3-4.' });
});
test('İncelenmeli kayıt Öneriyi kullan ya da kimlik kabulüyle Doğrulandı listesine geçer; öneri yoksa da düğme görünür', async () => {
 const u = await ui();
 const session = u.sessions.get('session-1');
 session.format = 'pdf';
 session.references[0].verification = { status: 'review', statusText: 'İncelenmeli', reason: 'Dizinde kesin eşleşme yok.' };
 session.references[1].verification = { status: 'review', statusText: 'İncelenmeli', suggested: 'Yetim, B. (2019). Belirsiz öneri. Dergi, 2, 5-6.' };
 session.references[1].protected = true;
 await u.events.get('word-verify:click')();
 const summary = () => u.element('word-reference-summary').innerHTML;
 const html = u.element('word-references').innerHTML;
 assert.equal((html.match(/data-action="usesuggestion"/g) || []).length, 2, 'eşleşmesiz, korunan ve PDF kayıtlarda da düğme var');
 const draft = html.match(/<textarea data-reference-draft="r1"[^>]*>([^<]*)<\/textarea>/);
 assert.ok(draft && draft[1].length > 0, 'öneri yoksa künyenin kendisi taslak olur');
 u.click('[data-action]', { action: 'usesuggestion', id: 'r1' });
 await new Promise(r => setImmediate(r));
 assert.deepEqual(JSON.parse(u.requests.find(r => r.url.endsWith('/apply')).body), { id: 'bib-r1', text: session.references[0].raw });
 assert.match(summary(), /aria-label="2 incelenmeli:/);
 session.references[0].accepted = true;
 session.references[1].confirmed = true;
 await u.events.get('word-verify:click')();
 assert.match(summary(), /aria-label="0 incelenmeli:/);
 assert.match(summary(), /aria-label="2 doğrulandı:/);
 const after = u.element('word-references').innerHTML;
 assert.match(after, /öneri sizin tarafınızdan kullanıldı/);
 assert.match(after, /kaynak kimliği sizin tarafınızdan kabul edildi/);
 assert.match(after, /data-action="undo" data-id="bib-r1"[^>]*>Kabulü geri al/);
});
