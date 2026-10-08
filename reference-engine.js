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
  const styles = root.CitationStyles || (typeof require === 'function' ? require('./citation-styles.js') : null);
  const registry = root.StyleRegistry || (typeof require === 'function' ? require('./style-registry.js') : null);
  const csl = root.CslEngine || (typeof require === 'function' ? require('./csl-engine.js') : null);
  const isNode = typeof module !== 'undefined' && !!module.exports;
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

  const BARE_ID = /^(?:(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?10\.\d{4,9}\/\S+|(?:https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\/|arxiv\s*:\s*)\S+)$/i;

  function splitReferences(text) {
    const lines = String(text).replace(/\r/g, '').trim().split('\n');
    const records = [];
    let current = [];
    let currentIsId = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (current.length) records.push(current.join(' '));
        current = [];
        currentIsId = false;
        continue;
      }
      // A line holding only a DOI/arXiv identifier is its own record, unless it
      // wraps the end of a reference that is still being collected.
      if (BARE_ID.test(trimmed) && (!current.length || currentIsId)) {
        if (current.length) records.push(current.join(' '));
        current = [trimmed];
        currentIsId = true;
        continue;
      }
      if (currentIsId && current.length) { records.push(current.join(' ')); current = []; currentIsId = false; }
      const numbered = /^(?:\[\d+\]|\(\d+\)|\d+[.)])\s+/.test(trimmed);
      const authorStart = /^(?:(?:van|von|de|der|den)\s+)*[\p{Lu}][\p{L}'’–-]+(?:\s+[\p{L}'’–-]+){0,2},\s*(?:[\p{Lu}]\.|[\p{Lu}][\p{Ll}])/u.test(trimmed);
      const vancouverStart = /^[\p{Lu}][\p{L}'’–-]+\s+[A-Z]{1,4}(?:[,\s]|\.)/u.test(trimmed);
      const datedAuthorStart = /^[^\n]{1,220}?\(\s*(?:(?:19|20)\d{2}[a-z]?(?:\s*[,)]|$)|t\.\s*y\.|n\.\s*d\.)/iu.test(trimmed);
      if (current.length && (numbered || authorStart || vancouverStart || datedAuthorStart)) {
        records.push(current.join(' '));
        current = [];
      }
      current.push(trimmed.replace(/^(?:\[\d+\]|\(\d+\)|\d+[.)])\s+/, ''));
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
    // A publication year stands alone — "(2025)", "2025.", "2025;" — whereas a
    // year inside a proceedings name ("Proceedings of the 2025 Conference…")
    // would make the container look like the title. Prefer the delimited one.
    const yearMatch = withoutDoi.match(/\b(?:18|19|20)\d{2}(?=[a-z]?\s*(?:[).,;:]|$))/i)
      || withoutDoi.match(/\b(?:18|19|20)\d{2}(?=[a-z]?\b)/i);
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
      // IEEE: initials-first authors, then the title in quotation marks: A. Zhang and B. Lee, “Title,” Journal, vol. 1, 2020.
      const quoted = withoutDoi.match(/[“"]([^”"]{8,}?)[,.]?[”"]/);
      if (quoted && quoted.index > 0) {
        title = quoted[1].replace(/[,.]+$/, '').trim();
        authorText = withoutDoi.slice(0, quoted.index).replace(/[,\s]+$/, '');
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
    // IEEE writes initials first ("K. Zhang, M. Lee"): the family name follows them.
    const initialsFirst = authorPrefix.match(/^(?:\p{Lu}\.[\s-]*)+((?:(?:van|von|de|der|den)\s+)*[\p{Lu}][\p{L}'’–-]+)/u)?.[1];
    const firstAuthor = initialsFirst ? initialsFirst : authorPrefix.includes(',') && !/^[\p{L}'’–-]+\s+[A-Z]{1,4},/u.test(authorPrefix)
      ? authorPrefix.split(',')[0].trim()
      : authorPrefix.match(/^([\p{L}'’–-]+)\s+[A-Z]{1,4}(?:\s|[,\.])/u)?.[1] || authorPrefix.match(/^([\p{L}'’–-]+)/u)?.[1] || '';
    // Only an identifier was given (DOI, doi.org link, arXiv number or link):
    // the record itself is the source of title, authors and year.
    const leftover = reference.replace(/\[[^\]]*\]\(\S+?\)|https?:\/\/\S+|\b10\.\d{4,9}\/\S+|\b(?:doi|arxiv)\b\s*:?|arxiv:\s*\S+/gi, ' ');
    const idOnly = !!(doi || arxiv) && !/\p{L}{2,}/u.test(leftover);
    return { reference, year, doi, title, firstAuthor, arxiv: arxiv || '', idOnly };
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
    if (parsed.idOnly) {
      // The identifier is the evidence; there is no cited text to compare.
      const doiMatch = parsed.doi === (item.doi || '').toLowerCase();
      return { ...item, titleMatch: doiMatch ? 1 : 0, authorMatch: doiMatch, yearMatch: doiMatch, doiMatch, score: doiMatch ? 100 : 0 };
    }
    const doiMatch = !!parsed.doi && parsed.doi === (item.doi || '').toLowerCase();
    let titleMatch = titleScore(parsed.title, item.title);
    if (doiMatch) {
      // The DOI already identifies the record, so a title parsed imperfectly
      // (container mistaken for title, truncated or abbreviated title) must not
      // reject it: accept the registered title appearing anywhere in the
      // reference, or the cited title being the beginning of the registered one.
      const registered = normalizeTitle(item.title);
      const cited = normalizeTitle(parsed.title);
      const whole = normalizeTitle(parsed.reference);
      if ((registered.split(' ').length >= 3 && ` ${whole} `.includes(` ${registered} `)) || (cited && registered.startsWith(`${cited} `))) titleMatch = 1;
    }
    const authorMatch = !!parsed.firstAuthor && item.author.some(author => {
      const name = normalizeTitle(author.family || author.literal);
      const wanted = normalizeTitle(parsed.firstAuthor);
      return name === wanted || (` ${name} `).includes(` ${wanted} `);
    });
    const yearMatch = !!parsed.year && parsed.year === item.year;
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
        const interval = provider === 'Crossref' ? (url.startsWith('https://api.crossref.org/works/') ? 200 : 1000) : ({ PubMed: 400, OpenLibrary: 1100, 'Semantic Scholar': 1000 })[provider] || 400;
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

  // The year of a Crossref record: the issue's own date first (an article put
  // online in December 2022 but belonging to the January 2023 issue is a 2023
  // article), then the work's published-online, published-print, issued and
  // created dates. No date at all stays null and is written as t.y.
  function crossrefDate(raw) {
    const dates = [raw['journal-issue']?.['published-online'], raw['journal-issue']?.['published-print'],
      raw['published-online'], raw['published-print'], raw.issued, raw.created, raw.published];
    for (const date of dates) { const [year, month] = date?.['date-parts']?.[0] || []; if (year) return { year, month: month || null }; }
    return { year: null, month: null };
  }
  const crossrefYear = raw => crossrefDate(raw).year;

  function fromCrossref(raw) {
    return { title: raw.title?.[0] || '', author: (raw.author || []).map(person => person.family || person.literal || !person.name ? person : { literal: person.name }),
      language: raw.language || '',
      year: crossrefYear(raw), month: crossrefDate(raw).month,
      doi: raw.DOI || '', containerTitle: raw['container-title']?.[0] || '', shortContainer: raw['short-container-title']?.[0] || '',
      place: raw['publisher-location'] || '', edition: raw['edition-number'] || '',
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

  async function openAlexSearch(parsed, directOnly = false) {
    const base = 'https://api.openalex.org/works';
    if (parsed.doi) {
      const direct = await requestJson('OpenAlex', `${base}?filter=doi:${encodeURIComponent(`https://doi.org/${parsed.doi}`)}&per-page=1`);
      if (direct?.results?.length) return direct.results.map(fromOpenAlex);
    }
    if (directOnly) return [];
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
      const acronym = /^(?:APA|BERT|COVID(?:-19)?|GIS|LISA|MDIVis|TR\d+|IEEE|ERIC|DOI)$/i.test(word) || (!allCaps && /^[\p{Lu}\d-]{2,8}$/u.test(word));
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
    const title = item.keepTitle ? String(item.title || '').trim().replace(/[.]+$/, '') : sentenceCase(item.title, item.language, item.properNouns);
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
    // Articles and conference papers are cited as Crossref's own APA output does:
    // title as registered, then "Container, volume(issue), pages." — the
    // publisher belongs only to books/reports without a container.
    if (item.containerTitle && ['journal-article', 'proceedings-article'].includes(item.type)) {
      const pages = decodeText(item.pages).replace(/(\d)\s*[-‐‑‒–]+\s*(\d)/g, '$1–$2');
      const title = decodeText(item.title).replace(/[.]+$/, '');
      const locator = [item.volume ? `${item.volume}${item.issue ? `(${item.issue})` : ''}` : (item.issue ? `(${item.issue})` : ''), pages].filter(Boolean).join(', ');
      return `${authors} (${item.year || 't.y.'}). ${title}${/[?!]$/.test(title) ? '' : '.'} ${decodeText(item.containerTitle)}${locator ? `, ${locator}` : ''}.${item.doi ? ` https://doi.org/${item.doi}` : ''}`;
    }
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

  const decodeText = value => {
    let text = String(value || '').replace(/<[^>]+>/g, '');
    for (let pass = 0; pass < 3 && /&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/i.test(text); pass++) {
      text = text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (_, code) => {
        const key = code.toLowerCase();
        if (key[0] !== '#') return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[key];
        return String.fromCodePoint(key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10));
      });
    }
    return text.replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
  };
  // A record found by identifier is formatted as registered: title kept as
  // published, markup removed, page ranges with an en dash.
  function registryItem(item) {
    const out = { ...item, keepTitle: true, title: decodeText(item.title), containerTitle: decodeText(item.containerTitle),
      pages: decodeText(item.pages).replace(/(\d)\s*[-‐‑‒–]+\s*(\d)/g, '$1–$2') };
    if (item.arxiv) Object.assign(out, { type: '', containerTitle: 'ArXiv', volume: '', issue: '', pages: `abs/${item.arxiv}`, doi: '' });
    return out;
  }

  // One record in the Vancouver or IEEE style (plain text, italic HTML, notes); APA is formatApa / crossrefApa.
  function formatStyle(item, style, extra = {}) { return registry?.isCsl(style) ? csl.formatOne(style, item, { sentenceCase }, extra) : styles.format(item, style, { sentenceCase }, extra); }
  // A CSL style is fetched once in the browser (Node reads it from disk); until then restyle leaves the result in APA.
  const styleReady = style => !registry?.isCsl(style) || isNode || csl.isLoaded(style);
  const prepareStyle = async style => { if (registry?.isCsl(style) && !isNode) await csl.loadAssets(style); };
  // The verification result with its suggestion written in `style`. The structured record stays in result.matched, so the style can be
  // changed at any time without verifying again; a record that was not found (or an APA request) is returned unchanged.
  function restyle(result, style, extra = {}) {
    if (!style || style === 'apa' || !result?.matched || !['verified', 'review'].includes(result.status) || !styleReady(style)) return result;
    const formatted = formatStyle(result.registry ? registryItem(result.matched) : result.matched, style, extra);
    const verified = result.status === 'verified';
    return { ...result, style, styleNotes: formatted.notes, styleNote: formatted.note || null, styleLabel: formatted.label || '', corrected: verified ? formatted.text : result.raw, correctedHtml: verified ? formatted.html : null,
      suggested: formatted.text, suggestedHtml: formatted.html, crossrefApa: null };
  }

  function errorDescription(error) {
    if (error.status === 429) return `${error.provider}: sorgu kotası/hız sınırı (HTTP 429)`;
    if (error.status === 401 || error.status === 403) return `${error.provider}: erişim reddedildi (HTTP ${error.status})`;
    return error.message;
  }

  async function verifyOne(reference, settings = {}) {
    const parsed = parseReference(reference);
    const webInput = parsed.arxiv ? null : web?.parse(reference);
    if (webInput && !getDoi(reference)) {
      // The caller's plan does not include web source verification: the record is reported as not checked.
      if (settings.web === false) return web.compare(reference, { state: 'blocked', reason: 'Web kaynağı doğrulaması paketinizde bulunmuyor.' });
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
        if (!isStrong(ranked()[0]) && !crossrefFound()) await attempt('DataCite', () => dataciteLookup(parsed));
      }
      if (parsed.idOnly) {
        // No cited text to search with: only direct identifier lookups apply.
        if (!isStrong(ranked()[0])) await attempt('OpenAlex', () => openAlexSearch(parsed, true));
      } else {
      // Missing/wrong DOI must not prevent a title search.
      if (!primaryUnavailable && !isStrong(ranked()[0]) && !crossrefFound()) await attempt('Crossref', () => crossrefSearch(parsed));
      // Crossref gave no usable answer (not found, 403, 429): Semantic Scholar is the first fallback.
      const extraIds = !settings.primaryOnly && additionalProviders ? additionalProviders.route(parsed, options) : [];
      if (extraIds.includes('Semantic Scholar') && !isStrong(ranked()[0]) && !crossrefFound()) await attempt('Semantic Scholar', () => additionalProviders.search('Semantic Scholar', parsed, requestJson));
      if (!settings.primaryOnly && !isStrong(ranked()[0]) && !crossrefFound()) await attempt('OpenAlex', () => openAlexSearch(parsed));
      if (!settings.primaryOnly && additionalProviders && !isStrong(ranked()[0]) && !crossrefFound()) {
        for (const id of extraIds) {
          if (id === 'Semantic Scholar') continue;
          await attempt(id, () => additionalProviders.search(id, parsed, requestJson));
          if (isStrong(ranked()[0])) break;
        }
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
        reason: technical ? `${warnings.join('; ')}.${primaryUnavailable ? ' Crossref geçici olarak erişilemiyor; diğer kaynaklar denendi.' : ''} Kaynak özgün haliyle korundu; tekrar deneyebilirsiniz.` : (parsed.idOnly ? 'Bu tanımlayıcıyla kayıt bulunamadı. DOI veya arXiv numarasını kontrol edin.' : parsed.title ? 'Yeterince güçlü bir akademik eşleşme bulunamadı. Kaynak özgün haliyle korundu.' : 'Başlık ayrıştırılamadı ve yeterli eşleşme bulunamadı. Kaynağın yazımını kontrol edin.'), debugRequests };
    }
    const status = isStrong(best) ? 'verified' : 'review';
    if (parsed.idOnly) {
      const formatted = registryItem(best);
      return { ...routing, raw: reference, status, statusText: 'Doğrulandı', score: best.score,
        registry: true, corrected: formatApa(formatted), correctedHtml: formatApaHtml(formatted), suggested: formatApa(formatted), suggestedHtml: formatApaHtml(formatted), crossrefApa: null,
        matched: best, provider: best.provider, url: best.url, changes: ['Künye kayıt verisinden oluşturuldu'], warnings, sourcesChecked,
        reason: `${best.provider} kaydı ${parsed.arxiv ? 'arXiv numarası' : 'DOI'} ile bulundu; künye kayıt verisinden oluşturuldu.` };
    }
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

  // settings.style (any id of style-registry.js) chooses how the corrected record is written.
  async function verifyReference(reference, settings = {}) { return restyle(await verifyOne(reference, settings), settings.style); }

  const waitForRetry = retryAt => waitForQuota('Ek kaynaklar', Math.max(0, retryAt - Date.now()), 1, options.signal, options.onRetry);
  function getPendingRetryAt(result) {
    if (!result.pendingProviders?.length) return result.pendingRetryAt;
    return Math.min(...result.pendingProviders.map(item => quotaUntil.get(item.provider) || item.retryAt));
  }
  const engine = { configure, normalizeTitle, splitReferences, getDoi, parseReference, titleScore, rankCandidate, sentenceCase, formatApa, formatApaHtml, formatStyle, restyle, prepareStyle, styleReady, verifyReference, requestJson, waitForRetry, getPendingRetryAt };
  if (typeof module !== 'undefined' && module.exports) module.exports = engine;
  else root.ReferenceEngine = engine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
