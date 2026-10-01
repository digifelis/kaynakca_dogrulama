// Synthetic connection/claim check; no manuscript content or secrets are logged.
const fs = require('node:fs');
const path = require('node:path');
const config = {};
const file = path.join(__dirname, '..', '.env');
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match) config[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const key = config.GROQ_API_KEY || process.env.GROQ_API_KEY;
const model = config.GROQ_MODEL || process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
async function main() {
  if (!key) { console.log('GROQ_API_KEY yapılandırılmamış.'); process.exitCode = 1; return; }
  if (!/^[a-zA-Z0-9/._-]+$/.test(model)) { console.log('GROQ_MODEL biçimi geçersiz.'); process.exitCode = 1; return; }
  console.log('Groq anahtarı yapılandırılmış; bağlantı ve örnek atıf kontrolü yapılıyor.');
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, max_completion_tokens: 1600, response_format: {
      type: 'json_schema', json_schema: { name: 'claim_check', strict: true, schema: {
        type: 'object', additionalProperties: false, required: ['results'], properties: { results: {
          type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'verdict', 'evidence'], properties: {
            id: { type: 'string', enum: ['A', 'B', 'C'] },
            verdict: { type: 'string', enum: ['supported', 'contradicted', 'insufficient'] }, evidence: { type: 'string' },
          } },
        } },
      } },
    },
      messages: [
        { role: 'system', content: 'Evaluate claims only against the supplied synthetic evidence. Return JSON with results: an array of objects containing id, verdict (supported, contradicted, or insufficient), and evidence (an exact quote from supplied evidence, empty if insufficient). No outside knowledge.' },
        { role: 'user', content: 'Evidence: "Çalışmada 120 yetişkin incelendi. Uyku süresi ile dikkat puanı arasında pozitif ilişki bulundu. Araştırma gözlemseldir; nedensellik göstermez." Claims: A: "Araştırmada 120 yetişkin yer aldı." B: "Araştırma, uzun uykunun dikkati artırdığını nedensel olarak kanıtladı." C: "Araştırmada çocukların matematik başarısı arttı." Evaluate A, B, C.' },
      ],
    }),
  });
  if (!response.ok) {
    const messages = { 400: 'İstek veya model ayarı geçersiz.', 401: 'API anahtarı geçersiz.', 402: 'Kredi/faturalandırma gerekli.', 403: 'Erişim izni yok.', 404: 'Model bulunamadı.', 429: 'Sorgu kotası/hız sınırı.' };
    console.log(`Groq HTTP ${response.status}: ${messages[response.status] || 'Servis hatası.'}`);
    const retry = response.headers.get('retry-after');
    if (retry && /^\d+(\.\d+)?$/.test(retry)) console.log(`Yeniden deneme süresi: ${retry} saniye.`);
    process.exitCode = 1; return;
  }
  const body = await response.json();
  const content = body.choices?.[0]?.message?.content;
  if (!content?.trim()) { console.log('API erişilebilir ancak metin yanıtı alınamadı.'); process.exitCode = 1; return; }
  console.log('Groq bağlantısı başarılı (HTTP 200); model yanıt verdi.');
  let output;
  try { output = JSON.parse(content); } catch { console.log('Yapılandırılmış JSON yanıtı geçersiz.'); process.exitCode = 1; return; }
  const evidence = 'Çalışmada 120 yetişkin incelendi. Uyku süresi ile dikkat puanı arasında pozitif ilişki bulundu. Araştırma gözlemseldir; nedensellik göstermez.';
  const expected = { A: 'supported', B: 'contradicted', C: 'insufficient' };
  let passed = true;
  for (const [id, verdict] of Object.entries(expected)) {
    const rows = Array.isArray(output.results) ? output.results.filter(row => row.id === id) : [];
    const row = rows[0];
    const validEvidence = typeof row?.evidence === 'string' && (verdict === 'insufficient' ? row.evidence === '' : row.evidence.trim().length > 0 && evidence.includes(row.evidence));
    const ok = rows.length === 1 && row.verdict === verdict && validEvidence;
    console.log(`Örnek ${id} (${verdict}): ${ok ? 'başarılı' : 'beklenen sonuç alınamadı'}.`);
    passed &&= ok;
  }
  if (Number.isFinite(body.usage?.total_tokens)) console.log(`Test kullanımı: ${body.usage.total_tokens} token.`);
  if (!passed) {
    console.log('Örnek yanıt (yalnız yapay test verisi): ' + JSON.stringify(output).split(key).join('[gizli anahtar]').replace(/gsk_[\w-]+/g, '[gizli anahtar]').slice(0, 1600));
    process.exitCode = 1;
  }
}
main().catch(() => { console.log('Groq bağlantısı kurulamadı (ağ veya zaman aşımı).'); process.exitCode = 1; });
