(function (root) {
  const enc = encodeURIComponent;
  const list = value => Array.isArray(value) ? value : value ? [value] : [];
  const literalAuthors = values => list(values).map(value => ({ literal: typeof value === 'string' ? value : value.name || '' })).filter(value => value.literal);
  const namedAuthors = values => list(values).map(value => {
    const name = typeof value === 'string' ? value : value.name || '';
    if (!name.includes(',')) return { literal: name };
    const [family, ...given] = name.split(',');
    return { family: family.trim(), given: given.join(',').trim() };
  });
  const citedAuthors = reference => {
    const prefix = String(reference || '').split(/\(\s*(?:18|19|20)\d{2}[a-z]?\s*\)/i)[0].replace(/,?\s*&\s*/g, ', ');
    const parts = prefix.split(/\s*,\s*/).map(value => value.trim()).filter(Boolean), authors = [];
    for (let index = 0; index + 1 < parts.length; index += 2) {
      const family = parts[index], given = parts[index + 1];
      if (!family || !/^(?:[\p{L}]\.(?:[-\s]*|$)){1,8}$/u.test(given)) return [];
      authors.push({ family, given: given.replace(/\./g, ' ').replace(/\s+/g, ' ').trim() });
    }
    return authors;
  };
  const arxivAuthors = (values, reference) => {
    const supplied = citedAuthors(reference), normalized = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return list(values).map((value, index) => {
      const name = String(typeof value === 'string' ? value : value?.name || value?.literal || '').replace(/\s+/g, ' ').trim();
      if (!name) return null;
      const cited = supplied[index], whole = normalized(name), family = normalized(cited?.family);
      if (cited && family && (whole === family || whole.endsWith(' ' + family))) return cited;
      if (name.includes(',')) { const [last, ...given] = name.split(','); return { family: last.trim(), given: given.join(',').trim() }; }
      const parts = name.split(/\s+/);return parts.length > 1 ? { family: parts.pop(), given: parts.join(' ') } : { literal: name };
    }).filter(Boolean);
  };
  const baseItem = (provider, title, author, year, url, fields = {}) => ({
    provider, title: String(title || '').replace(/<[^>]+>/g, '').trim(), author,
    year: Number(String(year || '').match(/\b(?:19|20)\d{2}\b/)?.[0]) || null,
    url, doi: '', containerTitle: '', volume: '', issue: '', pages: '', ...fields,
  });

  const descriptors = [
    { id: 'Web', name: 'Web kaynakları', note: 'URL üzerinden haber/blog künyesi; kota durumunda kayıt ertelenir', mode: 'auto' },
    { id: 'Crossref', name: 'Crossref', note: 'Genel yayınlar ve DOI', mode: 'auto' },
    { id: 'arXiv', name: 'arXiv', note: 'arXiv önbaskıları; arXiv API metadata doğrulaması', mode: 'auto' },
    { id: 'DataCite', name: 'DataCite', note: 'Önbaskı ve diğer DOI kayıtları', mode: 'auto' },
    { id: 'OpenAlex', name: 'OpenAlex', note: 'Genel akademik dizin', mode: 'auto' },
    { id: 'PubMed', name: 'PubMed', note: 'Biyomedikal yayınlar', mode: 'auto' },
    { id: 'Europe PMC', name: 'Europe PMC', note: 'Biyomedikal yayınlar', mode: 'auto' },
    { id: 'TR Dizin', name: 'TR Dizin', note: 'Türkçe akademik yayınlar', mode: 'auto' },
    { id: 'İSAM', name: 'İSAM', note: 'Tarih, kültür, ilahiyat makaleleri', mode: 'auto' },
    { id: 'ERIC', name: 'ERIC', note: 'Eğitim bilimleri', mode: 'auto' },
    { id: 'Semantic Scholar', name: 'Semantic Scholar', note: 'Crossref’te eşleşmeyenler; en çok 1 istek/sn; isteğe bağlı API anahtarı', mode: 'auto' },
    { id: 'OpenLibrary', name: 'OpenLibrary', note: 'Kitaplar; baskı bilgisi kullanıcı tarafından incelenir', mode: 'auto' },
    { id: 'Google Books', name: 'Google Books', note: 'Kitaplar; sunucuda API anahtarı gerekli', mode: 'key' },
    { id: 'ISSN', name: 'ISSN', note: 'Dergi kimliği; tek başına makale kanıtı değildir', mode: 'manual', url: 'https://portal.issn.org/' },
    { id: 'SOBIAD', name: 'SOBIAD', note: 'Manuel kontrol; otomatik erişim bağlantısı doğrulanmadı', mode: 'manual', url: 'https://atif.sobiad.com/' },
    { id: 'TO-KAT', name: 'TO-KAT', note: 'Manuel katalog kontrolü; otomatik erişim bağlantısı doğrulanmadı', mode: 'manual', url: 'https://www.toplukatalog.gov.tr/' },
  ];

  function route(parsed, options = {}) {
    const text = parsed.reference.toLowerCase();
    if (parsed.arxiv || /(?:arxiv\.org|arxiv\s*:\s*(?:[a-z]+[-\w]*\/\d{7}|\d{4}\.\d{4,5})|10\.48550\/arxiv\.)/i.test(text)) return ['arXiv'];
    const ids = [];
    if (/[çğıöşü]|\b(turkiye|turizm|tarih|ilahiyat)\b/i.test(text)) ids.push('TR Dizin', 'İSAM');
    if (/pmid|pubmed|medicine|medical|clinical|health|cancer|patient|aspirin|diabetes|hast[aı]|sağlık|tıp/i.test(text)) ids.push('Europe PMC', 'PubMed');
    if (/education|teaching|teacher|student|school|eğitim|öğret|öğrenci/i.test(text)) ids.push('ERIC');
    ids.unshift('Semantic Scholar');
    if (!parsed.doi) {
      ids.push('OpenLibrary');
      if (options.googleBooksConfigured) ids.push('Google Books');
    }
    return [...new Set(ids)];
  }

  async function search(id, parsed, request) {
    const title = parsed.title || parsed.reference;
    const quoted = title.replace(/["\\]/g, ' ');
    if (id === 'arXiv') {
      const endpoint = parsed.arxiv
        ? `https://export.arxiv.org/api/query?id_list=${enc(parsed.arxiv)}&max_results=1`
        : `https://export.arxiv.org/api/query?search_query=${enc(`ti:"${quoted}"`)}&start=0&max_results=5`;
      const data = await request(id, endpoint);
      return (data?.entries || []).map(raw => {
        const arxiv = String(raw.arxiv || parsed.arxiv || '').replace(/v\d+$/i, '');
        return baseItem(id, raw.title, arxivAuthors(raw.authors, parsed.reference), raw.published,
          raw.id || (arxiv ? `https://arxiv.org/abs/${arxiv}` : ''), { arxiv, doi: arxiv ? `10.48550/arxiv.${arxiv}` : '' });
      });
    }
    if (id === 'Europe PMC') {
      const query = parsed.doi ? `DOI:"${parsed.doi}" OR TITLE:"${quoted}"` : `TITLE:"${quoted}"`;
      const data = await request(id, `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${enc(query)}&format=json&resultType=core&pageSize=5`);
      return (data?.resultList?.result || []).map(raw => baseItem(id, raw.title,
        list(raw.authorList?.author).map(author => ({ family: author.lastName || '', given: author.firstName || '', literal: author.lastName ? undefined : author.fullName })),
        raw.pubYear, raw.doi ? `https://doi.org/${raw.doi}` : `https://europepmc.org/article/${raw.source}/${raw.id}`,
        { doi: raw.doi || '', containerTitle: raw.journalInfo?.journal?.title || '', volume: raw.journalInfo?.volume || '', issue: raw.journalInfo?.issue || '', pages: raw.pageInfo || '' }));
    }
    if (id === 'PubMed') {
      const titleTerms = `(${quoted.replace(/[^\p{L}\p{N}\s]/gu, ' ')})[Title]`;
      const term = parsed.doi ? `"${parsed.doi}"[AID] OR ${titleTerms}` : titleTerms;
      const data = await request(id, `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=5&term=${enc(term)}&tool=kaynakca_masasi`);
      if (data?.error || data?.esearchresult?.ERROR) throw Error(`${id}: arama servisi hatası`);
      const ids = data?.esearchresult?.idlist || [];
      if (!ids.length) return [];
      const summaries = await request(id, `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}&tool=kaynakca_masasi`);
      if (summaries?.error) throw Error(`${id}: özet servisi hatası`);
      return ids.map(uid => summaries?.result?.[uid]).filter(Boolean).map(raw => baseItem(id, raw.title, literalAuthors(raw.authors), raw.pubdate, `https://pubmed.ncbi.nlm.nih.gov/${raw.uid}/`,
        { doi: raw.articleids?.find(value => value.idtype === 'doi')?.value || '', containerTitle: raw.fulljournalname || raw.source || '', volume: raw.volume || '', issue: raw.issue || '', pages: raw.pages || '' }));
    }
    if (id === 'ERIC') {
      const data = await request(id, `https://api.ies.ed.gov/eric/?search=${enc(`title:"${quoted}"`)}&format=json&rows=5`);
      return (data?.response?.docs || []).map(raw => baseItem(id, raw.title, namedAuthors(raw.author), raw.publicationdateyear,
        `https://eric.ed.gov/?id=${enc(raw.id)}`, { containerTitle: raw.source || '', pages: raw.pages || '' }));
    }
    if (id === 'Semantic Scholar') {
      const fields = 'title,authors,year,externalIds,venue,url,journal';
      let values = [];
      if (parsed.doi) {
        const direct = await request(id, `https://api.semanticscholar.org/graph/v1/paper/DOI:${enc(parsed.doi)}?fields=${fields}`);
        if (direct?.title) values = [direct];
      }
      if (!values.length) {
        const data = await request(id, `https://api.semanticscholar.org/graph/v1/paper/search?query=${enc(title)}&limit=5&fields=${fields}`);
        values = data?.data || [];
      }
      return values.map(raw => baseItem(id, raw.title, literalAuthors(raw.authors), raw.year, raw.url,
        { doi: raw.externalIds?.DOI || '', containerTitle: raw.journal?.name || raw.venue || '', volume: raw.journal?.volume || '', pages: raw.journal?.pages || '' }));
    }
    if (id === 'TR Dizin') {
      const data = await request(id, `https://search.trdizin.gov.tr/api/defaultSearch/publication/?q=${enc(title)}&order=relevance-DESC&page=1&limit=10`);
      return (data?.hits?.hits || []).flatMap(hit => {
        const raw = hit._source;
        if (!raw) return [];
        const authors = literalAuthors(list(raw.authors).sort((a, b) => Number(a.order) - Number(b.order)).map(author => author.inPublicationName || author.name));
        return list(raw.abstracts).filter(value => value.title).map(value => baseItem(id, value.title, authors,
          raw.publicationYear, `https://search.trdizin.gov.tr/tr/yayin/detay/${enc(raw.id || hit._id)}`,
          { doi: raw.doi || '', containerTitle: raw.journal?.name || '', volume: raw.volume || (raw.issue?.volume && raw.issue.volume !== '0' ? raw.issue.volume : ''), issue: typeof raw.issue === 'object' ? raw.issue?.number || '' : raw.issue || '', pages: [raw.startPage, raw.endPage].filter(Boolean).join('–') }));
      });
    }
    if (id === 'İSAM') {
      const data = await request(id, `https://makale.isam.org.tr/server/api/discover/search/objects?query=${enc(`"${quoted}"`)}&size=5`);
      return (data?._embedded?.searchResult?._embedded?.objects || []).map(hit => hit._embedded?.indexableObject).filter(Boolean).map(raw => {
        const m = raw.metadata || {};
        const value = key => m[key]?.[0]?.value || '';
        return baseItem(id, value('dc.title') || raw.name, namedAuthors(list(m['dc.contributor.author']).map(author => author.value)), value('dc.date.issued'),
          value('dc.identifier.uri') || `https://makale.isam.org.tr/handle/${raw.handle}`,
          { doi: value('dc.identifier.doi').replace(/^https?:\/\/doi.org\//i, ''), containerTitle: value('dc.relation.journal') || value('dc.relation.book'), volume: value('dc.identifier.volume'), issue: value('dc.identifier.issue'), pages: value('dc.identifier.page'), requiresReview: true });
      });
    }
    if (id === 'OpenLibrary') {
      const data = await request(id, `https://openlibrary.org/search.json?title=${enc(title)}&author=${enc(parsed.firstAuthor)}&limit=5&fields=key,title,subtitle,author_name,first_publish_year,publisher,isbn`);
      return (data?.docs || []).map(raw => baseItem(id, `${raw.title || ''}${raw.subtitle ? `: ${raw.subtitle}` : ''}`, literalAuthors(raw.author_name), raw.first_publish_year,
        `https://openlibrary.org${raw.key}`, { type: 'book', publisher: raw.publisher?.[0] || '', requiresReview: true }));
    }
    if (id === 'Google Books') {
      const data = await request(id, `https://www.googleapis.com/books/v1/volumes?q=${enc(`intitle:${title} inauthor:${parsed.firstAuthor}`)}&maxResults=5`);
      return (data?.items || []).map(item => {
        const raw = item.volumeInfo || {};
        return baseItem(id, `${raw.title || ''}${raw.subtitle ? `: ${raw.subtitle}` : ''}`, literalAuthors(raw.authors), raw.publishedDate,
          raw.infoLink || `https://books.google.com/books?id=${enc(item.id)}`, { type: 'book', publisher: raw.publisher || '', requiresReview: true });
      });
    }
    return [];
  }
  const api = { descriptors, route, search };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReferenceProviders = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
