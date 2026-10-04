const https = require('node:https');
const UsageContext=require('./lib/usage-context.cjs');
const Prompts=require('./lib/prompts.cjs');
const Cache=require('./lib/cache-store.cjs');
const Metrics=require('./lib/metrics.cjs');
const dns = require('node:dns').promises;
const net = require('node:net');
const Engine = require('./reference-engine.js');
const Web = require('./web-reference.js');
function publicIp(ip) {
  // Match special-use subnet boundaries, not entire /16 blocks (192.0.66.x is public).
  if(net.isIP(ip)===4){const [a,b,c]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0&&(c===0||c===2)||b===88&&c===99)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);}
  return net.isIP(ip)===6 && /^[23][0-9a-f]{3}:/i.test(ip) && !/^2002:|^2001:(?:db8|0|10|20):/i.test(ip);
}
let semanticQueue=Promise.resolve(),semanticNext=0;
async function semanticRecord(doi,signal){
  if(!process.env.SEMANTIC_SCHOLAR_API_KEY)return null;
  const run=semanticQueue.catch(()=>{}).then(async()=>{
    const delay=Math.max(0,semanticNext-Date.now());if(delay)await require('node:timers/promises').setTimeout(delay,undefined,{signal});semanticNext=Date.now()+1000;
    const endpoint='https://api.semanticscholar.org/graph/v1/paper/DOI:'+encodeURIComponent(doi)+'?fields=title,abstract,openAccessPdf,externalIds';
    const response=await fetch(endpoint,{signal:AbortSignal.any([signal,AbortSignal.timeout(30000)]),headers:{Accept:'application/json','x-api-key':process.env.SEMANTIC_SCHOLAR_API_KEY}});
    if(response.status===404){await response.body?.cancel();return null;}
    if(response.status===429){const seconds=Math.max(1,Number(response.headers.get('retry-after'))||60);semanticNext=Math.max(semanticNext,Date.now()+seconds*1000);await response.body?.cancel();throw Error('Semantic Scholar kota beklemesi: '+seconds+' sn');}
    if(!response.ok){await response.body?.cancel();throw Error('Semantic Scholar HTTP '+response.status);}
    return response.json();
  });semanticQueue=run;return run;
}
async function unpaywallRecord(doi,signal,request=remote,emailOverride){
  const email=String(emailOverride||process.env.UNPAYWALL_EMAIL||process.env.CROSSREF_MAILTO||'').trim();if(!email)return null;
  const doiPath=doi.split('/').map(encodeURIComponent).join('/');
  const response=await request(`https://api.unpaywall.org/v2/${doiPath}?email=${encodeURIComponent(email)}`,signal);
  const record=JSON.parse(response.data);return record?.doi?.toLowerCase()===doi.toLowerCase()?record:null;
}
async function remote(url,signal,redirects=0,redirectChain=[]) {
  const u=new URL(url);
  if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||redirects>4) throw Error('Güvenli olmayan yayın bağlantısı.');
  const addresses=await dns.lookup(u.hostname,{all:true});
  if(!addresses.length||addresses.some(a=>!publicIp(a.address))) throw Error('İç ağ bağlantısı reddedildi.');
  const address=addresses.find(a=>a.family===4)||addresses[0];
  return new Promise((resolve,reject)=>{
    // Some institutional repositories (including eScholarship) reject product-style
    // user agents even for public, open-access PDFs. Use ordinary browser request
    // headers while keeping all SSRF, redirect, size and timeout controls below.
    const req=https.get(u,{signal,timeout:20000,headers:{Accept:'application/pdf, application/json, application/xml, text/html;q=0.8, */*;q=0.5','Accept-Language':'en-US,en;q=0.8','User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'},lookup:(_host,options,cb)=>cb(null,options.all?[address]:address.address,address.family)},res=>{
      if(res.statusCode>=300&&res.statusCode<400&&res.headers.location){res.resume();const next=new URL(res.headers.location,u).href;remote(next,signal,redirects+1,[...redirectChain,{status:res.statusCode,url:u.href,next}]).then(resolve,reject);return;}
      if(res.statusCode!==200){res.resume();reject(Error(`Tam metin servisi ${u.hostname}: HTTP ${res.statusCode}`));return;}
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>20*1024*1024){res.destroy(Error('Tam metin boyut sınırı aşıldı.'));return;}chunks.push(chunk);});
      res.on('end',()=>resolve({data:Buffer.concat(chunks),url:u.href,type:res.headers['content-type']||'',redirectChain}));res.on('error',reject);
    });req.on('timeout',()=>req.destroy(Error('Tam metin zaman aşımı.')));req.on('error',reject);
  });
}
function referenceUrl(reference){
  const raw=String(reference?.effectiveRaw||reference?.raw||'');
  const parsed=Web.parse(raw);if(parsed?.url)return parsed.url;
  const markdown=raw.match(/\[[^\]]*\]\((https:\/\/[^\s)]+)\)/i)?.[1];
  const plain=raw.match(/https:\/\/[^\s<>\]]+/i)?.[0];let url=markdown||plain||'';
  while(url.endsWith(')')&&(url.match(/\)/g)||[]).length>(url.match(/\(/g)||[]).length)url=url.slice(0,-1);
  return url.replace(/[.,;]+$/,'');
}
function referenceTitle(reference){
  return String(reference?.title||'').replace(/https?:\/\/\S+.*$/i,'').replace(/\s+/g,' ').trim().replace(/[.,;:!?]+$/,'').trim();
}
function decodeHtml(text){const entities={amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' ',rsquo:'’',lsquo:'‘',rdquo:'”',ldquo:'“',ndash:'–',mdash:'—'};return String(text||'').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi,(all,key)=>{if(key[0]!=='#')return entities[key.toLowerCase()]??all;const n=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1));return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';});}
function htmlText(value){return decodeHtml(String(value||'').replace(/<br\b[^>]*>|<\/p\s*>|<\/div\s*>|<\/li\s*>/gi,'\n').replace(/<[^>]+>/g,' ')).replace(/[ \t]+/g,' ').replace(/\s*\n\s*/g,'\n').replace(/\n{3,}/g,'\n\n').trim();}
function tagAttrs(tag){const out={};for(const m of String(tag).matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))out[m[1].toLowerCase()]=decodeHtml(m[2]??m[3]??m[4]);return out;}
function extractHtml(html,url){
  const meta=new Map();let refreshUrl='';for(const m of String(html).matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)){const a=tagAttrs(m[0]),key=(a.name||a.property||a.itemprop||'').toLowerCase();if(key&&a.content&&!meta.has(key))meta.set(key,a.content);if((a['http-equiv']||'').toLowerCase()==='refresh'&&a.content){const target=a.content.match(/(?:^|;)\s*url\s*=\s*['"]?([^'"]+)/i)?.[1];if(target)try{refreshUrl=new URL(decodeHtml(target),url).href}catch{}}}
  const get=(...keys)=>keys.map(k=>meta.get(k)).find(Boolean)||'';
  const title=htmlText(get('citation_title','og:title','twitter:title')||html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i)?.[1]||html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]).slice(0,1000);
  const abstract=htmlText(get('citation_abstract','dc.description','description','og:description'));
  let articleBody='';
  for(const m of String(html).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)){if(tagAttrs(m[1]).type?.toLowerCase()!=='application/ld+json')continue;try{const roots=[].concat(JSON.parse(m[2]));const stack=[...roots];while(stack.length){const n=stack.shift();if(!n||typeof n!=='object')continue;if(typeof n.articleBody==='string'&&n.articleBody.length>articleBody.length)articleBody=n.articleBody;for(const v of Object.values(n))if(v&&typeof v==='object')stack.push(...[].concat(v));}}catch{}}
  let body='';if(articleBody)body=articleBody;else{
    const area=html.match(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/i)?.[1]||html.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i)?.[1]||html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1]||html;
    const clean=area.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|dialog)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ');
    const blocks=[...clean.matchAll(/<(?:p|h[1-6]|li|blockquote)\b[^>]*>([\s\S]*?)<\/(?:p|h[1-6]|li|blockquote)\s*>/gi)].map(m=>htmlText(m[1])).filter(t=>t.length>=25&&!/^(cookie|accept all|sign in|subscribe|advertisement)\b/i.test(t));body=blocks.join('\n\n');
  }
  body=htmlText(body).slice(0,500000);const pdfValue=get('citation_pdf_url');let pdfUrl='';if(pdfValue)try{pdfUrl=new URL(pdfValue,url).href}catch{}
  const doi=get('citation_doi','dc.identifier').match(/10\.\d{4,9}\/\S+/i)?.[0]?.replace(/[.,;]+$/,'')||'';
  const parts=(body.length>=300?body:abstract).split(/\n{2,}/).filter(Boolean),passages=[];let chunk='';for(const part of parts){if(chunk&&chunk.length+part.length>4000){passages.push({location:`Web içeriği · bölüm ${passages.length+1}`,text:chunk});chunk='';}chunk+=(chunk?'\n\n':'')+part;}if(chunk)passages.push({location:`Web içeriği · bölüm ${passages.length+1}`,text:chunk});
  return {title,abstract,doi,pdfUrl,refreshUrl,passages,bodyLength:body.length};
}
async function parsedResource(response,reference,python,signal,request,options={}){
  const isPdf=response.data.subarray(0,5).equals(Buffer.from('%PDF-'))||/^application\/pdf\b/i.test(response.type||'');
  if(isPdf){const parsed=await python({operation:'pdf',data:response.data.toString('base64')});if(!parsed.passages?.some(p=>p.text.trim()))throw Error('PDF okunabilir metin içermiyor; OCR gerekli.');const notice=preprintNotice(parsed),sample=(parsed.passages||[]).slice(0,3).map(p=>p.text).join(' '),cleanTitle=referenceTitle(reference),expected=Engine.normalizeTitle(cleanTitle),normalized=Engine.normalizeTitle(sample),doi=Engine.getDoi(reference.raw||''),arxiv=doi.match(/^10\.48550\/arxiv\.(.+)$/i)?.[1];const identityConfirmed=!!expected&&normalized.includes(expected)||!!doi&&sample.toLowerCase().includes(doi.toLowerCase())||!!arxiv&&response.url.toLowerCase().includes(arxiv.toLowerCase());const needsConfirmation=!!options.alternate||!identityConfirmed;return {...parsed,url:response.url,title:options.title||cleanTitle||reference.title,identity:options.identity||'',access:options.alternate?'Açık erişim PDF · alternatif yayın sürümü':'Doğrudan erişilen PDF',license:options.license||'Kaynak sayfasındaki erişim koşulları geçerlidir.',needsConfirmation,versionNotice:notice,preview:options.alternate?'Dergi sürümü yerine ön baskı/yazar sürümü bulundu. Sürümün atfınızla uyumunu kontrol edip kaynak kimliğini kabul edin.':needsConfirmation?'PDF metninde beklenen başlık veya DOI otomatik doğrulanamadı. Önizleyip seçilen yayın olduğunu kabul edin.':''};}
  if(!/^(?:text\/html|application\/xhtml\+xml)\b/i.test(response.type||'')&&!/^\s*</.test(response.data.subarray(0,200).toString()))throw Error('Bağlantı desteklenen HTML veya PDF içeriği sağlamadı.');
  const page=extractHtml(response.data.toString('utf8'),response.url);
  if(page.refreshUrl&&(options.refreshDepth||0)<3){const next=await request(page.refreshUrl,signal);return parsedResource(next,reference,python,signal,request,{...options,refreshDepth:(options.refreshDepth||0)+1});}
  if(page.pdfUrl){const pdf=await request(page.pdfUrl,signal);return parsedResource(pdf,reference,python,signal,request,{...options,title:page.title||options.title});}
  if(!page.passages.length)throw Error('Web sayfasında okunabilir makale metni veya özet bulunamadı.');
  const expectedTitle=referenceTitle(reference);
  if(expectedTitle&&page.title&&Engine.titleScore(expectedTitle,page.title)<.55)throw Error('Erişilen web sayfasının başlığı kaynakla uyuşmuyor.');
  return {title:page.title||reference.title,identity:page.doi||options.identity||response.url,url:response.url,access:page.bodyLength>=300?'Web sayfası tam metni':'Yalnız web sayfası özeti incelendi',abstractOnly:page.bodyLength<300,passages:page.passages,license:'Web sayfasının kullanım koşulları geçerlidir.',needsConfirmation:false,redirectChain:response.redirectChain||[]};
}
async function fullText(reference,python,signal,dependencies={}) {
  const request=dependencies.remote||remote;
  const onDebug=dependencies.onDebug||(()=>{});
  const doi=reference.verification?.matched?.doi || Engine.parseReference(reference.effectiveRaw||reference.raw).doi;
  const errors=[];
  const attempt=async action=>{try{return await action();}catch(error){signal.throwIfAborted();errors.push(error.message);return null;}};
  const enteredUrl=referenceUrl(reference);
  if(enteredUrl&&!/^https:\/\/(?:dx\.)?doi\.org\//i.test(enteredUrl)){
    onDebug({kind:'request',provider:'İçerik edinme',url:enteredUrl,detail:'Kaynak adresi doğrudan deneniyor',at:Date.now()});
    const direct=await attempt(async()=>parsedResource(await request(enteredUrl,signal),reference,python,signal,request,{identity:doi||enteredUrl}));
    if(direct){onDebug({kind:'success',provider:'İçerik edinme',url:direct.url,detail:direct.access,at:Date.now()});return direct;}
  }
  if(!doi) throw Error('Web sayfası veya PDF içeriği edinilemedi.'+(errors.length?' Denenen yöntemler: '+[...new Set(errors)].join('; '):' Kaynağın erişilebilir bir web veya PDF adresini sağlayın.'));
  const pmc=await attempt(async()=>{
    onDebug({kind:'request',provider:'Europe PMC',detail:'Açık tam metin aranıyor',at:Date.now()});
    const response=await request('https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&query='+encodeURIComponent('DOI:"'+doi+'"'),signal);
    const item=JSON.parse(response.data).resultList?.result?.find(r=>r.doi?.toLowerCase()===doi.toLowerCase()&&r.pmcid&&r.isOpenAccess==='Y');
    if(!item)return null;
    const xml=await request(`https://www.ebi.ac.uk/europepmc/webservices/rest/${item.pmcid}/fullTextXML`,signal);
    const parsed=await python({operation:'xml',data:xml.data.toString('base64')});
    return {...parsed,url:'https://europepmc.org/articles/'+item.pmcid,identity:doi,access:'Açık erişim tam metin (Europe PMC)',license:'Europe PMC açık erişim kaydı; yayın lisansını bağlantıdan kontrol edin.'};
  });
  if(pmc?.passages?.some(p=>p.text.trim())){onDebug({kind:'success',provider:'Europe PMC',url:pmc.url,detail:pmc.access,at:Date.now()});return pmc;}
  onDebug({kind:'request',provider:'Unpaywall',detail:'DOI için açık erişim PDF konumları aranıyor',at:Date.now()});
  const unpaywall=await attempt(()=>unpaywallRecord(doi,signal,request,dependencies.unpaywallEmail));
  if(unpaywall?.is_oa){
    const seen=new Set(),locations=[unpaywall.best_oa_location,...(unpaywall.oa_locations||[])].filter(location=>location&&![location.url_for_pdf,location.url_for_landing_page].every(url=>!url));
    for(const location of locations){
      for(const candidate of [location.url_for_pdf,location.url_for_landing_page]){
        if(!candidate||seen.has(candidate))continue;seen.add(candidate);
        const alternate=location.version==='submittedVersion'||location.version==='acceptedVersion';
        onDebug({kind:'request',provider:'Unpaywall',url:candidate,detail:`${location.version||'sürüm bilinmiyor'} · ${location.host_type||'OA konumu'}`,at:Date.now()});
        const acquired=await attempt(async()=>parsedResource(await request(candidate,signal),reference,python,signal,request,{identity:doi,title:unpaywall.title||reference.title,license:location.license||'Unpaywall açık erişim kaydı',alternate}));
        if(acquired){onDebug({kind:'success',provider:'Unpaywall',url:acquired.url,detail:acquired.access,at:Date.now()});return acquired;}
      }
    }
  }else if(unpaywall)onDebug({kind:'result',provider:'Unpaywall',detail:'Bu DOI için açık erişim kopyası bildirilmedi',at:Date.now()});
  onDebug({kind:'request',provider:'Crossref tam metin',detail:'Kayıttaki PDF bağlantıları aranıyor',at:Date.now()});
  const doiPath=doi.split('/').map(encodeURIComponent).join('/'),mailto=String(process.env.CROSSREF_MAILTO||'').trim();
  const crossref=await attempt(async()=>JSON.parse((await request(`https://api.crossref.org/works/${doiPath}${mailto?'?mailto='+encodeURIComponent(mailto):''}`,signal)).data).message);
  if(crossref?.DOI?.toLowerCase()===doi.toLowerCase()){
    const links=(crossref.link||[]).filter(link=>link?.URL&&(/application\/pdf/i.test(link['content-type']||'')||/\/pdf(?:\/|$|\?)/i.test(link.URL))).sort((a,b)=>(a['content-version']==='vor'?-1:0)-(b['content-version']==='vor'?-1:0));
    const seenLinks=new Set();
    for(const link of links){if(seenLinks.has(link.URL))continue;seenLinks.add(link.URL);
      const version=String(link['content-version']||''),alternate=!!version&&!/^(?:vor|publishedVersion)$/i.test(version);
      onDebug({kind:'request',provider:'Crossref tam metin',url:link.URL,detail:`${version||'sürüm bilinmiyor'} · PDF indiriliyor`,at:Date.now()});
      const acquired=await attempt(async()=>parsedResource(await request(link.URL,signal),reference,python,signal,request,{identity:doi,title:crossref.title?.[0]||reference.title,license:'Crossref tam metin bağlantısı; yayın kullanım koşulları geçerlidir.',alternate}));
      if(acquired){onDebug({kind:'success',provider:'Crossref tam metin',url:acquired.url,detail:acquired.access,at:Date.now()});return acquired;}
    }
  }
  onDebug({kind:'request',provider:'OpenAlex',detail:'Açık erişim konumları aranıyor',at:Date.now()});
  const oa=await attempt(async()=>JSON.parse((await request('https://api.openalex.org/works/https://doi.org/'+encodeURIComponent(doi),signal)).data));
  const locations=[oa?.best_oa_location,...(oa?.locations||[])].filter(Boolean);
  const arxivId=doi.match(/^10\.48550\/arxiv\.(\d{4}\.\d{4,5})$/i)?.[1];
  const explicitVersion=(reference.effectiveRaw||reference.raw).match(/(?:arxiv\s*:\s*|arxiv\.org\/(?:abs|pdf)\/|10\.48550\/arxiv\.)(\d{4}\.\d{4,5})(v\d+)/i);
  const version=explicitVersion&&arxivId&&explicitVersion[1]===arxivId?explicitVersion[2]:'';
  const candidates=arxivId?[{pdf_url:'https://arxiv.org/pdf/'+arxivId+version,license:'Yayın lisansını arXiv kaydından kontrol edin.'}]:[];
  for(const location of locations){if(location.pdf_url)candidates.push(location);else if(location.is_oa&&/^https:\/\/arxiv\.org\/(abs|pdf)\//.test(location.landing_page_url||''))candidates.push({...location,pdf_url:location.landing_page_url.replace('/abs/','/pdf/')});}
  const seen=new Set();
  for(const location of candidates){
    if(seen.has(location.pdf_url))continue;seen.add(location.pdf_url);if(seen.size>8)break;
    const text=await attempt(async()=>{
      onDebug({kind:'request',provider:'Açık erişim PDF',url:location.pdf_url,detail:location.version||'PDF indiriliyor',at:Date.now()});
      const pdf=await request(location.pdf_url,signal);
      if(!pdf.data.subarray(0,5).equals(Buffer.from('%PDF-')))throw Error('Açık erişim bağlantısı metin PDF sağlamadı.');
      const parsed=await python({operation:'pdf',data:pdf.data.toString('base64')});
      if(!parsed.passages?.some(p=>p.text.trim()))throw Error('PDF okunabilir metin içermiyor; OCR gerekli.');
      const alternateVersion=!arxivId&&(/arxiv\.org\//.test(location.pdf_url)||location.version&&location.version!=='publishedVersion');
      const versionNotice=preprintNotice(parsed);
      return {...parsed,url:pdf.url,title:oa?.title||reference.title,identity:doi,access:alternateVersion?'Açık erişim PDF · alternatif yayın sürümü':'Açık erişim PDF',license:location.license||'Lisans bilgisi verilmedi',needsConfirmation:!!alternateVersion,versionNotice,preview:alternateVersion?'Dergi sürümü yerine ön baskı/yazar sürümü bulundu. Sürümün atfınızla uyumunu kontrol edip kaynak kimliğini kabul edin.':''};
    });
    if(text){onDebug({kind:'success',provider:'Açık erişim PDF',url:text.url,detail:text.access,at:Date.now()});return text;}
  }
  onDebug({kind:'request',provider:'Semantic Scholar',detail:'Özet veya açık PDF aranıyor',at:Date.now()});
  const semantic=await attempt(()=>semanticRecord(doi,signal));
  if(semantic?.openAccessPdf?.url){const text=await attempt(async()=>parsedResource(await request(semantic.openAccessPdf.url,signal),reference,python,signal,request,{identity:doi,title:semantic.title||oa?.title||reference.title,alternate:true}));if(text)return text;}
  const semanticAbstract=semantic?.abstract?String(semantic.abstract).slice(0,30000):'';
  onDebug({kind:'request',provider:'DOI yönlendirmesi',url:'https://doi.org/'+doi,detail:'Yayıncı sayfası takip ediliyor',at:Date.now()});
  const landing=await attempt(async()=>parsedResource(await request('https://doi.org/'+doi,signal),reference,python,signal,request,{identity:doi,title:oa?.title||reference.title}));
  if(landing){onDebug({kind:'success',provider:'DOI yönlendirmesi',url:landing.url,detail:landing.access,at:Date.now()});return landing;}
  let abstract='';
  if(oa?.doi?.toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi.org\//,'')===doi.toLowerCase()&&oa.abstract_inverted_index){
    const words=[];
    for(const [word,positions] of Object.entries(oa.abstract_inverted_index))for(const pos of positions)if(Number.isInteger(pos)&&pos>=0&&pos<20000)words[pos]=word;
    abstract=words.join(' ').trim();
  }
  if(!abstract&&semanticAbstract)abstract=semanticAbstract;
  if(!abstract&&crossref?.DOI?.toLowerCase()===doi.toLowerCase())abstract=String(crossref.abstract||'').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
  if(abstract){onDebug({kind:'success',provider:'Özet yedeği',detail:'Tam metin bulunamadı; yalnız özet kullanılacak',at:Date.now()});return {title:semantic?.title||oa?.title||reference.title,identity:doi,url:'https://doi.org/'+doi,access:'Yalnız özet incelendi — tam metne erişilemedi',abstractOnly:true,passages:[{location:'Yayın özeti',text:abstract}],license:'Özet metadata kaydı'};}
  throw Error('Tam metne veya özete ulaşılamadı. Kaynakça kayıtları bölümünden yayının PDF’sini yükleyin.'+(errors.length?' Denenen servisler: '+[...new Set(errors)].join('; '):''));
}
function evidenceKey(value) {
  return String(value).normalize('NFKC').replace(/\u00ad/g,'').replace(/[’‘]/g,"'").replace(/[“”]/g,'"').replace(/\s+/g,' ').trim();
}
function preprintNotice(text) {
  if(text?.versionNotice)return String(text.versionNotice).slice(0,500);
  const sample=(text?.passages||[]).slice(0,3).map(p=>p.text||'').join(' ').replace(/\s+/g,' ');
  const match=sample.match(/This is an? non-peer reviewed preprint[^.!?]*(?:[.!?]|$)/i);
  return match?match[0].trim():'';
}
function selectPassages(text,context) {
  const words=new Set(Engine.normalizeTitle(context.join(' ')).split(' ').filter(w=>w.length>3));
  const chunks=[];
  for(const p of text.passages||[]){
    for(let start=0;start<p.text.length;start+=1800){const value=p.text.slice(start,start+2400).trim();if(!value)continue;
      const terms=new Set(Engine.normalizeTitle(value).split(' '));let score=0;for(const w of words)if(terms.has(w))score++;
      chunks.push({location:p.location,text:value,score});}
  }
  // Even with translation, include different sections if keyword retrieval has no overlap.
  const sorted=chunks.sort((a,b)=>b.score-a.score);
  const selected=sorted.slice(0,3);
  if(sorted.every(p=>p.score===0)&&chunks.length>3) selected.splice(1,2,chunks[Math.floor(chunks.length/2)],chunks[chunks.length-1]);
  return selected.map((p,i)=>({...p,text:p.text.slice(0,1800),id:'P'+(i+1)}));
}
const schema={type:'object',additionalProperties:false,required:['verdict','explanation','claims'],properties:{
  verdict:{type:'string',enum:['supported','partial','contradicted','not_found','unassessable']},explanation:{type:'string'},
  claims:{type:'array',items:{type:'object',additionalProperties:false,required:['claim','verdict','passage','quote'],properties:{
    claim:{type:'string'},verdict:{type:'string',enum:['supported','partial','contradicted','not_found','unassessable']},passage:{type:'string'},quote:{type:'string'},
  }}},
}};
const KeyPool=require('./lib/key-pool.cjs');
// The key pool holds every Groq/OpenRouter key (panel-defined and .env) with its own rests and limits.
const keyPool=()=>KeyPool.pool({env:process.env,now:Date.now});
const poolName=provider=>provider.toLowerCase();
// OpenRouter's free models allow one request every few seconds per key.
// Groq's free tier allows 8000 tokens per minute per model (GROQ_TPM, default 8000): after a request the key rests for as long as its tokens take to refill,
// at least one second, so the average rate stays under the limit however large the prompts are.
const gapMs=(provider,tokens=0)=>{if(provider==='OpenRouter')return 3000;const tpm=Number(process.env.GROQ_TPM||8000);return tpm>0?Math.min(60000,Math.max(1000,Math.ceil((Number(tokens)||0)/tpm*60000))):0;};
const providerConfigured=provider=>keyPool().hasUsable(poolName(provider));
// When a provider can take its next request: after its own network back-off and after its earliest usable key.
const providerReadyAt=provider=>Math.max(providerNext[provider],keyPool().nextAvailableAt(poolName(provider)));
const OPENROUTER_DEFAULT_MODELS=['qwen/qwen3.8-27b:free','google/gemma-4-31b-it:free','cohere/north-mini-code:free','nvidia/nemotron-3.5-content-safety:free'];
let queue=Promise.resolve(),providerNext={Groq:0,OpenRouter:0},evaluationCount=0,openRouterModelIndex=0;
function durationMs(value, now=Date.now){
  const text=String(value||'').trim();
  if(/^\d+(?:\.\d+)?$/.test(text))return Number(text)*1000;
  const parts=text.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/i);
  if(parts&&(parts[1]||parts[2]||parts[3]))return ((Number(parts[1]||0)*3600)+(Number(parts[2]||0)*60)+Number(parts[3]||0))*1000;
  const date=Date.parse(text);return Number.isFinite(date)?date-now():NaN;
}
function resetDelay(response,now=Date.now){
  const values=['tokens','requests'].map(kind=>durationMs(response.headers.get('x-ratelimit-reset-'+kind),now)).filter(Number.isFinite);
  return values.length?Math.min(...values):NaN;
}
function quotaDelay(response,now=Date.now){
  const retry=durationMs(response.headers.get('retry-after'),now);
  if(Number.isFinite(retry))return retry;
  return resetDelay(response,now);
}
function openRouterModels(){const configured=String(process.env.OPENROUTER_MODELS||'').split(',').map(v=>v.trim()).filter(Boolean);return configured.length?configured:OPENROUTER_DEFAULT_MODELS;}
function openRouterEnabled(){return providerConfigured('OpenRouter');}
function modelFormat(provider,model,name,schema){
  if(provider==='Groq'||model.startsWith('qwen/'))return {type:'json_schema',json_schema:{name,strict:true,schema}};
  if(model.startsWith('google/'))return {type:'json_object'};
  return null;
}
function requestErrorDetail(error,timeoutMs){
  if(error?.name==='TimeoutError'||error?.cause?.code==='UND_ERR_CONNECT_TIMEOUT')return `Yanıt ${Math.round(timeoutMs/1000)} saniye içinde alınamadı`;
  if(error?.cause?.code)return `${error.cause.code}: ${error.cause.message||error.message||'bağlantı hatası'}`;
  return `${error?.name||'Error'}: ${error?.message||'bağlantı hatası'}`;
}
function jsonResult(value){const text=String(value||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');try{return JSON.parse(text);}catch{const first=text.indexOf('{'),last=text.lastIndexOf('}');if(first>=0&&last>first)return JSON.parse(text.slice(first,last+1));throw Error('Model okunabilir JSON sağlamadı.');}}
// Groq rejects output that does not fit the schema (cut off, bad escapes) but returns it as failed_generation; the text is often still usable.
function salvageJson(text,schema){
  const value=String(text||'').trim();if(!value)return null;
  try{return jsonResult(value);}catch{/* fall through to the answer-field repair */}
  if(!schema?.properties?.answer)return null;
  // Cut-off output: read the answer string by hand up to the last complete character.
  const key=value.indexOf('"answer"');if(key<0)return null;
  const open=value.indexOf('"',value.indexOf(':',key)+1);if(open<0)return null;
  const BS=String.fromCharCode(92),NL=String.fromCharCode(10),raw=[];
  for(let i=open+1;i<value.length;i++){
    const c=value[i];
    if(c===BS){const n=value[i+1];if(n===undefined)break;raw.push(c,n);i++;continue;}
    if(c==='"')break;
    raw.push(c===NL?BS+'n':c);
  }
  let answer;try{answer=JSON.parse('"'+raw.join('')+'"');}catch{return null;}
  return answer.trim()?{answer,insufficient:/"insufficient": ?true/.test(value)}:null;
}
// Serialized LLM request with provider routing, quota waits and model failover; returns parsed JSON.
async function chat({name,schema,system,user,maxTokens=2500,maxWaitMs,model:modelOverride},signal,onWait,onDebug=()=>{}) {
  const run=queue.catch(()=>{}).then(async()=>{
    const share=Math.min(1,Math.max(0,Number(process.env.OPENROUTER_SHARE||.2)||0));
    const useOpenRouter=openRouterEnabled()&&(!providerConfigured('Groq')||(++evaluationCount%Math.max(1,Math.round(1/share)))===0);
    let provider=useOpenRouter?'OpenRouter':'Groq',attempts=0,networkAttempts=0,modelAttempts=0,jsonFails=0;
    while(true){
      const alternate=provider==='Groq'?'OpenRouter':'Groq',alternateConfigured=providerConfigured(alternate);
      if(!providerConfigured(provider)){if(!alternateConfigured)throw Error(llmMissing());provider=alternate;continue;}
      if(Date.now()<providerReadyAt(provider)&&alternateConfigured&&Date.now()>=providerReadyAt(alternate))provider=alternate;
      // Callers that cannot wait (web metadata) get the retry time instead of a long quota wait.
      if(maxWaitMs!==undefined&&providerReadyAt(provider)-Date.now()>maxWaitMs)throw Object.assign(Error(provider+' kota beklemesi sürüyor'),{retryAt:providerReadyAt(provider),quota:true});
      while(Date.now()<providerReadyAt(provider)){signal.throwIfAborted();const readyAt=providerReadyAt(provider);if(!Number.isFinite(readyAt))break;onWait(readyAt);await new Promise(r=>setTimeout(r,Math.min(1000,readyAt-Date.now())));}
      signal.throwIfAborted();
      const key=keyPool().acquire(poolName(provider));
      if(!key){providerNext[provider]=Math.max(providerNext[provider],Date.now()+1000);continue;}
      let response;const models=openRouterModels();const model=provider==='Groq'?(modelOverride||process.env.GROQ_MODEL||'openai/gpt-oss-120b'):models[openRouterModelIndex%models.length];
      const routedModels=provider==='OpenRouter'?models.map((_,index)=>models[(openRouterModelIndex+index)%models.length]).slice(0,3):[];
      const endpoint=provider==='Groq'?'https://api.groq.com/openai/v1/chat/completions':'https://openrouter.ai/api/v1/chat/completions';
      // After a Groq schema-validation failure (HTTP 400 json_validate_failed) the retry drops the strict schema; jsonResult() still parses the reply.
      const format=jsonFails&&provider==='Groq'?(/json/i.test(system+user)?{type:'json_object'}:null):modelFormat(provider,model,name,schema);
      const payload={...(provider==='OpenRouter'?{models:routedModels}:{model}),messages:[{role:'system',content:system},{role:'user',content:user}]};
      if(provider==='Groq')payload.max_completion_tokens=maxTokens;else payload.max_tokens=maxTokens;if(format)payload.response_format=format;
      // OpenRouter performs provider/model failover itself when `models` is supplied.
      // A mixed model list cannot safely share one provider-specific JSON schema.
      if(provider==='OpenRouter'&&routedModels.length>1)delete payload.response_format;
      onDebug({kind:'request',scope:'groq',provider,url:endpoint,model,models:routedModels,key:key.label,detail:provider==='OpenRouter'?`Otomatik model sırası: ${routedModels.join(' → ')}`:'',at:Date.now()});
      const timeoutMs=provider==='OpenRouter'?120000:60000;
      try{response=await fetch(endpoint,{
        method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]),headers:{'Content-Type':'application/json',Authorization:'Bearer '+key.key,...(provider==='OpenRouter'?{'HTTP-Referer':'http://localhost:4173','X-Title':'Kaynakca Masasi'}:{})},body:JSON.stringify(payload),
      });}catch(error){signal.throwIfAborted();const detail=requestErrorDetail(error,timeoutMs);keyPool().report(key.id,{status:0,error:detail,retryAfterMs:1000,gapMs:gapMs(provider)});onDebug({kind:'error',scope:'groq',provider,model,detail,at:Date.now()});if(provider==='OpenRouter'){openRouterModelIndex=(openRouterModelIndex+1)%models.length;modelAttempts++;}if(alternateConfigured&&Date.now()>=providerReadyAt(alternate)){provider=alternate;continue;}if(++networkAttempts>2)throw Error(provider+' bağlantısı kurulamadı: '+detail+'.');providerNext[provider]=Date.now()+2000*networkAttempts;onDebug({kind:'wait',scope:'groq',provider,model,detail,retryAt:providerNext[provider],at:Date.now()});continue;}
      networkAttempts=0;
      const rateHeaders={retryAfter:response.headers.get('retry-after')||'',resetTokens:response.headers.get('x-ratelimit-reset-tokens')||'',resetRequests:response.headers.get('x-ratelimit-reset-requests')||'',remainingTokens:response.headers.get('x-ratelimit-remaining-tokens')||'',remainingRequests:response.headers.get('x-ratelimit-remaining-requests')||''};
      onDebug({kind:'response',scope:'groq',provider,model,status:response.status,at:Date.now(),...rateHeaders});
      if(response.status===429||response.status>=500){const headerDelay=quotaDelay(response),fallback=provider==='OpenRouter'?3000:60000;const delay=Math.max(1000,Number.isFinite(headerDelay)?headerDelay:Math.min(900000,fallback*2**Math.min(attempts++,4)));keyPool().report(key.id,{status:response.status,retryAfterMs:delay,gapMs:gapMs(provider)});onDebug({kind:'wait',scope:'groq',provider,model,status:response.status,key:key.label,detail:provider==='OpenRouter'?'OpenRouter tüm model alternatiflerinden yanıt alamadı. Model sırası değiştirilecek.':'',retryAt:Date.now()+delay,at:Date.now(),...rateHeaders});await response.body?.cancel();if(provider==='OpenRouter'){openRouterModelIndex=(openRouterModelIndex+1)%models.length;modelAttempts++;}if(Date.now()<providerReadyAt(provider)&&alternateConfigured&&Date.now()>=providerReadyAt(alternate))provider=alternate;continue;}
      // A refused key (401/403) is marked invalid in the pool; the request goes on with the next key or provider.
      if(response.status===401||response.status===403){keyPool().report(key.id,{status:response.status,error:'HTTP '+response.status});onDebug({kind:'error',scope:'groq',provider,model,status:response.status,key:key.label,detail:'Anahtar sağlayıcı tarafından reddedildi.',at:Date.now()});await response.body?.cancel();if(!providerConfigured(provider)&&!alternateConfigured)throw Error(provider+' HTTP '+response.status+'; anahtar sağlayıcı tarafından reddedildi, Yönetim → API anahtarları sayfasından kontrol edin.');continue;}
      if(!response.ok){let providerDetail='',errorCode='',failedGeneration='';try{const errorBody=await response.text();const parsed=JSON.parse(errorBody);errorCode=String(parsed?.error?.code||'');failedGeneration=String(parsed?.error?.failed_generation||'');providerDetail=String(parsed?.error?.message||parsed?.message||'').slice(0,500);}catch{await response.body?.cancel();}keyPool().report(key.id,{status:response.status,error:providerDetail,retryAfterMs:1000,gapMs:gapMs(provider)});onDebug({kind:'error',scope:'groq',provider,model,status:response.status,detail:providerDetail||'İstek reddedildi',at:Date.now()});if(provider==='Groq'&&response.status===400&&(errorCode==='json_validate_failed'||/Failed to (?:validate|generate) JSON/i.test(providerDetail))){const salvaged=salvageJson(failedGeneration,schema);if(salvaged){onDebug({kind:'error',scope:'groq',provider,model,detail:'Şemaya uymayan çıktıdan JSON kurtarıldı.',at:Date.now()});return {result:salvaged,provider,model,usage:null,keyLabel:key.label};}if(++jsonFails<=2)continue;}if(provider==='OpenRouter'&&[400,404,422].includes(response.status)&&++modelAttempts<models.length){openRouterModelIndex=(openRouterModelIndex+1)%models.length;continue;}if(alternateConfigured&&Date.now()>=providerReadyAt(alternate)){provider=alternate;continue;}throw Error(provider+' HTTP '+response.status+'; '+(providerDetail||'erişim/model ayarını kontrol edin.'));}
      const body=await response.json();
      keyPool().report(key.id,{ok:true,tokens:{prompt:body.usage?.prompt_tokens,completion:body.usage?.completion_tokens},gapMs:gapMs(provider,Math.max(body.usage?.total_tokens||(body.usage?.prompt_tokens||0)+(body.usage?.completion_tokens||0)||0,(body.usage?.prompt_tokens||Math.ceil((system.length+user.length)/3))+Math.min(maxTokens,1500)))});
      try{return {result:jsonResult(body.choices?.[0]?.message?.content),provider,model,usage:body.usage||null,keyLabel:key.label};}catch(error){onDebug({kind:'error',scope:'groq',provider,model,detail:error.message,at:Date.now()});if(provider==='OpenRouter'&&++modelAttempts<models.length){openRouterModelIndex=(openRouterModelIndex+1)%models.length;continue;}if(alternateConfigured&&Date.now()>=providerReadyAt(alternate)){provider=alternate;continue;}throw error;}
    }
  });queue=run;return run;
}
// LLM requests go to the LLM service queue when a transport is installed, otherwise straight to the provider.
let chatTransport=null;
function useChatTransport(transport){chatTransport=transport;}
function llmAvailable(){return chatTransport?chatTransport.available():providerConfigured('Groq')||providerConfigured('OpenRouter');}
const llmMissing=()=>chatTransport?'Kuyrukta anahtarı yapılandırılmış bir LLM servisi yok; LLM servisini başlatın.':'Etkin bir Groq veya OpenRouter API anahtarı yok. Yönetim → API anahtarları sayfasından ekleyin veya .env dosyasına GROQ_API_KEY / OPENROUTER_API_KEY yazın.';
// Every model call reports the tokens it used to the operation that is running (see lib/usage-context.cjs).
const llmChat=async(spec,signal,onWait,onDebug)=>{
  // Timing for the reports: the whole call, and how much of it was spent waiting for provider quota (onWait ticks about once a second).
  const started=Date.now(),operation=UsageContext.als.getStore();let waited=0,lastTick=0;
  const tracked=at=>{const t=Date.now();waited+=lastTick&&t-lastTick<=1500?t-lastTick:1000;lastTick=t;return onWait?.(at);};
  const report=(status,out,usage,error)=>{try{Metrics.defaultMetrics().llm({operationId:operation?.id||null,userId:operation?.userId||null,name:spec.name,provider:out?.provider,model:out?.model,status,durationMs:Date.now()-started,waitMs:waited,promptTokens:usage?.prompt||0,completionTokens:usage?.completion||0,error:error?.message});}catch{/* best effort */}};
  let out;
  try{out=await(chatTransport?chatTransport.chat(spec,signal,tracked,onDebug):chat(spec,signal,tracked,onDebug));}
  catch(error){report(signal?.aborted?'cancelled':'error',null,null,error);throw error;}
  const usage=UsageContext.fromUsage(out.usage,{promptChars:String(spec.system||'').length+String(spec.user||'').length,completionChars:JSON.stringify(out.result??'').length});
  UsageContext.record({kind:'chat',provider:out.provider,model:out.model,...usage});
  report('ok',out,usage);
  return out;
};
async function evaluateBatch(citation,text,signal,onWait,onDebug=()=>{}) {
  if(!llmAvailable()) throw Error(llmMissing());
  if(citation.sentence.length>5000) throw Error('Atıf cümlesi çok uzun; bağlam bölümünü düzenleyip tekrar deneyin.');
  const context=citation.context.map(s=>s.slice(0,2000));
  const passages=text.evidencePassages||selectPassages(text,citation.context);
  if(!passages.length) throw Error('Okunabilir yayın metni yok; tarama PDF için OCR gerekli.');
  const user=JSON.stringify({targetCitation:{authors:citation.authorText||citation.text||'',year:citation.year||'',publicationTitle:text.title},citationSentence:citation.sentence,context,publicationTitle:text.title,evidenceScope:text.abstractOnly?'ABSTRACT ONLY: conclusions must be limited to this abstract; lack of evidence does not establish absence in the full publication.':'Selected full-text passages',passages:passages.map(({id,location,text})=>({id,location,text}))});
  const {result,provider,model}=await llmChat({name:'citation_evidence',schema,system:Prompts.get('citation_evidence'),user,maxTokens:2500},signal,onWait,onDebug);
  if(!Array.isArray(result.claims)||!result.claims.length) throw Error('Model iddia değerlendirmesi sağlamadı.');
  const valid=new Set(['supported','partial','contradicted','not_found','unassessable']);
  const modelVerdict=result.verdict;let rejected=0;
  for(const claim of result.claims){
    if(!valid.has(claim.verdict))throw Error('Model karar biçimi geçersiz.');
    if(['supported','partial','contradicted'].includes(claim.verdict)){
      const passage=passages.find(p=>p.id===claim.passage);
      if(!passage||typeof claim.quote!=='string'||!claim.quote.trim()||claim.quote.length>250||!evidenceKey(passage.text).includes(evidenceKey(claim.quote))){
        claim.verdict='unassessable';claim.quote='';claim.passage='';rejected++;
        claim.evidenceError='Modelin kanıt alıntısı belirtilen yayın pasajında doğrulanamadı veya alıntı sınırını aştı.';
      }else claim.location=passage.location;
    }else{claim.quote='';claim.passage='';}
  }
  const vs=result.claims.map(c=>c.verdict);
  result.verdict=vs.includes('contradicted')?'contradicted':vs.every(v=>v==='supported')?'supported':vs.some(v=>v==='supported'||v==='partial')?'partial':vs.includes('unassessable')?'unassessable':'not_found';
  if(rejected||modelVerdict!==result.verdict){const labels={supported:'Bütün iddialar doğrulanmış pasajlarla desteklendi.',partial:'İddiaların yalnız bir bölümü için geçerli destek bulundu.',contradicted:'En az bir iddia doğrulanmış yayın pasajıyla çelişiyor.',unassessable:'Geçerli kanıt sağlanamadığı için değerlendirme tamamlanamadı.',not_found:'Seçilen pasajlarda destek bulunamadı; tüm yayında yokluk sonucu çıkarılamaz.'};result.explanation=labels[result.verdict]+(rejected?' '+rejected+' iddianın kanıt alıntısı doğrulanamadı.':'');}
  onDebug({kind:'success',scope:'groq',provider,model,verdict:result.verdict,at:Date.now()});
  return {...result,abstractOnly:!!text.abstractOnly,access:text.access,url:text.url||'',identity:text.identity,license:text.license||'',contextTruncated:context.some((v,i)=>v!==citation.context[i]),retrieval:text.abstractOnly?'Yalnız özet incelendi; sonuç tam yayına genellenemez.':'Seçilen yayın pasajları incelendi; tüm yayında yokluk kanıtı değildir.',passages:passages.map(({id,location})=>({id,location}))};
}

// Passage retrieval: BM25 ranking lets the most relevant sections reach the LLM first.
const TR_WORDS=new Set('ve bir bu ile için olarak gibi daha olan da de çok ise ancak göre kadar veya ayrıca şekilde arasında üzerinde'.split(' '));
const EN_WORDS=new Set('the and of to in that is for with are as this by from were was which their these be or on'.split(' '));
const STOP_WORDS=new Set([...TR_WORDS,...EN_WORDS,...'have has been also can may not but such than into between using used based study studies paper results show shows olan olarak cok icin gore kadar ayrica sekilde arasinda uzerinde calisma calismada calismalar arastirma'.split(' ')]);
function language(value){
  const text=String(value||'').slice(0,6000),words=text.toLowerCase().split(/[^\p{L}]+/u);let tr=(text.match(/[ğışİĞŞ]/g)||[]).length,en=0;
  for(const w of words){if(TR_WORDS.has(w))tr++;if(EN_WORDS.has(w))en++;}
  return tr>en?'tr':en>tr?'en':'';
}
function retrievalTerms(value){
  const text=String(value||'');
  const numbers=(text.match(/\d+(?:[.,]\d+)?/g)||[]).filter(n=>!/^(?:19|20)\d\d$/.test(n)).map(n=>'#'+n.replace(',','.'));
  const words=Engine.normalizeTitle(text).split(' ').filter(w=>w.length>2&&!/^\d+$/.test(w)&&!STOP_WORDS.has(w)).map(w=>w.length>6?w.slice(0,6):w);
  return [...words,...numbers];
}
function queryWeights(citation,expansion=[]){
  const weights=new Map();
  const add=(value,weight)=>{for(const term of new Set(retrievalTerms(value))){const w=term.startsWith('#')?weight*2:weight;if(w>(weights.get(term)||0))weights.set(term,w);}};
  add(citation.sentence,1);for(const value of citation.context||[])if(value!==citation.sentence)add(value,.3);for(const value of expansion)add(value,.9);
  return weights;
}
function rankPassages(passages,weights){
  const docs=passages.map((p,index)=>{const tf=new Map(),terms=retrievalTerms(p.text);for(const t of terms)tf.set(t,(tf.get(t)||0)+1);return {p,index,tf,length:terms.length||1};});
  const average=docs.reduce((n,d)=>n+d.length,0)/(docs.length||1),df=new Map();
  for(const d of docs)for(const t of d.tf.keys())df.set(t,(df.get(t)||0)+1);
  return docs.map(d=>{let score=0;for(const [t,w] of weights){const f=d.tf.get(t);if(!f)continue;const n=df.get(t);score+=w*Math.log(1+(docs.length-n+.5)/(n+.5))*f*2.2/(f+1.2*(.25+.75*d.length/average));}return {passage:d.p,index:d.index,score};})
    .sort((a,b)=>b.score-a.score||a.index-b.index);
}
const BATCH_CHARACTERS=12000;
function planBatches(passages,ranked){
  const order=ranked,batches=[];let batch=[],size=0;
  for(const item of order){if(size+item.passage.text.length>BATCH_CHARACTERS&&batch.length){batches.push(batch);batch=[];size=0;}batch.push(item);size+=item.passage.text.length;}
  if(batch.length)batches.push(batch);
  return batches.map(b=>b.sort((x,y)=>x.index-y.index).map(x=>x.passage));
}
const expansionSchema={type:'object',additionalProperties:false,required:['terms'],properties:{terms:{type:'array',items:{type:'string'}}}};
const expansionCache=new Map();
function queryExpansionEnabled(){return !/^(?:false|0|no|off)$/i.test(String(process.env.CONTENT_QUERY_EXPANSION??'true').trim());}
async function expandQuery(citation,text,targetLanguage,signal,onWait,onDebug){
  const key=targetLanguage+'\u0000'+citation.sentence+'\u0000'+(text.title||'');
  if(expansionCache.has(key))return expansionCache.get(key);
  const stored=Cache.defaultCache().getTerms(key);
  if(stored){expansionCache.set(key,stored);return stored;}
  const system=Prompts.get('search_terms');
  const user=JSON.stringify({citationSentence:citation.sentence.slice(0,2000),publicationTitle:text.title||'',publicationLanguage:targetLanguage==='en'?'English':'Turkish'});
  const {result}=await llmChat({name:'search_terms',schema:expansionSchema,system,user,maxTokens:1200},signal,onWait,onDebug);
  const terms=(Array.isArray(result.terms)?result.terms:[]).filter(t=>typeof t==='string'&&t.trim()).map(t=>t.trim().slice(0,80)).slice(0,30);
  if(expansionCache.size>=500)expansionCache.delete(expansionCache.keys().next().value);
  expansionCache.set(key,terms);Cache.defaultCache().putTerms(key,terms);return terms;
}

// Neither the publication's own abstract nor its reference list is evidence for a citation, so full-text scans leave both out.
const BIBLIOGRAPHY_HEADING=/^\s*(?:(?:[IVX]+|\d+)[.)\s]+)?(?:REFERENCES(?:\s+AND\s+NOTES)?|BIBLIOGRAPHY|LITERATURE\s+CITED|WORKS\s+CITED|KAYNAKÇA|KAYNAKLAR|KAYNAKÇA\s+LİSTESİ)\s*:?\s*$/i;
const ABSTRACT_START=/^\s*(?:ABSTRACT|ÖZET|ÖZ)\s*(?:$|[:.\-—–]\s*\S)/i;
const ABSTRACT_END=/^\s*(?:(?:[IVX]+|\d+)[.)\s]+)?(?:KEY\s?WORDS?|INDEX\s+TERMS|ANAHTAR\s+KELİMELER|INTRODUCTION|GİRİŞ|BACKGROUND)\b/i;
function publicationPassages(text){
  const output=[];let bibliography=false,abstractDone=!!text.abstractOnly,inAbstract=false,skipped=0;
  for(const page of text.passages||[]){
    const lines=String(page.text||'').split(/\n/);const kept=[];
    for(const line of lines){
      if(BIBLIOGRAPHY_HEADING.test(line)){bibliography=true;continue;}
      if(bibliography&&/^\s*(?:APPENDIX|APPENDICES|SUPPLEMENTARY MATERIAL)\b/i.test(line))bibliography=false;
      if(bibliography)continue;
      if(!abstractDone){
        if(!inAbstract&&ABSTRACT_START.test(line)){inAbstract=true;skipped=0;}
        if(inAbstract){
          if(ABSTRACT_END.test(line)||(!line.trim()&&skipped>=150)||skipped>3000){inAbstract=false;abstractDone=true;if(ABSTRACT_END.test(line)&&!/^\s*(?:KEY\s?WORDS?|INDEX\s+TERMS|ANAHTAR\s+KELİMELER)/i.test(line))kept.push(line);continue;}
          skipped+=line.length+1;continue;
        }
      }
      kept.push(line);
    }
    const body=kept.join('\n');
    for(let start=0;start<body.length;start+=2000){const value=body.slice(start,start+2400).trim();if(value)output.push({id:'P'+(output.length+1),location:page.location,text:value});}
  }
  return output;
}
async function evaluate(citation,text,signal,onWait,onDebug=()=>{}){
  const all=publicationPassages(text);if(!all.length)throw Error('Okunabilir yayın metni yok; tarama PDF için OCR gerekli.');
  const characters=all.reduce((n,p)=>n+p.text.length,0);let expansion=[];
  if(characters>BATCH_CHARACTERS&&queryExpansionEnabled()&&llmAvailable()){
    const source=language(citation.sentence),target=language(all.map(p=>p.text).join(' '));
    if(source&&target&&source!==target){
      try{expansion=await expandQuery(citation,text,target,signal,onWait,onDebug);onDebug({kind:'info',scope:'groq',provider:'İçerik taraması',detail:'Atıf iddiası yayın diline çevrilerek arandı: '+expansion.slice(0,10).join(', '),at:Date.now()});}
      catch(error){if(signal.aborted)throw error;onDebug({kind:'info',scope:'groq',provider:'İçerik taraması',detail:'Arama terimleri çevrilemedi; sözcük eşleşmesiyle sıralanıyor: '+error.message,at:Date.now()});}
    }
  }
  const batches=planBatches(all,rankPassages(all,queryWeights(citation,expansion)));
  const results=[],evidence=new Map(),evidenceBatches=new Set();let earlyStop=false,screenedOut=0;
  const screening=batches.length>1&&screeningEnabled()&&llmAvailable();
  const evaluateAt=async(i,label)=>{
    const result=await evaluateBatch(citation,{...text,evidencePassages:batches[i]},signal,onWait,onDebug);results.push(result);
    for(const claim of result.claims)if(claim.passage&&claim.quote){const source=all.find(p=>p.id===claim.passage);if(source){evidence.set(source.id,source);evidenceBatches.add(results.length-1);}}
    return result;
  };
  for(let i=0;i<batches.length;i++){
    signal.throwIfAborted();onDebug({kind:'info',scope:'groq',provider:'İçerik taraması',detail:'Yayın metni bölüm '+(i+1)+'/'+batches.length+' inceleniyor'+(batches.length>1?' (alaka sırasına göre)':''),at:Date.now()});
    // A cheaper model decides first whether this section can matter at all; only relevant sections reach the main model.
    // A failed screening counts as "relevant", so it can only cost tokens, never lose evidence.
    if(screening){
      const relevant=await screenBatch(citation,batches[i],signal,onWait,onDebug).catch(error=>{signal.throwIfAborted();onDebug({kind:'info',scope:'groq',provider:'İçerik taraması',detail:'Ön eleme yapılamadı, bölüm doğrudan inceleniyor: '+error.message,at:Date.now()});return true;});
      if(!relevant){screenedOut++;onDebug({kind:'info',scope:'groq',provider:'İçerik taraması',detail:'Bölüm '+(i+1)+' ön elemede ilgisiz bulundu; ana modele gönderilmedi',at:Date.now()});continue;}
    }
    const result=await evaluateAt(i);
    // Full support with verified quotes ends the scan; other verdicts keep searching the remaining sections.
    if(result.verdict==='supported'&&i<batches.length-1){earlyStop=true;onDebug({kind:'info',scope:'groq',provider:'İçerik taraması',detail:'Destek bulundu; kalan '+(batches.length-i-1)+' bölüm için LLM isteği gönderilmedi',at:Date.now()});break;}
  }
  // If screening dismissed every section, the best-ranked one still gets the main model before concluding anything.
  if(!results.length){signal.throwIfAborted();await evaluateAt(0);}
  let result=results[0];
  if(evidenceBatches.size===1)result=results[[...evidenceBatches][0]];
  // Evidence in several sections is combined here, without another model call.
  else if(evidenceBatches.size>1)result=mergeEvidence([...evidenceBatches].sort((a,b)=>a-b).map(i=>results[i]));
  else if(results.length>1){const uncertain=results.some(r=>r.verdict==='unassessable');result={...result,verdict:uncertain?'unassessable':'not_found',claims:results.flatMap(r=>r.claims),explanation:uncertain?'Bazı bölümlerde değerlendirme tamamlanamadı; yayında destek olmadığı sonucuna varılamaz.':(screenedOut?'İncelenen bölümlerde':'Erişilen yayın metninin kaynakça dışındaki bölümleri tarandı;')+' bu atfa ilişkin destek bulunamadı.'};}
  const screenNote=screenedOut?` ${batches.length} bölümden ${screenedOut}'i ön elemede ilgisiz bulunarak ana modele gönderilmedi.`:'';
  const retrieval=text.abstractOnly?'Yalnız erişilen özet tarandı; tam yayına genellenemez.':earlyStop?`Alaka sırasına göre taranan ${results.length}/${batches.length} bölümde doğrulanmış destek bulundu; kalan bölümler gerekmediği için gönderilmedi.${screenNote}`:'Erişilen metnin kaynakça dışındaki tüm bölümleri tarandı. PDF metin çıkarımında kaybolan tablo ve görseller bu kapsama dahil değildir.'+screenNote;
  return {...result,analysisVersion:2,coverage:{batches:batches.length,scannedBatches:results.length,screenedOut,earlyStop,queryExpansion:expansion.length>0,passages:all.length,characters},retrieval};
}

