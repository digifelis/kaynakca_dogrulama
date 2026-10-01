const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
process.env.WORD_ARCHIVE_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'word-archive-tests-'));
const S=require('../word-service.cjs'),Store=require('../word-store.cjs'),C=require('../word-content.cjs');
const py=path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const fixture=JSON.parse(execFileSync(py,[path.join(__dirname,'word-fixture.py')],{encoding:'utf8'}));
async function api(){
 const server=require('../server.cjs').createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const get=async route=>{const r=await fetch(base+route);assert.equal(r.status,200);return r.json();};
 const post=async(route,data,expected=200)=>{const r=await fetch(base+route,{method:'POST',headers:{'X-Word-Request':'1','Content-Type':'application/json'},body:JSON.stringify(data)});const result=await r.json();assert.equal(r.status,expected,JSON.stringify(result));return result;};
 return {server,base,get,post,close:()=>new Promise(r=>server.close(r))};
}
test('archive restores edits, original, results and PDF attachments after a fresh process loads it',async()=>{
 const a=await api();let id;
 try{
  let s=await a.post('/api/word/upload',{name:'archive.docx',mode:'content',...fixture});id=s.id;
  const original=s.paragraphs[1].text;assert.equal(s.paragraphs[3].editable,false);assert.equal(s.paragraphs[7].editable,false);
  const session=S.sessions.get(id);session.content[session.citations[0].id]={verdict:'supported',claims:[]};
  session.pdfFiles=[{id:'test-pdf',name:'source.pdf',reference:'r0',data:Buffer.from('%PDF-1.4\ntest').toString('base64')}];Store.save(session);
  s=await a.post('/api/word/'+id+'/paragraph',{paragraph:s.paragraphs[1].id,text:'Düzenlenen metin (Yılmaz, 2020).\nİkinci satır.\tSon.',revision:0});
  assert.equal(s.revision,1);assert.ok(s.citations.some(c=>c.year==='2020'&&c.paragraph===s.paragraphs[1].id));
  assert.ok(s.citations.filter(c=>c.paragraph===s.paragraphs[1].id).every(c=>!c.content));
  await a.post('/api/word/'+id+'/paragraph',{paragraph:s.paragraphs[1].id,text:'Stale',revision:0},400);
  await a.post('/api/word/'+id+'/paragraph',{paragraph:s.paragraphs[3].id,text:'Table edit',revision:1},400);
  const cold=JSON.parse(execFileSync(process.execPath,['-e',`const S=require('./word-store.cjs');const s=S.load('${id}');console.log(JSON.stringify({text:s.paragraphs[1].text,revision:s.revision,pdfs:s.pdfFiles.length,mode:s.mode}));`],{cwd:path.join(__dirname,'..'),encoding:'utf8'}));
  assert.equal(cold.revision,1);assert.equal(cold.pdfs,1);assert.equal(cold.mode,'content');assert.match(cold.text,/Düzenlenen/);
  S.dispose(S.sessions.get(id));s=await a.get('/api/word/'+id);assert.equal(s.revision,1);
  const download=await fetch(a.base+'/api/word/'+id+'/download');const edited=await S.python({operation:'inspect',data:Buffer.from(await download.arrayBuffer()).toString('base64')});
  assert.equal(edited.paragraphs[1].text,cold.text);assert.equal(edited.paragraphs[3].text,s.paragraphs[3].text);
  const orig=await fetch(a.base+'/api/word/'+id+'/original');assert.equal(Buffer.from(await orig.arrayBuffer()).toString('base64'),fixture.data);
  const pdf=await fetch(a.base+'/api/word/'+id+'/pdfdownload?file=test-pdf');assert.match(await pdf.text(),/%PDF/);
  const list=await a.get('/api/word/documents');assert.ok(list.documents.some(d=>d.id===id&&d.pdfs.length===1));
  const deleted=await fetch(a.base+'/api/word/'+id,{method:'DELETE',headers:{'X-Word-Request':'1'}});assert.equal(deleted.status,200);assert.equal(Store.load(id),null);
 }finally{if(id&&S.sessions.has(id))S.dispose(S.sessions.get(id));await a.close();}
});

