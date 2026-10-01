const {spawn}=require('node:child_process');
const {Worker}=require('node:worker_threads');
const {randomUUID,createHash}=require('node:crypto');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const Analysis=require('./word-analysis.cjs');
const Content=require('./word-content.cjs');
const Store=require('./word-store.cjs');
const Engine=require('./reference-engine.js');
const bundled=path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const pythonPath=()=>process.env.WORD_PYTHON||(fs.existsSync(bundled)?bundled:'python');
function python(request){return new Promise((resolve,reject)=>{
  const child=spawn(pythonPath(),[path.join(__dirname,'scripts/word-package.py')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let data='',size=0;const timer=setTimeout(()=>child.kill(),45000);
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>32*1024*1024){child.kill();return;}data+=chunk.toString();});
  child.stderr.resume();child.stdin.on('error',()=>{});
  child.on('error',()=>{clearTimeout(timer);reject(Error('Word işleme için Python çalıştırılamadı.'));});
  child.on('close',()=>{clearTimeout(timer);try{const output=JSON.parse(data);if(output.error)reject(Error(output.error));else resolve(output);}catch{reject(Error('Dosya işleme tamamlanamadı; boyut/biçim sınırlarını kontrol edin.'));}});
  child.stdin.end(JSON.stringify(request));
});}
async function body(req){let size=0;const parts=[];for await(const chunk of req){size+=chunk.length;if(size>29*1024*1024)throw Error('Dosya en fazla 20 MB olabilir.');parts.push(chunk);}try{return JSON.parse(Buffer.concat(parts));}catch{throw Error('Geçersiz istek.');}}
function decode(data){if(typeof data!=='string'||data.length>28*1024*1024||! /^[A-Za-z0-9+/]*={0,2}$/.test(data))throw Error('Geçersiz dosya verisi.');const buffer=Buffer.from(data,'base64');if(buffer.length>20*1024*1024)throw Error('Dosya en fazla 20 MB olabilir.');return buffer;}
function spans(html,text){
  const decode=s=>s.replace(/&(?:amp|lt|gt|quot|#039);/g,v=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#039;':"'"}[v]));
  const result=[];let italic=false;
  for(const part of String(html||'').split(/(<\/?em>)/g)) {if(part==='<em>')italic=true;else if(part==='</em>')italic=false;else if(part)result.push({text:decode(part.replace(/<[^>]*>/g,'')),italic});}
  return result.map(s=>s.text).join('')===text?result:[{text,italic:false}];
}
function effectiveParagraphs(s){return s.paragraphs.map(p=>{let text=p.text;const ps=[...s.applied.values()].filter(x=>x.paragraph===p.id).sort((a,b)=>b.start-a.start);for(const patch of ps)text=text.slice(0,patch.start)+patch.replacement+text.slice(patch.end);return {...p,text};});}
function refPatches(s,r,result){const replacement=result.suggested||result.corrected;return r.paragraphs.map((id,i)=>{
  const p=s.paragraphs.find(p=>p.id===id);return {paragraph:id,start:0,end:p.text.length,original:p.text,replacement:i?'':replacement,whole:true,spans:i?[{text:'',italic:false}]:spans(result.suggestedHtml||result.correctedHtml,replacement)};
});}
function rebuild(s){
  if(s.mode==='content'&&s.checks&&!s.checks.citations&&!s.checks.llm){s.citations=[];s.findings=[];s.effectiveReferences=s.references;s.suggestions=new Map();return;}

  const refs=s.references.map(r=>{const accepted=s.appliedGroups.has('bib-'+r.id);const raw=accepted?(s.appliedGroups.get('bib-'+r.id)?.[0]?.replacement||r.raw):r.raw;return {...r,...Analysis.referenceIdentity(raw),effectiveRaw:raw,accepted,confirmed:s.manualConfirmed.has(r.id)};});
  const base=Analysis.analyze(s.paragraphs,refs,s.range);
  s.suggestions=new Map();
  for(const f of base.findings) if(f.patch&&!s.appliedGroups.has(f.id))s.suggestions.set(f.id,[f.patch]);
  for(const r of s.references){const v=r.verification;if(v?.matched&&(v.suggested||v.corrected)&&!r.protected)s.suggestions.set('bib-'+r.id,refPatches(s,r,v));}
  // Apply corrections to the analysis view as well, while keeping original patch anchors.
  const effective=Analysis.analyze(effectiveParagraphs(s),refs,s.range);
  s.citations=base.citations.map(c=>{
    let pos=c.start;
    for(const patch of [...s.applied.values()].filter(p=>p.paragraph===c.paragraph&&p.start<c.start))pos+=patch.replacement.length-(patch.end-patch.start);
    const current=effective.citations.find(e=>e.paragraph===c.paragraph&&e.start===pos);
    return {...c,...(current?{reference:current.reference,candidate:current.candidate,context:current.context,sentence:current.sentence,year:current.year,issue:current.issue,text:current.text,authors:current.authors,authorText:current.authorText}:{}),effectiveId:current?.id||c.id,content:s.content[c.id]};
  });
  s.findings=effective.findings.map(f=>{
    if(f.citation){const c=s.citations.find(c=>c.effectiveId===f.citation);if(c){f.id=c.id;f.citation=c.id;f.patch=s.suggestions.get(c.id)?.[0];}}
    return f;
  });
  for(const c of s.citations){
    const selected=s.manualMappings?.get(c.id);
    if(selected){const ref=refs.find(r=>r.id===selected);
      if(ref){c.reference=ref.id;delete c.candidate;delete c.candidates;const patches=[];
        const original=base.citations.find(v=>v.id===c.id);
        if(c.year!==ref.year&&original&&!c.protected)patches.push({paragraph:c.paragraph,start:original.start,end:original.end,original:original.original,replacement:ref.year==='n.d.'?'t.y.':ref.year});
        const turkish=Analysis.isTurkish(s.paragraphs.find(p=>p.id===c.paragraph)?.text||'');
        const author=ref.authors.length>=3?ref.author+(turkish?' ve ark.':' et al.'):ref.authors.join(c.narrative?(turkish?' ve ':' and '):' & ');
        if(original&&!c.protected&&(s.mode==='word'?c.authorText!==author:c.authors[0]!==Engine.normalizeTitle(ref.author))){patches.push({paragraph:c.paragraph,start:original.authorStart,end:original.authorEnd,original:original.authorText,replacement:author});}
        s.findings=s.findings.filter(f=>f.citation!==c.id&&!(f.id==='orphan-'+ref.id));
        if(patches.length){c.issue='Seçtiğiniz kaynakla yazar/yıl uyuşmazlığı';s.suggestions.set(c.id,patches);s.findings.push({id:c.id,citation:c.id,paragraph:c.paragraph,location:c.location,type:c.issue,original:c.text,patch:patches[0],reference:ref.id});}
        else c.issue=c.protected?'Korunan alan; yalnız raporlama.':undefined;
      }
    }
    if(s.contextOverrides?.has(c.id)){c.context=s.contextOverrides.get(c.id);c.sentence=c.context.at(-1);}
  }
  s.findings=s.findings.filter(f=>!f.id.startsWith('orphan-'));
  const used=new Set(s.citations.flatMap(c=>[c.reference,...(c.candidates||[])]).filter(Boolean));
  for(const r of refs)if(!used.has(r.id))s.findings.push({id:'orphan-'+r.id,type:'Taranan metinde atıfı bulunmayan kaynak',reference:r.id,original:r.effectiveRaw});
  s.effectiveReferences=refs;
}
const sessions=new Map();
function dispose(s){clearTimeout(s.persistTimer);s.persistTimer=null;s.worker?.terminate();s.controller?.abort();sessions.delete(s.id);}
function persist(s){clearTimeout(s.persistTimer);s.persistTimer=null;s.updatedAt=Date.now();Store.save(s);}
// Debug events arrive in bursts; coalesce their archive writes instead of saving on every event.
function persistSoon(s){if(s.persistTimer||s.deleted)return;s.persistTimer=setTimeout(()=>{s.persistTimer=null;if(!s.deleted)persist(s);},1000);s.persistTimer.unref?.();}
function editable(s,p){return p.part==='word/document.xml'&&p.group===p.part&&!p.protected&&!p.paragraphLocked&&!(s.headings||[]).includes(p.index)&&!(p.index>=s.range.start&&p.index<=s.range.end)&&!s.references.some(r=>r.paragraphs.includes(p.id));}
function referenceDebug(s){return s.references.map((reference,index)=>{
  const result=reference.verification;if(!result?.pendingRetryAt&&!result?.fallbackNeeded&&!result?.debugRequests?.length)return null;
  return {index:index+1,id:reference.id,reference:String(reference.raw||'').slice(0,800),status:result.status,statusText:result.statusText,provider:result.provider,
    fallbackNeeded:!!result.fallbackNeeded,pendingRetryAt:result.pendingRetryAt||null,pendingProviders:(result.pendingProviders||[]).map(item=>({provider:item.provider,retryAt:item.retryAt})),
    sourcesChecked:result.sourcesChecked||[],warnings:result.warnings||[],debugRequests:(result.debugRequests||[]).map(item=>({provider:item.provider,status:item.status,url:item.url,requestUrl:item.requestUrl,detail:item.detail}))};
}).filter(Boolean);}
function safeEventUrl(value){try{const u=new URL(value);for(const key of ['key','api_key','access_token'])u.searchParams.delete(key);return u.href.slice(0,1200);}catch{return String(value||'').slice(0,1200);}}
function addDebugEvent(s,event){
  s.debugEvents||=[];const clean={id:randomUUID(),at:Number(event.at)||Date.now(),scope:event.scope==='groq'?'groq':'reference',kind:String(event.kind||'info').slice(0,30),provider:String(event.provider||'Sistem').slice(0,80)};
  for(const key of ['status','retryAt','index'])if(event[key]!==undefined&&event[key]!==null)clean[key]=Number(event[key])||event[key];
  for(const key of ['model','detail','citation','record','verdict','retryAfter','resetTokens','resetRequests','remainingTokens','remainingRequests'])if(event[key])clean[key]=String(event[key]).slice(0,key==='record'?500:240);
  if(event.url)clean.url=safeEventUrl(event.url);s.debugEvents.push(clean);if(s.debugEvents.length>200)s.debugEvents.splice(0,s.debugEvents.length-200);return clean;
}
function llmConfigured(){return !!process.env.GROQ_API_KEY||Content.openRouterEnabled();}
function snapshot(s){return {id:s.id,name:s.name,mode:s.mode||'word',checks:s.checks,checksStarted:s.checksStarted,revision:s.revision||0,createdAt:s.createdAt,updatedAt:s.updatedAt,pdfFiles:(s.pdfFiles||[]).map(({data,...v})=>v),range:s.range,paragraphs:effectiveParagraphs(s).map(p=>({id:p.id,index:p.index,text:p.text,part:p.part,protected:p.protected,editable:editable(s,p)})),warnings:s.warnings,references:(s.effectiveReferences||s.references).map(r=>({...r,pdf:s.texts[r.id]?{preview:s.texts[r.id].preview,needsConfirmation:s.texts[r.id].needsConfirmation,versionNotice:Content.preprintNotice(s.texts[r.id]),access:s.texts[r.id].access}:null})),citations:s.citations||[],findings:s.mode==='content'&&s.checks?.citations===false?[]:s.findings||[],job:s.job,referenceJob:s.referenceJob,debugEvents:s.debugEvents||[],applied:[...s.appliedGroups].map(([id,patches])=>({id,before:patches.map(p=>p.original).join(' '),after:patches.map(p=>p.replacement).join(' ')})),content:s.content,groqConfigured:llmConfigured(),openrouterConfigured:Content.openRouterEnabled()};}
function startVerification(s,port,after,scope){
  if(s.job.running)throw Error('Önce devam eden işlemi durdurun.');
  s.worker?.terminate();s.followupContent=false;s.autoContentScope=after?(scope||{}):null;
  const seen=new Set();let released=false,newReady=false;
  s.referenceJob={running:true,pending:0,completed:0,total:s.references.length};
  s.job={running:true,kind:'references',message:'Kaynaklar doğrulanıyor',completed:0,total:s.references.length};
  addDebugEvent(s,{scope:'reference',kind:'start',provider:'Kaynak doğrulama',detail:`${s.references.length} kayıt sıraya alındı`});
  const worker=new Worker(path.join(__dirname,'scripts/word-verify-worker.cjs'),{workerData:{proxy:`http://127.0.0.1:${port}/api/proxy`,references:s.references.map(r=>r.raw),initialResults:s.references.map(r=>r.verification),googleBooksConfigured:!!process.env.GOOGLE_BOOKS_API_KEY}});s.worker=worker;
  const content=()=>{if(!after&&!s.autoContentScope)return;if(s.job.running){s.followupContent=true;return;}startContent(s,s.autoContentScope||scope).catch(e=>{s.job={running:false,message:e.message};persist(s);});};
  worker.on('message',m=>{
    if(s.worker!==worker)return;
    if(m.type==='debug'){const r=s.references[m.event.index];addDebugEvent(s,{...m.event,index:m.event.index+1,record:r?.raw});persistSoon(s);return;}
    if(m.type==='result'){
      const r=s.references[m.index],old=r.verification,suffix=r.year.match(/[a-z]$/)?.[0];
      if(suffix&&m.result.matched?.year)for(const key of ['suggested','suggestedHtml','corrected','correctedHtml'])if(m.result[key])m.result[key]=m.result[key].replace(`(${m.result.matched.year})`,`(${m.result.matched.year}${suffix})`);
      r.verification=m.result;seen.add(m.index);if(m.result.status==='verified'&&old?.status!=='verified')newReady=true;
      if(JSON.stringify(old?.matched)!==JSON.stringify(m.result.matched)||old?.status!==m.result.status)for(const c of s.citations)if(c.reference===r.id)delete s.content[c.id];
      s.referenceJob.seen=seen.size;s.referenceJob.completed=[...seen].filter(i=>!s.references[i].verification?.pendingRetryAt&&!s.references[i].verification?.fallbackNeeded).length;s.referenceJob.debug=referenceDebug(s);
      if(!released){s.job.completed=s.referenceJob.completed;s.job.message=`Kaynak ${m.index+1} sorgulandı; ${seen.size}/${s.references.length} kayda bakıldı`;delete s.job.retryAt;}
      rebuild(s);
      addDebugEvent(s,{scope:'reference',kind:'result',provider:m.result.provider||'Kaynak doğrulama',index:m.index+1,status:m.result.status,detail:m.result.statusText,record:r.raw});persist(s);
    }
    if(m.type==='wait'){s.referenceJob.retryAt=m.retryAt;s.referenceJob.provider=m.provider;s.referenceJob.lastWait={provider:m.provider,retryAt:m.retryAt,receivedAt:Date.now()};s.referenceJob.debug=referenceDebug(s);if(!released){s.job.message=m.provider+' kotası bekleniyor; otomatik devam edilecek';s.job.retryAt=m.retryAt;}addDebugEvent(s,{scope:'reference',kind:'wait',provider:m.provider,index:m.index+1,retryAt:m.retryAt,record:s.references[m.index]?.raw});persistSoon(s);}
    if(m.type==='ready'){
      const runContent=!released||newReady;newReady=false;
      s.referenceJob={...s.referenceJob,pending:m.pending,completed:m.completed,retryAt:m.retryAt,debug:referenceDebug(s)};
      if(!released){released=true;s.job={running:false,kind:'references',completed:m.completed,total:s.references.length,message:`${m.completed} kaynak kontrol edildi; ${m.pending} kaynak kota nedeniyle arka planda yeniden denenecek. Hazır kaynaklarla içerik kontrolünü başlatabilirsiniz.`};}
      persist(s);if(runContent)content();
    }
    if(m.type==='done'||m.type==='error'){
      s.referenceJob={...s.referenceJob,running:false,pending:0,retryAt:null};s.worker=null;worker.terminate();
      if(!s.job.running||s.job.kind==='references')s.job={running:false,kind:'references',completed:m.type==='done'?s.references.length:s.referenceJob.completed,total:s.references.length,message:m.message||'Kaynak doğrulama tamamlandı'};
      persist(s);if(m.type==='done')content();
    }
  });
  worker.on('error',()=>{if(s.worker!==worker)return;s.referenceJob.running=false;if(s.job.kind==='references')s.job={...s.job,running:false,message:'Kaynak işçisi başlatılamadı.'};s.worker=null;persist(s);});
  worker.on('exit',()=>{if(s.worker===worker){s.referenceJob.running=false;if(s.job.kind==='references')s.job={...s.job,running:false,message:'Kaynak işçisi durdu; yeniden başlatabilirsiniz.'};s.worker=null;persist(s);}});
}
function scopedCitations(s,scope={}){
  return (s.citations||[]).filter(c=>(!scope.paragraph||c.paragraph===scope.paragraph)&&(!scope.citation||c.id===scope.citation)&&(!scope.matchedOnly||!!c.reference&&!c.issue)&&(!scope.pendingOnly||!s.content?.[c.id]));
}
function scopeNeedsVerification(s,scope={}){
  if(s.checks?.references===false)return false;
  return scopedCitations(s,scope).some(c=>{
    const ref=(s.effectiveReferences||s.references||[]).find(r=>r.id===c.reference);
    if(!ref)return false;
    const url=Content.referenceUrl(ref),directWeb=!!url&&!/^https:\/\/(?:dx\.)?doi\.org\//i.test(url);
    return ref.verification?.status!=='verified'&&!ref.accepted&&!s.manualConfirmed.has(ref.id)&&!directWeb;
  });
}
async function startContent(s,scope={}){
  if(s.job.running)throw Error('Önce devam eden işlemi durdurun.');
  if(!llmConfigured())throw Error('Etkin bir GROQ_API_KEY veya OPENROUTER_API_KEY yapılandırılmamış.');
  s.autoContentScope=scope;const controller=new AbortController();s.controller=controller;const signal=controller.signal;
  s.job={running:true,kind:'content',message:'Yayın metinleri ediniliyor',completed:0,total:scopedCitations(s,scope).length};
  addDebugEvent(s,{scope:'groq',kind:'start',provider:'Groq',detail:`${s.job.total} atıf sıraya alındı`});persist(s);
  const done=c=>s.content[c.id]?.analysisVersion===2&&s.content[c.id].verdict!=='unassessable';
  const ready=ref=>ref&&(ref.verification?.status==='verified'||ref.accepted||s.manualConfirmed.has(ref.id)||Content.referenceUrl(ref));
  // One acquisition per reference and run; the next publication downloads while the LLM evaluates the current one.
  const fetches=new Map();
  const acquire=(ref,c)=>{if(!fetches.has(ref.id)){const pending=Content.fullText(ref,python,signal,{onDebug:event=>{addDebugEvent(s,{...event,citation:c.location,record:ref.raw});persistSoon(s);}}).then(text=>{
    const expectedTitle=Content.referenceTitle(ref);if(text.title&&expectedTitle&&Engine.titleScore(expectedTitle,text.title)<.65)throw Error('Erişilen yayının başlığı kaynakla uyuşmuyor.');return text;});
    pending.catch(()=>{});fetches.set(ref.id,pending);}return fetches.get(ref.id);};
  const prefetch=(list,from)=>{for(let j=from;j<list.length;j++){const next=list[j];if(done(next)||(next.issue&&!/^Korunan alan|^Alan kodu\/korunan öğe/.test(next.issue)))continue;const ref=s.effectiveReferences.find(r=>r.id===next.reference);
    if(!ready(ref)||s.texts[ref.id]||fetches.has(ref.id))continue;acquire(ref,next);return;}};
  const run=async()=>{
    const list=scopedCitations(s,scope);
    for(let i=0;i<list.length;i++){const c=list[i];
      signal.throwIfAborted();
      if(done(c)){s.job.completed++;continue;}
      const ref=s.effectiveReferences.find(r=>r.id===c.reference);
      try{
        if(!ref||(c.issue&&!/^Korunan alan|^Alan kodu\/korunan öğe/.test(c.issue)))throw Error('Önce atıf eşleşmesini/uyuşmazlığını çözün.');
        if(!ready(ref))throw Error('Kaynak kimliği doğrulanmadı; eşleşmeyi inceleyip kabul edin.');
        let text=s.texts[ref.id];
        if(!text){s.job.message=`${c.location}: tam metin aranıyor`;text=await acquire(ref,c);s.texts[ref.id]=text;}
        if(text.needsConfirmation){const notice=Content.preprintNotice(text);throw Error('PDF’nin yayın kimliğini ve sürümünü önizleyip kabul edin.'+(notice?' PDF sürüm beyanı: “'+notice+'”':''));}
        s.job.message=`${c.location}: LLM ile karşılaştırılıyor`;prefetch(list,i+1);
        s.content[c.id]=await Content.evaluate(c,text,signal,at=>{s.job.message='LLM hız/kota beklemesi; otomatik devam edilecek';s.job.retryAt=at;},event=>{addDebugEvent(s,{...event,citation:c.location,record:c.sentence});persistSoon(s);});
      }catch(e){if(signal.aborted)throw e;s.content[c.id]={verdict:'unassessable',explanation:e.message,claims:[]};}
      s.job.completed++;delete s.job.retryAt;rebuild(s);persist(s);
    }
    if(s.controller===controller){s.job.running=false;s.job.message='İçerik denetimi tamamlandı';s.controller=null;persist(s);if(s.followupContent){s.followupContent=false;startContent(s,scope).catch(()=>{});}}
  };
  run().catch(()=>{if(s.controller===controller){s.job.running=false;s.job.message='İçerik denetimi durduruldu';s.controller=null;persist(s);}});
}
function removeApplied(s,id){const group=s.appliedGroups.get(id);if(group)for(const patch of group)s.applied.delete(patch._key);s.appliedGroups.delete(id);}
async function saveParagraph(s,input){
  if(s.job.running)throw Error('Düzenlemek için devam eden denetimi durdurun.');
  if(input.revision!==(s.revision||0))throw Error('Belge başka bir pencerede değişti; yeniden açın.');
  const p=s.paragraphs.find(p=>p.id===input.paragraph);
  if(!p||!editable(s,p))throw Error('Yalnız ana metindeki düzenlenebilir paragraflar değiştirilebilir.');
  if(typeof input.text!=='string'||input.text.length>20000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.text))throw Error('Paragraf metni geçersiz veya çok uzun.');
  s.mutation=true;
  try{
    const old=new Map(s.citations.map(c=>[c.id,JSON.stringify([c.sentence,c.context,c.reference,c.issue])]));
    const output=await python({operation:'export',data:s.data.toString('base64'),patches:[{paragraph:p.id,start:0,end:p.text.length,original:p.text,replacement:input.text,whole:true,paragraphEdit:true}]});
    const inspected=await python({operation:'inspect',data:output.data});
    for(const [id,patches] of s.appliedGroups)if(patches.some(v=>v.paragraph===p.id))removeApplied(s,id);
    // Preserve confirmed publication identities when paragraph edits move citation offsets.
    const identity=c=>JSON.stringify([c.authors,c.year]);
    const prior=s.citations.filter(c=>c.paragraph===p.id);
    const accepted=new Map();
    for(const c of prior){const key=identity(c);if(!accepted.has(key))accepted.set(key,[]);accepted.get(key).push(s.manualMappings.get(c.id)||null);s.manualMappings.delete(c.id);s.contextOverrides.delete(c.id);}
    const updated=Analysis.citationsIn(inspected.paragraphs.find(x=>x.id===p.id),s.effectiveReferences||s.references);
    for(const c of updated){const ref=accepted.get(identity(c))?.shift();if(ref)s.manualMappings.set(c.id,ref);}
    s.data=Buffer.from(output.data,'base64');s.paragraphs=inspected.paragraphs;s.revision=(s.revision||0)+1;
    rebuild(s);
    const valid={};for(const c of s.citations)if(c.paragraph!==p.id&&old.get(c.id)===JSON.stringify([c.sentence,c.context,c.reference,c.issue])&&s.content[c.id])valid[c.id]=s.content[c.id];
    s.content=valid;rebuild(s);s.job.message='Paragraf kaydedildi; etkilenen atıflar yeniden kontrol edilmeli.';
  }finally{s.mutation=false;}
}
function applyGroup(s,id){
  const patches=s.suggestions.get(id);if(!patches)throw Error('Düzeltme önerisi bulunamadı.');
  for(const p of patches){
    const source=s.paragraphs.find(v=>v.id===p.paragraph);if(source.protected||source.text.slice(p.start,p.end)!==p.original)throw Error('Düzeltme konumu geçersiz veya korunuyor.');
    if([...s.applied.values()].some(a=>a.paragraph===p.paragraph&&a.start<p.end&&p.start<a.end))throw Error('Örtüşen düzeltmeyi önce geri alın.');
  }
  const group=patches.map((p,i)=>({...p,_key:id+':'+i}));for(const p of group)s.applied.set(p._key,p);s.appliedGroups.set(id,group);
}
async function handle(req,res,url,json){
  if(!url.pathname.startsWith('/api/word'))return false;
  try{
    if(req.method!=='GET'&&req.headers['x-word-request']!=='1')return json(res,403,{error:'Yerel uygulama isteği gerekli.'}),true;
    if(url.pathname==='/api/word/upload'&&req.method==='POST'){

      const input=await body(req);if(!/\.docx$/i.test(input.name||''))throw Error('Yalnız .docx desteklenir; .doc/.docm dosyasını Word’de .docx olarak kaydedin.');
      const data=decode(input.data);const result=await python({operation:'inspect',data:data.toString('base64')});
      const extracted=Analysis.extractReferences(result.paragraphs);
      const s={id:randomUUID(),name:path.basename(input.name).slice(0,150),mode:input.mode==='content'?'content':'word',createdAt:Date.now(),revision:0,originalData:data,pdfFiles:[],data,paragraphs:result.paragraphs,warnings:result.warnings,...extracted,touched:Date.now(),applied:new Map(),appliedGroups:new Map(),manualConfirmed:new Set(),manualMappings:new Map(),contextOverrides:new Map(),content:{},texts:{},debugEvents:[],job:{running:false,message:extracted.needsRange?'Kaynakça sınırlarını seçin.':'Belge alındı; atıf eşleştirmesi hazır.'}};
      if(s.mode==='content'){s.checks={references:input.checks?.references!==false,citations:input.checks?.citations!==false,llm:input.checks?.llm!==false};s.checksStarted=false;}if(!extracted.needsRange)rebuild(s);sessions.set(s.id,s);persist(s);json(res,200,snapshot(s));return true;
    }
    if(url.pathname==='/api/word/documents'&&req.method==='GET'){json(res,200,{documents:Store.list().map(d=>sessions.has(d.id)?{...d,job:sessions.get(d.id).job}:{...d,job:{...d.job,running:false}})});return true;}
    const match=url.pathname.match(/^\/api\/word\/([a-f0-9-]{36})(?:\/(\w+))?$/);if(!match)return json(res,404,{error:'İşlem bulunamadı.'}),true;
    let s=sessions.get(match[1]);if(!s){s=Store.load(match[1]);if(s){rebuild(s);sessions.set(s.id,s);}}if(!s)return json(res,404,{error:'Belge oturumu sona erdi; yeniden yükleyin.'}),true;s.touched=Date.now();const action=match[2]||'state';
    if(req.method==='GET'&&action==='state'){const body=JSON.stringify(snapshot(s)),tag='"'+createHash('sha1').update(body).digest('base64url')+'"';
      if(req.headers['if-none-match']===tag){res.writeHead(304,{ETag:tag,'Cache-Control':'no-cache'});res.end();return true;}
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff',ETag:tag});res.end(body);return true;}
    if(req.method==='DELETE'){if(s.mutation)throw Error('Kayıt sürüyor; bitmesini bekleyin.');s.deleted=true;dispose(s);Store.remove(s.id);json(res,200,{deleted:true});return true;}
    if(req.method==='GET'&&action==='original'){res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','Content-Disposition':'attachment; filename=original.docx'});res.end(s.originalData||s.data);return true;}
    if(req.method==='GET'&&action==='pdfdownload'){const pdf=(s.pdfFiles||[]).find(p=>p.id===url.searchParams.get('file'));if(!pdf)throw Error('PDF bulunamadı.');res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename=source.pdf'});res.end(Buffer.from(pdf.data,'base64'));return true;}
    if(req.method==='GET'&&action==='download'){
      const out=await python({operation:'export',data:s.data.toString('base64'),patches:[...s.applied.values()]});
      res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','Content-Disposition':'attachment; filename="makale_duzeltilmis.docx"','Cache-Control':'no-store'});res.end(Buffer.from(out.data,'base64'));return true;
    }
    if(req.method!=='POST')return json(res,405,{error:'Desteklenmeyen işlem.'}),true;
    const input=await body(req);
    if(s.mutation)throw Error('Belge kaydediliyor; tekrar deneyin.');
    if(action==='paragraph'){await saveParagraph(s,input);persist(s);json(res,200,snapshot(s));return true;}
    if(action==='stop'){s.followupContent=false;s.autoContentScope=null;if(s.referenceJob)s.referenceJob.running=false;s.worker?.terminate();s.worker=null;s.controller?.abort();s.controller=null;s.job.running=false;s.job.message='İşlem durduruldu; tekrar başlatabilirsiniz.';delete s.job.retryAt;}
    else if(action==='range'){
      s.worker?.terminate();s.worker=null;if(s.referenceJob)s.referenceJob.running=false;
      if(s.job.running)throw Error('Önce işlemi durdurun.');
      const start=Number(input.start),end=Number(input.end);if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||end>=s.paragraphs.filter(p=>p.part==='word/document.xml').length)throw Error('Kaynakça sınırları geçersiz.');
      const extracted=Analysis.extractReferences(s.paragraphs,{start,end});s.range=extracted.range;s.references=extracted.references;s.applied.clear();s.appliedGroups.clear();s.texts={};s.content={};s.manualConfirmed.clear();rebuild(s);
      s.manualMappings.clear();s.contextOverrides.clear();rebuild(s);
    }
    else if(action==='group'){
      s.worker?.terminate();s.worker=null;if(s.referenceJob)s.referenceJob.running=false;
      if(s.job.running)throw Error('Önce denetimi durdurun.');const index=s.references.findIndex(r=>r.id===input.reference);if(index<0)throw Error('Kaynak bulunamadı.');
      const ref=s.references[index];let replacements;
      if(input.mode==='merge'){
        const next=s.references[index+1];if(!next)throw Error('Sonraki kaynak bulunamadı.');
        replacements=[{raw:ref.raw+' '+next.raw,paragraphs:[...ref.paragraphs,...next.paragraphs],protected:ref.protected||next.protected}];s.references.splice(index,2,...replacements);
      }else if(input.mode==='split'){
        if(ref.paragraphs.length<2)throw Error('Bu kayıt tek paragraf; Word’de kayıtları ayrı paragraflara ayırın.');
        replacements=ref.paragraphs.map(id=>{const p=s.paragraphs.find(p=>p.id===id);return {raw:p.text.trim(),paragraphs:[id],protected:p.protected};});s.references.splice(index,1,...replacements);
      }else throw Error('Kayıt ayırma işlemi geçersiz.');
      s.references=s.references.map((r,i)=>({id:'r'+i,raw:r.raw,paragraphs:r.paragraphs,protected:r.protected,...Analysis.referenceIdentity(r.raw)}));
      s.applied.clear();s.appliedGroups.clear();s.content={};s.texts={};s.manualMappings.clear();s.contextOverrides.clear();s.manualConfirmed.clear();rebuild(s);
    }
    else if(action==='runchecks'){
      if(s.job.running||s.referenceJob?.running)throw Error('Önce devam eden denetimi durdurun.');
      const checks={references:input.checks?.references===true,citations:input.checks?.citations===true,llm:input.checks?.llm===true};
      if(!Object.values(checks).some(Boolean))throw Error('En az bir denetim seçin.');
      if(checks.llm&&!llmConfigured())throw Error('LLM API anahtarı yapılandırılmamış.');
      s.checks=checks;s.checksStarted=true;rebuild(s);
      if(checks.references)startVerification(s,req.socket.localPort,checks.llm);
      else if(checks.llm)await startContent(s,{});
      else s.job={running:false,kind:'citations',message:'Metin içi atıf kontrolü tamamlandı',completed:s.citations.length,total:s.citations.length};
    }
    else if(action==='verify'){if(!s.references.length)throw Error('Önce kaynakça bölümünü seçin.');startVerification(s,req.socket.localPort);}
    else if(action==='content'||action==='check'){if(!s.references.length)throw Error('Önce kaynakça bölümünü seçin.');if(action==='check'){if(!llmConfigured())throw Error('Etkin bir GROQ_API_KEY veya OPENROUTER_API_KEY yapılandırılmamış.');if(s.checks?.references!==false&&!s.worker&&scopeNeedsVerification(s,input))startVerification(s,req.socket.localPort,true,input);else await startContent(s,input);}else await startContent(s,input);}
    else if(action==='apply'||action==='undo'||action==='applymany'){
      if(s.job.running)throw Error('Düzeltmeden önce denetimi durdurun.');
      const oldApplied=new Map(s.applied),oldGroups=new Map(s.appliedGroups);
      if(action==='undo')removeApplied(s,input.id);
      else if(action==='applymany'){
        if(!Array.isArray(input.ids)||!input.ids.length||input.ids.length>1000)throw Error('Düzeltme seçimi geçersiz.');
        try{for(const id of input.ids)applyGroup(s,id);}catch(e){s.applied=oldApplied;s.appliedGroups=oldGroups;throw e;}
      }else applyGroup(s,input.id);
      // Verify the actual OOXML edit before accepting the patch.
      try{await python({operation:'export',data:s.data.toString('base64'),patches:[...s.applied.values()]});}catch(e){s.applied=oldApplied;s.appliedGroups=oldGroups;throw e;}
      s.content={};rebuild(s);
    }
    else if(action==='match'||action==='context'){
      if(s.job.running)throw Error('Önce denetimi durdurun.');const c=s.citations.find(c=>c.id===input.citation);if(!c)throw Error('Atıf bulunamadı.');
      if(action==='match'){
        const ref=s.references.find(r=>r.id===input.reference);if(!ref)throw Error('Kaynak bulunamadı.');
        const same=x=>x.year===c.year&&JSON.stringify(x.authors)===JSON.stringify(c.authors);
        const targets=[c,...(input.applySimilar===true&&s.mode==='word'?s.citations.filter(x=>x.id!==c.id&&x.issue&&!x.protected&&same(x)):[])];
        const previous={applied:new Map(s.applied),appliedGroups:new Map(s.appliedGroups),manualMappings:new Map(s.manualMappings),manualConfirmed:new Set(s.manualConfirmed),contextOverrides:new Map(s.contextOverrides),content:{...s.content}};
        try{
          for(const target of targets){s.manualMappings.set(target.id,ref.id);s.contextOverrides.delete(target.id);delete s.content[target.id];}
          s.manualConfirmed.add(ref.id);rebuild(s);
          if(s.mode==='word')for(const target of targets)if(s.suggestions.has(target.id)){removeApplied(s,target.id);applyGroup(s,target.id);}
          await python({operation:'export',data:s.data.toString('base64'),patches:[...s.applied.values()]});
          rebuild(s);
        }catch(error){Object.assign(s,previous);rebuild(s);throw error;}
      }else {
        if(typeof input.text!=='string'||input.text.length>8000)throw Error('Bağlam en fazla 8000 karakter olabilir.');
        const context=Analysis.sentences(input.text).map(s=>s.text);if(!context.length||context.length>4)throw Error('Bağlam bir ila dört cümle olmalıdır; son cümle atıf cümlesidir.');
        s.contextOverrides.set(c.id,context);delete s.content[c.id];rebuild(s);
      }
      if(action==='context'){if(!s.worker&&scopeNeedsVerification(s,{citation:c.id}))startVerification(s,req.socket.localPort,true,{citation:c.id});else await startContent(s,{citation:c.id});}
    }
    else if(action==='confirm'){
      if(s.job.running)throw Error('Önce denetimi durdurun.');
      const ref=s.references.find(r=>r.id===input.reference);if(!ref)throw Error('Kaynak bulunamadı.');
      s.manualConfirmed.add(ref.id);if(s.texts[ref.id])s.texts[ref.id].needsConfirmation=false;
      if(input.citation){const citation=s.citations.find(c=>c.id===input.citation&&c.reference===ref.id);if(!citation)throw Error('Atıf ve kaynak eşleşmesi bulunamadı.');delete s.content[citation.id];rebuild(s);await startContent(s,{citation:citation.id});}else rebuild(s);
    }
    else if(action==='pdf'){
      if(s.job.running)throw Error('Önce denetimi durdurun.');const ref=s.references.find(r=>r.id===input.reference);if(!ref)throw Error('Kaynak bulunamadı.');
      const pdf=decode(input.data);if(!pdf.subarray(0,5).equals(Buffer.from('%PDF-')))throw Error('Geçerli PDF değil.');
      const parsed=await python({operation:'pdf',data:pdf.toString('base64')});
      s.pdfFiles||=[];s.pdfFiles.push({id:randomUUID(),reference:ref.id,name:path.basename(input.name||'kaynak.pdf'),createdAt:Date.now(),data:pdf.toString('base64')});
      const first=parsed.passages.slice(0,2).map(p=>p.text).join(' ');const doi=ref.verification?.matched?.doi||Engine.getDoi(ref.raw);
      const doiMatches=doi&&first.toLowerCase().includes(doi.toLowerCase());
      s.texts[ref.id]={...parsed,identity:doi||ref.title,title:ref.title,access:'Kullanıcı PDF’si',needsConfirmation:!doiMatches,preview:first.slice(0,2500),license:'Kullanıcının sağladığı yayın; lisans doğrulanmadı.'};
      for(const c of s.citations)if(c.reference===ref.id)delete s.content[c.id];rebuild(s);
      persist(s);json(res,200,{...snapshot(s),pdfPreview:{reference:ref.id,text:first.slice(0,2500),needsConfirmation:!doiMatches}});return true;
    }
    else throw Error('İşlem bulunamadı.');
    persist(s);json(res,200,snapshot(s));return true;
  }catch(e){json(res,400,{error:e.message||'Word işlemi tamamlanamadı.'});return true;}
}
module.exports={handle,startVerification,python,spans,applyGroup,rebuild,decode,sessions,dispose,scopedCitations,scopeNeedsVerification};
