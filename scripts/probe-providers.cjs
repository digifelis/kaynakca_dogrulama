const endpoints = [
  ['PubMed', 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=aspirin&retmode=json&retmax=2'],
  ['Europe PMC', 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=TITLE:aspirin&format=json&resultType=core&pageSize=2'],
  ['ERIC', 'https://api.ies.ed.gov/eric/?search=title:education&format=json&rows=2'],
  ['Semantic Scholar', 'https://api.semanticscholar.org/graph/v1/paper/search?query=attention%20is%20all%20you%20need&limit=2&fields=title,authors,year,externalIds,venue,url'],
  ['TR Dizin', 'https://search.trdizin.gov.tr/api/defaultSearch/publication/?q=turizm&order=relevance-DESC&page=1&limit=10'],
  ['İSAM', 'https://makale.isam.org.tr/server/api/discover/search/objects?query=tasavvuf&size=2'],
  ['Google Books', 'https://www.googleapis.com/books/v1/volumes?q=intitle:start%20with%20why&maxResults=2'],
  ['OpenLibrary', 'https://openlibrary.org/search.json?title=Start%20with%20why&limit=2'],
];
(async () => {
  const results = await Promise.allSettled(endpoints.map(async ([provider, url]) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(18000), headers: { Accept: 'application/json' } });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { return { provider, status: response.status, contentType: response.headers.get('content-type'), body: text.slice(0, 100) }; }
    const sample = data.resultList?.result?.[0] || data.result?.hits?.hit?.[0]?.info || data.response?.docs?.[0] || data.items?.[0]?.volumeInfo || data.docs?.[0] || data.data?.[0] || data.hits?.hits?.[0]?._source || data.results?.[0] || data._embedded?.searchResult?._embedded?.objects?.[0]?._embedded?.indexableObject;
    return { provider, status: response.status, keys: Object.keys(data), sample: sample ? { keys: Object.keys(sample), title: sample.title || sample.name, author: sample.author || sample.authors, year: sample.year || sample.yearPublished || sample.first_publish_year, journal: sample.journal, publication: sample.publication } : data.error || data.message || data.esearchresult?.idlist };
  }));
  results.forEach((result, index) => console.log(JSON.stringify(result.status === 'fulfilled' ? result.value : { provider: endpoints[index][0], error: result.reason.message }).slice(0, 2800)));
})();
