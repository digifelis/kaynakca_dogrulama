const fs=require('node:fs'),path=require('node:path');
const E=require('../reference-engine.js'),C=require('../word-content.cjs'),S=require('../word-service.cjs');
for(const line of fs.readFileSync(path.join(__dirname,'../.env'),'utf8').split(/\r?\n/)){const m=line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].replace(/^(['"])(.*)\1$/,'$2');}
const folder=path.join(__dirname,'../tests/tmp');
// Default outbound payloads contain only public publication metadata and a synthetic claim.
const manuscriptMode=process.argv.includes('--manuscript-context');
const textOnly=process.argv.includes('--text-only');
const results=textOnly?JSON.parse(fs.readFileSync(path.join(folder,'bestas-live-after.json'),'utf8')).filter(r=>r.task!=='Li alternative text'):[];const save=()=>fs.writeFileSync(path.join(folder,'bestas-live-after.json'),JSON.stringify(results,null,2));
async function main(){
 E.configure({proxyUrl:'http://127.0.0.1:4173/api/proxy',deferQuota:true});
 if(!textOnly){
 const publicReferences=[{author:'Jegham',raw:'Jegham, N., Abdelatti, M., Koh, C. Y., Elmoubarki, L., & Hendawi, A. (2025). How hungry is AI? Benchmarking energy, water, and carbon footprint of LLM inference. arXiv:2505.09598.'}];
 for(const r of publicReferences){const v=await E.verifyReference(r.raw,{primaryOnly:true});results.push({task:'identity',author:r.author,status:v.status,matchedAuthor:v.matched?.author?.map(a=>a.family||a.literal),doi:v.matched?.doi,year:v.matched?.year});save();console.log('Kimlik: '+r.author+' · '+v.status);}
 const text=JSON.parse(fs.readFileSync(path.join(folder,'bestas-text-r25.json'),'utf8'));
 const synthetic='US data centres consume 1.7 billion litres of water per day, and fewer than one third of operators measure their consumption.';
 const citation=manuscriptMode?JSON.parse(fs.readFileSync(path.join(folder,'bestas-after.json'),'utf8')).analysis.citations.find(c=>c.location.endsWith('paragraf 25')&&c.authors[0]==='mytton'):{sentence:synthetic,context:[synthetic]};
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),180000);
 try{const result=await C.evaluate(citation,text,controller.signal,()=>{});results.push({task:manuscriptMode?'Mytton manuscript context':'Mytton synthetic public claim',result});console.log('Mytton içerik: '+result.verdict);}catch(e){results.push({task:'Mytton content',error:e.message});console.log('Mytton içerik: '+e.message);}finally{clearTimeout(timer);save();}
 }
 const li={raw:'Li, P., Yang, J., Islam, M. A., & Ren, S. (2025). Making AI Less Thirsty. Communications of the ACM. https://doi.org/10.1145/3724499',title:'Making AI Less Thirsty'},c2=new AbortController(),t2=setTimeout(()=>c2.abort(),180000);
 try{const source=await C.fullText(li,S.python,c2.signal);results.push({task:'Li alternative text',url:source.url,access:source.access,needsConfirmation:source.needsConfirmation,passages:source.passages.length});console.log('Li metin: '+source.access+' · '+source.passages.length+' pasaj');}catch(e){results.push({task:'Li alternative text',error:e.message});console.log('Li metin: '+e.message);}finally{clearTimeout(t2);save();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
