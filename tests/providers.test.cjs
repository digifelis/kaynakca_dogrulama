const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const providers = require('../providers.js');
const engine = require('../reference-engine.js');
const { allowedTarget, createServer } = require('../server.cjs');
const parsed = { title: 'A study of education', firstAuthor: 'Smith', year: 2020, doi: '', reference: 'Smith, A. (2020). A study of education.' };

test('all requested sources have an explicit automated, keyed or manual status', () => {
  for (const id of ['Crossref', 'arXiv', 'OpenAlex', 'PubMed', 'Europe PMC', 'ERIC', 'Semantic Scholar', 'ISSN', 'TR Dizin', 'İSAM', 'SOBIAD', 'TO-KAT', 'Google Books', 'OpenLibrary']) {
    assert.ok(providers.descriptors.find(provider => provider.id === id));
  }
  assert.equal(providers.descriptors.find(provider => provider.id === 'ISSN').mode, 'manual');
});

test('routing selects domain sources and requires configured Google Books key', () => {
  assert.ok(providers.route({ ...parsed, reference: 'Turizm araştırmaları Türkiye' }).includes('TR Dizin'));
  assert.ok(providers.route({ ...parsed, reference: 'aspirin clinical patient' }).includes('PubMed'));
  assert.ok(providers.route(parsed).includes('ERIC'));
  assert.ok(!providers.route({ ...parsed, reference: 'neural computer learning' }).includes('DBLP'));
  assert.equal(providers.route(parsed)[0], 'Semantic Scholar');
  assert.ok(!providers.route(parsed).includes('Google Books'));
  assert.ok(providers.route(parsed, { googleBooksConfigured: true }).includes('Google Books'));
  assert.deepEqual(providers.route({ ...parsed, arxiv: '2304.14163', reference: 'https://arxiv.org/abs/2304.14163' }), ['arXiv']);
});

test('arXiv adapter uses API metadata and preserves arXiv identity', async () => {
  const arxivParsed = { ...parsed, arxiv: '2304.14163', reference: 'https://arxiv.org/abs/2304.14163' };
  let requested = '';
  const [item] = await providers.search('arXiv', arxivParsed, async (_, url) => {
    requested = url;
    return { entries: [{ id: 'https://arxiv.org/abs/2304.14163v2', title: 'A study of education', published: '2023-04-28T00:00:00Z', authors: [{ literal: 'Smith, Alice' }], arxiv: '2304.14163' }] };
  });
  assert.match(requested, /export\.arxiv\.org\/api\/query/);
  assert.match(requested, /id_list=2304\.14163/);
  assert.equal(item.year, 2023);
  assert.equal(item.arxiv, '2304.14163');
  assert.equal(item.url, 'https://arxiv.org/abs/2304.14163v2');
});

