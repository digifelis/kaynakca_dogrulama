const Prompts=require('./lib/prompts.cjs');
const Web=require('./web-reference.js');
const KeyPool=require('./lib/key-pool.cjs');
let nextRequest=0;
function durationMs(value,now=Date.now){
  const text=String(value||'').trim();
  if(/^\d+(?:\.\d+)?$/.test(text))return Number(text)*1000;
  const parts=text.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/i);
  if(parts&&(parts[1]||parts[2]||parts[3]))return ((Number(parts[1]||0)*3600)+(Number(parts[2]||0)*60)+Number(parts[3]||0))*1000;
  const date=Date.parse(text);return Number.isFinite(date)?date-now():NaN;
}
function quotaDelay(response,now=Date.now){
  const retry=durationMs(response.headers.get('retry-after'),now);
  if(Number.isFinite(retry))return retry;
  const resets=['tokens','requests'].map(kind=>durationMs(response.headers.get('x-ratelimit-reset-'+kind),now)).filter(Number.isFinite);
  return resets.length?Math.min(...resets):NaN;
}
const fields=['title','author','published','modified','site'];
const field={type:'object',additionalProperties:false,required:['value','quote'],properties:{value:{type:'string'},quote:{type:'string'}}};
const schema={type:'object',additionalProperties:false,required:fields,properties:Object.fromEntries(fields.map(k=>[k,field]))};
const key=v=>Web.clean(v).normalize('NFKC').toLocaleLowerCase('en-US');
function merge(page,result,text){
  const next={...page,evidence:[...(page.evidence||[])],warnings:[...(page.warnings||[])],authors:[...(page.authors||[])]};
  const labels={title:'Başlık',author:'Yazar',published:'Yayın tarihi',modified:'Güncelleme tarihi',site:'Site'};
  for(const name of fields){
    if(name==='author'?next.authors.length:next[name]&&(name!=='published'&&name!=='modified'||Web.dateParts(next[name])))continue;
    const item=result?.[name];if(!item?.value)continue;
    let valid=typeof item.value==='string'&&item.value.length<=1000&&typeof item.quote==='string'&&item.quote.trim().length>0&&item.quote.length<=500&&key(text).includes(key(item.quote));
    if(valid&&['published','modified'].includes(name)){
      const a=Web.dateParts(item.value),b=Web.dateParts(item.quote);
      valid=!!a&&!!b&&['year','month','day'].every(k=>a[k]===b[k])&&!/©|copyright|telif|all rights reserved/i.test(item.quote);
      valid&&=name==='published'?/publish|yayın|yayıml|posted|datePublished/i.test(item.quote):/updat|modif|güncell|dateModified/i.test(item.quote);
    }else if(valid){valid=key(item.quote).includes(key(item.value));if(name==='author')valid&&=/\bby\b|written|author|yazar|yazan|tarafından/i.test(item.quote)&&!/reviewed by|reviewer|editör|editor|yorum/i.test(item.quote);}
    if(!valid){next.warnings.push('Groq '+labels[name].toLowerCase()+' önerisi sayfa kanıtıyla doğrulanamadı.');continue;}
    if(name==='author')next.authors=[{name:Web.clean(item.value),type:'Person'}];else next[name]=Web.clean(item.value);
    next.evidence.push({field:labels[name],value:Web.clean(item.value),source:'Groq · sayfa metninde doğrulanan alıntı: '+item.quote});
    next.groqEnriched=true;
  }
  return next;
}
const system=()=>Prompts.get('web_metadata');
const userMessage=(page,text)=>JSON.stringify({url:page.url,known:{title:page.title,authors:page.authors,published:page.published,modified:page.modified,site:page.site},text});
// With an LLM transport (queue mode) the LLM service holds the key and the quota state; a quota wait returns at once.
let transport=null;
function useTransport(value){transport=value;}
async function enrichVia(page,text,signal){
  if(!transport.available())return {...page,warnings:[...(page.warnings||[]),'Eksik alanlar için anahtarı yapılandırılmış bir LLM servisi bulunamadı.']};
  try{const {result}=await transport.chat({name:'web_metadata',schema,system:system(),user:userMessage(page,text),maxTokens:1800,maxWaitMs:0},signal,()=>{},()=>{});return merge(page,result,text);}
  catch(e){signal?.throwIfAborted();return {...page,groqRetryAt:e.retryAt,warnings:[...(page.warnings||[]),e.retryAt?'LLM hız/kota beklemesi sürüyor. Bulunan metadata ile kısmi öneri hazırlandı; daha sonra yeniden doğrulayabilirsiniz.':'LLM incelemesi tamamlanamadı; bulunan alanlarla kısmi öneri hazırlandı.']};}
}
async function enrich(page,text,signal,{request=fetch,now=Date.now}={}){
  if(transport)return enrichVia(page,text,signal);
  const keys=KeyPool.pool({env:process.env,now});
  if(!keys.hasUsable('groq'))return {...page,warnings:[...(page.warnings||[]),'Eksik alanlar için Groq anahtarı yapılandırılmamış.']};
  nextRequest=keys.nextAvailableAt('groq');
  const key=nextRequest===0?keys.acquire('groq'):null;
  if(!key)return {...page,groqRetryAt:nextRequest||now()+1000,warnings:[...(page.warnings||[]),'Groq hız/kota beklemesi sürüyor. Bulunan metadata ile kısmi öneri hazırlandı; daha sonra yeniden doğrulayabilirsiniz.']};
  try{
    const response=await request('https://api.groq.com/openai/v1/chat/completions',{method:'POST',redirect:'error',signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(25000)]),headers:{'Content-Type':'application/json',Authorization:'Bearer '+key.key},body:JSON.stringify({model:process.env.GROQ_MODEL||'openai/gpt-oss-120b',max_completion_tokens:1800,response_format:{type:'json_schema',json_schema:{name:'web_bibliography',strict:true,schema}},messages:[
      {role:'system',content:system()},
      {role:'user',content:userMessage(page,text)}
    ]})});
    if(!response.ok){const delay=quotaDelay(response,now);keys.report(key.id,{status:response.status,retryAfterMs:response.status===429||response.status>=500?Math.max(1000,Number.isFinite(delay)?delay:60000):1000});nextRequest=keys.nextAvailableAt('groq');await response.body?.cancel();throw Error('Groq HTTP '+response.status);}
    const body=await response.json();keys.report(key.id,{ok:true,tokens:{prompt:body.usage?.prompt_tokens,completion:body.usage?.completion_tokens}});return merge(page,JSON.parse(body.choices[0].message.content),text);
  }catch(e){signal?.throwIfAborted();return {...page,groqRetryAt:nextRequest,warnings:[...(page.warnings||[]),e.message.startsWith('Groq HTTP')?e.message+'; bulunan alanlarla kısmi öneri hazırlandı.':'Groq incelemesi tamamlanamadı; bulunan alanlarla kısmi öneri hazırlandı.']};}
}
module.exports={enrich,merge,useTransport};
