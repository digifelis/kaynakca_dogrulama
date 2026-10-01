const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');
function fixture(handler,env={}){let now=100000,calls=0;const urls=[];const context={require:id=>require(id.startsWith('./')?path.join(__dirname,'..',id):id),module:{exports:{}},process:{env:{GROQ_API_KEY:'test-only',GROQ_MODEL:'openai/gpt-oss-120b',...env}},URL,Buffer,AbortSignal,
 Date:{now:()=>now,parse:Date.parse},setTimeout:(fn,ms)=>{now+=ms;queueMicrotask(fn);},fetch:async(url,options)=>{calls++;urls.push(url);return handler(calls,now,options,url);}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../word-content.cjs'),'utf8'),context);return {api:context.module.exports,urls,get calls(){return calls;},get now(){return now;}};}
const citation={sentence:'Çalışmaya 120 yetişkin katıldı.',context:['Önceki cümle.','Çalışmaya 120 yetişkin katıldı.']};
const publication={passages:[{text:'Çalışmada 120 yetişkin incelendi.',location:'Sayfa 1'}],title:'Yapay örnek',access:'Test metni'};
const response=claims=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({verdict:'supported',explanation:'Test',claims})}}]}));
test('OpenRouter sends at most three alternatives and rotates the fourth into retries',async()=>{
 const sent=[];
 const f=fixture((calls,now,options)=>{
   const models=JSON.parse(options.body).models;sent.push(models);assert.ok(models.length<=3);
   if(calls===1)return new Response('{}',{status:503});
   return response([{claim:'120 yetişkin',verdict:'supported',passage:'P1',quote:'Çalışmada 120 yetişkin incelendi.'}]);
 },{GROQ_API_KEY:'',OPENROUTER_API_KEY:'or-test',OPENROUTER_MODELS:'qwen/first:free,google/second:free,cohere/third:free,nvidia/fourth:free'});
 const result=await f.api.evaluate(citation,publication,new AbortController().signal,()=>{});
 assert.equal(result.verdict,'supported');assert.deepEqual(sent[0],['qwen/first:free','google/second:free','cohere/third:free']);assert.deepEqual(sent[1],['google/second:free','cohere/third:free','nvidia/fourth:free']);
});
test('OpenRouter headers pass native Fetch validation while Turkish evidence stays intact',async()=>{
 const f=fixture((calls,now,options,url)=>{
   const request=new Request(url,options);
   assert.equal(request.headers.get('x-title'),'Kaynakca Masasi');
   assert.equal(JSON.parse(JSON.parse(options.body).messages[1].content).citationSentence,citation.sentence);
   return response([{claim:'120 yetişkin',verdict:'supported',passage:'P1',quote:'Çalışmada 120 yetişkin incelendi.'}]);
 },{GROQ_API_KEY:'',OPENROUTER_API_KEY:'or-test'});
 const result=await f.api.evaluate(citation,publication,new AbortController().signal,()=>{});
 assert.equal(result.verdict,'supported');assert.equal(f.calls,1);
});
test('full publication scan reaches late evidence, excludes bibliography and identifies target citation',async()=>{
 const seen=[];const f=fixture((calls,now,options)=>{const payload=JSON.parse(options.body),input=JSON.parse(payload.messages[1].content);seen.push(input);assert.equal(input.targetCitation.authors,'Mu and Lin');assert.match(payload.messages[0].content,/ONLY the clause attributed to targetCitation/);const p=input.passages.find(p=>p.text.includes('We review MoE algorithms and system design.'));return response([{claim:'Mu and Lin cover MoE algorithms and systems',verdict:p?'supported':'not_found',passage:p?.id||'',quote:p?'We review MoE algorithms and system design.':''}]);});
 const text={title:'MoE survey',passages:[{location:'Page 1',text:'Other material. '.repeat(1400)},{location:'Page 2',text:'We review MoE algorithms and system design.'},{location:'Page 3',text:'REFERENCES\nBIBLIOGRAPHY_SENTINEL'}]};
 const result=await f.api.evaluate({...citation,authorText:'Mu and Lin',year:'2025'},text,new AbortController().signal,()=>{});
 assert.equal(result.verdict,'supported');assert.ok(result.coverage.batches>1);assert.equal(seen.length,result.coverage.scannedBatches);assert.equal(result.coverage.scannedBatches,result.coverage.batches);assert.ok(seen.every(input=>input.passages.every(p=>!p.text.includes('BIBLIOGRAPHY_SENTINEL'))));assert.equal(result.analysisVersion,2);
});
test('a failed publication batch cannot become a not-found conclusion',async()=>{
 const f=fixture((calls)=>{if(calls===2) return new Response('{}',{status:403});return response([{claim:'Claim',verdict:'not_found',passage:'',quote:''}]);});
 await assert.rejects(f.api.evaluate(citation,{passages:[{text:'Long publication text. '.repeat(1500),location:'Page 1'}]},new AbortController().signal,()=>{}),/403/);
});
test('semantic decisions require exact bounded evidence; invented quotes are rejected',async()=>{
 const f=fixture(()=>response([{claim:'120 yetişkin',verdict:'supported',passage:'P1',quote:'Çalışmada 120 yetişkin incelendi.'},{claim:'Nedensellik',verdict:'supported',passage:'P1',quote:'Nedensellik kanıtlandı.'}]));
 const result=await f.api.evaluate(citation,publication,new AbortController().signal,()=>{});
 assert.equal(result.claims[0].verdict,'supported');assert.equal(result.claims[1].verdict,'unassessable');assert.equal(result.verdict,'partial');
 assert.equal(result.claims[0].location,'Sayfa 1');assert.equal(f.calls,1);
 assert.match(result.explanation,/yalnız bir bölümü/);assert.match(result.claims[1].evidenceError,/doğrulanamadı/);
});
test('PDF whitespace and ligatures are normalized without accepting invented evidence',async()=>{
 const f=fixture(()=>response([{claim:'Water',verdict:'supported',passage:'P1',quote:'water efficiency is 1.7 billion litres/day'}]));
 const text={title:'Test',access:'PDF',passages:[{location:'Sayfa 1',text:'water efﬁciency is 1.7\nbillion litres/day'}]};
 const r=await f.api.evaluate(citation,text,new AbortController().signal,()=>{});assert.equal(r.verdict,'supported');
 const invalid=fixture(()=>response([{claim:'Water',verdict:'supported',passage:'P1',quote:'water efficiency is 17 billion litres/day'}]));
 const rejected=await invalid.api.evaluate(citation,text,new AbortController().signal,()=>{});assert.equal(rejected.verdict,'unassessable');assert.match(rejected.explanation,/tamamlanamadı/);
});
test('Groq quota retries the same payload only after cooldown and continues',async()=>{
 let initial,at;const f=fixture((calls,now,options)=>{if(calls===1){initial=options.body;at=now;return new Response('{}',{status:429,headers:{'retry-after':'90'}});}assert.equal(options.body,initial);assert.ok(now>=at+90000);return response([{claim:'120 yetişkin',verdict:'supported',passage:'P1',quote:'Çalışmada 120 yetişkin incelendi.'}]);});
 const waits=[];const result=await f.api.evaluate(citation,publication,new AbortController().signal,t=>waits.push(t));assert.equal(result.verdict,'supported');assert.equal(f.calls,2);assert.ok(waits.length);
});
test('Groq reset headers control the wait instead of a fixed 60 second delay',async()=>{
 let firstAt,secondAt;
 const f=fixture((calls,now)=>{
   if(calls===1){firstAt=now;return new Response('{}',{status:429,headers:{'x-ratelimit-reset-tokens':'7.5s'}});}
   secondAt=now;return response([{claim:'120 yetişkin',verdict:'supported',passage:'P1',quote:'Çalışmada 120 yetişkin incelendi.'}]);
 });
 const waits=[];const result=await f.api.evaluate(citation,publication,new AbortController().signal,t=>waits.push(t));
 assert.equal(result.verdict,'supported');assert.equal(f.calls,2);assert.ok(secondAt>=firstAt+7500);assert.ok(secondAt<firstAt+60000);assert.ok(waits.length);
});
test('Groq denial is reported without retries, empty PDF cannot be evaluated',async()=>{
 const f=fixture(()=>new Response('{}',{status:403}));await assert.rejects(f.api.evaluate(citation,publication,new AbortController().signal,()=>{}),/403/);assert.equal(f.calls,1);
 await assert.rejects(f.api.evaluate(citation,{passages:[]},new AbortController().signal,()=>{}),/OCR/);assert.equal(f.calls,1);
});
test('cancelled quota wait does not issue another request',async()=>{
 const controller=new AbortController();const f=fixture(()=>new Response('{}',{status:429,headers:{'retry-after':'90'}}));
 await assert.rejects(f.api.evaluate(citation,publication,controller.signal,()=>controller.abort()));assert.equal(f.calls,1);
});
test('Groq 429 immediately falls back to OpenRouter and uses the requested free model',async()=>{
 const f=fixture((calls,now,options,url)=>calls===1?new Response('{}',{status:429,headers:{'retry-after':'90'}}):response([{claim:'120 yetişkin',verdict:'supported',passage:'P1',quote:'Çalışmada 120 yetişkin incelendi.'}]),{OPENROUTER_API_KEY:'or-test',OPENROUTER_SHARE:'0',OPENROUTER_MODELS:'qwen/qwen3.8-27b:free'});
 const result=await f.api.evaluate(citation,publication,new AbortController().signal,()=>{});assert.equal(result.verdict,'supported');assert.deepEqual(f.urls,['https://api.groq.com/openai/v1/chat/completions','https://openrouter.ai/api/v1/chat/completions']);
});
test('OpenRouter model configuration preserves all supplied free fallbacks',()=>{
 const f=fixture(()=>response([]),{OPENROUTER_MODELS:'qwen/qwen3.8-27b:free,nvidia/nemotron-3.5-content-safety:free,cohere/north-mini-code:free,google/gemma-4-31b-it:free'});
 assert.deepEqual(Array.from(f.api.openRouterModels()),['qwen/qwen3.8-27b:free','nvidia/nemotron-3.5-content-safety:free','cohere/north-mini-code:free','google/gemma-4-31b-it:free']);
});
test('OPENROUTER_ENABLED=false disables routing even when its key remains configured',async()=>{
 const f=fixture(()=>response([{claim:'120 yetişkin',verdict:'supported',passage:'P1',quote:'Çalışmada 120 yetişkin incelendi.'}]),{OPENROUTER_API_KEY:'or-test',OPENROUTER_ENABLED:'false',OPENROUTER_SHARE:'1'});
 assert.equal(f.api.openRouterEnabled(),false);await f.api.evaluate(citation,publication,new AbortController().signal,()=>{});assert.deepEqual(f.urls,['https://api.groq.com/openai/v1/chat/completions']);
 const disabledOnly=fixture(()=>response([]),{GROQ_API_KEY:'',OPENROUTER_API_KEY:'or-test',OPENROUTER_ENABLED:'false'});
 await assert.rejects(disabledOnly.api.evaluate(citation,publication,new AbortController().signal,()=>{}),/Etkin bir/);assert.equal(disabledOnly.calls,0);
});
test('OpenRouter sends its configured models as one automatic fallback chain',async()=>{
 let sent;
 const f=fixture((calls,now,options)=>{sent=JSON.parse(options.body);return response([{claim:'120 yetişkin',verdict:'supported',passage:'P1',quote:'Çalışmada 120 yetişkin incelendi.'}]);},{GROQ_API_KEY:'',OPENROUTER_API_KEY:'or-test',OPENROUTER_MODELS:'qwen/qwen3.8-27b:free,google/gemma-4-31b-it:free'});
 const result=await f.api.evaluate(citation,publication,new AbortController().signal,()=>{});
 assert.equal(result.verdict,'supported');assert.deepEqual(Array.from(sent.models),['qwen/qwen3.8-27b:free','google/gemma-4-31b-it:free']);assert.equal(sent.model,undefined);assert.equal(sent.response_format,undefined);
});
test('OpenRouter reports the actual network failure and rotates its model order',async()=>{
 const bodies=[],debug=[];let calls=0;
 const f=fixture((count,now,options)=>{bodies.push(JSON.parse(options.body));if(++calls===1){const error=Error('fetch failed');error.cause={code:'UND_ERR_CONNECT_TIMEOUT',message:'Connect Timeout Error'};throw error;}return response([{claim:'120 yetişkin',verdict:'supported',passage:'P1',quote:'Çalışmada 120 yetişkin incelendi.'}]);},{GROQ_API_KEY:'',OPENROUTER_API_KEY:'or-test',OPENROUTER_MODELS:'qwen/qwen3.8-27b:free,google/gemma-4-31b-it:free'});
 const result=await f.api.evaluate(citation,publication,new AbortController().signal,()=>{},event=>debug.push(event));
 assert.equal(result.verdict,'supported');assert.equal(bodies[0].models[0],'qwen/qwen3.8-27b:free');assert.equal(bodies[1].models[0],'google/gemma-4-31b-it:free');assert.match(debug.find(event=>event.kind==='error').detail,/120 saniye/);
});
test('PDF preprint statement is exposed as a bounded version warning',()=>{
 const f=fixture(()=>response([]));
 assert.equal(f.api.preprintNotice({passages:[{text:'Title. Preprint Statement: This is a non-peer reviewed preprint submitted to EarthArXiv. The manuscript is under review.'}]}),'This is a non-peer reviewed preprint submitted to EarthArXiv.');
 assert.equal(f.api.preprintNotice({passages:[{text:'Published journal article.'}]}),'');
});
test('relevance ranking sends the matching late section first and stops after verified support',async()=>{
 const seen=[];const f=fixture((calls,now,options)=>{const input=JSON.parse(JSON.parse(options.body).messages[1].content);seen.push(input);const p=input.passages.find(p=>p.text.includes('mixture-of-experts routing algorithms'));return response([{claim:'Routing review',verdict:p?'supported':'not_found',passage:p?.id||'',quote:p?'We review mixture-of-experts routing algorithms.':''}]);});
 const text={title:'MoE survey',passages:[{location:'Page 1',text:'Unrelated background material. '.repeat(1500)},{location:'Page 9',text:'We review mixture-of-experts routing algorithms.'}]};
 const result=await f.api.evaluate({sentence:'The survey covers mixture-of-experts routing algorithms.',context:['The survey covers mixture-of-experts routing algorithms.']},text,new AbortController().signal,()=>{});
 assert.equal(result.verdict,'supported');assert.equal(f.calls,1);assert.ok(result.coverage.batches>1);assert.equal(result.coverage.scannedBatches,1);assert.equal(result.coverage.earlyStop,true);assert.match(result.retrieval,/1\/\d+ bölümde/);
 assert.ok(seen[0].passages.some(p=>p.text.startsWith('Unrelated background')),'opening passage stays in the first batch');
});
test('cross-language citations are expanded into publication-language search terms once',async()=>{
 const kinds=[];const f=fixture((calls,now,options)=>{const payload=JSON.parse(options.body);if(payload.response_format?.json_schema?.name==='search_terms'){kinds.push('expand');return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({terms:['routing algorithms','mixture of experts']})}}]}));}
   kinds.push('evaluate');const input=JSON.parse(payload.messages[1].content);const p=input.passages.find(p=>p.text.includes('routing algorithms for mixture of experts'));return response([{claim:'Yönlendirme',verdict:p?'supported':'not_found',passage:p?.id||'',quote:p?'We study routing algorithms for mixture of experts.':''}]);});
 const text={title:'MoE survey',passages:[{location:'Page 1',text:'The model is trained on the data and evaluated in the lab. '.repeat(500)},{location:'Page 9',text:'We study routing algorithms for mixture of experts.'}]};
 const c={sentence:'Çalışma, uzman karışımı modellerinde yönlendirme algoritmalarını inceledi.',context:['Çalışma, uzman karışımı modellerinde yönlendirme algoritmalarını inceledi.']};
 const result=await f.api.evaluate(c,text,new AbortController().signal,()=>{});
 assert.equal(result.verdict,'supported');assert.deepEqual(kinds,['expand','evaluate']);assert.equal(result.coverage.queryExpansion,true);
 await f.api.evaluate(c,text,new AbortController().signal,()=>{});assert.deepEqual(kinds,['expand','evaluate','evaluate'],'expansion is cached');
});
test('query expansion failure falls back to lexical ranking and can be disabled',async()=>{
 const f=fixture((calls,now,options)=>{const payload=JSON.parse(options.body);if(payload.response_format?.json_schema?.name==='search_terms')return new Response(JSON.stringify({choices:[{message:{content:'not json'}}]}));return response([{claim:'x',verdict:'not_found',passage:'',quote:''}]);});
 const text={title:'T',passages:[{location:'Page 1',text:'The model is trained on the data and evaluated in the lab. '.repeat(500)}]};
 const c={sentence:'Bu çalışma yeni bir yöntem önerdi ve doğruladı.',context:[]};
 const result=await f.api.evaluate(c,text,new AbortController().signal,()=>{});assert.equal(result.verdict,'not_found');assert.equal(result.coverage.queryExpansion,false);assert.equal(result.coverage.scannedBatches,result.coverage.batches);
 const names=[];const off=fixture((calls,now,options)=>{names.push(JSON.parse(options.body).response_format?.json_schema?.name);return response([{claim:'x',verdict:'not_found',passage:'',quote:''}]);},{CONTENT_QUERY_EXPANSION:'false'});
 await off.api.evaluate(c,text,new AbortController().signal,()=>{});assert.ok(names.length>1);assert.ok(names.every(name=>name==='citation_evidence'));
});
test('retrieval terms match Turkish decimal commas, stems and ignore citation years',()=>{
 const f=fixture(()=>response([]));
 const passages=[{id:'P1',text:'Introduction text.'},{id:'P2',text:'Engagement rose by 42.5% among participants in 2021.'},{id:'P3',text:'Participants were adults.'}];
 const ranked=f.api.rankPassages(passages,f.api.queryWeights({sentence:'Katılımcılarda bağlılık %42,5 arttı (Smith, 2021).',context:[]}));
 assert.equal(ranked[0].passage.id,'P2');assert.equal(f.api.language('Bu çalışma ve bir yöntem için'),'tr');assert.equal(f.api.language('The method of the study'),'en');
});
