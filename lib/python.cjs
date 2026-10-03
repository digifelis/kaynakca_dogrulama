// Runs scripts/word-package.py (DOCX/PDF/XML handling).
// Used by the web app and by the verification service for full-text PDFs.
//
// Starting Python and importing pypdf costs far more than reading a typical file, so a few long-lived workers
// (`word-package.py --serve`: one JSON request per line in, one JSON answer per line out) are kept and reused.
// PYTHON_POOL sets how many (default 2, 0 = a new process per request as before). A worker that times out, crashes,
// or has served PYTHON_RECYCLE requests (default 100) is replaced; if workers cannot be started the old one-shot
// path is used, so a broken pool never breaks file processing.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const __root=path.join(__dirname,'..');
const bundled=path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const pythonPath=()=>process.env.WORD_PYTHON||(fs.existsSync(bundled)?bundled:'python');
const script=path.join(__root,'scripts/word-package.py');
const FAILED='Dosya işleme tamamlanamadı; boyut/biçim sınırlarını kontrol edin.';
const MAX_OUTPUT=32*1024*1024,TIMEOUT_MS=45000,IDLE_MS=60000;

function oneShot(request){return new Promise((resolve,reject)=>{
  const child=spawn(pythonPath(),[script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let data='',size=0;const timer=setTimeout(()=>child.kill(),TIMEOUT_MS);
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>MAX_OUTPUT){child.kill();return;}data+=chunk.toString();});
  child.stderr.resume();child.stdin.on('error',()=>{});
  child.on('error',()=>{clearTimeout(timer);reject(Error('Word işleme için Python çalıştırılamadı.'));});
  child.on('close',()=>{clearTimeout(timer);try{const output=JSON.parse(data);if(output.error)reject(Error(output.error));else resolve(output);}catch{reject(Error(FAILED));}});
  child.stdin.end(JSON.stringify(request));
});}

const poolSize=()=>{const n=Number(process.env.PYTHON_POOL);return Number.isFinite(n)?Math.min(6,Math.max(0,Math.floor(n))):2;};
const recycleAfter=()=>Math.max(1,Number(process.env.PYTHON_RECYCLE)||100);
const workers=new Set(),waiting=[];
let startFailures=0;

function startWorker(){
  const child=spawn(pythonPath(),[script,'--serve'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const worker={child,busy:false,served:0,buffer:'',current:null,idle:null,dead:false};
  child.stderr.resume();child.stdin.on('error',()=>{});
  // The pool never keeps the application alive on its own.
  child.unref();child.stdin.unref?.();child.stdout.unref?.();child.stderr.unref?.();
  child.stdout.on('data',chunk=>{
    if(!worker.current)return;
    worker.buffer+=chunk.toString();
    if(worker.buffer.length>MAX_OUTPUT)return retire(worker,Error(FAILED));
    const end=worker.buffer.indexOf('\n');
    if(end<0)return;
    const line=worker.buffer.slice(0,end);worker.buffer='';
    finish(worker,()=>{const output=JSON.parse(line);if(output.error)throw Error(output.error);return output;});
  });
  // A worker that dies before it ever answered probably cannot run here at all: its request is retried once the old way.
  const crashed=()=>{
    if(worker.dead)return;
    const job=worker.current,fresh=worker.served===0;
    if(job)startFailures++;
    worker.current=null;retire(worker,null);
    if(job){clearTimeout(job.timer);(fresh?oneShot(job.request):Promise.reject(Error(FAILED))).then(job.resolve,job.reject);}
  };
  child.on('error',()=>{startFailures++;crashed();});
  child.on('close',crashed);
  workers.add(worker);
  return worker;
}
// Settles the request a worker is running (value or error), then makes the worker available again or replaces it.
function finish(worker,produce){
  const job=worker.current;if(!job)return;
  worker.current=null;clearTimeout(job.timer);
  let value,error=null;try{value=produce();}catch(e){error=e;}
  worker.busy=false;worker.served++;if(!error)startFailures=0;
  if(worker.served>=recycleAfter())retire(worker,null);else release(worker);
  if(error)job.reject(error);else job.resolve(value);
}
function retire(worker,error){
  if(worker.dead)return;worker.dead=true;workers.delete(worker);clearTimeout(worker.idle);
  const job=worker.current;worker.current=null;
  try{worker.child.kill();}catch{/* already gone */}
  if(job){clearTimeout(job.timer);job.reject(error||Error(FAILED));}
  pump();
}
function release(worker){
  clearTimeout(worker.idle);
  worker.idle=setTimeout(()=>retire(worker,null),IDLE_MS);worker.idle.unref();
  pump();
}
function run(worker,job){
  clearTimeout(worker.idle);worker.busy=true;worker.current=job;worker.buffer='';
  job.timer=setTimeout(()=>retire(worker,Error(FAILED)),TIMEOUT_MS);
  worker.child.stdin.write(JSON.stringify(job.request)+'\n');
}
function pump(){
  while(waiting.length){
    let worker=[...workers].find(w=>!w.busy&&!w.dead);
    if(!worker&&workers.size<poolSize())worker=startWorker();
    if(!worker)return;
    run(worker,waiting.shift());
  }
}
function python(request){
  if(poolSize()===0||startFailures>=3)return oneShot(request);
  return new Promise((resolve,reject)=>{waiting.push({request,resolve,reject});pump();});
}
const stop=()=>{for(const worker of [...workers])retire(worker,null);};
process.once('exit',()=>{for(const worker of workers)try{worker.child.kill();}catch{/* ignore */}});

module.exports={python,pythonPath,stop};
