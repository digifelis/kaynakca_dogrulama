const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
process.env.WORD_ARCHIVE_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'word-store-tests-'));
const Store=require('../word-store.cjs');
const id='11111111-2222-4333-8444-555555555555';
function session(){return {id,name:'a.docx',mode:'word',createdAt:1,updatedAt:1,data:Buffer.from('DOCX'),pdfFiles:[{id:'p1',name:'s.pdf',data:Buffer.from('%PDF').toString('base64')}],texts:{r1:{passages:[{text:'x'}],identity:'d'}},paragraphs:[],references:[],job:{running:false},applied:new Map(),appliedGroups:new Map(),manualMappings:new Map(),contextOverrides:new Map(),manualConfirmed:new Set()};}
test('archive keeps binaries outside the session JSON and rewrites them only when they change',()=>{
 const s=session();s.originalData=s.data;Store.save(s);
 const dir=Store.root(),json=JSON.parse(fs.readFileSync(path.join(dir,id+'.json'),'utf8'));
 assert.equal(json.data,undefined);assert.equal(json.texts,undefined);assert.equal(json.pdfFiles[0].data,undefined);
 const docx=path.join(dir,id+'.docx'),before=fs.statSync(docx).mtimeMs;fs.utimesSync(docx,new Date(0),new Date(0));
 s.content={c:1};Store.save(s);assert.equal(fs.statSync(docx).mtimeMs,0,'unchanged DOCX is not rewritten');
 s.data=Buffer.from('EDITED');Store.save(s);assert.ok(fs.statSync(docx).mtimeMs>0);assert.ok(before>0);
 const loaded=Store.load(id);assert.equal(loaded.data.toString(),'EDITED');assert.equal(loaded.originalData.toString(),'DOCX');
 assert.equal(Buffer.from(loaded.pdfFiles[0].data,'base64').toString(),'%PDF');assert.equal(loaded.texts.r1.identity,'d');assert.ok(loaded.applied instanceof Map);
 assert.deepEqual(Store.list().map(d=>[d.id,d.pdfs.length]),[[id,1]]);
 Store.remove(id);assert.deepEqual(fs.readdirSync(dir).filter(n=>n.startsWith(id)),[]);assert.equal(Store.load(id),null);
});
test('archives written in the inline base64 format still load and get a list summary',()=>{
 const legacyId='99999999-2222-4333-8444-555555555555',dir=Store.root();
 fs.writeFileSync(path.join(dir,legacyId+'.json'),JSON.stringify({id:legacyId,name:'old.docx',updatedAt:5,data:Buffer.from('OLD').toString('base64'),pdfFiles:[],texts:{},job:{running:true},applied:[],appliedGroups:[],manualMappings:[],contextOverrides:[],manualConfirmed:[]}));
 const s=Store.load(legacyId);assert.equal(s.data.toString(),'OLD');assert.equal(s.originalData.toString(),'OLD');assert.equal(s.job.running,false);
 assert.ok(Store.list().some(d=>d.id===legacyId&&d.name==='old.docx'));assert.ok(fs.existsSync(path.join(dir,legacyId+'.meta.json')));
 Store.save(s);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,legacyId+'.json'),'utf8')).data,undefined);assert.equal(Store.load(legacyId).data.toString(),'OLD');
 Store.remove(legacyId);
});
