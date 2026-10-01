const fs=require('node:fs');const path=require('node:path');
for(const line of fs.readFileSync(path.join(__dirname,'../.env'),'utf8').split(/\r?\n/)){
 const match=line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);if(match&&process.env[match[1]]===undefined)process.env[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2');
}
const Content=require('../word-content.cjs');const Service=require('../word-service.cjs');
(async()=>{
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),90000);
 try{
   const result=await Content.evaluate({sentence:'Araştırma, uyku süresinin dikkati artırdığını nedensel olarak kanıtladı.',context:['Bu bir yapay testtir.','Araştırma, uyku süresinin dikkati artırdığını nedensel olarak kanıtladı.']},
     {title:'Yapay test yayını',identity:'synthetic',access:'Yapay test metni',passages:[{location:'Test paragrafı',text:'Çalışmada 120 yetişkin incelendi. Uyku süresi ile dikkat puanı arasında pozitif ilişki bulundu. Araştırma gözlemseldir; nedensellik göstermez.'}]},controller.signal,()=>{});
   console.log('Groq içerik entegrasyonu: '+result.verdict+'; doğrulanmış kanıt: '+result.claims.some(c=>!!c.quote));
   if(result.verdict!=='contradicted')process.exitCode=1;
   const text=await Content.fullText({raw:'https://doi.org/10.1371/journal.pmed.0020124'},Service.python,controller.signal);
   console.log('Canlı açık erişim tam metin: '+text.access+'; '+text.passages.length+' pasaj.');
   if(!text.passages.length)process.exitCode=1;
 }finally{clearTimeout(timer);}
})().catch(e=>{console.log('Entegrasyon testi: '+e.message);process.exitCode=1;});