test('abstract fallback is bounded, labelled and requires the exact publication identity',async()=>{
 const ref={raw:'Author. (2021). Study. https://doi.org/10.1234/test',title:'Study'};const signal=new AbortController().signal;
 const request=async url=>({data:Buffer.from(JSON.stringify(url.includes('openalex')?{doi:'https://doi.org/10.1234/test',title:'Study',abstract_inverted_index:{Water:[0],use:[1],increased:[2]}}:url.includes('crossref')?{message:{DOI:'10.1234/test',abstract:'<p>Water use increased.</p>'}}:{resultList:{result:[]}}))});
 const result=await C.fullText(ref,()=>{throw Error('no PDF expected');},signal,{remote:request});
 assert.equal(result.abstractOnly,true);assert.match(result.access,/Yalnız özet/);assert.equal(result.passages[0].text,'Water use increased');
 await assert.rejects(C.fullText(ref,()=>{},signal,{remote:async()=>({data:Buffer.from('{}')})}),/PDF/);
 const wrong=await C.fullText(ref,()=>{},signal,{remote:async url=>url.includes('openalex')?{data:Buffer.from(JSON.stringify({doi:'https://doi.org/10.9999/wrong',abstract_inverted_index:{Wrong:[0]}}))}:request(url)});
 assert.equal(wrong.passages[0].text,'Water use increased.');
});

