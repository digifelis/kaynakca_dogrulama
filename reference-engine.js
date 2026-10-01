/* Shared browser/Node verification engine. No citation text is persisted. */
(function (root) {
  function checkAbort(signal) {
    if (signal?.aborted) { const error = new Error('İşlem durduruldu'); error.name = 'AbortError'; throw error; }
  }
  function sleep(ms, signal) {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
      const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); const error = new Error('İşlem durduruldu'); error.name = 'AbortError'; reject(error); };
      const timer = setTimeout(finish, ms);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  function retryDelay(header, count = 0) {
    const value = header?.trim();
    const delay = value ? (/^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()) : NaN;
    return Number.isFinite(delay) ? Math.max(1000, delay) : Math.min(900000, 60000 * 2 ** Math.min(count, 4));
  }
  async function waitForQuota(provider, delay, count, signal, onRetry) {
    const retryAt = Date.now() + delay;
    while (Date.now() < retryAt) {
      checkAbort(signal);
      const remainingMs = retryAt - Date.now();
      onRetry?.({ provider, remainingMs, retryAt, count, waiting: true });
      await sleep(Math.min(1000, remainingMs), signal);
    }
    checkAbort(signal);
    onRetry?.({ provider, remainingMs: 0, retryAt, count, waiting: false });
  }
  const cache = new Map();
  const lastRequest = new Map();
  const providerQueues = new Map();
  const quotaUntil = new Map();
  const quotaAttempts = new Map();
  let additionalProviders = root.ReferenceProviders || null;
  const web = root.ReferenceWeb || (typeof require === 'function' ? require('./web-reference.js') : null);
  let options = {};
  function configure(settings = {}) {
    options = { ...options, ...settings };
    if (settings.additionalProviders) additionalProviders = settings.additionalProviders;
    if ('proxyUrl' in settings || 'additionalProviders' in settings || 'googleBooksConfigured' in settings) cache.clear();
  }

  function normalizeTitle(value) {
    return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '')
      .toLowerCase().replace(/ı/g, 'i').replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  function splitReferences(text) {
    const lines = String(text).replace(/\r/g, '').trim().split('\n');
    const records = [];
    let current = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (current.length) records.push(current.join(' '));
        current = [];
        continue;
      }
      const numbered = /^(?:\[\d+\]|\d+[.)])\s+/.test(trimmed);
      const authorStart = /^(?:(?:van|von|de|der|den)\s+)*[\p{Lu}][\p{L}'’–-]+(?:\s+[\p{L}'’–-]+){0,2},\s*(?:[\p{Lu}]\.|[\p{Lu}][\p{Ll}])/u.test(trimmed);
      const vancouverStart = /^[\p{Lu}][\p{L}'’–-]+\s+[A-Z]{1,4}(?:[,\s]|\.)/u.test(trimmed);
      const datedAuthorStart = /^[^\n]{1,220}?\(\s*(?:(?:19|20)\d{2}[a-z]?(?:\s*[,)]|$)|t\.\s*y\.|n\.\s*d\.)/iu.test(trimmed);
      if (current.length && (numbered || authorStart || vancouverStart || datedAuthorStart)) {
        records.push(current.join(' '));
        current = [];
      }
      current.push(trimmed.replace(/^(?:\[\d+\]|\d+[.)])\s+/, ''));
    }
    if (current.length) records.push(current.join(' '));
    return records.filter(Boolean);
  }

  function getDoi(reference) {
    const match = reference.match(/\b10\.\d{4,9}\/[^\s<>"]+/i);
    let doi = match?.[0]?.replace(/[.,;]+$/, '') || '';
    // Preserve parentheses belonging to the DOI; remove only unbalanced wrappers.
    while (doi.endsWith(')') && (doi.match(/\)/g) || []).length > (doi.match(/\(/g) || []).length) doi = doi.slice(0, -1);
    return doi.toLowerCase();
  }

  function parseReference(reference) {
    const arxiv = reference.match(/(?:arxiv\s*:\s*|arxiv\.org\/(?:abs|pdf)\/|10\.48550\/arxiv\.)([a-z]+[-\w]*\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i)?.[1];
    const doi = getDoi(reference) || (arxiv ? `10.48550/arxiv.${arxiv}` : '');
    const withoutDoi = reference.replace(/(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?10\.\d{4,9}\/\S+/i, '').trim();
    const yearMatch = withoutDoi.match(/\b(?:18|19|20)\d{2}(?=[a-z]?\b)/i);
    const year = yearMatch ? Number(yearMatch[0]) : null;
    let yearEnd = yearMatch ? yearMatch.index + yearMatch[0].length : -1;
    if(yearMatch){const date=withoutDoi.slice(0,yearMatch.index).match(/\(\s*$/);if(date){const close=withoutDoi.indexOf(')',yearEnd);if(close>=0&&close-yearEnd<65)yearEnd=close+1;}}
    let title = '';
    let authorText = '';
    if (yearMatch) {
      const tail = withoutDoi.slice(yearEnd).replace(/^[a-z]?\s*\)?[.,:]?\s*/, '');
      // Author-date references have the title immediately after the year.
      if (tail && !/^\s*[;:\d]/.test(tail)) {
        title = tail.split(/\.\s+/)[0].replace(/[.]+$/, '').trim();
        authorText = withoutDoi.slice(0, yearMatch.index).replace(/\(\s*$/, '').trim();
      }
    }
    if (!title) {
      // Vancouver: author list. Title. Journal. Year;volume:pages.
      const parts = withoutDoi.split(/\.\s+/);
      if (parts.length > 1) {
        authorText = parts[0];
        title = parts.slice(1).find(part => normalizeTitle(part).split(' ').length >= 3 && !/^\d/.test(part)) || '';
        title = title.replace(/[.?!]+$/, '').trim();
      }
    }
    const authorPrefix = authorText || withoutDoi;
    const firstAuthor = authorPrefix.includes(',') && !/^[\p{L}'’–-]+\s+[A-Z]{1,4},/u.test(authorPrefix)
      ? authorPrefix.split(',')[0].trim()
      : authorPrefix.match(/^([\p{L}'’–-]+)\s+[A-Z]{1,4}(?:\s|[,\.])/u)?.[1] || authorPrefix.match(/^([\p{L}'’–-]+)/u)?.[1] || '';
    return { reference, year, doi, title, firstAuthor, arxiv: arxiv || '' };
  }

  function titleScore(a, b) {
    const normalizedA = normalizeTitle(a);
    const normalizedB = normalizeTitle(b);
    // Some styles separate title and journal with a comma. A complete candidate
    // title at the beginning is a title match, even when publication text follows.
    if (normalizedB.split(' ').length >= 4 && normalizedA.startsWith(`${normalizedB} `)) return 1;
    const left = new Set(normalizedA.split(' ').filter(Boolean));
    const right = new Set(normalizedB.split(' ').filter(Boolean));
    if (!left.size || !right.size) return 0;
    return [...left].filter(word => right.has(word)).length / Math.max(left.size, right.size);
  }

  function rankCandidate(parsed, item) {
    const titleMatch = titleScore(parsed.title, item.title);
    const authorMatch = !!parsed.firstAuthor && item.author.some(author => {
      const name = normalizeTitle(author.family || author.literal);
      const wanted = normalizeTitle(parsed.firstAuthor);
      return name === wanted || (` ${name} `).includes(` ${wanted} `);
    });
    const yearMatch = !!parsed.year && parsed.year === item.year;
    const doiMatch = !!parsed.doi && parsed.doi === (item.doi || '').toLowerCase();
    return { ...item, titleMatch, authorMatch, yearMatch, doiMatch,
      score: Math.round(titleMatch * 60 + (authorMatch ? 20 : 0) + (yearMatch ? 10 : 0) + (doiMatch ? 10 : 0)) };
  }

  class ProviderError extends Error {
    constructor(provider, status, detail) {
      super(detail || `${provider}: HTTP ${status}`);
      this.provider = provider;
      this.status = status;
    }
  }

  async function requestJson(provider, url) {
    const { signal, onRetry, onRequest } = options;
    checkAbort(signal);
    if (cache.has(url)) return cache.get(url);
    // One in-flight call per provider, with conservative spacing for public pools.
    const previous = providerQueues.get(provider) || Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      if (cache.has(url)) return cache.get(url);
      let attempt = 0;
      let quotaCount = 0;
      while (true) {
        checkAbort(signal);
        const until = quotaUntil.get(provider) || 0;
        if (until > Date.now()) {
          if (options.deferQuota) { const error = new ProviderError(provider, 429); error.retryAt = until; error.url = url; throw error; }
          await waitForQuota(provider, until - Date.now(), quotaAttempts.get(provider) || 1, signal, onRetry);
        }
        const interval = provider === 'Crossref' ? (url.startsWith('https://api.crossref.org/works/') ? 200 : 1000) : ({ PubMed: 400, CORE: 2200, DBLP: 1100, OpenLibrary: 1100, 'Semantic Scholar': 1000 })[provider] || 400;
        await sleep(Math.max(0, interval - (Date.now() - (lastRequest.get(provider) || 0))), signal);
        lastRequest.set(provider, Date.now());
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => controller.abort(), 15000);
        let response;
        let requestUrl = url;
        try {
          onRequest?.({ provider, url, at: Date.now() });
          requestUrl = options.proxyUrl ? `${options.proxyUrl}?provider=${encodeURIComponent(provider)}&url=${encodeURIComponent(url)}` : url;
          response = await fetch(requestUrl, { signal: controller.signal, headers: { Accept: 'application/json' } });
        } catch (error) {
          checkAbort(signal);
          if (attempt < 2) { await sleep(1000 * 2 ** attempt++, signal); continue; }
          const failure = new ProviderError(provider, 0, `${provider}: ${error.name === 'AbortError' ? 'zaman aşımı' : 'bağlantı veya tarayıcı erişim hatası'}`);
          failure.url = url; failure.requestUrl = requestUrl; throw failure;
        } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
        checkAbort(signal);
        options.onResponse?.({ provider, url, status: response.status, at: Date.now(), retryAfter: response.headers.get('retry-after') || '' });
        if (response.status === 404) { cache.set(url, null); return null; }
        if (response.status === 429) {
          // Keep this exact request and the batch position until the quota resets.
          quotaCount = quotaAttempts.get(provider) || 0;
          const delay = retryDelay(response.headers.get('retry-after'), quotaCount);
          quotaUntil.set(provider, Date.now() + delay);
          quotaAttempts.set(provider, quotaCount + 1);
          if (options.deferQuota) { const error = new ProviderError(provider, 429); error.retryAt = quotaUntil.get(provider); error.url = url; throw error; }
          await waitForQuota(provider, delay, ++quotaCount, signal, onRetry);
          continue;
        }
        if (response.status >= 500) {
          const retryHeader = response.headers.get('retry-after');
          const retrySeconds = Number(retryHeader);
          const retryMs = retryHeader ? (Number.isFinite(retrySeconds) ? retrySeconds * 1000 : Date.parse(retryHeader) - Date.now()) : 1500 * 2 ** attempt;
          if (attempt < 2 && retryMs <= 30000) { attempt += 1; await sleep(Math.max(1000, retryMs || 1500), signal); continue; }
          let detail = '';
          try { detail = (await response.clone().json())?.error || ''; } catch { /* The gateway may return HTML. */ }
          const failure = new ProviderError(provider, response.status, detail ? `${provider}: ${detail}` : undefined);
          failure.url = url; failure.requestUrl = requestUrl; throw failure;
        }
        if (!response.ok) { const failure = new ProviderError(provider, response.status); failure.url = url; failure.requestUrl = requestUrl; throw failure; }
        let data;
        try { data = await response.json(); } catch { throw new ProviderError(provider, response.status, `${provider}: geçersiz JSON yanıtı`); }
        cache.set(url, data);
        quotaUntil.delete(provider);
        quotaAttempts.delete(provider);
        return data;
      }
    });
    providerQueues.set(provider, job);
    return job;
  }

  function fromCrossref(raw) {
    return { title: raw.title?.[0] || '', author: raw.author || [],
      language: raw.language || '',
      year: raw.published?.['date-parts']?.[0]?.[0] || raw.issued?.['date-parts']?.[0]?.[0] || null,
      doi: raw.DOI || '', containerTitle: raw['container-title']?.[0] || '',
      volume: raw.volume || '', issue: raw.issue || '', pages: raw.page || '',
      publisher: raw.publisher || '', editor: raw.editor || [], type: raw.type || '',
      url: raw.DOI ? `https://doi.org/${raw.DOI}` : raw.URL || '', provider: 'Crossref' };
  }

  async function crossrefSearch(parsed, byDoi = false) {
    const base = 'https://api.crossref.org/works';
    // A DOI is a path with a meaningful slash. Encode each component while
    // preserving that separator so Crossref receives /works/10.53328/inr26rma002.
    const doiPath = parsed.doi.split('/').map(encodeURIComponent).join('/');
    const url = byDoi ? `${base}/${doiPath}` : `${base}?query.bibliographic=${encodeURIComponent(parsed.title ? `${parsed.title} ${parsed.firstAuthor} ${parsed.year || ''}` : parsed.reference)}&rows=5`;
    const data = await requestJson('Crossref', url);
    return (byDoi ? (data?.message ? [data.message] : []) : data?.message?.items || []).map(fromCrossref);
  }

  async function dataciteLookup(parsed) {
    const data = await requestJson('DataCite', `https://api.datacite.org/dois/${encodeURIComponent(parsed.doi)}`);
    const raw = data?.data?.attributes;
    if (!raw) return [];
    return [{ title: raw.titles?.[0]?.title || '', author: (raw.creators || []).map(person => {
      if (person.familyName) return { family: person.familyName, given: person.givenName || '' };
      if (person.name?.includes(',')) { const [family, ...given] = person.name.split(','); return { family: family.trim(), given: given.join(',').trim() }; }
      return { literal: person.name || '' };
    }), year: Number(raw.publicationYear) || null, doi: raw.doi || parsed.doi,
    containerTitle: raw.container?.title || raw.publisher?.name || raw.publisher || '',
    volume: raw.container?.volume || '', issue: raw.container?.issue || '', pages: '',
    provider: 'DataCite', url: `https://doi.org/${raw.doi || parsed.doi}` }];
  }

  async function openAlexSearch(parsed) {
    const base = 'https://api.openalex.org/works';
    if (parsed.doi) {
      const direct = await requestJson('OpenAlex', `${base}?filter=doi:${encodeURIComponent(`https://doi.org/${parsed.doi}`)}&per-page=1`);
      if (direct?.results?.length) return direct.results.map(fromOpenAlex);
    }
    const data = await requestJson('OpenAlex', `${base}?search=${encodeURIComponent(parsed.title || parsed.reference)}&per-page=5`);
    return (data?.results || []).map(fromOpenAlex);
  }

  function fromOpenAlex(raw) {
    return { title: raw.title || '', author: (raw.authorships || []).map(entry => ({ literal: entry.author?.display_name || '' })),
      year: raw.publication_year || null, doi: raw.doi?.replace(/^https?:\/\/doi\.org\//i, '') || '',
      containerTitle: raw.primary_location?.source?.display_name || '',
      volume: raw.biblio?.volume || '', issue: raw.biblio?.issue || '',
      pages: [raw.biblio?.first_page, raw.biblio?.last_page].filter(Boolean).join('–'),
      provider: 'OpenAlex', url: raw.doi || raw.id };
  }

  function sentenceCase(value, language = '', properNouns = []) {
    const title = String(value || '').trim().replace(/[.]+$/, '');
    const locale = /^tr\b/i.test(language) || (!language && /[çğıöşü]/i.test(title)) ? 'tr' : 'en';
    const words = [...title.matchAll(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu)];
    const allCaps = title === title.toLocaleUpperCase(locale);
    const sentenceStyle = words.filter(entry => /^\p{Lu}/u.test(entry[0])).length / Math.max(1, words.length) < .45;
    const names = ['SWE-agent', 'SWE-bench', 'AI', 'Türkiye', 'Turkey', 'Türkçe', 'English', 'Turkish', 'Google Maps', 'Google', 'Flickr', 'Airbnb', 'TripAdvisor', 'YouTube', 'Facebook', 'OpenAlex', 'Crossref', 'PubMed', 'Europe PMC', 'OpenLibrary', 'Los Angeles', 'Hong Kong', 'Barcelona', 'Konya', 'Çatalhöyük', 'Beydağları', 'Ihlara', 'Edirne', 'Yogyakarta', 'Banyumas', 'Austria', 'Serbia', 'Mexico', ...properNouns];
    const protectedRanges = [];
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const match of title.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu'))) {
        protectedRanges.push({ start: match.index, end: match.index + match[0].length, name });
      }
    }
    protectedRanges.sort((a, b) => (b.end - b.start) - (a.end - a.start));
    let converted = title.replace(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu, (word, offset) => {
      const range = protectedRanges.find(entry => offset >= entry.start && offset + word.length <= entry.end);
      if (range) return range.name.slice(offset - range.start, offset - range.start + word.length);
      const acronym = /^(?:APA|BERT|COVID(?:-19)?|GIS|LISA|MDIVis|TR\d+|IEEE|ERIC|DBLP|CORE|DOI)$/i.test(word) || (!allCaps && /^[\p{Lu}\d-]{2,8}$/u.test(word));
      const mixedCase = word.split(/[-’']/).some(part => /\p{Ll}.*\p{Lu}/u.test(part));
      if (acronym || mixedCase || (sentenceStyle && /^\p{Lu}/u.test(word))) return word;
      return word.toLocaleLowerCase(locale);
    });
    // Initial word of the title, subtitle and any subsequent sentence.
    return converted.replace(/(^|[:.!?]\s+|\s[-–—]\s+|[–—]\s*)([^\p{L}\p{N}]*)([\p{L}])/gu, (_, prefix, punctuation, letter) => prefix + punctuation + letter.toLocaleUpperCase(locale));
  }

  function apaParts(item) {
    if (item.type === 'web' && item.webCitation) return [{ text: item.webCitation.text, italic: false }];
    const names = item.author.map(author => {
      if (author.literal) return author.literal;
      const initials = (author.given || '').split(/[\s-]+/).filter(Boolean).map(part => `${part[0]}.`).join(' ');
      return `${author.family || ''}${initials ? `, ${initials}` : ''}`;
    }).filter(Boolean);
    const authors = bibliographyAuthors(names, item);
    const parts = [];
    const add = (text, italic = false) => { if (text) parts.push({ text, italic }); };
    add(`${authors} (${item.year || 't.y.'}). `);
    const title = sentenceCase(item.title, item.language, item.properNouns);
    add(title, item.type === 'book');
    add(/[.!?]$/.test(title) ? '' : '.');
    if (item.type === 'book') {
      if (item.publisher) add(` ${item.publisher}.`);
    } else if (item.containerTitle || item.volume || item.issue || item.pages) {
      add(' ');
      add(item.containerTitle || '', true);
      if (item.volume) { add(item.containerTitle ? ', ' : ''); add(String(item.volume), true); }
      if (item.issue) add(`(${item.issue})`);
      if (item.pages) add(`${item.containerTitle || item.volume || item.issue ? ', ' : ''}${item.pages}`);
      add('.');
    }
    if (item.doi) add(` https://doi.org/${item.doi}`);
    return parts;
  }
  function bibliographyAuthors(names, item) {
    if (names.length > 20) return names.slice(0, 19).join(', ') + ', . . . ' + names.at(-1);
    return names.length > 1 ? names.slice(0, -1).join(', ') + ', & ' + names.at(-1) : names[0] || 'Yazar bilgisi bulunamadı';
  }
  function formatApa(item) { return apaParts(item).map(part => part.text).join(''); }
  function crossrefTitleCase(title) {
    const small = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
    return String(title || '').replace(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu, (word, offset, full) => {
      const lower = word.toLocaleLowerCase('en-US').replace(/['’]s$/u, '’s');
      if (/^ai(?:['’]s)?$/iu.test(word)) return word.replace(/ai/iu, 'AI').replace(/['’]s$/u, '’s');
      if (offset > 0 && small.has(lower) && !/[.:!?]\s*$/u.test(full.slice(0, offset))) return lower;
      return lower.charAt(0).toLocaleUpperCase('en-US') + lower.slice(1);
    });
  }
  function crossrefApa(item) {
    const names = (item.author || []).map(author => {
      if (author.literal) return author.literal;
      const initials = (author.given || '').split(/[\s-]+/).filter(Boolean).map(part => `${part[0]}.`).join(' ');
      return `${author.family || ''}${initials ? `, ${initials}` : ''}`;
    }).filter(Boolean);
    const authors = bibliographyAuthors(names, item);
    const title = crossrefTitleCase(item.title);
    const publisher = item.publisher || item.containerTitle || '';
    const editor = item.editor?.length ? item.editor.map(author => author.family || author.name || '').filter(Boolean).join(', ') : '';
    const editorPart = editor ? ` (${editor}, Ed.).` : item.type === 'report' ? ' (, Ed.).' : '.';
    return `${authors} (${item.year || 't.y.'}). ${title}${editorPart}${publisher ? ` ${publisher}.` : ''}${item.doi ? ` https://doi.org/${item.doi}` : ''}`;
  }
  function formatApaHtml(item) {
    if (item.type === 'web' && item.webCitation) return item.webCitation.html;
    const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
    return apaParts(item).map(part => part.italic ? `<em>${escape(part.text)}</em>` : escape(part.text)).join('');
  }

  function errorDescription(error) {
    if (error.status === 429) return `${error.provider}: sorgu kotası/hız sınırı (HTTP 429)`;
    if (error.status === 401 || error.status === 403) return `${error.provider}: erişim reddedildi (HTTP ${error.status})`;
    return error.message;
  }

  async function verifyReference(reference, settings = {}) {
    const webInput = web?.parse(reference);
    if (webInput && !getDoi(reference)) {
      if (!options.proxyUrl) return web.compare(reference, { state: 'blocked', reason: 'Web doğrulaması için yerel sunucuyu node server.cjs ile başlatın.' });
      checkAbort(options.signal);
      const controller = new AbortController();
      const abort = () => controller.abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 65000);
      try {
        options.onRequest?.({ provider: 'Web sayfası', at: Date.now() });
        const endpoint = options.proxyUrl.replace(/\/proxy(?:\?.*)?$/, '/web-reference');
        const response = await fetch(`${endpoint}?url=${encodeURIComponent(webInput.url)}`, { signal: controller.signal });
        const page = await response.json();
        checkAbort(options.signal);
        return web.compare(reference, response.ok ? { ...page, formattedTitle: sentenceCase(page.title) } : { state: 'blocked', reason: page.error || 'Web sayfasına erişilemedi.' });
      } catch (error) {
        checkAbort(options.signal);
        return web.compare(reference, { state: 'blocked', reason: error.name === 'AbortError' ? 'Web isteği zaman aşımına uğradı; özgün kayıt korundu.' : 'Web sayfası alınamadı; özgün kayıt korundu.' });
      } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
    }
    const parsed = parseReference(reference);
    const candidates = [];
    const errors = [];
    const sourcesChecked = [];
    const debugRequests = [];
    let crossrefSucceeded = false;
    let primaryUnavailable = false;
    const attempt = async (id, action) => {
      if (!sourcesChecked.includes(id)) sourcesChecked.push(id);
      try { candidates.push(...await action()); if (id === 'Crossref') crossrefSucceeded = true; } catch (error) {
        if (error.name === 'AbortError') throw error;
        error.provider ||= id;
        errors.push(error);
        debugRequests.push({ provider: id, status: error.status || 0, url: error.url || '', requestUrl: error.requestUrl || '', detail: error.message || '' });
        if (id === 'Crossref' && (!error.status || error.status >= 500)) primaryUnavailable = true;
      }
    };
    const ranked = () => candidates.map(item => rankCandidate(parsed, item)).sort((a, b) => b.score - a.score);
    const isStrong = item => !!item && !item.requiresReview && item.authorMatch && (!parsed.year || item.yearMatch) && (!parsed.doi || item.doiMatch) &&
      (item.titleMatch >= .8 || (item.doiMatch && item.titleMatch >= .7));
    // A Crossref identity hit should end the additional-source phase even when
    // an author is formatted differently (initials, compound surnames, etc.).
    // Verification still requires the stricter author check in isStrong().
    const crossrefFound = () => ranked().some(item => item.provider === 'Crossref' && item.titleMatch >= .8 &&
      (item.doiMatch || item.authorMatch || (parsed.year ? item.yearMatch : false)));

    if (parsed.arxiv) {
      // arXiv records are identified and verified by the arXiv API directly.
      // Do not send these preprints through DOI/Crossref fallbacks: arXiv IDs
      // are not DOI identities and fallback failures used to create false
      // "additional source" warnings.
      if (additionalProviders?.search) {
        await attempt('arXiv', () => additionalProviders.search('arXiv', parsed, requestJson));
      }
    } else {
      if (parsed.doi) {
        await attempt('Crossref', () => crossrefSearch(parsed, true));
        if (!primaryUnavailable && !isStrong(ranked()[0]) && !crossrefFound()) await attempt('DataCite', () => dataciteLookup(parsed));
      }
      // Missing/wrong DOI must not prevent a title search.
      if (!primaryUnavailable && !isStrong(ranked()[0]) && !crossrefFound()) await attempt('Crossref', () => crossrefSearch(parsed));
      if (!primaryUnavailable && !settings.primaryOnly && !isStrong(ranked()[0]) && !crossrefFound()) await attempt('OpenAlex', () => openAlexSearch(parsed));
      if (!primaryUnavailable && !settings.primaryOnly && additionalProviders && !isStrong(ranked()[0]) && !crossrefFound()) {
        for (const id of additionalProviders.route(parsed, options)) {
          if (id === 'Semantic Scholar' && !crossrefSucceeded) continue;
          await attempt(id, () => additionalProviders.search(id, parsed, requestJson));
          if (isStrong(ranked()[0])) break;
        }
      }
    }
    const best = ranked()[0];
    const warnings = errors.map(errorDescription);
    const pendingProviders = errors.filter(error => error.retryAt).map(error => ({ provider: error.provider, retryAt: error.retryAt }));
    const routing = { fallbackNeeded: parsed.arxiv ? !isStrong(best) : !crossrefFound() && !isStrong(best), pendingProviders, pendingRetryAt: pendingProviders.length ? Math.min(...pendingProviders.map(item => item.retryAt)) : null };
    if (!best || best.titleMatch < .45) {
      const technical = warnings.length > 0;
      return { ...routing, raw: reference, status: technical ? 'error' : 'failed', statusText: technical ? 'Kontrol tamamlanamadı' : 'Bulunamadı',
        score: best?.score || 0, corrected: reference, provider: technical ? 'Servis hatası' : sourcesChecked.join(' / '), changes: [], warnings, sourcesChecked,
        reason: technical ? `${warnings.join('; ')}.${primaryUnavailable ? ' Crossref geçici olarak erişilemiyor; ek kaynak sorguları bu nedenle başlatılmadı.' : ''} Kaynak özgün haliyle korundu; tekrar deneyebilirsiniz.` : (parsed.title ? 'Yeterince güçlü bir akademik eşleşme bulunamadı. Kaynak özgün haliyle korundu.' : 'Başlık ayrıştırılamadı ve yeterli eşleşme bulunamadı. Kaynağın yazımını kontrol edin.'), debugRequests };
    }
    const status = isStrong(best) ? 'verified' : 'review';
    const changes = [];
    if (parsed.year && best.year && parsed.year !== best.year) changes.push(`Yıl ${parsed.year} → ${best.year}`);
    if (best.doi && parsed.doi !== best.doi.toLowerCase()) changes.push(parsed.doi ? 'DOI farklı' : 'DOI bulundu');
    if (best.titleMatch < .99) changes.push('Başlık farklı');
    if (status === 'verified') changes.push('Künye biçimlendirildi');
    const reasons = [];
    if (parsed.year && !best.yearMatch) reasons.push(`Yıl uyuşmuyor: giriş ${parsed.year}, bulunan ${best.year || 'bilinmiyor'}`);
    if (!best.authorMatch) reasons.push('İlk yazar eşleşmesi kesinleşmedi');
    if (parsed.doi && !best.doiMatch) reasons.push('Verilen DOI ile bulunan kaydın DOI’si farklı');
    if (best.titleMatch < .8) reasons.push('Başlık eşleşmesi yeterince güçlü değil');
    if (best.requiresReview) reasons.push(best.type === 'book' ? 'Kitap baskısı, yayın yılı ve yayınevi bilgilerini kontrol edin' : 'Arşiv kaydının künye bilgilerini kontrol edin');
    return { ...routing, raw: reference, status, statusText: status === 'verified' ? 'Doğrulandı' : 'İnceleme gerekli',
      score: best.score, corrected: status === 'verified' ? (best.provider === 'Crossref' ? crossrefApa(best) : formatApa(best)) : reference,
      correctedHtml: status === 'verified' && best.provider !== 'Crossref' ? formatApaHtml(best) : null,
      suggested: best.provider === 'Crossref' ? crossrefApa(best) : formatApa(best), suggestedHtml: best.provider === 'Crossref' ? null : formatApaHtml(best), crossrefApa: best.provider === 'Crossref' ? crossrefApa(best) : null, matched: best, provider: best.provider, url: best.url, changes, warnings, sourcesChecked,
      reason: status === 'verified' ? 'Başlık, yazar ve mevcut kimlik bilgileri tutarlı bir kayıtla eşleşti.' : `${reasons.join('; ')}. Öneri inceleme için gösterildi; özgün kaynak değiştirilmedi.` };
  }

  const waitForRetry = retryAt => waitForQuota('Ek kaynaklar', Math.max(0, retryAt - Date.now()), 1, options.signal, options.onRetry);
  function getPendingRetryAt(result) {
    if (!result.pendingProviders?.length) return result.pendingRetryAt;
    return Math.min(...result.pendingProviders.map(item => quotaUntil.get(item.provider) || item.retryAt));
  }
  const engine = { configure, normalizeTitle, splitReferences, getDoi, parseReference, titleScore, rankCandidate, sentenceCase, formatApa, formatApaHtml, verifyReference, requestJson, waitForRetry, getPendingRetryAt };
  if (typeof module !== 'undefined' && module.exports) module.exports = engine;
  else root.ReferenceEngine = engine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