test('arXiv DOI lookup structures complete author lists using the supplied APA surnames', async () => {
  const examples = [
    {
      reference: 'Kaplan, J., McCandlish, S., Henighan, T., Brown, T. B., Chess, B., Child, R., Gray, S., Radford, A., Wu, J., & Amodei, D. (2020). Scaling laws for neural language models. https://doi.org/10.48550/arXiv.2001.08361',
      id: '2001.08361', title: 'Scaling Laws for Neural Language Models', names: ['Jared Kaplan','Sam McCandlish','Tom Henighan','Tom B. Brown','Benjamin Chess','Rewon Child','Scott Gray','Alec Radford','Jeffrey Wu','Dario Amodei'], families: ['Kaplan','McCandlish','Henighan','Brown','Chess','Child','Gray','Radford','Wu','Amodei'],
    },
    {
      reference: 'Le, T., Thai, M. V. T., Nguyen Manh, D., Phan Nhat, H., & Bui, N. D. Q. (2025). SWE-EVO: Benchmarking coding agents in long-horizon software evolution scenarios. https://doi.org/10.48550/arXiv.2512.18470',
      id: '2512.18470', title: 'SWE-EVO: Benchmarking Coding Agents in Long-Horizon Software Evolution Scenarios', names: ['Tue Le','Minh V. T. Thai','Dung Nguyen Manh','Huy Phan Nhat','Nghi D. Q. Bui'], families: ['Le','Thai','Nguyen Manh','Phan Nhat','Bui'],
    },
    {
      reference: 'Jimenez, C. E., Yang, J., Wettig, A., Yao, S., Pei, K., Press, O., & Narasimhan, K. (2024). SWE-bench: Can language models resolve real-world GitHub issues? In Proceedings of the 12th International Conference on Learning Representations. https://doi.org/10.48550/arXiv.2310.06770',
      id: '2310.06770', title: 'SWE-bench: Can Language Models Resolve Real-World GitHub Issues?', names: ['Carlos E. Jimenez','John Yang','Alexander Wettig','Shunyu Yao','Kexin Pei','Ofir Press','Karthik Narasimhan'], families: ['Jimenez','Yang','Wettig','Yao','Pei','Press','Narasimhan'],
    },
  ];
  for (const example of examples) {
    const parsed = engine.parseReference(example.reference);let requested='';
    const [item] = await providers.search('arXiv', parsed, async (_, url) => {requested=url;return {entries:[{id:`https://arxiv.org/abs/${example.id}v2`,title:example.title,published:`${example.id==='2310.06770'?'2023':example.id.slice(0,2)==='20'?'2020':'2025'}-01-01T00:00:00Z`,authors:example.names.map(name=>({literal:name})),arxiv:example.id}]};});
    assert.match(requested,new RegExp(`id_list=${example.id.replace('.','\\.')}`));assert.equal(item.doi,`10.48550/arxiv.${example.id}`);assert.deepEqual(item.author.map(author=>author.family),example.families);assert.ok(item.author.every(author=>author.given));
  }
});

test('Europe PMC normalizes author, journal and DOI', async () => {
  const [item] = await providers.search('Europe PMC', parsed, async () => ({ resultList: { result: [{ title: parsed.title, pubYear: 2020, doi: '10.1/test', authorList: { author: [{ lastName: 'Smith', firstName: 'Alice' }] }, journalInfo: { journal: { title: 'Journal' }, volume: '3', issue: '1' }, pageInfo: '1-5' }] } }));
  assert.equal(item.author[0].family, 'Smith');
  assert.equal(item.containerTitle, 'Journal');
});

test('PubMed retrieves batched summaries after ID search', async () => {
  let calls = 0;
  const [item] = await providers.search('PubMed', parsed, async (_, url) => {
    calls += 1;
    return url.includes('esearch') ? { esearchresult: { idlist: ['123'] } } : { result: { 123: { uid: '123', title: parsed.title, pubdate: '2020 Jan', authors: [{ name: 'Smith A' }], articleids: [{ idtype: 'doi', value: '10.1/test' }], fulljournalname: 'Journal' } } };
  });
  assert.equal(calls, 2);
  assert.equal(item.year, 2020);
  assert.equal(item.doi, '10.1/test');
});

test('ERIC and Semantic Scholar response adapters', async () => {
  const responses = {
    ERIC: { response: { docs: [{ id: 'EJ123', title: parsed.title, author: ['Smith, Alice'], publicationdateyear: 2020 }] } },
    'Semantic Scholar': { data: [{ title: parsed.title, year: 2020, authors: [{ name: 'Alice Smith' }], externalIds: { DOI: '10.1/test' }, url: 'https://semanticscholar.org/paper/test' }] },
  };
  for (const id of Object.keys(responses)) {
    const [item] = await providers.search(id, parsed, async () => responses[id]);
    assert.equal(item.title, parsed.title);
    assert.equal(item.year, 2020);
    assert.ok(item.author.length);
  }
});

