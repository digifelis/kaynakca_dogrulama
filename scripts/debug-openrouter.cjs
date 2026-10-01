const fs = require('node:fs');

for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (!match) continue;
  let value = match[2].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  process.env[match[1].trim()] = value;
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) throw Error('OPENROUTER_API_KEY yok');
  const started = Date.now();
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:4173',
        'X-Title': 'Kaynakca Masasi',
      },
      body: JSON.stringify({
        models: ['qwen/qwen3.8-27b:free', 'google/gemma-4-31b-it:free'],
        max_tokens: 20,
        messages: [{ role: 'user', content: 'Reply only with OK' }],
      }),
      signal: AbortSignal.timeout(120000),
    });
    const text = await response.text();
    let detail = text;
    try {
      const json = JSON.parse(text);
      detail = json.error?.message || json.choices?.[0]?.message?.content || '';
    } catch {}
    console.log(JSON.stringify({ status: response.status, elapsedMs: Date.now() - started, requestId: response.headers.get('x-request-id'), detail: String(detail).slice(0, 300) }));
  } catch (error) {
    console.error(JSON.stringify({ name: error.name, message: error.message, cause: error.cause && { code: error.cause.code, message: error.cause.message }, elapsedMs: Date.now() - started }));
    process.exitCode = 1;
  }
}

main();
