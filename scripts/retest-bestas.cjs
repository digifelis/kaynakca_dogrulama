// Real-manuscript regression test; no changes are written to the input document.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const S=require('../word-service.cjs'),A=require('../word-analysis.cjs');
const input=process.argv[2]||'C:/Users/bes-t/Downloads/1142_BESTAS_original.docx';
const out=path.join(__dirname,'../tests/tmp');fs.mkdirSync(out,{recursive:true});
async function main(){
 const bytes=fs.readFileSync(input),hash=()=>crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex'),originalHash=hash();
 const doc=await S.python({operation:'inspect',data:bytes.toString('base64')});
 const ext=A.extractReferences(doc.paragraphs),analysis=A.analyze(doc.paragraphs,ext.references,ext.range);
 assert.equal(ext.references.length,40);assert.ok(!analysis.citations.some(c=>c.location.endsWith('paragraf 4')));
 for(const [paragraph,author] of [[33,'ristic'],[37,'li'],[40,'lei'],[44,'han'],[46,'qi'],[80,'siddik']])assert.ok(analysis.citations.some(c=>c.location.endsWith('paragraf '+paragraph)&&c.authors[0]===author&&c.reference));
 assert.ok(analysis.citations.filter(c=>c.issue==='Yıl uyuşmazlığı').every(c=>!c.patch));
 const server=require('../server.cjs').createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port+'/api/word';let id;
 const post=async(action,data)=>{const r=await fetch(base+action,{method:'POST',headers:{'Content-Type':'application/json','X-Word-Request':'1'},body:JSON.stringify(data)});const result=await r.json();assert.equal(r.status,200,result.error);return result;};
 const edits=[];
 try{
  const state=await post('/upload',{name:path.basename(input),data:bytes.toString('base64')});id=state.id;
  for(const c of state.citations.filter(c=>c.issue==='Yıl uyuşmazlığı')){
   const selected=await post('/'+id+'/match',{citation:c.id,reference:c.reference});const f=selected.findings.find(f=>f.id===c.id);assert.ok(f.patch);
   const applied=await post('/'+id+'/apply',{id:c.id});assert.equal(applied.applied.length,1);
   const download=await fetch(base+'/'+id+'/download');assert.equal(download.status,200);const data=Buffer.from(await download.arrayBuffer());
   const changed=await S.python({operation:'inspect',data:data.toString('base64')});
   for(const p of doc.paragraphs){const expected=p.id===f.patch.paragraph?p.text.slice(0,f.patch.start)+f.patch.replacement+p.text.slice(f.patch.end):p.text;assert.equal(changed.paragraphs.find(v=>v.id===p.id).text,expected);}
   edits.push({location:c.location,original:c.text,technicalWrite:'passed'});
   await post('/'+id+'/undo',{id:c.id});
  }
 }finally{if(id)await fetch(base+'/'+id,{method:'DELETE',headers:{'X-Word-Request':'1'}});await new Promise(r=>server.close(r));}
 assert.equal(hash(),originalHash);
 const result={references:ext.references.length,citations:analysis.citations.length,findings:analysis.findings.reduce((a,f)=>(a[f.type]=(a[f.type]||0)+1,a),{}),yearChangesRequireSelection:true,httpWrites:edits,originalUnchanged:true};
 fs.writeFileSync(path.join(out,'bestas-after.json'),JSON.stringify({summary:result,extracted:ext,analysis},null,2));
 console.log(JSON.stringify(result,null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