test('TR Dizin maps Turkish and English titles from the same record', async () => {
  const items = await providers.search('TR Dizin', parsed, async () => ({ hits: { hits: [{ _source: { id: 123, publicationYear: 2020, abstracts: [{ language: 'TUR', title: 'Eğitim araştırması' }, { language: 'ENG', title: parsed.title }], authors: [{ order: 2, name: 'Other Author' }, { order: 1, name: 'Alice Smith' }], journal: { name: 'Journal' }, issue: { number: '36', volume: '0' }, startPage: 5, endPage: 9 } }] } }));
  assert.equal(items.length, 2);
  assert.equal(items[1].title, parsed.title);
  assert.equal(items[0].author[0].literal, 'Alice Smith');
  assert.equal(items[0].pages, '5–9');
  assert.equal(items[0].issue, '36');
  assert.equal(items[0].volume, '');
});

test('İSAM preserves provenance and requires archive review', async () => {
  const metadata = { 'dc.title': [{ value: parsed.title }], 'dc.contributor.author': [{ value: 'Smith, Alice' }], 'dc.date.issued': [{ value: '2020' }], 'dc.identifier.uri': [{ value: 'https://makale.isam.org.tr/handle/123456789/123' }] };
  const [item] = await providers.search('İSAM', parsed, async () => ({ _embedded: { searchResult: { _embedded: { objects: [{ _embedded: { indexableObject: { metadata } } }] } } } }));
  assert.equal(item.year, 2020);
  assert.ok(item.requiresReview);
  assert.ok(item.url.includes('/handle/'));
});

test('OpenLibrary and Google Books proposals require edition/archive review', async () => {
  const responses = {
    OpenLibrary: { docs: [{ key: '/works/OL123W', title: parsed.title, author_name: ['Alice Smith'], first_publish_year: 2020 }] },
    'Google Books': { items: [{ id: '123', volumeInfo: { title: parsed.title, authors: ['Alice Smith'], publishedDate: '2020-01-01', publisher: 'Publisher' } }] },
  };
  for (const id of Object.keys(responses)) {
    const [item] = await providers.search(id, parsed, async () => responses[id]);
    assert.ok(item.requiresReview);
    assert.equal(item.year, 2020);
  }
});

test('fallback to extra provider is actually used and records search provenance', async () => {
  const context = { module: { exports: {} }, ReferenceProviders: providers, AbortController,
    setTimeout: (fn, ms) => setTimeout(fn, ms >= 15000 ? ms : 0), clearTimeout,
    fetch: async url => new Response(JSON.stringify(url.includes('api.ies.ed.gov') ? { response: { docs: [{ id: 'EJ123', title: parsed.title, author: ['Smith, Alice'], publicationdateyear: 2020 }] } } : url.includes('api.crossref.org') ? { message: { items: [] } } : { results: [] }), { status: 200 }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../reference-engine.js'), 'utf8'), context);
  const result = await context.module.exports.verifyReference(parsed.reference);
  assert.equal(result.status, 'verified');
  assert.equal(result.provider, 'ERIC');
  assert.ok(result.sourcesChecked.includes('ERIC'));
  assert.ok(!result.sourcesChecked.includes('CORE'));
  assert.ok(!providers.descriptors.some(provider => provider.id === 'CORE' || provider.id === 'DBLP'));
});

test('proxy rejects local URLs, mismatched providers, credentials and unsafe protocols', () => {
  assert.ok(allowedTarget('PubMed', 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed'));
  for (const url of ['http://localhost/', 'https://127.0.0.1/', 'https://api.crossref.org.evil.test/works', 'https://name:pass@api.crossref.org/works', 'file:///etc/passwd', 'https://api.crossref.org:4173/works']) assert.equal(allowedTarget('Crossref', url), false);
  assert.equal(allowedTarget('PubMed', 'https://api.crossref.org/works'), false);
});

test('server exposes key availability but never keys or .env files', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.proxy, true);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    assert.equal((await fetch(`${base}/api/proxy?provider=Crossref&url=http://localhost`)).status, 400);
    assert.equal((await fetch(`${base}/api/config`, { headers: { Origin: 'https://untrusted.test' } })).status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
