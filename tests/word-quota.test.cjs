const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events');
const root=path.join(__dirname,'..');
test('Word worker releases ready results before the quota delay and retries the same remaining record',async()=>{
 const messages=[],calls=[];let resume;
 const engine={configure(){},getPendingRetryAt:r=>r.pendingRetryAt,waitForRetry:()=>new Promise(r=>resume=r),verifyReference:async(raw,opts)=>{calls.push(raw);if(raw==='good')return {status:'verified'};if(opts?.primaryOnly)return {fallbackNeeded:true};return calls.filter(c=>c==='pending').length<3?{status:'error',pendingRetryAt:1,fallbackNeeded:true}:{status:'verified'};}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'scripts/word-verify-worker.cjs'),'utf8'),{require:id=>id==='node:worker_threads'?{parentPort:{postMessage:m=>messages.push(m)},workerData:{references:['good','pending']}}:id.includes('reference-engine')?engine:{}});
 for(let i=0;i<20&&!resume;i++)await new Promise(r=>setImmediate(r));
 assert.equal(messages.find(m=>m.type==='ready').pending,1);
 assert.equal(messages.find(m=>m.type==='ready').completed,1);
 assert.equal(messages.some(m=>m.type==='done'),false);
 resume();for(let i=0;i<20&&!messages.some(m=>m.type==='done');i++)await new Promise(r=>setImmediate(r));
 assert.equal(messages.at(-1).type,'done');assert.equal(calls.filter(c=>c==='good').length,1);assert.equal(calls.filter(c=>c==='pending').length,3);
});

test('deferred Word quota unlocks content controls without losing successful results',()=>{
 let worker;
 class FakeWorker extends EventEmitter{constructor(){super();worker=this;}terminate(){}}
 const mod={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'word-service.cjs'),'utf8'),{module:mod,__dirname:root,process,Buffer,AbortController,URL,require:id=>id==='node:worker_threads'?{Worker:FakeWorker}:id==='./word-store.cjs'?{save(){}}:require(id.startsWith('.')?path.join(root,id):id),setTimeout,clearTimeout});
 const s={id:'test',data:Buffer.from(''),references:[{id:'r0',raw:'Author. (2021). Test.',year:'2021'}],citations:[],paragraphs:[],range:{start:0,end:0},content:{untouched:{verdict:'supported'}},applied:new Map(),appliedGroups:new Map(),manualConfirmed:new Set(),manualMappings:new Map(),contextOverrides:new Map(),job:{running:false}};
 mod.exports.startVerification(s,4173,false);
 const retryAt=Date.now()+321000;
 worker.emit('message',{type:'result',index:0,result:{status:'pending',statusText:'Kota bekleniyor',provider:'Servis hatası',fallbackNeeded:true,pendingRetryAt:retryAt,pendingProviders:[{provider:'CORE',retryAt}],sourcesChecked:['Crossref','CORE'],warnings:['CORE: HTTP 429'],debugRequests:[{provider:'CORE',status:429,url:'https://api.core.ac.uk/test',requestUrl:'http://127.0.0.1:4173/api/proxy',detail:'CORE: kota'}]}});
 worker.emit('message',{type:'ready',pending:1,completed:0,retryAt});
 assert.equal(s.job.running,false);assert.equal(s.referenceJob.running,true);assert.equal(s.referenceJob.pending,1);assert.equal(s.content.untouched.verdict,'supported');
 assert.equal(s.referenceJob.debug[0].index,1);assert.equal(s.referenceJob.debug[0].debugRequests[0].status,429);
 s.job={running:true,kind:'content',message:'Groq ile karşılaştırılıyor',completed:2,total:3};
 worker.emit('message',{type:'wait',provider:'CORE',retryAt:Date.now()+321000});
 assert.equal(s.job.kind,'content');assert.equal(s.job.completed,2);assert.equal(s.job.message,'Groq ile karşılaştırılıyor');
 assert.equal(s.referenceJob.lastWait.provider,'CORE');
 worker.emit('message',{type:'done'});assert.equal(s.referenceJob.running,false);assert.equal(s.job.kind,'content');assert.equal(s.job.running,true);
});
