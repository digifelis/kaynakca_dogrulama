const { parentPort, workerData } = require('node:worker_threads');
const engine = require('../reference-engine.js');
let activeIndex=-1;
engine.configure({proxyUrl:workerData.proxy,additionalProviders:require('../providers.js'),googleBooksConfigured:workerData.googleBooksConfigured,deferQuota:true,
  onRequest:event=>parentPort.postMessage({type:'debug',event:{kind:'request',scope:'reference',index:activeIndex,provider:event.provider,url:event.url,at:event.at}}),
  onResponse:event=>parentPort.postMessage({type:'debug',event:{kind:'response',scope:'reference',index:activeIndex,provider:event.provider,url:event.url,status:event.status,retryAfter:event.retryAfter,at:event.at}}),
  onRetry:event=>parentPort.postMessage({type:'wait',provider:event.provider,retryAt:event.retryAt,index:activeIndex})});
(async()=>{
  const results=[];
  for(let i=0;i<workerData.references.length;i++) {
    activeIndex=i;
    const previous=workerData.initialResults?.[i];
    const reusable=previous&&(previous.pendingRetryAt>Date.now()||['verified','review'].includes(previous.status)&&!previous.pendingRetryAt&&!previous.fallbackNeeded);
    const result=reusable?previous:await engine.verifyReference(workerData.references[i],{primaryOnly:true});results[i]=result;
    parentPort.postMessage({type:'result',index:i,result});
  }
  let pending=results.map((r,i)=>r.fallbackNeeded?i:-1).filter(i=>i>=0);
  while(pending.length){
    for(const i of pending){
      activeIndex=i;
      const retryAt=engine.getPendingRetryAt(results[i]); if(retryAt>Date.now()) continue;
      const result=await engine.verifyReference(workerData.references[i]);results[i]=result;
      parentPort.postMessage({type:'result',index:i,result});
    }
    pending=pending.filter(i=>results[i].pendingRetryAt);
    if(pending.length){
      const at=Math.min(...pending.map(i=>engine.getPendingRetryAt(results[i])));
      parentPort.postMessage({type:'ready',pending:pending.length,completed:results.length-pending.length,retryAt:at});
      parentPort.postMessage({type:'wait',provider:'Kaynak dizinleri',retryAt:at});
      await engine.waitForRetry(at); pending=[...pending.slice(1),pending[0]];
    }
  }
  parentPort.postMessage({type:'done'});
})().catch(()=>parentPort.postMessage({type:'error',message:'Kaynak doğrulama tamamlanamadı; yeniden başlatabilirsiniz.'}));
