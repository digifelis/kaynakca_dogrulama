const { parentPort, workerData } = require('node:worker_threads');
const engine = require('../reference-engine.js');
const { orchestrate } = require('../lib/verification.cjs');
let activeIndex=-1;
engine.configure({proxyUrl:workerData.proxy,additionalProviders:require('../providers.js'),googleBooksConfigured:workerData.googleBooksConfigured,deferQuota:true,
  onRequest:event=>parentPort.postMessage({type:'debug',event:{kind:'request',scope:'reference',index:activeIndex,provider:event.provider,url:event.url,at:event.at}}),
  onResponse:event=>parentPort.postMessage({type:'debug',event:{kind:'response',scope:'reference',index:activeIndex,provider:event.provider,url:event.url,status:event.status,retryAfter:event.retryAfter,at:event.at}}),
  onRetry:event=>parentPort.postMessage({type:'wait',provider:event.provider,retryAt:event.retryAt,index:activeIndex})});
// One record at a time: the engine's debug callbacks are attributed through activeIndex.
orchestrate({references:workerData.references,initialResults:workerData.initialResults,parallel:1,
  verify:(index,options)=>{activeIndex=index;return engine.verifyReference(workerData.references[index],options);},
  retryAt:result=>engine.getPendingRetryAt(result),wait:at=>engine.waitForRetry(Date.now()+at),
  emit:message=>parentPort.postMessage(message)})
  .catch(()=>parentPort.postMessage({type:'error',message:'Kaynak doğrulama tamamlanamadı; yeniden başlatabilirsiniz.'}));
