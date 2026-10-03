const fs=require('node:fs');
const path=require('node:path');
const root=()=>process.env.WORD_ARCHIVE_DIR||path.join(__dirname,'data','documents');
const maps=['applied','appliedGroups','manualMappings','contextOverrides'];
// Large, rarely changing parts live beside the session JSON and are rewritten only when they change.
const written=new Map();
function file(id,suffix='.json'){if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Geçersiz belge kimliği.');return path.join(root(),id+suffix);}
function writeAtomic(target,data){const tmp=target+'.tmp';fs.writeFileSync(tmp,data);fs.renameSync(tmp,target);}
function pdfFile(id,pdfId){if(!/^[\w-]{1,80}$/.test(pdfId))throw Error('Geçersiz PDF kimliği.');return file(id,'.pdf-'+pdfId+'.pdf');}
function metadata(s){return {id:s.id,owner:s.owner||null,name:s.name,format:s.format||'docx',mode:s.mode||'word',createdAt:s.createdAt||s.touched,updatedAt:s.updatedAt||s.touched,job:s.job,pdfs:(s.pdfFiles||[]).map(({data,...v})=>v)};}
function textsSignature(texts){return JSON.stringify(Object.entries(texts||{}).map(([key,t])=>[key,t?.passages?.length||0,t?.identity||'',!!t?.needsConfirmation,t?.access||'']));}
function save(s){
  if(s.deleted)return;
  fs.mkdirSync(root(),{recursive:true});
  const seen=written.get(s.id)||{};
  if(seen.data!==s.data){writeAtomic(file(s.id,'.docx'),s.data);seen.data=s.data;}
  const original=s.originalData||s.data;
  if(seen.original!==original){writeAtomic(file(s.id,'.original.docx'),original);seen.original=original;}
  seen.pdfs||=new Set();
  for(const pdf of s.pdfFiles||[])if(pdf.data&&!seen.pdfs.has(pdf.id)){writeAtomic(pdfFile(s.id,pdf.id),Buffer.from(pdf.data,'base64'));seen.pdfs.add(pdf.id);}
  const signature=textsSignature(s.texts);
  if(seen.texts!==signature){writeAtomic(file(s.id,'.texts.json'),JSON.stringify(s.texts||{}));seen.texts=signature;}
  written.set(s.id,seen);
  const record={...s,storage:2};
  for(const key of ['worker','controller','suggestions','citations','findings','effectiveReferences','mutation','persistTimer','data','originalData','texts'])delete record[key];
  record.pdfFiles=(s.pdfFiles||[]).map(({data,...v})=>v);
  for(const key of maps)record[key]=[...(s[key]||[])];record.manualConfirmed=[...(s.manualConfirmed||[])];
  writeAtomic(file(s.id),JSON.stringify(record));
  writeAtomic(file(s.id,'.meta.json'),JSON.stringify(metadata(s)));
}
function load(id){
  const target=file(id);if(!fs.existsSync(target))return null;
  const s=JSON.parse(fs.readFileSync(target,'utf8'));
  if(s.storage===2){
    s.data=fs.readFileSync(file(id,'.docx'));
    const original=file(id,'.original.docx');s.originalData=fs.existsSync(original)?fs.readFileSync(original):s.data;
    const texts=file(id,'.texts.json');s.texts=fs.existsSync(texts)?JSON.parse(fs.readFileSync(texts,'utf8')):{};
    s.pdfFiles=(s.pdfFiles||[]).map(pdf=>{const source=pdfFile(id,pdf.id);return fs.existsSync(source)?{...pdf,data:fs.readFileSync(source).toString('base64')}:pdf;});
    written.set(id,{data:s.data,original:s.originalData,texts:textsSignature(s.texts),pdfs:new Set(s.pdfFiles.map(p=>p.id))});
  }else{
    // Archives written before external parts kept everything inline as base64.
    s.data=Buffer.from(s.data,'base64');s.originalData=Buffer.from(s.originalData||s.data,'base64');
  }
  delete s.storage;
  for(const key of maps)s[key]=new Map(s[key]||[]);s.manualConfirmed=new Set(s.manualConfirmed||[]);
  if(s.job.running)s.job={...s.job,running:false,retryAt:null,message:'Sunucu yeniden başladı; tamamlanan sonuçlar korundu. Kontrole devam edebilirsiniz.'};
  if(s.referenceJob)s.referenceJob.running=false;
  s.followupContent=false;s.autoContentScope=null;
  return s;
}
function list(){
  if(!fs.existsSync(root()))return [];
  const names=fs.readdirSync(root());
  return names.filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).map(n=>{
    const id=n.slice(0,36),meta=path.join(root(),id+'.meta.json');
    if(names.includes(id+'.meta.json'))try{return JSON.parse(fs.readFileSync(meta,'utf8'));}catch{}
    const s=JSON.parse(fs.readFileSync(path.join(root(),n),'utf8')),summary=metadata(s);
    try{writeAtomic(meta,JSON.stringify(summary));}catch{}
    return summary;
  }).sort((a,b)=>b.updatedAt-a.updatedAt);
}
// With accounts, every document belongs to a user. Archives made before that have no owner and were declared deletable:
// they are removed once (a marker file records it), never again.
function purgeUnowned(){
  const dir=root(),marker=path.join(dir,'.owners-enabled');
  if(!fs.existsSync(dir)||fs.existsSync(marker))return 0;
  let removed=0;
  for(const name of fs.readdirSync(dir))if(/^[a-f0-9-]{36}\./.test(name)){fs.rmSync(path.join(dir,name),{force:true});if(name.endsWith('.json')&&!name.endsWith('.meta.json'))removed++;}
  fs.writeFileSync(marker,'owners enabled '+new Date().toISOString());
  return removed;
}
function remove(id){
  file(id);written.delete(id);
  if(!fs.existsSync(root()))return;
  for(const name of fs.readdirSync(root()))if(name.startsWith(id+'.'))fs.rmSync(path.join(root(),name),{force:true});
}
module.exports={save,load,list,remove,root,purgeUnowned};
