// Local QA report for the explicitly supplied test manuscript; original is read-only.
const fs=require('node:fs');const path=require('node:path');
const Engine=require('../reference-engine.js');const Content=require('../word-content.cjs');const Service=require('../word-service.cjs');
const out=path.join(__dirname,'../tests/tmp');fs.mkdirSync(out,{recursive:true});
for(const line of fs.readFileSync(path.join(__dirname,'../.env'),'utf8').split(/\r?\n/)){
 const match=line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);if(match&&process.env[match[1]]===undefined)process.env[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2');
}
const baseline=JSON.parse(fs.readFileSync(path.join(out,'bestas-baseline.json'),'utf8'));
const save=(name,data)=>fs.writeFileSync(path.join(out,name),JSON.stringify(data,null,2));
async function verify(){
 Engine.configure({proxyUrl:'http://127.0.0.1:4173/api/proxy',deferQuota:true});const results=[];
 for(let i=0;i<baseline.extracted.references.length;i++){
  const ref=baseline.extracted.references[i];const result=await Engine.verifyReference(ref.raw,{primaryOnly:true});results.push({id:ref.id,raw:ref.raw,...result});save('bestas-primary.json',results);
  console.log(`Birincil kayıt ${i+1}/${baseline.extracted.references.length}: ${result.status}${result.pendingRetryAt?' (kota beklemesi ayrıldı)':''}`);
 }
 console.log('Birincil kontrol özeti: '+JSON.stringify(results.reduce((a,r)=>(a[r.status]=(a[r.status]||0)+1,a),{})));
}
async function content(){
 const ids=['r25','r19','r18','r30'];const samples=[];
 for(const id of ids){
  const ref=baseline.extracted.references.find(r=>r.id===id);
  const citation=id==='r30'?{id:'manual-p33',paragraph:'word/document.xml:32',location:'Ana metin · paragraf 33',sentence:baseline.document.paragraphs.find(p=>p.id==='word/document.xml:32').text,context:[baseline.document.paragraphs.find(p=>p.id==='word/document.xml:32').text]}:baseline.analysis.citations.find(c=>c.reference===id);
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),180000);
  console.log('İçerik örneği: '+id+' · '+citation.location);
  try{
   const text=await Content.fullText(ref,Service.python,controller.signal);save('bestas-text-'+id+'.json',text);
   console.log('Metin erişimi: '+text.access+' · '+text.passages.length+' pasaj');
   const result=await Content.evaluate(citation,text,controller.signal,()=>{});
   samples.push({reference:id,raw:ref.raw,citation,result});console.log('Karar: '+result.verdict);
  }catch(e){samples.push({reference:id,raw:ref.raw,citation,result:{verdict:'unassessable',explanation:e.message}});console.log('Değerlendirilemedi: '+e.message);}
  finally{clearTimeout(timer);save('bestas-content.json',samples);}
 }
}
(process.argv[2]==='content'?content():verify()).catch(()=>{console.log('Test işi tamamlanamadı.');process.exitCode=1;});
