const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const { publicIp } = require('./word-content.cjs');
const Web = require('./web-reference.js');
const Groq = require('./web-groq.cjs');
const MAX_BYTES = 3 * 1024 * 1024;
function decode(text) {
  const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…' };
  return String(text || '').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (all, key) => {
    if (key[0] !== '#') return entities[key.toLowerCase()] ?? all;
    const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
  });
}
const plain = html => Web.clean(decode(String(html || '').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->/gi, ' ').replace(/<[^>]+>/g, ' ')));
function attrs(tag) {
  const values = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) values[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4]);
  return values;
}
const samePage = (a, b) => { try { const x = new URL(a, b), y = new URL(b); return x.origin === y.origin && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '') && x.search === y.search; } catch { return false; } };
function metadata(html, url) {
  const meta = new Map(), evidence = [], conflicts = [];
  for (const m of html.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const a = attrs(m[0]), key = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (key && a.content) meta.set(key, [...(meta.get(key) || []), a.content]);
  }
  const value = key => meta.get(key)?.[0] || '';
  const h1 = plain(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i)?.[1]);
  const titleTag = plain(html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]);
  const nodes = [];
  function collect(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 20 || nodes.length > 2000) return;
    if (Array.isArray(node)) { node.forEach(x => collect(x, depth + 1)); return; }
    nodes.push(node);
    for (const v of Object.values(node)) if (v && typeof v === 'object') collect(v, depth + 1);
  }
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (attrs(m[1]).type?.toLowerCase() !== 'application/ld+json') continue;
    try { collect(JSON.parse(m[2])); } catch { /* Invalid metadata is not evidence. */ }
  }
  const types = node => [].concat(node?.['@type'] || []);
  const articles = nodes.filter(n => types(n).some(t => ['Article', 'NewsArticle', 'BlogPosting', 'ScholarlyArticle', 'Report'].includes(t)));
  const identities = n => [n.url, typeof n.mainEntityOfPage === 'string' ? n.mainEntityOfPage : n.mainEntityOfPage?.['@id'], n['@id']].filter(x => typeof x === 'string');
  const article = articles.find(n => identities(n).some(id => samePage(id, url))) || articles.find(n => !identities(n).length && h1 && Web.norm(n.headline) === Web.norm(h1));
  const resolveNode = node => node?.['@id'] && !node.name ? nodes.find(n => n['@id'] === node['@id'] && n.name) || node : node;
  const record = (field, val, source) => { if (val) evidence.push({ field, value: String(val).slice(0, 1500), source }); return val || ''; };
  const title = record('Başlık', article?.headline || h1 || value('og:title') || titleTag, article?.headline ? 'JSON-LD headline' : h1 ? 'Görünen H1' : value('og:title') ? 'og:title' : 'HTML title');
  if (value('og:title')) record('Alternatif başlık', value('og:title'), 'og:title');
  if (article?.headline) record('Alternatif başlık', article.headline, 'JSON-LD headline');
  const site = record('Site', resolveNode(article?.publisher)?.name || value('og:site_name'), article?.publisher ? 'JSON-LD publisher' : 'og:site_name');
  let authors = [].concat(article?.author || []).map(resolveNode).map(a => typeof a === 'string' ? { name: a, type: 'Person' } : { name: a?.name, type: types(a).includes('Organization') ? 'Organization' : 'Person' }).filter(a => a.name);
  if (!authors.length) authors = (meta.get('author') || meta.get('autor') || meta.get('citation_author') || []).map(name => ({ name, type: 'Person' }));
  authors = authors.slice(0, 50).map(a => ({ ...a, name: Web.clean(a.name).slice(0, 200) }));
  if (authors.length) record('Yazar', authors.map(a => a.name).join('; '), article?.author ? 'JSON-LD author' : 'meta author');
  // Only explicit labels count as visible dates. Never read a year from footer text.
  const bodyText = plain(html);
  const visibleDate = bodyText.match(/(?:Published(?:\s+on)?|Yayımlanma(?:\s+tarihi)?|Yayın\s+tarihi)\s*:?\s*((?:[A-Za-zÇĞİÖŞÜçğıöşü]+\s+\d{1,2},?\s+\d{4})|(?:\d{1,2}\s+[A-Za-zÇĞİÖŞÜçğıöşü]+\s+\d{4})|(?:\d{4}-\d{2}-\d{2}))/i)?.[1];
  const date=(items)=>items.find(v=>v&&Web.dateParts(v))||'';
  const published = record('Yayın tarihi', date([article?.datePublished,value('article:published_time'),value('citation_publication_date'),value('datepublished'),value('date'),value('pubdate'),visibleDate]), 'JSON-LD / meta / açık yayın tarihi');
  const modified = record('Güncelleme tarihi', date([article?.dateModified,value('article:modified_time'),value('datemodified'),value('last-modified'),value('og:updated_time')]), 'JSON-LD / meta güncelleme tarihi');
  for (const candidate of [article?.datePublished, value('article:published_time'),visibleDate].filter(Boolean)) {
    record('Yayın tarihi', candidate, 'Yapılandırılmış yayın tarihi');
    const a = Web.dateParts(published), b = Web.dateParts(candidate);
    if (a && b && ['year', 'month', 'day'].some(k => a[k] && b[k] && a[k] !== b[k])) conflicts.push('Yayın tarihi kanıtları çelişiyor');
  }
  if (article?.author && value('author') && !authors.some(a => Web.norm(a.name) === Web.norm(value('author')))) conflicts.push('Yazar metadata alanları farklı; görünür yazar satırını kontrol edin');
  let canonical = '';
  for (const m of html.matchAll(/<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const a = attrs(m[0]);
    if (a.rel?.split(/\s+/).includes('canonical') && a.href) { try { canonical = new URL(a.href, url).href; } catch {} }
  }
  if (canonical && !samePage(canonical, url)) conflicts.push('Canonical adresi ile açılan sayfa farklı; adresi kontrol edin');
  const doi = (value('citation_doi') || String(article?.identifier?.value || '')).match(/10\.\d{4,9}\/[^\s]+/i)?.[0] || '';
  if (types(article).some(t => ['ScholarlyArticle', 'Report'].includes(t)) || value('citation_journal_title')) return { state: 'unsupported', reason: 'Bu bağlantı akademik makale/rapor olarak tanındı. DOI ile akademik doğrulamayı kullanın.', doi, evidence };
  if ((!title&&bodyText.length<80) || /^(just a moment|access denied|attention required|page not found|404|sign in|log in|verify you are human)/i.test(title)) return { state: 'blocked', reason: 'Yazı yerine erişim, hata veya giriş sayfası alındı.', evidence };
  if (!h1 && !article) conflicts.push('Görünen yazı başlığı alınamadı; yalnız sayfa meta bilgileri mevcut');
  return { state: 'ok', title: title.slice(0, 1000), authors, published, modified, site: String(site).slice(0, 300), url, canonical, evidence, conflicts, checkedAt: new Date().toISOString() };
}
function validateUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || value.length > 8000) throw Error('Desteklenmeyen web adresi.');
  return url;
}
async function fetchPage(value, signal, redirects = 0, lookup = dns.lookup) {
  signal?.throwIfAborted();
  if (redirects > 4) throw Error('Yönlendirme sınırı aşıldı.');
  const url = validateUrl(value);
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  signal?.throwIfAborted();
  if (!addresses.length || addresses.some(a => !publicIp(a.address))) throw Error('İç ağ veya özel adres bağlantısı reddedildi.');
  const address = addresses.find(a => a.family === 4) || addresses[0];
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, { signal, timeout: 15000,
      headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Encoding': 'identity', 'User-Agent': 'KaynakcaMasasi/1.0 (bibliography verification)' },
      lookup: (_host, options, cb) => cb(null, options.all ? [address] : address.address, address.family),
    }, response => {
      const status = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        let next; try { next = new URL(response.headers.location, url).href; } catch (e) { reject(e); return; }
        fetchPage(next, signal, redirects + 1, lookup).then(resolve, reject); return;
      }
      const common = { status, url: url.href, retryAfter: response.headers['retry-after'] };
      if (status !== 200) { response.resume(); resolve(common); return; }
      if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(response.headers['content-type'] || '')) { response.resume(); resolve({ ...common, unsupported: true }); return; }
      let size = 0; const chunks = [];
      response.on('data', chunk => { size += chunk.length; if (size > MAX_BYTES) response.destroy(Error('Web sayfası 3 MB sınırını aşıyor.')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const data = Buffer.concat(chunks);
          const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(response.headers['content-type'])?.[1] || /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(data.subarray(0, 2048).toString('ascii'))?.[1] || 'utf-8';
          resolve({ ...common, html: new TextDecoder(charset).decode(data) });
        } catch { reject(Error('Web sayfası karakter kodlaması okunamadı.')); }
      });
    });
    request.on('timeout', () => request.destroy(Error('Web isteği zaman aşımına uğradı.')));
    request.on('error', reject);
  });
}
function retryTime(header, now) {
  const delay = /^\d+(?:\.\d+)?$/.test(header || '') ? Number(header) * 1000 : Date.parse(header) - now;
  return now + (Number.isFinite(delay) ? Math.max(1000, delay) : 60000);
}
function createService({ transport = fetchPage, now = Date.now, spacing = 1000, enrich = Groq.enrich } = {}) {
  const cache = new Map(), stale = new Map(), cooldowns = new Map(), queues = new Map(), last = new Map();
  const blockedFallback = (key, reason) => {
    const previous = stale.get(key);
    if (!previous) return null;
    return { ...previous, state: 'ok', staleAccess: true, warnings: [...(previous.warnings || []), 'Web erişimi engellendi; önceki başarılı künye ve kanıtlar kullanıldı.'], reason };
  };
  return async function inspect(value, signal) {
    const url = validateUrl(value); url.hash = '';
    const key = url.href, host = url.hostname;
    if (cache.get(key)?.expires > now()) return cache.get(key).data;
    const job = (queues.get(host) || Promise.resolve()).catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      if (cache.get(key)?.expires > now()) return cache.get(key).data;
      if ((cooldowns.get(host) || 0) > now()) return { state: 'deferred', retryAt: cooldowns.get(host), reason: 'Bu site için kota beklemesi sürüyor; diğer kaynaklara devam edildi.' };
      const delay = Math.max(0, spacing - (now() - (last.get(host) || 0)));
      if (delay) await require('node:timers/promises').setTimeout(delay, undefined, { signal });
      last.set(host, now());
      const response = await transport(key, signal);
      if (response.status === 429) {
        const retryAt = retryTime(response.retryAfter, now()); cooldowns.set(host, retryAt);
        return { state: 'deferred', retryAt, reason: 'Site hız/kota sınırı bildirdi. Bu kayıt ertelendi; özgün kaynak korundu.' };
      }
      if ([404, 410].includes(response.status)) return { state: 'missing', reason: `Web adresi HTTP ${response.status} döndürdü. Bu, yayının hiç var olmadığı anlamına gelmez.` };
      if (response.status !== 200) return blockedFallback(key, `Web sayfasına erişilemedi (HTTP ${response.status}); önceki başarılı künye kullanıldı.`) || { state: 'blocked', reason: `Web sayfasına erişilemedi (HTTP ${response.status}). Özgün kayıt korundu.` };
      if (response.unsupported) return { state: 'unsupported', reason: 'Bağlantı bir HTML web sayfası değil; PDF/diğer belgeler bu akışta desteklenmiyor.' };
      let data = metadata(response.html, response.url);
      if (new URL(response.url).pathname === '/' && url.pathname !== '/') { data.state = 'blocked'; data.reason = 'Yazı adresi ana sayfaya yönlendirildi; kaynak kimliği doğrulanamadı.'; }
      if (data.state === 'blocked') return blockedFallback(key, data.reason) || data;
      if(data.state==='ok'){
        if(!data.title||!data.authors.length||!Web.dateParts(data.published)||!data.site){
          const text=plain(response.html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi,' '));
          const bounded=text.length>18000?text.slice(0,14000)+' […] '+text.slice(-4000):text;
          data=await enrich(data,bounded,signal);
        }
        if(!data.authors.length&&data.site){data.authors=[{name:data.site,type:'Organization'}];data.authorFallback=true;data.evidence.push({field:'Yazar',value:data.site,source:'Kişi yazarı bulunamadı; site adı kurumsal yazar olarak kullanıldı'});}
      }
      if (cache.size >= 100) cache.delete(cache.keys().next().value);
      cache.set(key, { data, expires: data.groqRetryAt?Math.min(now()+300000,data.groqRetryAt):now()+300000 });
      if (data.state === 'ok') stale.set(key, data);
      return data;
    });
    queues.set(host, job);
    try { return await job; } finally { if (queues.get(host) === job) queues.delete(host); }
  };
}
module.exports = { metadata, validateUrl, fetchPage, createService, retryTime };
