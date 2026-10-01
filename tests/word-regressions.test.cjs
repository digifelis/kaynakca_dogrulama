const test=require('node:test'),assert=require('node:assert/strict');
const A=require('../word-analysis.cjs'),E=require('../reference-engine.js'),C=require('../word-content.cjs'),S=require('../word-service.cjs');
const {execFileSync}=require('node:child_process'),path=require('node:path'),os=require('node:os');
const p=(text,index=0,style='Body')=>({id:'word/document.xml:'+index,part:'word/document.xml',index,text,style,group:'body',protected:false});
const ref=(raw,id='r0')=>({id,raw,...A.referenceIdentity(raw)});
const range={start:100,end:200};
test('bibliography treats explicit new paragraphs as independent references even without a date',()=>{
 const ps=[p('References',0),p('Aczel, M., & Madani, K. (2026). Report.',1),p('United Nations University Institute (UNU). https://doi.org/10.53328/INR26RMA002',2),p('Food & Water Watch. (2026). Report.',3),p('Privette, CV, et al. (2026). Study.',4),p('Ekler',5,'Balk1'),p('Sonraki metin (2026).',6)];
 const e=A.extractReferences(ps);assert.equal(e.references.length,4);assert.equal(e.references[0].paragraphs.length,1);assert.equal(e.references[2].author,'Food & Water Watch');assert.equal(e.references[3].author,'Privette');assert.equal(e.range.end,4);
});
test('complete narrative author lists survive preceding journal titles and possessives',()=>{
 const rs=[ref('Lei, N., Lu, J., Shehabi, A., & Masanet, E. (2025). Study.'),ref('Han, Y., Li, P., Wierman, A., & Ren, S. (2026). Study.','r1'),ref('Ren, S. (2025). Other study.','r2'),ref('Mytton, D. (2021). Water.','r3'),ref('De Vries-Gao, A. (2025). Water.','r4')];
 const result=A.analyze([p('In Resources, Conservation and Recycling, Lei, Lu, Shehabi, and Masanet (2025) found results. Han, Li, Wierman, and Ren’s (2026) work. Mytton’s (2021) research. de Vries-Gao’s (2025) results.')],rs,range);
 assert.equal(result.citations.length,4);assert.equal(result.citations[0].authorText,'Lei, Lu, Shehabi, and Masanet');assert.equal(result.citations[1].authors[0],'han');assert.ok(result.citations.every(c=>!c.issue));
 for(const c of result.citations)assert.equal(p('In Resources, Conservation and Recycling, Lei, Lu, Shehabi, and Masanet (2025) found results. Han, Li, Wierman, and Ren’s (2026) work. Mytton’s (2021) research. de Vries-Gao’s (2025) results.').text.slice(c.authorStart,c.authorEnd),c.authorText);
});
test('date ranges, prose years, target commitments and unit suffixes are not citations',()=>{
 const r=ref('Mytton, D. (2021). Water.');const cs=A.citationsIn(p('Forecasting Study (2020–2050). (baseline year 2025). 0.49 L/kWh (2021). (Microsoft 2030, AWS 2030 reclaimed water goals). Mytton (2021).'),[r]);assert.equal(cs.length,1);assert.equal(cs[0].authorText,'Mytton');
});
test('institution aliases, et al without a dot and Turkish heading boundaries are respected',()=>{
 const rs=[ref('Environmental and Energy Study Institute (EESI). (2025). Report.'),ref('Mistral AI. (2025). Report.','r1'),ref('Jiang, Y., Roy, R. B., & Tiwari, D. (2025). Study.','r2')];
 const r=A.analyze([p('Old section.',0),p('Yeni bölüm',1,'Balk1'),p('EESI (2025). Mistral (2025). Jiang et al (2025).',2)],rs,range);assert.equal(r.citations.length,3);assert.ok(r.citations.every(c=>!c.issue));assert.deepEqual(r.citations[0].context,['EESI (2025).']);
});
test('unverified year differences require version selection; ambiguous sources are not orphaned',()=>{
 const rs=[ref('Li, P. (2025). Journal.'),ref('McIver, L. (2026). One.','r1'),ref('McIver, L. (2026). Two.','r2')];
 const r=A.analyze([p('Li (2023). McIver (2026).')],rs,range);assert.equal(r.citations[0].issue,'Yıl uyuşmazlığı');assert.equal(r.citations[0].patch,undefined);assert.ok(!r.findings.some(f=>f.id.startsWith('orphan-')));
});
test('DOI, arXiv version and specific URL identity detect duplicates without conflating home pages',()=>{
 const rs=[ref('Jegham, N. (2025). How hungry? arXiv:2505.09598.'),ref('Ren, S. (2025). How hungry? https://arxiv.org/abs/2505.09598v2','r1'),ref('Bhat, D. (2025). News. https://restofworld.org/2025/example/','r2'),ref('Rest of World. (2026). News. https://www.restofworld.org/2025/example/','r3'),ref('Author, A. (2025). One. https://example.com/','r4'),ref('Author, B. (2026). Two. https://example.com/','r5')];
 assert.equal(A.analyze([],rs,range).findings.filter(f=>f.type==='Yinelenen kaynakça kaydı').length,4);
 assert.equal(E.parseReference(rs[0].raw).doi,'10.48550/arxiv.2505.09598');
});
test('article title begins after the complete parenthesized publication date',()=>{
 assert.equal(E.parseReference('Bhat, D. (2025, August 4). Big Tech is building AI in the desert. Rest of World.').title,'Big Tech is building AI in the desert');
 assert.equal(E.parseReference('Yazar, A. (2025a). Makale. Dergi.').title,'Makale');
});
test('long author lists remain separate Word bibliography entries',()=>{
 const authors='Hoffmann, J., Borgeaud, S., Mensch, A., Buchatskaya, E., Cai, T., Rutherford, E., de Las Casas, D., Hendricks, L. A., Welbl, J., Clark, A., Hennigan, T., Noland, E., Millican, K., van den Driessche, G., Damoc, B., Guy, A., Osindero, S., Simonyan, K., Elsen, E., Rae, J. W., Vinyals, O., & Sifre, L.';
 const raw=authors+' (2022). Training compute-optimal large language models. https://doi.org/10.48550/arxiv.2203.15556';
 const result=A.extractReferences([p('References',0),p('Fedus, W. (2022). Switch transformers.',1),p(raw,2),p('Next, A. (2023). Another study.',3)]);
 assert.equal(result.references.length,3);assert.equal(result.references[1].raw,raw);assert.equal(result.references[1].author,'Hoffmann');assert.equal(result.references[1].year,'2022');assert.deepEqual(result.references[1].paragraphs,['word/document.xml:2']);
});
test('author initials N. D. do not create a false undated reference or year mismatch',()=>{
 const raw='Le, T., Thai, M. V. T., Nguyen Manh, D., Phan Nhat, H., & Bui, N. D. Q. (2025). SWE-EVO. https://doi.org/10.48550/arXiv.2512.18470';
 const identity=A.referenceIdentity(raw);assert.equal(identity.year,'2025');assert.equal(identity.authors.length,5);assert.equal(identity.authors[4],'Bui');
 const result=A.analyze([p('SWE-EVO (Le et al., 2025) reports results.')],[ref(raw)],range);
 assert.equal(result.citations[0].reference,'r0');assert.equal(result.citations[0].issue,undefined);assert.equal(result.findings.length,0);
 assert.equal(A.referenceIdentity('Organization. (n.d.). Report.').year,'n.d.');
});
test('DOCX partial edits preserve tabs, line breaks, emoji offsets and all other ZIP parts',async()=>{
 const py=path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
 const original=JSON.parse(execFileSync(py,[path.join(__dirname,'word-fixture.py')],{encoding:'utf8'}));
 const transform=`import sys,json,zipfile,io,base64
d=json.load(sys.stdin); z=zipfile.ZipFile(io.BytesIO(base64.b64decode(d['data']))); out=io.BytesIO()
with zipfile.ZipFile(out,'w') as target:
 for info in z.infolist():
  data=z.read(info.filename)
  if info.filename=='word/document.xml': data=data.replace(b'<w:t>2019</w:t>', '<w:tab/><w:br/><w:t>2019</w:t>'.encode()).replace('Bulgular'.encode(),'Bulgular😊'.encode())
  target.writestr(info,data)
print(json.dumps({'data':base64.b64encode(out.getvalue()).decode()}))`;
 const fixture=JSON.parse(execFileSync(py,['-c',transform],{encoding:'utf8',input:JSON.stringify(original)}));
 const doc=await S.python({operation:'inspect',...fixture});const paragraph=doc.paragraphs[1],start=paragraph.text.indexOf('2019');
 const edited=await S.python({operation:'export',...fixture,patches:[{paragraph:paragraph.id,start,end:start+4,original:'2019',replacement:'2020'}]});
 const mapped=await S.python({operation:'inspect',...edited});assert.equal(mapped.paragraphs[1].text,paragraph.text.replace('2019','2020'));
 const check=`import sys,json,zipfile,io,base64,xml.etree.ElementTree as ET
a,b=json.load(sys.stdin);a=zipfile.ZipFile(io.BytesIO(base64.b64decode(a)));b=zipfile.ZipFile(io.BytesIO(base64.b64decode(b)))
W='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}';x=ET.fromstring(a.read('word/document.xml'));y=ET.fromstring(b.read('word/document.xml'))
print(json.dumps({'otherParts':all(a.read(n)==b.read(n) for n in a.namelist() if n!='word/document.xml'),'tabs':len(list(x.iter(W+'tab')))==len(list(y.iter(W+'tab'))),'breaks':len(list(x.iter(W+'br')))==len(list(y.iter(W+'br')))}))`;
 assert.deepEqual(JSON.parse(execFileSync(py,['-c',check],{input:JSON.stringify([fixture.data,edited.data]),encoding:'utf8'})),{otherParts:true,tabs:true,breaks:true});
 await assert.rejects(S.python({operation:'export',...fixture,patches:[{paragraph:paragraph.id,start:start-2,end:start+4,original:paragraph.text.slice(start-2,start+4),replacement:'2020'}]}),/sekme\/satır sonunu/);
});
test('text acquisition tries a second OA location after a blocked first location',async()=>{
 const calls=[];const result=await C.fullText(ref('Yazar, A. (2025). Study. https://doi.org/10.1234/test'),async()=>({passages:[{text:'Evidence.',location:'Page 1'}]}),new AbortController().signal,{remote:async url=>{calls.push(url);if(url.includes('europepmc'))throw Error('HTTP 403');if(url.includes('openalex'))return {data:Buffer.from(JSON.stringify({title:'Study',best_oa_location:{pdf_url:'https://publisher.example/blocked.pdf'},locations:[{pdf_url:'https://repository.example/open.pdf',version:'acceptedVersion'}]}))};if(url.includes('blocked'))throw Error('HTTP 403');return {data:Buffer.from('%PDF-test'),url};}});
 assert.equal(result.url,'https://repository.example/open.pdf');assert.equal(result.needsConfirmation,true);assert.equal(calls.length,5);assert.ok(calls.some(url=>url.includes('api.crossref.org/works/10.1234/test')));
});
test('Unpaywall DOI lookup prefers an open PDF before metadata abstracts',async()=>{
 const calls=[],reference=ref('Author, A. (2025). Open study. https://doi.org/10.1234/open');
 const result=await C.fullText(reference,async()=>({passages:[{text:'Open study 10.1234/open reports the evidence.',location:'Page 1'}]}),new AbortController().signal,{unpaywallEmail:'researcher@example.org',remote:async url=>{calls.push(url);if(url.includes('europepmc'))return {data:Buffer.from('{"resultList":{"result":[]}}'),url,type:'application/json'};if(url.includes('api.unpaywall.org'))return {data:Buffer.from(JSON.stringify({doi:'10.1234/open',is_oa:true,title:'Open study',best_oa_location:{url_for_pdf:'https://repository.example/open.pdf',url_for_landing_page:'https://repository.example/item',version:'publishedVersion',host_type:'repository',license:'cc-by'},oa_locations:[]})),url,type:'application/json'};if(url.endsWith('.pdf'))return {data:Buffer.from('%PDF-test'),url,type:'application/pdf'};throw Error('unexpected '+url);}});
 assert.equal(result.access,'Doğrudan erişilen PDF');assert.equal(result.needsConfirmation,false);assert.match(result.license,/cc-by/);assert.ok(calls[1].includes('api.unpaywall.org/v2/10.1234/open?email='));assert.equal(calls.length,3);
});
test('Crossref version-of-record PDF links are acquired before abstract fallback',async()=>{
 const calls=[],reference=ref('Li, P., Yang, J., Islam, M. A., & Ren, S. (2025). Making AI Less Thirsty. https://doi.org/10.1145/3724499');
 const result=await C.fullText(reference,async()=>({passages:[{text:'Making AI Less Thirsty DOI 10.1145/3724499 evidence.',location:'Page 1'}]}),new AbortController().signal,{remote:async url=>{calls.push(url);if(url.includes('europepmc'))return {data:Buffer.from('{"resultList":{"result":[]}}'),url,type:'application/json'};if(url.includes('api.crossref.org'))return {data:Buffer.from(JSON.stringify({message:{DOI:'10.1145/3724499',title:['Making AI Less Thirsty'],abstract:'Metadata abstract must not be used.',link:[{URL:'https://dl.acm.org/doi/pdf/10.1145/3724499','content-type':'application/pdf','content-version':'vor','intended-application':'syndication'}]}})),url,type:'application/json'};if(url.includes('dl.acm.org/doi/pdf'))return {data:Buffer.from('%PDF-test'),url,type:'application/pdf'};if(url.includes('openalex'))return {data:Buffer.from('{}'),url,type:'application/json'};throw Error('missing');}});
 assert.equal(result.access,'Doğrudan erişilen PDF');assert.equal(result.needsConfirmation,false);assert.equal(result.abstractOnly,undefined);assert.ok(calls.find(url=>url.includes('dl.acm.org/doi/pdf')));
});
test('explicit arXiv identity supports PDF retrieval; cancellation never starts alternate requests',async()=>{
 const r=ref('Jegham, N. (2025). Study. arXiv:2505.09598.');
 const result=await C.fullText(r,async()=>({passages:[{text:'Evidence.',location:'Page 1'}]}),new AbortController().signal,{remote:async url=>url.includes('arxiv.org/pdf')?{data:Buffer.from('%PDF-test'),url}:{data:Buffer.from('{}')}});assert.equal(result.url,'https://arxiv.org/pdf/2505.09598');assert.equal(result.needsConfirmation,false);
 const specific=await C.fullText({...r,raw:r.raw.replace('2505.09598','2505.09598v2')},async()=>({passages:[{text:'Evidence.',location:'Page 1'}]}),new AbortController().signal,{remote:async url=>url.includes('arxiv.org/pdf')?{data:Buffer.from('%PDF-test'),url}:{data:Buffer.from('{}')}});assert.equal(specific.url,'https://arxiv.org/pdf/2505.09598v2');
 const controller=new AbortController();let calls=0;await assert.rejects(C.fullText(r,async()=>({}),controller.signal,{remote:async()=>{calls++;controller.abort();throw Error('Cancelled');}}));assert.equal(calls,1);
});
test('DOI-free HTML and direct PDF references enter the evidence pipeline',async()=>{
 const html=Buffer.from('<html><head><meta property="og:title" content="How do data centers use and manage water?"></head><body><article><h1>How do data centers use and manage water?</h1><p>Data centers use water in cooling systems and power generation. Operators monitor withdrawals, consumption and local water stress when selecting cooling equipment.</p><p>This article explains operational water management practices in detail for operators, including treatment, reuse, discharge and seasonal demand. These practices affect both facility operations and surrounding water systems.</p></article></body></html>');
 const web=await C.fullText(ref('Roundy, J. (2025). How do data centers use and manage water? https://example.org/article'),async()=>({}),new AbortController().signal,{remote:async url=>({data:html,url,type:'text/html'})});
 assert.equal(web.access,'Web sayfası tam metni');assert.ok(web.passages[0].text.includes('cooling systems'));
 const pdf=await C.fullText(ref('Microsoft. (2026). Sustainability report. https://example.org/report'),async()=>({passages:[{text:'Sustainability evidence',location:'Page 1'}]}),new AbortController().signal,{remote:async url=>({data:Buffer.from('%PDF-test'),url,type:'application/pdf'})});
 assert.equal(pdf.access,'Doğrudan erişilen PDF');assert.equal(pdf.passages.length,1);
});
test('HTML meta refresh is followed before extracting DOI landing content',async()=>{
 const calls=[];const reference=ref('Author, A. (2025). Study title. https://doi.org/10.1234/study');
 const result=await C.fullText(reference,async()=>({}),new AbortController().signal,{remote:async url=>{calls.push(url);if(url.includes('europepmc'))throw Error('missing');if(url.includes('openalex'))return {data:Buffer.from('{}'),url,type:'application/json'};if(url==='https://doi.org/10.1234/study')return {data:Buffer.from('<meta http-equiv="refresh" content="0; url=https://publisher.example/article">'),url,type:'text/html'};return {data:Buffer.from('<html><head><meta name="citation_title" content="Study title"><meta name="citation_abstract" content="A sufficiently detailed abstract supplies evidence for this study and its reported findings."></head></html>'),url,type:'text/html'};}});
 assert.equal(result.abstractOnly,true);assert.match(result.passages[0].text,/reported findings/);assert.ok(calls.includes('https://publisher.example/article'));
});
test('targeted content checks do not reverify URL references that the acquisition pipeline can validate',()=>{
 const urlRef=ref('Roundy, J. (2025). Water use. https://example.org/water');urlRef.verification={status:'review'};
 const doiOnly=ref('Author, A. (2025). Study. https://doi.org/10.1234/study','r1');doiOnly.verification={status:'review'};
 const session={citations:[{id:'c0',reference:'r0',paragraph:'p0'},{id:'c1',reference:'r1',paragraph:'p1'}],references:[urlRef,doiOnly],effectiveReferences:[urlRef,doiOnly],appliedGroups:new Map(),manualConfirmed:new Set()};
 assert.equal(S.scopeNeedsVerification(session,{citation:'c0'}),false);
 assert.equal(S.scopeNeedsVerification(session,{citation:'c1'}),true);
 assert.equal(S.scopeNeedsVerification(session,{paragraph:'p0'}),false);
});
test('automatic content scope includes only matched citations without an existing result',()=>{
 const session={citations:[{id:'ready',reference:'r0'},{id:'issue',reference:'r1',issue:'Yıl uyuşmazlığı'},{id:'orphan'},{id:'done',reference:'r2'}],content:{done:{verdict:'supported'}}};
 assert.deepEqual(S.scopedCitations(session,{matchedOnly:true,pendingOnly:true}).map(c=>c.id),['ready']);
});
test('web identity comparison removes a trailing URL from bibliography titles',()=>{
 assert.equal(C.referenceTitle({title:'How\tdo\tdata\tcenters\tuse\tand\tmanage\twater? https://example.org/article'}),'How do data centers use and manage water');
});