test('one-click check runs the real verification worker then evidence evaluation; context action reruns it',async()=>{
 const http=require('node:http');let verified=0,evaluated=0,id;
 const oldText=C.fullText,oldEvaluate=C.evaluate,oldKey=process.env.GROQ_API_KEY;process.env.GROQ_API_KEY='synthetic-test';
 C.fullText=async()=>({title:'Data center water consumption',passages:[{location:'Test passage',text:'Water consumption varies.'}],access:'Test'});
 C.evaluate=async c=>{evaluated++;assert.ok(verified>0);return {verdict:'supported',explanation:'Synthetic evidence',claims:[],access:'Test'};};
 const item={DOI:'10.1038/s41545-021-00101-w',title:['Data center water consumption'],author:[{family:'Mytton',given:'David'}],published:{'date-parts':[[2021]]},'container-title':['npj Clean Water'],volume:'4',type:'journal-article'};
 const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 const server=http.createServer(async(req,res)=>{const url=new URL(req.url,'http://localhost');if(url.pathname==='/api/proxy'){verified++;const target=new URL(url.searchParams.get('url'));return json(res,200,{message:target.pathname.startsWith('/works/')?item:{items:[item]}});}await S.handle(req,res,url,json);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const post=async(action,data)=>{const r=await fetch(base+action,{method:'POST',headers:{'X-Word-Request':'1','Content-Type':'application/json'},body:JSON.stringify(data)});const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;};
 const code=`import sys,json,base64,io,zipfile
d=json.load(sys.stdin); z=zipfile.ZipFile(io.BytesIO(base64.b64decode(d['data']))); b=io.BytesIO()
with zipfile.ZipFile(b,'w') as out:
 for n in z.namelist():
  if n=='word/document.xml': out.writestr(n,'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Mytton (2021) discusses water consumption.</w:t></w:r></w:p><w:p><w:r><w:t>References</w:t></w:r></w:p><w:p><w:r><w:t>Mytton, D. (2021). Data center water consumption. npj Clean Water, 4, 11. https://doi.org/10.1038/s41545-021-00101-w</w:t></w:r></w:p></w:body></w:document>')
  elif n!='word/footnotes.xml': out.writestr(n,z.read(n))
print(json.dumps({'data':base64.b64encode(b.getvalue()).decode()}))`;
 const one=JSON.parse(execFileSync(py,['-c',code],{input:JSON.stringify(fixture),encoding:'utf8'}));
 try{
  let s=await post('/api/word/upload',{...one,name:'pipeline.docx',mode:'content'});id=s.id;
  await post('/api/word/'+id+'/check',{});
  for(let i=0;i<100;i++){s=await(await fetch(base+'/api/word/'+id)).json();if(!s.job.running)break;await new Promise(r=>setTimeout(r,25));}
  assert.equal(s.job.running,false);assert.equal(s.references[0].verification.status,'verified');assert.equal(evaluated,1);assert.equal(s.citations[0].content.verdict,'supported');
  await post('/api/word/'+id+'/context',{citation:s.citations[0].id,text:'Mytton (2021) discusses water consumption.'});
  for(let i=0;i<30&&evaluated<2;i++)await new Promise(r=>setTimeout(r,10));assert.equal(evaluated,2);
 }finally{if(id&&S.sessions.has(id))S.dispose(S.sessions.get(id));C.fullText=oldText;C.evaluate=oldEvaluate;if(oldKey===undefined)delete process.env.GROQ_API_KEY;else process.env.GROQ_API_KEY=oldKey;await new Promise(r=>server.close(r));}
});
test('state polling revalidates with ETag and returns 304 while the document is unchanged',async()=>{
 const a=await api();let id;
 try{
  const s=await a.post('/api/word/upload',{name:'etag.docx',mode:'word',...fixture});id=s.id;
  const first=await fetch(a.base+'/api/word/'+id);const tag=first.headers.get('etag');assert.equal(first.status,200);assert.ok(tag);await first.json();
  const same=await fetch(a.base+'/api/word/'+id,{headers:{'If-None-Match':tag}});assert.equal(same.status,304);assert.equal(await same.text(),'');
  S.sessions.get(id).warnings.push('changed');
  const changed=await fetch(a.base+'/api/word/'+id,{headers:{'If-None-Match':tag}});assert.equal(changed.status,200);assert.notEqual(changed.headers.get('etag'),tag);await changed.json();
 }finally{if(id&&S.sessions.has(id)){Store.remove(id);S.dispose(S.sessions.get(id));}await a.close();}
});
test('Durdur sonrası arayüzün otomatik içerik isteği işi yeniden başlatmaz',async()=>{
 const a=await api();let id;const oldKey=process.env.GROQ_API_KEY;process.env.GROQ_API_KEY='synthetic-test';
 try{
  let s=await a.post('/api/word/upload',{name:'stop.docx',mode:'content',...fixture});id=s.id;
  s=await a.post('/api/word/'+id+'/stop',{});assert.equal(s.autoPaused,true);assert.equal(s.job.running,false);
  s=await a.post('/api/word/'+id+'/check',{matchedOnly:true,pendingOnly:true,auto:true});
  assert.equal(s.job.running,false);assert.equal(!!s.referenceJob?.running,false);assert.equal(s.autoPaused,true);
  assert.equal(Store.load(id).autoPaused,true,'duraklatma arşivde de korunur');
 }finally{if(oldKey===undefined)delete process.env.GROQ_API_KEY;else process.env.GROQ_API_KEY=oldKey;if(id&&S.sessions.has(id)){Store.remove(id);S.dispose(S.sessions.get(id));}await a.close();}
});
test('Öneriyi kullan, düzenlenmiş künyeyi Word’e yazar ve dergi italiklerini korur',async()=>{
 const a=await api();let id;
 try{
  let s=await a.post('/api/word/upload',{name:'oneri.docx',mode:'word',...fixture});id=s.id;
  const session=S.sessions.get(id),ref=session.references[0];
  ref.verification={status:'verified',statusText:'Doğrulandı',matched:{title:'x'},suggested:'Yılmaz, A. (2020). Eski başlık. Eğitim Dergisi, 5(2), 1–10.',suggestedHtml:'Yılmaz, A. (2020). Eski başlık. <em>Eğitim Dergisi, 5</em>(2), 1–10.'};S.rebuild(session);
  const text='Yılmaz, A. (2020). Kullanıcının düzelttiği başlık. Eğitim Dergisi, 5(2), 1–10.';
  s=await a.post('/api/word/'+id+'/apply',{id:'bib-'+ref.id,text});
  const applied=s.references.find(r=>r.id===ref.id);assert.equal(applied.accepted,true);assert.equal(applied.effectiveRaw,text);
  const download=Buffer.from(await (await fetch(a.base+'/api/word/'+id+'/download')).arrayBuffer());
  const xml=execFileSync(py,['-c','import sys,zipfile,io;print(zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())).read("word/document.xml").decode("utf-8"))'],{input:download,encoding:'utf8',env:{...process.env,PYTHONIOENCODING:'utf-8'}});
  assert.match(xml,/Kullanıcının düzelttiği başlık/);
  assert.match(xml,/<w:i ?\/>[\s\S]{0,200}?Eğitim Dergisi, 5</,'dergi adı ve cilt italik kalır');
  s=await a.post('/api/word/'+id+'/undo',{id:'bib-'+ref.id});assert.equal(s.references.find(r=>r.id===ref.id).accepted,false);
  await a.post('/api/word/'+id+'/apply',{id:'bib-'+ref.id,text:'   '},400);
 }finally{if(id&&S.sessions.has(id)){Store.remove(id);S.dispose(S.sessions.get(id));}await a.close();}
});
