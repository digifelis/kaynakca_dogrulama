const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events');
const root=path.join(__dirname,'..');
test('Word worker releases ready results before the quota delay and retries the same remaining record',async()=>{
 const messages=[],calls=[];let resume;
 const engine={configure(){},getPendingRetryAt:r=>r.pendingRetryAt,waitForRetry:()=>new Promise(r=>resume=r),verifyReference:async(raw,opts)=>{calls.push(raw);if(raw==='good')return {status:'verified'};if(opts?.primaryOnly)return {fallbackNeeded:true};return calls.filter(c=>c==='pending').length<3?{status:'error',pendingRetryAt:1,fallbackNeeded:true}:{status:'verified'};}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'scripts/word-verify-worker.cjs'),'utf8'),{process:{env:{}},require:id=>id==='node:async_hooks'?require('node:async_hooks'):id==='node:worker_threads'?{parentPort:{postMessage:m=>messages.push(m)},workerData:{references:['good','pending']}}:id.includes('reference-engine')?engine:id.includes('lib/verification')?require(path.join(root,'lib/verification.cjs')):{}});
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
 vm.runInNewContext(fs.readFileSync(path.join(root,'word-service.cjs'),'utf8'),{module:mod,__dirname:root,process,Buffer,AbortController,URL,require:id=>id==='./lib/verification.cjs'?{start:()=>new FakeWorker()}:id==='./word-store.cjs'?{save(){}}:require(id.startsWith('.')?path.join(root,id):id),setTimeout,clearTimeout});
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

test('the local worker verifies several records at once and still attributes each request to its own record', async () => {
  const messages = [], state = { active: 0, peak: 0 }; let options = null;
  const engine = { configure(o) { options = o; }, getPendingRetryAt: () => 0, waitForRetry: async () => {},
    verifyReference: async raw => { state.active++; state.peak = Math.max(state.peak, state.active); await new Promise(r => setTimeout(r, 15)); options.onRequest({ provider: 'Crossref', url: 'u:' + raw, at: 1 }); await new Promise(r => setTimeout(r, 5)); options.onResponse({ provider: 'Crossref', url: 'u:' + raw, status: 200, at: 2 }); state.active--; return { status: 'verified', raw }; } };
  const refs = ['a', 'b', 'c', 'd', 'e', 'f'];
  vm.runInNewContext(fs.readFileSync(path.join(root, 'scripts/word-verify-worker.cjs'), 'utf8'), { process: { env: { VERIFY_LOCAL_PARALLEL: '3' } }, setTimeout, setImmediate, require: id => id === 'node:async_hooks' ? require('node:async_hooks') : id === 'node:worker_threads' ? { parentPort: { postMessage: m => messages.push(m) }, workerData: { references: refs, initialResults: [] } } : id.includes('reference-engine') ? engine : id.includes('lib/verification') ? require(path.join(root, 'lib/verification.cjs')) : {} });
  for (let i = 0; i < 100 && !messages.some(m => m.type === 'done'); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(messages.at(-1).type, 'done'); assert.equal(state.peak, 3, 'three records were in flight together');
  for (const m of messages.filter(m => m.type === 'debug')) assert.equal(m.event.url.slice(2), refs[m.event.index], 'request ' + m.event.url + ' is attributed to record ' + m.event.index);
  assert.equal(messages.filter(m => m.type === 'debug').length, 12); assert.equal(messages.filter(m => m.type === 'result').length, 6);
});
