const test=require('node:test');
const assert=require('node:assert/strict');
const E=require('../reference-engine.js');
const A=require('../word-analysis.cjs');
const item=n=>({title:'SWE-agent: Agent-Computer Interfaces Enable Software Engineering',language:'en',year:2025,containerTitle:'Journal of Testing',volume:'3',issue:'2',pages:'10–20',doi:'10.1234/test',author:Array.from({length:n},(_,i)=>({family:'Author'+i,given:'Jane'}))});
test('APA bibliography includes all authors through twenty, then first nineteen and last',()=>{
 for(const n of [1,2,5,20,21,22]){
  const source=item(n),text=E.formatApa(source);
  assert.equal(source.author.length,n);
  assert.doesNotMatch(text,/et al\.|ve diğerleri/);
  for(let i=0;i<Math.min(n,19);i++)assert.ok(text.includes(`Author${i}, J.`));
  assert.ok(text.includes(`Author${n-1}, J.`));
  if(n>20){assert.match(text,/, \. \. \. Author/);assert.ok(!text.includes('Author19, J.'));assert.doesNotMatch(text,/&/);}
  else if(n>1)assert.ok(text.includes(`, & Author${n-1}, J.`));
 }
});
test('APA journal title case, italics and DOI',()=>{
 const html=E.formatApaHtml(item(5));
 assert.match(html,/SWE-agent: Agent-computer interfaces enable software engineering/);
 assert.match(html,/<em>Journal of Testing<\/em>, <em>3<\/em>\(2\), 10–20/);
 assert.match(html,/https:\/\/doi.org\/10.1234\/test/);
});
test('Turkish ve ark. survives citation extraction and sentence splitting',()=>{
 const text='Bu çalışmaya göre Kaplan ve ark. (2020) sonuçları açıklamıştır.';
 const refs=[{id:'r0',...A.referenceIdentity('Kaplan, J., Smith, A., & Doe, B. (2020). Test.')}];
 const citations=A.citationsIn({id:'p1',text},refs);
 assert.equal(citations.length,1);assert.equal(citations[0].authors[0],'kaplan');
 assert.equal(A.sentences(text).length,1);
 assert.equal(A.isTurkish(text),true);
 assert.equal(A.isTurkish('The study by Yılmaz and Smith shows the results of this work.'),false);
});
