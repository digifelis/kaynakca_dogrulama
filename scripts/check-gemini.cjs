// Connection check only: no manuscript text or API key is printed.
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
const key = process.env.GEMINI_API_KEY || config.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || config.GEMINI_MODEL || 'gemini-3.8-flash';
async function main() {
  if (!key) { console.log('GEMINI_API_KEY yapılandırılmamış.'); process.exitCode = 1; return; }
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) { console.log('GEMINI_MODEL biçimi geçersiz.'); process.exitCode = 1; return; }
  console.log('Gemini anahtarı yapılandırılmış; bağlantı kontrol ediliyor.');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with only OK.' }] }], generationConfig: { maxOutputTokens: 128 } }),
  });
  // Never log the raw upstream response: it can echo request details.
  if (!response.ok) {
    const messages = { 400: 'İstek veya anahtar geçersiz.', 401: 'Kimlik doğrulama başarısız.', 403: 'Anahtarın erişim izni yok.', 404: 'Yapılandırılmış model bulunamadı.', 429: 'Sorgu kotası/hız sınırı.' };
    const retry = response.headers.get('retry-after');
    console.log(`Gemini HTTP ${response.status}: ${messages[response.status] || 'Servis hatası.'}`);
    const detail = await response.json().catch(() => ({}));
    const message = detail.error?.message || '';
    if (message) {
      const safeMessage = String(message).split(key).join('[gizli anahtar]').replace(/AIza[\w-]+/g, '[gizli anahtar]').replace(/[\r\n]+/g, ' ').slice(0, 800);
      console.log(`API açıklaması: ${safeMessage}`);
    }
    const reasons = detail.error?.details?.map(item => item.reason) || [];
    if (/reported as leaked|leaked api key/i.test(message)) console.log('Neden: Google anahtarı sızdırılmış olarak işaretlemiş; yeni anahtar gerekiyor.');
    else if (reasons.includes('SERVICE_DISABLED')) console.log('Neden: Projede Generative Language API etkin değil.');
    else if (reasons.includes('API_KEY_SERVICE_BLOCKED')) console.log('Neden: Anahtarın API kısıtlamaları bu servise izin vermiyor.');
    else if (reasons.includes('API_KEY_HTTP_REFERRER_BLOCKED')) console.log('Neden: Anahtarın web sitesi kısıtlaması sunucu isteğini engelliyor.');
    else if (reasons.includes('API_KEY_IP_ADDRESS_BLOCKED')) console.log('Neden: Anahtarın IP kısıtlaması sunucu isteğini engelliyor.');
    else if (reasons.includes('API_KEY_INVALID')) console.log('Neden: API anahtarı geçersiz.');
    else if (/location.*not supported/i.test(message)) console.log('Neden: Hesabın veya bağlantının bölgesinde hizmet desteklenmiyor.');
    if (retry && /^\d+$/.test(retry)) console.log(`Yeniden deneme süresi: ${retry} saniye.`);
    process.exitCode = 1;
    return;
  }
  const body = await response.json();
  const hasText = body.candidates?.some(candidate => candidate.content?.parts?.some(part => typeof part.text === 'string' && part.text.trim()));
  console.log(hasText ? 'Gemini bağlantısı başarılı; model metin yanıtı verdi.' : 'API erişilebilir ancak metin yanıtı alınamadı.');
  if (!hasText) process.exitCode = 1;
}
main().catch(() => { console.log('Gemini bağlantısı kurulamadı (ağ veya zaman aşımı).'); process.exitCode = 1; });
