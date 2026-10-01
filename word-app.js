function createWordWorkspace(prefix,mode) {
  const $=id=>document.getElementById(prefix+'-'+id);
  let state=null,stateTag=null,poll=null,busy=false,autoStarting=false,filter='all',view='issues',query='',debugHiddenBefore=0,stateEpoch=0;
  let inspectedCitation=null;
  const selected=new Set(),drawers=new Set(),drafts=new Map();
  const isContent=mode==='content';
  if(isContent)view='evidence';
  if(!isContent){
    $('inspection-close')?.addEventListener('click',()=>$('inspection').close());
    $('inspection')?.addEventListener('close',()=>{inspectedCitation=null;});
  }
  const selectedChecks=()=>Object.fromEntries(['references','citations','llm'].map(key=>[key,$('check-'+key)?.checked!==false]));
  if(isContent)$('runchecks')?.addEventListener('click',()=>action('runchecks',{checks:selectedChecks()}));
  const paragraphDrafts=new Map();let saveTimer,saveTask=null;
  const remember=()=>{if(typeof localStorage!=='undefined'&&state)localStorage.setItem(prefix+'-last-document',state.id);};
  async function library(){
    try{const response=await fetch('/api/word/documents');if(!response.ok)throw Error('Belge listesi alınamadı.');const data=await response.json();
      $('library').innerHTML=(data.documents||[]).filter(d=>d.mode===mode).map(d=>`<article class="library-row"><button type="button" class="word-inline-button" data-open-document="${esc(d.id)}">${esc(d.name)}</button><small>Yüklendi: ${esc(new Date(d.createdAt).toLocaleString('tr-TR'))} · Son kayıt: ${esc(new Date(d.updatedAt).toLocaleString('tr-TR'))}</small><p>${esc(d.job?.message||'Hazır')}</p><a href="/api/word/${esc(d.id)}/original">Özgün Word</a>${(d.pdfs||[]).map(p=>`<a href="/api/word/${esc(d.id)}/pdfdownload?file=${encodeURIComponent(p.id)}">${esc(p.name)}</a>`).join('')}</article>`).join('')||'<p>Henüz belge yüklenmedi.</p>';
    }catch(e){const libraryElement=$('library');if(libraryElement)libraryElement.textContent=e.message;}
  }
  function editor(){
    if(!isContent)return;
    const editorElement=$('editor');
    if(!editorElement)return;
    paragraphDrafts.clear();clearTimeout(saveTimer);
    editorElement.innerHTML=state.paragraphs.filter(p=>p.part==='word/document.xml'&&p.text.trim()).map(p=>`<article id="${prefix}-editor-${esc(p.id)}" class="editor-paragraph"><label><span>Paragraf ${p.index+1} ${p.editable?'':'· salt okunur'}</span><textarea data-paragraph="${esc(p.id)}" rows="4" ${p.editable?'':'readonly'}>${esc(p.text)}</textarea></label>${p.editable?`<button type="button" class="word-inline-button" data-recheck="${esc(p.id)}">Bu paragrafı yeniden kontrol et</button>`:''}</article>`).join('');
    if($('save-status'))$('save-status').textContent='Kaydedildi';
  }
  async function flush(){
    clearTimeout(saveTimer);if(!isContent)return;
    if(saveTask){await saveTask;if(paragraphDrafts.size)return flush();return;}
    saveTask=(async()=>{
      while(paragraphDrafts.size){
        if(state.job.running)throw Error('Paragrafı kaydetmek için denetimi durdurun.');
        const [id,text]=paragraphDrafts.entries().next().value;if($('save-status'))$('save-status').textContent='Kaydediliyor…';
        state=await api('paragraph',{paragraph:id,text,revision:state.revision||0});
        if(paragraphDrafts.get(id)===text)paragraphDrafts.delete(id);
        render();
      }
      if($('save-status'))$('save-status').textContent='Kaydedildi · '+new Date().toLocaleTimeString('tr-TR');
    })();
    try{await saveTask;}catch(e){if($('save-status'))$('save-status').textContent='Kaydedilemedi: '+e.message;throw e;}finally{saveTask=null;}
    await library();
  }
  if(isContent){
    const editorElement=$('editor');
    editorElement?.addEventListener('input',e=>{const id=e.target.dataset.paragraph;if(!id)return;paragraphDrafts.set(id,e.target.value);if($('save-status'))$('save-status').textContent='Kaydedilmemiş değişiklik';clearTimeout(saveTimer);saveTimer=setTimeout(()=>flush().catch(()=>{}),1200);});
    $('save')?.addEventListener('click',()=>flush().catch(e=>notify(e.message)));
    editorElement?.addEventListener('click',e=>{const b=e.target.closest('[data-recheck]');if(b)action('check',{paragraph:b.dataset.recheck});});
    if(typeof window!=='undefined')window.addEventListener('beforeunload',e=>{if(paragraphDrafts.size||saveTask){e.preventDefault();e.returnValue='';}});
  }
  $('library').addEventListener('click',async e=>{const b=e.target.closest('[data-open-document]');if(!b||busy)return;const epoch=++stateEpoch;try{await flush();busy=true;clearTimeout(poll);const response=await fetch('/api/word/'+b.dataset.openDocument);const next=await response.json();if(!response.ok)throw Error(next.error);if(epoch!==stateEpoch)return;state=next;remember();initialize();}catch(e){if(epoch===stateEpoch)notify(e.message);}finally{if(epoch===stateEpoch){busy=false;if(state)render();}}});
  const views={issues:'Atıf sorunları','orphan-citations':'Yetim atıflar','orphan-references':'Yetim kaynakça',evidence:'Atıflar ve içerik kanıtları',references:'Kaynakça kayıtları'};
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  const verdicts={supported:'Destekleniyor',partial:'Kısmen destekleniyor',contradicted:'Çelişiyor',not_found:'İncelenen pasajlarda destek bulunamadı',unassessable:'Değerlendirilemedi'};
  const referenceFilters={all:'tümü',verified:'doğrulandı',correction:'doğrulandı – düzeltme gerekli',review:'incelenmeli',failed:'bulunamadı',error:'servis hatası',pending:'bekliyor'};
  const citationText=value=>String(value||'').normalize('NFC').replace(/\s+/g,' ').trim();
  function referenceComparison(r){
    const original=citationText(r.raw),suggested=citationText(r.verification?.suggested);
    if(!suggested)return {different:false,score:null};
    if(original===suggested)return {different:false,score:100};
    const pairs=new Map();for(let i=0;i<original.length-1;i++){const key=original.slice(i,i+2);pairs.set(key,(pairs.get(key)||0)+1);}
    let overlap=0;for(let i=0;i<suggested.length-1;i++){const key=suggested.slice(i,i+2),count=pairs.get(key)||0;if(count){overlap++;pairs.set(key,count-1);}}
    return {different:true,score:Math.min(99,Math.round(200*overlap/Math.max(1,original.length+suggested.length-2)))};
  }
  function referenceMarkup(v){
    // Only formatting produced by the bibliography formatter is allowed as markup.
    const html=String(v.suggestedHtml||'');
    if(!html)return esc(v.suggested);
    return html.split(/(<\/?em>)/g).map(part=>part==='<em>'||part==='</em>'?part:esc(part.replace(/&(?:amp|lt|gt|quot|#039);/g,x=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#039;':"'"}[x])))).join('');
  }
  function referenceStatus(r){return r.verification?.status==='verified'&&!r.accepted&&referenceComparison(r).different?'correction':r.verification?.status||'pending';}
  let referenceFilter='all';
  async function encoded(file){if(file.size>20*1024*1024)throw Error('Dosya en fazla 20 MB olabilir.');const bytes=new Uint8Array(await file.arrayBuffer());let value='';for(let i=0;i<bytes.length;i+=32768)value+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(value);}
  function notify(message){const messageElement=$('message');if(messageElement)messageElement.textContent=message;}
  async function api(action,data={},method='POST'){
    // State polls revalidate with ETag; an unchanged document returns 304 and skips the re-render.
    const statePoll=method==='GET'&&!action,cached=statePoll&&stateTag?.id===state?.id?stateTag.value:'';if(!statePoll)stateTag=null;
    const response=await fetch('/api/word/'+(action==='upload'?'upload':state.id+(action?'/'+action:'')),{method,headers:{'Content-Type':'application/json','X-Word-Request':'1',...(cached?{'If-None-Match':cached}:{})},...(method==='GET'||method==='DELETE'?{}:{body:JSON.stringify(data)})});
    if(statePoll&&response.status===304)return null;
    const result=await response.json();if(!response.ok)throw Error(result.error||'İşlem tamamlanamadı.');
    if(statePoll){const tag=response.headers?.get?.('ETag');stateTag=tag?{id:result.id,value:tag}:null;}return result;
  }
  function pendingMatchedCitations(){return isContent&&state?.groqConfigured&&state?.range?.start>=0?(state.citations||[]).filter(c=>c.reference&&!c.issue&&!c.content):[];}
  function maybeAutoContent(){
    if(state?.checks&&(state.checksStarted!==true||!state.checks.llm)||busy||autoStarting||state?.job?.running||state?.referenceJob?.running||!pendingMatchedCitations().length)return;
    autoStarting=true;setTimeout(()=>action('check',{matchedOnly:true,pendingOnly:true}).finally(()=>{autoStarting=false;}),0);
  }
  function schedule(){clearTimeout(poll);if(state?.job.running||state?.referenceJob?.running){const id=state.id;poll=setTimeout(async()=>{try{const next=await api('',{},'GET');if(state?.id!==id)return;if(next){state=next;render();}else renderProgress();schedule();if(!state.job.running&&!state.referenceJob?.running){library();maybeAutoContent();}}catch(e){if(state?.id===id)notify(e.message);}},1500);}else maybeAutoContent();}
  function button(action,id,label){return `<button class="copy-button" type="button" data-action="${action}" data-id="${esc(id)}" ${busy||state.job.running?'disabled':''}>${label}</button>`;}
  function location(c){return `<a class="word-location" href="#${prefix}-p-${esc(c.paragraph)}" data-show="${esc(c.paragraph)}">${esc(c.location||'Belgede göster')}</a>`;}
  function groupFindings(){return {
    issues:state.findings.filter(f=>!f.id.startsWith('orphan-')&&!f.type.startsWith('Kaynakçası olmayan atıf')),
    'orphan-citations':state.findings.filter(f=>f.type.startsWith('Kaynakçası olmayan atıf')),
    'orphan-references':state.findings.filter(f=>f.id.startsWith('orphan-')),
  };}
  function matches(...values){return !query||values.filter(Boolean).join(' ').toLocaleLowerCase('tr-TR').includes(query.toLocaleLowerCase('tr-TR'));}
  function drawer(key,label,html){return `<details class="word-drawer" data-drawer="${esc(key)}" ${drawers.has(key)?'open':''}><summary>${esc(label)}</summary><div class="word-drawer-body">${html}</div></details>`;}
  function paragraphDrawer(item,prefix){
    const citation=state.citations.find(c=>c.id===(item.citation||item.id));
    const ref=state.references.find(r=>r.id===item.reference);
    const ids=item.paragraph?[item.paragraph]:(ref?.paragraphs||[]);
    if(!ids.length)return '';
    const content=ids.map(id=>{
      const p=state.paragraphs.find(p=>p.id===id);if(!p)return '';
      const start=citation?.authorStart,end=citation?.end;
      const text=citation&&start>=0&&end>start&&end<=p.text.length?`${esc(p.text.slice(0,start))}<mark>${esc(p.text.slice(start,end))}</mark>${esc(p.text.slice(end))}`:esc(p.text);
      return `<div class="word-paragraph"><p class="word-paragraph-label">${esc(item.location||'Kaynakça · paragraf '+(p.index+1))}</p><p>${text}</p></div>`;
    }).join('');
    return drawer(prefix+'-paragraph-'+item.id,'İlgili paragrafı göster',content);
  }
  function findingCard(f,kind){return `<article class="result-card word-finding ${kind==='orphan-citations'?'failed':'review'}" data-finding="${esc(f.id)}"><div class="word-card-heading"><h4>${esc(f.type)}</h4>${f.location?`<span>${esc(f.location)}</span>`:''}</div><p class="word-finding-original">${esc(f.original||'')}</p>${f.reviewReason?`<p class="word-guidance">${esc(f.reviewReason)}</p>`:''}${kind==='orphan-references'?'':paragraphDrawer(f,kind)}${f.patch?`<div class="word-correction"><p><span>${esc(f.patch.original)}</span><span aria-label="yerine">→</span><strong>${esc(f.patch.replacement)}</strong></p><div class="word-card-actions"><label class="word-patch-select"><input type="checkbox" data-patch="${esc(f.id)}" ${selected.has(f.id)?'checked':''} ${busy||state.job.running?'disabled':''}> Toplu düzeltmeye seç</label>${button('apply',f.id,'Düzeltmeyi uygula')}</div></div>`:''}${f.citation?`<button type="button" class="word-inline-button" data-inspect="${esc(f.citation)}">Eşleşmeyi ve kanıtları incele</button>`:''}${f.reference?`<button type="button" class="word-inline-button" data-reference-view="${esc(f.reference)}">Kaynakça kaydını incele</button>`:''}</article>`;}
  function manualParagraph(c){
    const p=state.paragraphs.find(p=>p.id===c.paragraph);
    if(!p?.editable)return '<p class="word-guidance">Bu paragraf korunan veya salt okunur bir alandadır.</p>';
    return `<label class="word-field">Paragrafı elle düzenle<textarea data-word-paragraph="${esc(p.id)}" rows="5" ${busy||state.job.running?'disabled':''}>${esc(drafts.get('paragraph:'+p.id)??p.text)}</textarea></label><p class="word-guidance">Değişiklikleri kaydettiğinizde indirilecek Word dosyasına işlenir.</p>${button('saveparagraph',p.id,'Paragrafı Word belgesine kaydet')}`;
  }
  function citationCard(c){
    const result=c.content;const status=result?verdicts[result.verdict]:(isContent?'İçerik kontrolü yapılmadı':'');
    const tone=result?.verdict==='supported'?'verified':result?.verdict==='contradicted'?'failed':'review';
    const ref=state.references.find(r=>r.id===c.reference),versionApproval=ref?.pdf?.needsConfirmation;
    return `<article id="${prefix}-citation-${esc(c.id)}" data-citation="${esc(c.id)}" class="result-card word-evidence-card ${tone}"><div class="word-card-heading"><h4>${esc(c.text)}</h4>${status?`<span class="status-pill ${tone}">${esc(status)}</span>`:''}</div><p class="word-guidance">${esc(c.issue||'Kaynakça ile eşleşti')}</p>${result?.verdict==='unassessable'?`<p class="word-guidance">${esc(result.explanation)}</p>${versionApproval?`<button type="button" class="copy-button" data-action="confirmcheck" data-id="${esc(c.reference)}" data-citation-id="${esc(c.id)}">Bu PDF sürümünü kabul et ve yeniden incele</button>`:c.reference?`<button type="button" class="word-inline-button" data-reference-view="${esc(c.reference)}">Kaynağı incele / PDF yükle</button>`:''}`:''}${result?.abstractOnly?'<p class="word-guidance"><strong>Yalnız özet incelendi.</strong> Sonuç tam yayına genellenemez.</p>':''}${paragraphDrawer(c,'evidence')}${drawer('context-'+c.id,'Atıf cümlesi ve önceki üç cümle ('+c.context.length+' cümle)',c.context.map((text,i)=>`<p class="${i===c.context.length-1?'word-cited-sentence':''}">${esc(text)}</p>`).join(''))}
      ${drawer('editor-'+c.id,'Eşleşmeyi veya bağlamı düzenle',`${c.issue?.includes('Yıl uyuşmazlığı')?'<p class="word-guidance">Ön baskı ve dergi sürümü farklı yıllarda olabilir. Kullanılan yayını kontrol edin. Yetim Kaynak kontrolünde eşleşmeyi kabul ettiğinizde atıf seçilen kaynağa göre düzeltilir.</p>':''}<label class="word-field">Atfın kaynağı<select data-match="${esc(c.id)}" ${busy||state.job.running?'disabled':''}><option value="">Kaynağı seçin</option>${state.references.map(r=>`<option value="${esc(r.id)}" ${r.id===c.reference?'selected':''}>${esc(r.raw.slice(0,140))}</option>`).join('')}</select></label>${button('match',c.id,'Seçilen eşleşmeyi kabul et')}${isContent?`<label class="word-field">Bağlam (son cümle atıf cümlesi)<textarea data-context="${esc(c.id)}" rows="4" ${busy||state.job.running?'disabled':''}>${esc(c.context.join(' '))}</textarea></label>${button('context',c.id,'Bu bağlamla incele')}`:manualParagraph(c)}`)}
      ${result?`<div class="word-evidence-result"><h5>${esc(verdicts[result.verdict])}</h5><p>${esc(result.explanation)}</p><p class="provider-note">${esc(result.access||'')} · ${esc(result.retrieval||'')}</p>${(result.claims||[]).map(cl=>`<div class="word-claim"><p><strong>${esc(verdicts[cl.verdict])}:</strong> ${esc(cl.claim)}</p>${cl.evidenceError?`<p class="word-guidance">${esc(cl.evidenceError)}</p>`:''}${cl.quote?`<blockquote>${esc(cl.quote)}</blockquote><p class="provider-note">${esc(cl.location)}</p>`:''}</div>`).join('')}${result.url&&/^https:\/\//.test(result.url)?`<a class="word-inline-button" href="${esc(result.url)}" target="_blank" rel="noopener noreferrer">İncelenen yayını aç</a>`:''}</div>`:'<p class="provider-note">Kaynak eşleşmesini kontrol ettikten sonra içerik kontrolünü başlatabilirsiniz.</p>'}</article>`;
  }
  function empty(message){return `<div class="word-empty"><p>${esc(query?'Aramanızla eşleşen kayıt yok.':message)}</p>${query?'<button type="button" class="word-inline-button" data-clear-search>Aramayı temizle</button>':''}</div>`;}
  function remaining(at){return Math.max(0,Math.ceil((Number(at)-Date.now())/1000));}
  function renderProgress(){
    if(!$('progress')||!state)return;
    const job=state.job||{},refs=state.referenceJob||{};
    const sources=state.references||[],citations=state.citations||[];
    const refDone=sources.filter(r=>r.verification&&!r.verification.pendingRetryAt&&!r.verification.fallbackNeeded&&r.verification.status!=='pending').length;
    if(!isContent){
      // Orphan-reference page: a single bar for source verification, shown from the first click until the document closes.
      const running=!!refs.running||!!(job.running&&job.kind==='references');
      if(!running&&!state.referenceJob&&!sources.some(r=>r.verification)){$('progress').innerHTML='';return;}
      // The bar tracks records already queried; settled and waiting records are reported separately below it.
      // While running, count records queried in this run (server-side), so earlier results do not prefill the bar.
      const total=sources.length,queried=running?Number(refs.seen)||0:sources.filter(r=>r.verification).length;
      const completed=Math.min(total,Math.max(0,queried)),percent=total?Math.round(100*completed/total):0;
      const waiting=sources.filter(r=>r.verification?.pendingRetryAt||r.verification?.fallbackNeeded).length;
      const quota=running&&Number(refs.retryAt||job.retryAt)>Date.now()?`Kota bekleniyor; ${remaining(refs.retryAt||job.retryAt)} sn sonra otomatik devam edilecek.`:'';
      const detail=quota||(running?(job.kind==='references'&&job.message)||'Yayın kayıtları sorgulanıyor':completed>=total?'Kaynak doğrulama tamamlandı.':'Doğrulama durdu; kalan kayıtlar için Kaynakları doğrula düğmesini kullanın.');
      $('progress').innerHTML=`<div class="progress-stage ${running?'is-active':''}"><div class="progress-stage-heading"><label for="${prefix}-stage-references">Kaynak doğrulama</label><strong>${completed} / ${total} sorgulandı · %${percent}</strong></div><progress id="${prefix}-stage-references" class="${running&&!completed?'is-starting':''}" max="${Math.max(1,total)}" value="${completed}">%${percent}</progress><p>${esc(detail)}</p><p>${refDone} kayıt kesinleşti${waiting?`; ${waiting} kayıt ek kaynak veya kota için bekliyor`:''}.</p></div>`;
      return;
    }
    const llmActive=job.kind==='content';
    const assessed=citations.filter(c=>c.content).length;
    const total=llmActive?(job.total||0):citations.length;
    const done=llmActive?(job.completed||0):assessed;
    const wait=(active,at)=>active&&Number(at)>Date.now()?`Kota bekleniyor · ${remaining(at)} sn sonra yeniden denenecek`:'';
    const rows=[
      {name:'Kaynakça doğrulama',done:refDone,total:sources.length,active:refs.running||job.running&&job.kind==='references',detail:wait(refs.running,refs.retryAt)||wait(job.running&&job.kind==='references',job.retryAt)|| (refs.running?'Yayın kayıtları sorgulanıyor':'Kaynak kayıtlarının kontrolü')},
      {name:'Metin içi atıf kontrolü',done:citations.length,total:citations.length,active:false,detail:state.range?.start<0?'Kaynakça bölümünü seçmeniz bekleniyor':`${citations.length} atıf tarandı · ${(state.findings||[]).filter(f=>f.citation).length} atıf sorunu`},
      {name:'LLM içerik değerlendirmesi',done,total,active:llmActive&&job.running,detail:wait(llmActive&&job.running,job.retryAt)||(llmActive?job.message:'Yayın içeriğiyle karşılaştırma bekleniyor')}
    ];
    $('progress').innerHTML='<h3>Denetim ilerlemesi</h3>'+rows.map((r,i)=>{if(state.checks&& !state.checks[['references','citations','llm'][i]])return ''; 
      const completed=Math.min(r.total,Math.max(0,r.done)),percent=r.total?Math.round(100*completed/r.total):0;
      return `<div class="progress-stage ${r.active?'is-active':''}"><div class="progress-stage-heading"><label for="${prefix}-stage-${i}">${esc(r.name)}</label><strong>${completed} / ${r.total} · %${percent}</strong></div><progress id="${prefix}-stage-${i}" max="${Math.max(1,r.total)}" value="${completed}">${percent}%</progress><p>${esc(r.detail||'Bekliyor')}</p></div>`;
    }).join('')+'<p class="provider-note">İlerleme, işlenen kayıt sayısını gösterir; tüm kayıtların doğrulandığı veya desteklendiği anlamına gelmez.</p>';
  }
  function renderQueryMonitor(){
    const panel=$('query-monitor'),summary=$('query-monitor-summary'),log=$('query-monitor-log'),status=$('query-monitor-status');if(!panel||!summary||!log||!status)return;
    const job=state.job||{},refs=state.referenceJob||{},events=(state.debugEvents||[]).filter(event=>event.at>debugHiddenBefore);
    const active=!!job.running||!!refs.running;if(!active&&!events.length){panel.classList.add('hidden');return;}panel.classList.remove('hidden');panel.classList.toggle('is-live',active);
    status.textContent=active?'İstekler ve servis yanıtları otomatik yenileniyor.':'İşlem bitti. Son sorgular aşağıda duruyor.';
    const groqWait=job.retryAt?` · ${remaining(job.retryAt)} sn sonra yeniden denenecek`:'';
    const refWait=refs.retryAt?` · ${remaining(refs.retryAt)} sn sonra yeniden denenecek`:'';
    summary.innerHTML=`<article><span>LLM içerik denetimi</span><strong>${esc(job.kind==='content'?(job.completed||0)+' / '+(job.total||0):'Beklemede')}</strong><small>${esc(job.kind==='content'?(job.message||'Çalışıyor')+groqWait:'İçerik sorgusu çalışmıyor')}</small></article><article><span>Kaynak doğrulama</span><strong>${esc(refs.running?(refs.pending||0)+' kaynak bekliyor':'Bekleme yok')}</strong><small>${esc(refs.running?(refs.provider||'Dizin sorguları sürüyor')+refWait:'Arka plan sorgusu çalışmıyor')}</small></article>`;
    const labels={request:'İstek gönderildi',response:'Yanıt alındı',wait:'Yeniden deneme bekliyor',success:'Değerlendirme tamamlandı',result:'Kayıt tamamlandı',error:'Bağlantı hatası',start:'İşlem başladı'};
    log.innerHTML=events.slice(-80).reverse().map(event=>{const meta=[event.index?'Kayıt '+event.index:'',event.citation||'',event.status?'HTTP '+event.status:'',event.retryAt?remaining(event.retryAt)+' sn kaldı':''].filter(Boolean).join(' · ');const rate=[event.remainingRequests&&`kalan istek: ${event.remainingRequests}`,event.remainingTokens&&`kalan token: ${event.remainingTokens}`,event.resetRequests&&`istek sıfırlama: ${event.resetRequests}`,event.resetTokens&&`token sıfırlama: ${event.resetTokens}`].filter(Boolean).join(' · ');return `<article class="query-event ${esc(event.kind)}"><time>${esc(new Date(event.at).toLocaleTimeString('tr-TR'))}</time><div><p><strong>${esc(event.provider)}</strong><span>${esc(labels[event.kind]||event.kind)}</span></p>${meta?`<small>${esc(meta)}</small>`:''}${event.url?`<code>${esc(event.url)}</code>`:''}${event.record?`<p class="query-record">${esc(event.record)}</p>`:''}${event.detail?`<small>${esc(event.detail)}</small>`:''}${rate?`<small>${esc(rate)}</small>`:''}</div></article>`;}).join('')||'<p class="query-monitor-empty">Henüz yeni sorgu yok.</p>';
  }
  function setView(next){view=next;query='';$('search').value='';render();}
  function render(){
    if(!state)return;if(isContent&&$('runchecks'))$('runchecks').disabled=busy||state.job.running||!!state.referenceJob?.running;renderProgress();$('panel').classList.remove('hidden');
    if(isContent){$('editor')?.querySelectorAll('textarea').forEach(el=>{el.disabled=busy||!!state.job.running;});if($('save'))$('save').disabled=busy||!!state.job.running;}
    const job=state.job;notify(`${state.name} · ${job.message||''}${job.running?` (${job.completed}/${job.total})`:''}${job.retryAt?` · tekrar denemeye ${Math.max(0,Math.ceil((job.retryAt-Date.now())/1000))} sn`:''}`);
    if(state.referenceJob?.running&&state.referenceJob.pending){const r=state.referenceJob;notify(($('message')?.textContent||'')+' · '+r.pending+' kaynak arka planda kota bekliyor'+(r.retryAt?' ('+Math.max(0,Math.ceil((r.retryAt-Date.now())/1000))+' sn)':''));}
    renderQueryMonitor();
    for(const action of ['range','verify','content','download','upload','applymany'])$(action).disabled=busy||job.running;
    for(const id of [...selected])if(!state.findings.some(f=>f.id===id&&f.patch))selected.delete(id);
    $('applymany').disabled ||= !selected.size;$('applymany').textContent=selected.size?`Seçilen ${selected.size} düzeltmeyi uygula`:'Seçilen düzeltmeleri uygula';
    $('applymany').classList.toggle('hidden',view==='evidence'||view==='references');
    $('content').disabled ||= !state.groqConfigured;$('stop').disabled=!job.running&&!state.referenceJob?.running;
    const referenceCounts=Object.fromEntries(Object.keys(referenceFilters).map(key=>[key,key==='all'?state.references.length:state.references.filter(r=>referenceStatus(r)===key).length]));
    $('reference-summary').innerHTML=Object.entries(referenceFilters).map(([status,label])=>`<button type="button" class="summary-stat" data-reference-filter="${status}" aria-pressed="${referenceFilter===status}" aria-label="${referenceCounts[status]} ${label}: kaynakça kayıtlarını göster"><strong>${referenceCounts[status]}</strong><span>${label}</span></button>`).join('');
    $('references').innerHTML=state.references.map((r,i)=>{
      const v=r.verification,comparison=referenceComparison(r);const status=referenceStatus(r)==='correction'?'Doğrulandı – düzeltme gerekli':v?.statusText||'Henüz dizin doğrulaması yapılmadı';
      const tone=v?.status==='verified'?'verified':v?.status==='failed'?'failed':v?.status==='error'?'error':v?.status==='pending'?'pending':'review';
      if((referenceFilter!=='all'&&referenceStatus(r)!==referenceFilter)||!matches(r.raw,v?.suggested,v?.reason))return '';
      return `<article id="${prefix}-reference-${esc(r.id)}" class="result-card ${tone}"><div class="result-top"><span class="result-number">${String(i+1).padStart(2,'0')}</span><span class="status-pill ${tone}">${esc(status)}</span></div><p class="raw-reference">${esc(r.raw)}</p>${comparison.score!==null?`<p class="provider-note" title="Özgün ve önerilen künye metinlerinin karakter çifti benzerliği; yayın kimliği güven puanı değildir.">Künye benzerliği: <strong>${comparison.score}/100</strong></p>`:''}${v?.suggested&&comparison.different?`<p class="matched-reference"><strong>Öneri:</strong> ${referenceMarkup(v)}</p>`:''}<p class="provider-note">${esc(v?.reason||'')}</p>
      ${typeof ReferenceWeb !== 'undefined' ? ReferenceWeb.details(v) : ''}
      ${v?.matched&&!r.protected&&(comparison.different||r.accepted)?(r.accepted?button('undo','bib-'+r.id,'Kaynakça düzeltmesini geri al'):button('apply','bib-'+r.id,'Kaynakçada düzeltmeyi uygula')):''}
      ${button('confirm',r.id,r.pdf?.needsConfirmation?'Bu PDF sürümünü kabul et':r.confirmed?'Kaynak kimliği kabul edildi':'Kaynak kimliğini kabul et')}
      <details><summary>Kaynakça kayıt sınırlarını düzenle</summary><p>Birleştirme/ayırma, belge için doğrulama sonuçlarını ve seçilen düzeltmeleri sıfırlar. Aynı paragraftaki farklı kayıtları Word’de ayrı paragraflara ayırın.</p>${i<state.references.length-1?button('merge',r.id,'Sonraki kayıtla birleştir'):''}${r.paragraphs.length>1?button('split',r.id,'Her paragrafı ayrı kayıt yap'):''}</details>
      <label class="word-pdf">Yayının PDF’sini ekle <input type="file" accept=".pdf" data-reference="${esc(r.id)}" ${job.running?'disabled':''}></label>
      ${r.pdf?`<details><summary>${esc(r.pdf.access)} ${r.pdf.needsConfirmation?'· Yayın kimliği onayı gerekiyor':''}</summary><p>${esc(r.pdf.preview||'Yayın metni alındı.')}</p>${r.pdf.versionNotice?`<p class="word-guidance"><strong>PDF sürüm uyarısı:</strong> “${esc(r.pdf.versionNotice)}”</p>`:''}</details>`:''}
      <a class="text-button" href="${v?.type === 'web' ? 'https://www.google.com/search?q=' : 'https://scholar.google.com/scholar?hl=tr&q='}${encodeURIComponent(r.raw)}" target="_blank" rel="noopener noreferrer">${v?.type === 'web' ? 'Web’de ara' : 'Google Scholar’da ara'} ↗</a></article>`;
    }).join('');
    const groups=groupFindings(),counts={...Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,v.length])),evidence:state.citations.length,references:state.references.length};
    $('summary').innerHTML=Object.entries(views).filter(([key])=>(isContent||key!=='evidence')&&(!isContent||!state.checks||(key==='references'?state.checks.references:key==='evidence'?state.checks.llm:state.checks.citations))).map(([key,label])=>`<button id="${prefix}-nav-${key}" type="button" aria-pressed="${view===key}" aria-controls="${prefix}-view-${key}" data-view="${key}"><span>${label}</span><strong>${counts[key]}</strong></button>`).join('');
    for(const key of Object.keys(views))$('view-'+key).classList.toggle('hidden',view!==key);
    for(const [key,target] of [['issues','findings'],['orphan-citations','orphan-citations'],['orphan-references','orphan-references']])$(target).innerHTML=groups[key].filter(f=>matches(f.original,f.type,f.location)).map(f=>findingCard(f,key)).join('')||empty(key==='issues'?'Yazar, yıl veya eşleşme sorunu bulunmadı.':key==='orphan-citations'?'Kaynakçada karşılığı bulunamayan atıf yok.':'Taranan metinde atıfsız kaynak bulunmadı.');
    $('applied').innerHTML=state.applied.length?drawer('applied-corrections',`Seçtiğiniz düzeltmeler (${state.applied.length})`,state.applied.map(p=>`<article class="result-card verified"><p>${esc(p.before)} → ${esc(p.after)}</p>${button('undo',p.id,'Geri al')}</article>`).join('')):'';
    const labels={all:'Tüm atıflar',pending:'Henüz incelenmedi',supported:'Desteklenen',partial:'Kısmi destek',contradicted:'Çelişen',not_found:'Destek bulunamayan',unassessable:'Değerlendirilemeyen'};
    $('evidence-filters').innerHTML=Object.entries(labels).map(([key,label])=>`<button type="button" aria-pressed="${filter===key}" data-filter="${key}">${label}<span>${state.citations.filter(c=>key==='all'||(c.content?.verdict||'pending')===key).length}</span></button>`).join('');
    $('citations').innerHTML=state.citations.filter(c=>c.id!==inspectedCitation).filter(c=>(filter==='all'||(c.content?.verdict||'pending')===filter)&&matches(c.text,c.sentence,c.location,c.content?.explanation)).map(citationCard).join('')||empty('Bu içerik durumunda atıf yok. Henüz inceleme yapılmadıysa “Henüz incelenmedi” filtresini seçin.');
    if(!$('references').innerHTML)$('references').innerHTML=empty('Kaynakça kaydı bulunamadı. Belge bölümünü kontrol edin.');
    if(!isContent&&inspectedCitation){const c=state.citations.find(c=>c.id===inspectedCitation);$('inspection-body').innerHTML=c?citationCard(c):'<p>Paragraf kaydedildi. Atıf listesi güncellendi; bu pencereyi kapatabilirsiniz.</p>';}
    for(const field of $('panel').querySelectorAll('[data-match], [data-context]')){const key=(field.dataset.match?'match:':'context:')+(field.dataset.match||field.dataset.context);if(drafts.has(key))field.value=drafts.get(key);}
    if(!state.groqConfigured)notify(($('message')?.textContent||'')+' · Groq veya OpenRouter anahtarı sunucuda yapılandırılmamış.');
  }
  function initialize(){
    const main=state.paragraphs.filter(p=>p.part==='word/document.xml');
    const options=main.map(p=>`<option value="${p.index}">${p.index+1}. ${esc(p.text.slice(0,120)||'(boş paragraf)')}</option>`).join('');$('start').innerHTML=options;$('end').innerHTML=options;
    $('start').value=state.range.start>=0?state.range.start:0;$('end').value=state.range.end;
    $('preview').innerHTML=state.paragraphs.map(p=>`<p id="${prefix}-p-${esc(p.id)}"><small>${esc(p.part)} · ${p.index+1}${p.protected?' · korunan alan':''}</small><br>${esc(p.text)}</p>`).join('');
    if(isContent&&state.checks){for(const [key,value] of Object.entries(state.checks))if($('check-'+key))$('check-'+key).checked=value;}
    $('boundaries').open=state.range.start<0;filter='all';referenceFilter='all';view=isContent?(state.checks?.llm!==false?'evidence':state.checks?.citations!==false?'issues':'references'):'issues';query='';$('search').value='';selected.clear();drawers.clear();drafts.clear();editor();render();schedule();
  }
  async function action(name,data){let error;const epoch=stateEpoch,documentId=state?.id;try{if(name!=='stop')await flush();if(epoch!==stateEpoch||state?.id!==documentId)return;if(name==='context'){view='evidence';filter='all';drawers.add('editor-'+data.citation);notify('Düzenlenen bağlam kaydediliyor ve bu atıf yeniden inceleniyor…');}busy=true;render();const next=await api(name,data);if(epoch!==stateEpoch||state?.id!==documentId)return;state=next;if(name==='runchecks')view=state.checks.llm?'evidence':state.checks.citations?'issues':'references';if(name==='match'){for(const key of drafts.keys())if(key.startsWith('paragraph:'))drafts.delete(key);}if(name==='paragraph'){drafts.delete('paragraph:'+data.paragraph);notify('Paragraf Word belgesine kaydedildi.');}if(name==='context'||name==='match')drafts.delete(name+':'+data.citation);if(name==='range')initialize();if(isContent&&['apply','undo','applymany','group'].includes(name))editor();await library();}catch(e){if(epoch===stateEpoch&&state?.id===documentId)error=e.message;}finally{if(epoch===stateEpoch&&state?.id===documentId){busy=false;if(state)render();if(error)notify(error);schedule();if(name==='context'&&state)setTimeout(()=>document.getElementById(prefix+'-citation-'+data.citation)?.scrollIntoView({behavior:'smooth',block:'start'}),0);}}}
  $('upload').addEventListener('change',async()=>{const file=$('upload').files[0];if(!file)return;const epoch=++stateEpoch;try{await flush();busy=true;notify('Word dosyası okunuyor…');clearTimeout(poll);const next=await api('upload',{name:file.name,mode,...(isContent?{checks:selectedChecks()}:{}),data:await encoded(file)});if(epoch!==stateEpoch)return;state=next;remember();busy=false;initialize();await library();}catch(e){if(epoch===stateEpoch)notify(e.message);}finally{if(epoch===stateEpoch)busy=false;}});
  $('range').addEventListener('click',()=>action('range',{start:Number($('start').value),end:Number($('end').value)}));
  for(const name of ['verify','content','stop'])$(name).addEventListener('click',()=>action(name==='content'&&isContent?'check':name,{}));
  $('applymany').addEventListener('click',()=>action('applymany',{ids:[...selected]}));
  $('search').addEventListener('input',()=>{query=$('search').value;render();});
  $('panel').addEventListener('toggle',event=>{const d=event.target;if(d.dataset.drawer){if(d.open)drawers.add(d.dataset.drawer);else drawers.delete(d.dataset.drawer);}},true);
  $('panel').addEventListener('input',event=>{const field=event.target;if(field.dataset.wordParagraph)drafts.set('paragraph:'+field.dataset.wordParagraph,field.value);if(field.dataset.context)drafts.set('context:'+field.dataset.context,field.value);});
  $('panel').addEventListener('change',event=>{const field=event.target;
    if(field.dataset.patch){if(field.checked)selected.add(field.dataset.patch);else selected.delete(field.dataset.patch);$('applymany').disabled=busy||state.job.running||!selected.size;$('applymany').textContent=selected.size?`Seçilen ${selected.size} düzeltmeyi uygula`:'Seçilen düzeltmeleri uygula';}
    if(field.dataset.match)drafts.set('match:'+field.dataset.match,field.value);
  });
  $('delete').addEventListener('click',async()=>{const deletedState=state,epoch=++stateEpoch;busy=true;clearTimeout(poll);try{await flush();const response=await fetch('/api/word/'+deletedState.id,{method:'DELETE',headers:{'X-Word-Request':'1'}});const result=await response.json();if(!response.ok)throw Error(result.error||'Belge silinemedi.');if(epoch!==stateEpoch)return;state=null;paragraphDrafts.clear();drafts.clear();selected.clear();drawers.clear();autoStarting=false;if(typeof localStorage!=='undefined')localStorage.removeItem(prefix+'-last-document');$('panel')?.classList.add('hidden');if($('upload'))$('upload').value='';notify('Belge, eklenen PDF’ler ve analiz verileri silindi.');await library();}catch(e){if(epoch===stateEpoch){state=deletedState;notify(e.message);}}finally{if(epoch===stateEpoch){busy=false;if(state)render();}}});
  $('download').addEventListener('click',async()=>{try{await flush();notify('Word dosyası hazırlanıyor…');const response=await fetch(`/api/word/${state.id}/download`);if(!response.ok)throw Error((await response.json()).error);download(await response.blob(),'makale_duzeltilmis.docx');render();}catch(e){notify(e.message);}});
  function download(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  $('report').addEventListener('click',()=>{
    const groups=groupFindings();
    const html=`<!doctype html><html lang="tr"><meta charset="utf-8"><title>Makale denetim raporu</title><style>body{font:16px/1.65 sans-serif;max-width:1000px;margin:40px auto;padding:0 20px}article{border-bottom:1px solid #ccc;padding:20px}button,input,label{display:none}blockquote{border-left:3px solid #999;padding-left:16px}mark{background:#e5f1ec}.word-paragraph{white-space:pre-wrap}h2{margin-top:40px}</style><h1>Makale denetim raporu</h1><p>${esc(state.name)} · ${esc(new Date().toLocaleString('tr-TR'))}</p><p>${esc(state.warnings.join(' '))}</p><h2>Seçilen düzeltmeler</h2>${$('applied').innerHTML}${Object.entries(groups).map(([key,findings])=>`<h2>${esc(views[key])} (${findings.length})</h2>${findings.map(f=>findingCard(f,key)).join('')||'<p>Bulgu yok.</p>'}`).join('')}<h2>Kaynakça kayıtları</h2>${state.references.map(r=>`<article><p>${esc(r.raw)}</p><p>${esc(r.verification?.statusText||'Henüz doğrulanmadı')}</p>${r.verification?.suggested?`<p>Öneri: ${esc(r.verification.suggested)}</p>`:''}</article>`).join('')}<h2>Atıflar ve içerik kanıtları</h2>${state.citations.map(citationCard).join('')}</html>`;
    download(new Blob([html],{type:'text/html;charset=utf-8'}),'makale_denetim_raporu.html');
  });
  $('panel').addEventListener('click',event=>{
    if(event.target.closest('[data-clear-debug]')){debugHiddenBefore=Date.now();renderQueryMonitor();return;}
    const b=event.target.closest('[data-action]');if(b){const {action:name,id}=b.dataset;
      if(name==='merge'||name==='split')action('group',{reference:id,mode:name});
      else if(name==='match'){const value=Array.from((!isContent&&inspectedCitation?$('inspection-body'):$('citations')).querySelectorAll('[data-match]')).find(el=>el.dataset.match===id)?.value;const c=state.citations.find(c=>c.id===id);const similar=!isContent&&c?state.citations.filter(x=>x.id!==id&&x.issue&&!x.protected&&x.year===c.year&&JSON.stringify(x.authors)===JSON.stringify(c.authors)):[];
        const applySimilar=similar.length>0&&window.confirm(`Aynı yazar ve yıl bilgisine sahip ${similar.length} başka sorunlu atıf bulundu. Seçtiğiniz kaynakla bunları da düzeltmek ister misiniz?`);
        action(name,{citation:id,reference:value,applySimilar});}
      else if(name==='saveparagraph'){const text=drafts.get('paragraph:'+id)??state.paragraphs.find(p=>p.id===id)?.text;action('paragraph',{paragraph:id,text,revision:state.revision||0});}
      else if(name==='context'){const text=Array.from($('citations').querySelectorAll('[data-context]')).find(el=>el.dataset.context===id)?.value;action(name,{citation:id,text});}
      else if(name==='confirmcheck')action('confirm',{reference:id,citation:b.dataset.citationId});
      else action(name,name==='confirm'?{reference:id}:{id});return;}
    const referenceFilterButton=event.target.closest('[data-reference-filter]');if(referenceFilterButton){referenceFilter=referenceFilterButton.dataset.referenceFilter;render();$('reference-summary').querySelector(`[data-reference-filter="${referenceFilter}"]`)?.focus({preventScroll:true});return;}
    const nav=event.target.closest('[data-view]');if(nav){setView(nav.dataset.view);$('nav-'+view).focus({preventScroll:true});return;}
    const f=event.target.closest('[data-filter]');if(f){filter=f.dataset.filter;render();$('evidence-filters').querySelector('[data-filter="'+filter+'"]').focus({preventScroll:true});return;}
    if(event.target.closest('[data-clear-search]')){query='';$('search').value='';render();$('search').focus();return;}
    const inspect=event.target.closest('[data-inspect]');if(inspect){if(!isContent){inspectedCitation=inspect.dataset.inspect;drawers.add('editor-'+inspectedCitation);render();$('inspection').showModal();return;}filter='all';drawers.add('editor-'+inspect.dataset.inspect);setView('evidence');document.getElementById(prefix+'-citation-'+inspect.dataset.inspect)?.scrollIntoView({behavior:'smooth',block:'start'});return;}
    const source=event.target.closest('[data-reference-view]');if(source){setView('references');document.getElementById(prefix+'-reference-'+source.dataset.referenceView)?.scrollIntoView({behavior:'smooth',block:'start'});return;}
    const show=event.target.closest('[data-show]');if(show){$('boundaries').open=true;document.getElementById(prefix+'-p-'+show.dataset.show)?.scrollIntoView({behavior:'smooth',block:'center'});}
  });
  $('references').addEventListener('change',async event=>{const target=event.target;if(!target.dataset.reference)return;const file=target.files[0];if(!file)return;
    try{await flush();notify('Yayın PDF’si okunuyor…');state=await api('pdf',{reference:target.dataset.reference,name:file.name,data:await encoded(file)});render();await library();
      if(state.pdfPreview){const box=document.createElement('article');box.className='result-card review';const p=document.createElement('p');p.textContent='PDF kimlik önizlemesi: '+state.pdfPreview.text;box.append(p);if(state.pdfPreview.needsConfirmation){const b=document.createElement('button');b.className='copy-button';b.textContent='Bu PDF’nin seçilen yayın olduğunu onayla';b.dataset.action='confirm';b.dataset.id=state.pdfPreview.reference;box.append(b);}else{const p=document.createElement('p');p.textContent='DOI eşleşti.';box.append(p);}document.getElementById(prefix+'-reference-'+state.pdfPreview.reference)?.prepend(box);}
    }catch(e){notify(e.message);}
  });
  if(typeof window!=='undefined'){
    library();
    const last=localStorage.getItem(prefix+'-last-document');
    if(last){const epoch=stateEpoch;fetch('/api/word/'+encodeURIComponent(last)).then(async r=>{if(!r.ok)return;const saved=await r.json();if(epoch===stateEpoch&&saved.mode===mode&&!state){state=saved;initialize();}}).catch(e=>{if(epoch===stateEpoch)notify('Belge geri yüklenemedi: '+e.message);});}
  }
}
createWordWorkspace('word','word');
createWordWorkspace('content','content');
