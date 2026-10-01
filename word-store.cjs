const fs=require('node:fs');
const path=require('node:path');
const root=()=>process.env.WORD_ARCHIVE_DIR||path.join(__dirname,'data','documents');
const maps=['applied','appliedGroups','manualMappings','contextOverrides'];
function file(id){if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Geçersiz belge kimliği.');return path.join(root(),id+'.json');}
function save(s){
  if(s.deleted)return;
  const record={...s};
  for(const key of ['worker','controller','suggestions','citations','findings','effectiveReferences','mutation'])delete record[key];
  record.data=s.data.toString('base64');record.originalData=(s.originalData||s.data).toString('base64');
  for(const key of maps)record[key]=[...(s[key]||[])];record.manualConfirmed=[...(s.manualConfirmed||[])];
  fs.mkdirSync(root(),{recursive:true});const target=file(s.id),tmp=target+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(record));fs.renameSync(tmp,target);
}
function load(id){
  const target=file(id);if(!fs.existsSync(target))return null;
  const s=JSON.parse(fs.readFileSync(target,'utf8'));
  s.data=Buffer.from(s.data,'base64');s.originalData=Buffer.from(s.originalData||s.data,'base64');
  for(const key of maps)s[key]=new Map(s[key]||[]);s.manualConfirmed=new Set(s.manualConfirmed||[]);
  if(s.job.running)s.job={...s.job,running:false,retryAt:null,message:'Sunucu yeniden başladı; tamamlanan sonuçlar korundu. Kontrole devam edebilirsiniz.'};
  if(s.referenceJob)s.referenceJob.running=false;
  s.followupContent=false;s.autoContentScope=null;
  return s;
}
function list(){
  if(!fs.existsSync(root()))return [];
  return fs.readdirSync(root()).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).map(n=>{
    const s=JSON.parse(fs.readFileSync(path.join(root(),n),'utf8'));
    return {id:s.id,name:s.name,mode:s.mode||'word',createdAt:s.createdAt||s.touched,updatedAt:s.updatedAt||s.touched,job:s.job,pdfs:(s.pdfFiles||[]).map(({data,...v})=>v)};
  }).sort((a,b)=>b.updatedAt-a.updatedAt);
}
function remove(id){fs.rmSync(file(id),{force:true});}
module.exports={save,load,list,remove,root};
