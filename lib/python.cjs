// Runs scripts/word-package.py (DOCX/PDF/XML handling) with one JSON request on stdin.
// Used by the web app and by the verification service for full-text PDFs.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const __root=path.join(__dirname,'..');
const bundled=path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const pythonPath=()=>process.env.WORD_PYTHON||(fs.existsSync(bundled)?bundled:'python');
function python(request){return new Promise((resolve,reject)=>{
  const child=spawn(pythonPath(),[path.join(__root,'scripts/word-package.py')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let data='',size=0;const timer=setTimeout(()=>child.kill(),45000);
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>32*1024*1024){child.kill();return;}data+=chunk.toString();});
  child.stderr.resume();child.stdin.on('error',()=>{});
  child.on('error',()=>{clearTimeout(timer);reject(Error('Word işleme için Python çalıştırılamadı.'));});
  child.on('close',()=>{clearTimeout(timer);try{const output=JSON.parse(data);if(output.error)reject(Error(output.error));else resolve(output);}catch{reject(Error('Dosya işleme tamamlanamadı; boyut/biçim sınırlarını kontrol edin.'));}});
  child.stdin.end(JSON.stringify(request));
});}
module.exports={python,pythonPath};