// ---- cheap pre-screening of long publications, and the local merge of evidence found in several sections
const screenSchema={type:'object',additionalProperties:false,required:['relevant'],properties:{relevant:{type:'boolean'}}};
function screeningEnabled(){return !/^(?:false|0|no|off)$/i.test(String(process.env.CONTENT_SCREENING??'true').trim());}
const screenModel=()=>String(process.env.GROQ_SCREEN_MODEL||'openai/gpt-oss-20b').trim();
async function screenBatch(citation,passages,signal,onWait,onDebug){
  const user=JSON.stringify({citationSentence:citation.sentence.slice(0,2000),passages:passages.map(({id,text})=>({id,text}))});
  const {result}=await llmChat({name:'batch_screen',schema:screenSchema,system:Prompts.get('batch_screen'),user,maxTokens:200,model:screenModel()},signal,onWait,onDebug);
  return result?.relevant!==false;
}
const claimTokens=value=>new Set(Engine.normalizeTitle(String(value||'')).split(' ').filter(w=>w.length>3));
function similarClaims(a,b){const x=claimTokens(a),y=claimTokens(b);if(!x.size||!y.size)return false;let shared=0;for(const w of x)if(y.has(w))shared++;return shared/Math.min(x.size,y.size)>=.6;}
function mergeEvidence(results){
  const withEvidence=[],seen=new Set();
  for(const result of results)for(const claim of result.claims)if(['supported','partial','contradicted'].includes(claim.verdict)){const key=claim.verdict+'|'+claim.passage+'|'+claim.quote;if(!seen.has(key)){seen.add(key);withEvidence.push(claim);}}
  // A claim without evidence stays visible unless another section did support or contradict the same statement.
  const open=results.flatMap(r=>r.claims).filter(c=>!['supported','partial','contradicted'].includes(c.verdict)&&!withEvidence.some(e=>similarClaims(e.claim,c.claim)));
  const claims=[...withEvidence,...open.filter((c,i)=>open.findIndex(o=>similarClaims(o.claim,c.claim))===i)];
  const vs=claims.map(c=>c.verdict);
  const verdict=vs.includes('contradicted')?'contradicted':vs.every(v=>v==='supported')?'supported':vs.some(v=>v==='supported'||v==='partial')?'partial':vs.includes('unassessable')?'unassessable':'not_found';
  const explanations=[...new Set(results.map(r=>String(r.explanation||'').trim()).filter(Boolean))].join(' ').slice(0,900);
  const passages=[...new Map(results.flatMap(r=>r.passages||[]).map(p=>[p.id,p])).values()];
  return {...results[0],verdict,claims,passages,explanation:`Kanıtlar ${results.length} ayrı bölümde bulundu ve birleştirildi. ${explanations}`.trim()};
}

module.exports={chat,llmChat,useChatTransport,llmAvailable,llmMissing,publicationPassages,rankPassages,planBatches,queryWeights,language,publicIp,remote,referenceUrl,referenceTitle,extractHtml,semanticRecord,unpaywallRecord,fullText,preprintNotice,selectPassages,evaluate,openRouterEnabled,openRouterModels,jsonResult};
