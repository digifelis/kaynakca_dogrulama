const { parentPort, workerData } = require('node:worker_threads');
const engine = require('../reference-engine.js');
const { orchestrate } = require('../lib/verification.cjs');
const { AsyncLocalStorage } = require('node:async_hooks');
// Records are verified several at a time (VERIFY_LOCAL_PARALLEL, default 3); the web server's provider proxy still spaces the requests of each index.
const records = new AsyncLocalStorage(), activeIndex = () => records.getStore() ?? -1;
const parallel = Math.min(8, Math.max(1, Number(process.env.VERIFY_LOCAL_PARALLEL) || 3));
engine.configure({proxyUrl:workerData.proxy,additionalProviders:require('../providers.js'),googleBooksConfigured:workerData.googleBooksConfigured,deferQuota:true,
  onRequest:event=>parentPort.postMessage({type:'debug',event:{kind:'request',scope:'reference',index:activeIndex(),provider:event.provider,url:event.url,at:event.at}}),
  onResponse:event=>parentPort.postMessage({type:'debug',event:{kind:'response',scope:'reference',index:activeIndex(),provider:event.provider,url:event.url,status:event.status,retryAfter:event.retryAfter,at:event.at}}),
  onRetry:event=>parentPort.postMessage({type:'wait',provider:event.provider,retryAt:event.retryAt,index:activeIndex()})});
orchestrate({references:workerData.references,initialResults:workerData.initialResults,parallel,
  verify:(index,options)=>records.run(index,()=>engine.verifyReference(workerData.references[index],{...workerData.options,...options})),
  retryAt:result=>engine.getPendingRetryAt(result),wait:at=>engine.waitForRetry(Date.now()+at),
  emit:message=>parentPort.postMessage(message)})
  .catch(()=>parentPort.postMessage({type:'error',message:'Kaynak doğrulama tamamlanamadı; yeniden başlatabilirsiniz.'}));
