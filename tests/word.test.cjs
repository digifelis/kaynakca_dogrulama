const test=require('node:test');const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');const path=require('node:path');const os=require('node:os');
process.env.WORD_ARCHIVE_DIR=require('node:fs').mkdtempSync(path.join(os.tmpdir(),'word-regression-'));
const Service=require('../word-service.cjs');const A=require('../word-analysis.cjs');const C=require('../word-content.cjs');
const py=path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const fixture=JSON.parse(execFileSync(py,[path.join(__dirname,'word-fixture.py')],{encoding:'utf8'}));
const p=text=>({id:'word/document.xml:0',part:'word/document.xml',index:0,text,group:'body',protected:false});
const refs=()=>[
 {id:'r0',raw:'Yılmaz, A. (2020). Başlık.'}, {id:'r1',raw:'Kaya, B. (2021). Diğer başlık.'},
].map(r=>({...r,...A.referenceIdentity(r.raw)}));
test('Word import finds bibliography, split runs, table, footnotes and protected fields',async()=>{
 const doc=await Service.python({operation:'inspect',...fixture});const ext=A.extractReferences(doc.paragraphs);
 assert.equal(ext.references.length,3);const result=A.analyze(doc.paragraphs,ext.references,ext.range);
 assert.ok(result.findings.some(f=>f.type==='Yıl uyuşmazlığı'&&!f.patch&&f.reviewReason));
 assert.ok(result.findings.some(f=>f.type==='Kaynakçası olmayan atıf'));
 assert.ok(result.findings.some(f=>f.type.includes('atıfı bulunmayan')&&f.reference==='r2'));
 assert.ok(result.citations.some(c=>c.location.startsWith('Dipnot')));
 assert.ok(result.citations.some(c=>c.protected&&!c.patch));
 const citation=result.citations.find(c=>c.original==='2019');assert.equal(citation.context.length,4);
 assert.equal(result.citations.find(c=>c.sentence.startsWith('Tablo')).context.length,1);
});
test('DOCX range patches preserve other package entries and styles, undo is original',async()=>{
 const doc=await Service.python({operation:'inspect',...fixture});const ext=A.extractReferences(doc.paragraphs);const result=A.analyze(doc.paragraphs,ext.references,ext.range);
 const c=result.citations.find(c=>c.original==='2019');
 const patch={paragraph:c.paragraph,start:c.start,end:c.end,original:c.original,replacement:'2020'};
 const edited=await Service.python({operation:'export',...fixture,patches:[patch]});const mapped=await Service.python({operation:'inspect',data:edited.data});
 assert.ok(mapped.paragraphs[1].text.includes('Yılmaz, 2020'));
 assert.equal(mapped.paragraphs[2].text,doc.paragraphs[2].text);
 const code='import sys,json,base64,io,zipfile; a,b=json.load(sys.stdin); za=zipfile.ZipFile(io.BytesIO(base64.b64decode(a))); zb=zipfile.ZipFile(io.BytesIO(base64.b64decode(b))); print(json.dumps({"unchanged":all(za.read(n)==zb.read(n) for n in za.namelist() if n!="word/document.xml"),"bold":b"<w:b" in zb.read("word/document.xml"),"italic":b"<w:i" in zb.read("word/document.xml")}))';
 const checked=JSON.parse(execFileSync(py,['-c',code],{input:JSON.stringify([fixture.data,edited.data]),encoding:'utf8'}));assert.deepEqual(checked,{unchanged:true,bold:true,italic:true});
 const original=await Service.python({operation:'export',...fixture,patches:[]});assert.equal((await Service.python({operation:'inspect',data:original.data})).paragraphs[1].text,doc.paragraphs[1].text);
 await assert.rejects(Service.python({operation:'export',...fixture,patches:[{...patch,original:'wrong'}]}));
 await assert.rejects(Service.python({operation:'export',...fixture,patches:[patch,patch]}));
});
test('Word export writes bibliography italics as OOXML, not HTML',async()=>{
 const doc=await Service.python({operation:'inspect',...fixture});const target=doc.paragraphs[7];
 const edited=await Service.python({operation:'export',...fixture,patches:[{paragraph:target.id,start:0,end:target.text.length,original:target.text,replacement:'Author. Journal.',whole:true,spans:[{text:'Author. ',italic:false},{text:'Journal.',italic:true}]}]});
 assert.equal((await Service.python({operation:'inspect',data:edited.data})).paragraphs[7].text,'Author. Journal.');
});
test('APA multi-source, suffix, undated and personal communication handling',()=>{
 const rs=[...refs(),{id:'r2',...A.referenceIdentity('Yılmaz, A. (2020a). Başlık.'),raw:'Yılmaz, A. (2020a). Başlık.'},{id:'r3',...A.referenceIdentity('WHO. (n.d.). Test.'),raw:'WHO. (n.d.). Test.'}];
 const cs=A.citationsIn(p('(Yılmaz, 2020a; Kaya, 2021, s. 5). WHO (n.d.). (Ak, kişisel iletişim, 2024).'),rs);
 assert.equal(cs.length,3);assert.equal(cs[0].year,'2020a');assert.equal(cs[2].year,'n.d.');
 assert.deepEqual(A.citationsIn(p('Yılmaz ve Kaya (2020) buldu.'),rs)[0].authors,['yilmaz','kaya']);
 const ambiguous=A.analyze([p('(Yılmaz, 2020).')],[...refs(),{...refs()[0],id:'r9'}],{start:10,end:20});assert.ok(ambiguous.findings.some(f=>f.type.startsWith('Belirsiz')));
});
test('content HTTP jobs use citation context and correctly abstain for unmatched citations',async()=>{
 const oldText=C.fullText,oldEvaluate=C.evaluate;let contexts=[];
 C.fullText=async()=>({passages:[{text:'Kanıt.',location:'Paragraf 1'}],title:'Örnek araştırma',access:'Test tam metni'});
 C.evaluate=async(c,text)=>{contexts.push(c.context);return {verdict:'supported',claims:[{claim:c.sentence,verdict:'supported',quote:'Kanıt.',passage:'P1',location:'Paragraf 1'}],access:text.access};};
 const previous=process.env.GROQ_API_KEY;process.env.GROQ_API_KEY='test-only';
 const server=require('../server.cjs').createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const post=async(url,data)=>{const r=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json','X-Word-Request':'1'},body:JSON.stringify(data)});assert.equal(r.status,200);return r.json();};let id;
 try{
  let s=await post('/api/word/upload',{name:'test.docx',...fixture});id=s.id;
  const f=s.findings.find(f=>f.type==='Yıl uyuşmazlığı');assert.equal(f.patch,undefined);
  s=await post('/api/word/'+id+'/match',{citation:f.citation,reference:f.reference});
  assert.ok(s.applied.some(group=>group.id===f.id));assert.ok(!s.findings.some(item=>item.citation===f.citation));
  for(const r of s.references)await post('/api/word/'+id+'/confirm',{reference:r.id});
  await post('/api/word/'+id+'/content',{});
  for(let i=0;i<30;i++){s=await(await fetch(base+'/api/word/'+id)).json();if(!s.job.running)break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(s.job.running,false);assert.ok(contexts.some(c=>c.length===4));
  assert.ok(s.citations.some(c=>c.content?.verdict==='supported'));
  assert.equal(s.citations.find(c=>c.authorText==='Demir').content.verdict,'unassessable');
 }finally{C.fullText=oldText;C.evaluate=oldEvaluate;if(previous===undefined)delete process.env.GROQ_API_KEY;else process.env.GROQ_API_KEY=previous;if(id&&Service.sessions.has(id))Service.dispose(Service.sessions.get(id));await new Promise(r=>server.close(r));}
});
test('content retrieval bounds evidence chunks and rejects internal network addresses',()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','192.168.1.1','169.254.169.254','::1','fc00::1','::ffff:127.0.0.1'])assert.equal(C.publicIp(ip),false);
 assert.equal(C.publicIp('8.8.8.8'),true);const evidence=C.selectPassages({passages:[{location:'p1',text:'attention sample sleep '.repeat(1000)}]},['sleep attention']);assert.ok(evidence.length<=7);assert.ok(evidence.every(p=>p.text.length<=2400));
});
test('Word HTTP upload, patch, download, delete and cross-origin protection',async()=>{
 const server=require('../server.cjs').createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;const post=async(url,data,headers={})=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json','X-Word-Request':'1',...headers},body:JSON.stringify(data)});
 let id;
 try{
  assert.equal((await post('/api/word/upload',{name:'test.docx',...fixture},{Origin:'https://evil.test'})).status,403);
  assert.equal((await fetch(base+'/api/word/upload',{method:'POST',body:'{}'})).status,403);
  const uploaded=await post('/api/word/upload',{name:'test.docx',...fixture});assert.equal(uploaded.status,200);const state=await uploaded.json();id=state.id;
  const f=state.findings.find(f=>f.type==='Yıl uyuşmazlığı');assert.ok(f);
  assert.equal(f.patch,undefined);
  assert.equal((await post('/api/word/'+id+'/apply',{id:f.id})).status,400);
  assert.equal((await post('/api/word/'+id+'/match',{citation:f.citation,reference:f.reference})).status,200);
  const applied=await fetch(base+'/api/word/'+id);assert.equal(applied.status,200);const corrected=await applied.json();assert.equal(corrected.applied.length,1);assert.ok(!corrected.findings.some(item=>item.citation===f.citation));
  const download=await fetch(base+'/api/word/'+id+'/download');assert.equal(download.status,200);
  const exported=await Service.python({operation:'inspect',data:Buffer.from(await download.arrayBuffer()).toString('base64')});
  assert.ok(exported.paragraphs[1].text.includes('(Yılmaz, 2020)'));
  assert.ok(corrected.citations.find(c=>c.id===f.citation).context.join(' ').includes('(Yılmaz, 2020)'));
  assert.equal((await post('/api/word/'+id+'/undo',{id:f.id})).status,200);
  assert.equal((await fetch(base+'/api/word/'+id,{method:'DELETE',headers:{'X-Word-Request':'1'}})).status,200);
  assert.equal((await fetch(base+'/api/word/'+id)).status,404);
 }finally{if(id&&Service.sessions.has(id))Service.dispose(Service.sessions.get(id));await new Promise(r=>server.close(r));}
});

test('approved matching occurrences survive paragraph save and DOCX download; decline changes only one',async()=>{
 const doc=await Service.python({operation:'inspect',...fixture});
 const edited=await Service.python({operation:'export',...fixture,patches:[2,3,8].map(i=>({paragraph:doc.paragraphs[i].id,start:0,end:doc.paragraphs[i].text.length,original:doc.paragraphs[i].text,replacement:i===8?'Yılmaz, A. (2020). Başka yayın.':i===2?'Bulgular (Yılmaz, 2019). Ayrıca (Yılmaz, 2019).':'Bulgular (Yılmaz, 2019) ile uyumludur.',whole:true}))});
 const server=require('../server.cjs').createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;const ids=[];
 const post=async(path,data)=>{const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Word-Request':'1'},body:JSON.stringify(data)});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;};
 try{for(const applySimilar of [false,true]){
  let state=await post('/api/word/upload',{name:'repeat.docx',mode:'word',data:edited.data});ids.push(state.id);
  const citation=state.citations.find(c=>c.year==='2019');
  state=await post('/api/word/'+state.id+'/match',{citation:citation.id,reference:'r0',applySimilar});
  assert.equal(state.applied.length,applySimilar?4:1);
  const correctedIds=state.citations.filter(c=>c.year==='2020'&&c.reference==='r0'&&!c.protected).map(c=>c.id);
  for(const id of correctedIds)assert.ok(!state.findings.some(f=>f.citation===id),id); 
  const paragraph=state.paragraphs.find(p=>p.id===citation.paragraph);
  state=await post('/api/word/'+state.id+'/paragraph',{paragraph:paragraph.id,text:paragraph.text+' Ek açıklama.',revision:state.revision});
  for(const c of state.citations.filter(c=>c.year==='2020'&&c.reference==='r0'&&!c.protected))assert.ok(!state.findings.some(f=>f.citation===c.id),c.id);
  const response=await fetch(base+'/api/word/'+state.id+'/download');assert.equal(response.status,200);
  const output=await Service.python({operation:'inspect',data:Buffer.from(await response.arrayBuffer()).toString('base64')});
  assert.match(output.paragraphs[1].text,/Yılmaz, 2020/);assert.match(output.paragraphs[1].text,/Ek açıklama/);
  for(const i of [2,3])assert.ok(output.paragraphs[i].text.includes(applySimilar?'Yılmaz, 2020':'Yılmaz, 2019'));
 }}finally{for(const id of ids)if(Service.sessions.has(id))Service.dispose(Service.sessions.get(id));await new Promise(r=>server.close(r));}
});

test('disabled bibliography verification is respected for all LLM scopes without deleting prior results',()=>{
 const previous={status:'verified',matched:{doi:'10.1234/old'}};
 const s={checks:{references:false,llm:true},citations:[{id:'c1',paragraph:'p1',reference:'r1'},{id:'c2',paragraph:'p2',reference:'r2'}],references:[{id:'r1',raw:'Smith (2020). Test. https://doi.org/10.1234/test'},{id:'r2',verification:previous}],manualConfirmed:new Set(),content:{}};
 for(const scope of [{},{citation:'c1'},{paragraph:'p1'},{matchedOnly:true,pendingOnly:true}])assert.equal(Service.scopeNeedsVerification(s,scope),false);
 assert.equal(s.references[1].verification,previous);
 s.checks.references=true;assert.equal(Service.scopeNeedsVerification(s,{citation:'c1'}),true);
});
test('orphan check: "and" lists, glued initials and sentence openers do not hide citations',()=>{
 const refs=['Madusanka, W. M. L., Rajini, P. A. D., and Konara, K. M. G. K. (2016). Decision making. Proc.','Morad, A. M., and Sattarvand, J. (2013). Tire monitoring. Archives, 58(4), 1133–1144.','Vander Veen, D. J., and Jordan, W. C. (1989). Trade-offs. Management Science, 35(10), 1215–','Zheng, SY. and Chen, S. (2018). Fleet replacement. Transportation Research D, 60, 153–173.'];
 const body=['Similarly, Madusanka (2016) reviewed it.','Morad and Sattarvand (2013) applied it.','For instance, Vander Veen and Jordan (1989) proposed it.','Methods (Zheng and Chen, 2018).'];
 const para=(id,index,group,text)=>({id,index,part:'word/document.xml',group,text,style:''});
 const all=[...body.map((t,i)=>para('b'+i,i,0,t)),para('h',10,1,'References'),...refs.map((t,i)=>para('r'+i,11+i,1,t))];
 const extracted=A.extractReferences(all);
 assert.deepEqual(extracted.references.map(r=>r.authors.length),[3,2,2,2]);
 const orphans=A.analyze(all,extracted.references,extracted.range).findings.filter(f=>f.type.startsWith('Taranan metinde'));
 assert.deepEqual(orphans,[]);
});
test('misspelled co-authored citation is linked to its undated reference, not reported as orphan',()=>{
 const para=(id,index,group,text)=>({id,index,part:'word/document.xml',group,text,style:''});
 const all=[para('b0',0,0,'Varaschin and De Souza (2015) evaluated fleets.'),para('h',10,1,'References'),para('r0',11,1,'Varaschina, J. and De Souza, E. (n.d.). Economics of diesel fleet replacement. Unpublished manuscript.')];
 const ex=A.extractReferences(all);const f=A.analyze(all,ex.references,ex.range).findings;
 assert.ok(f.some(x=>x.type.startsWith('Olası yazar yazım')));
 assert.ok(!f.some(x=>x.type.startsWith('Taranan metinde')));
});
