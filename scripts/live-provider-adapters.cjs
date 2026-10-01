const providers = require('../providers.js');
const engine = require('../reference-engine.js');
engine.configure({ proxyUrl: 'http://localhost:4173/api/proxy' });
const samples = [
  ['PubMed', 'Toward Precision Aspirin Prophylaxis: Optimal Aspirin Dosing For Prevention of Preeclampsia', 'Gaur', 2026],
  ['Europe PMC', 'Toward Precision Aspirin Prophylaxis: Optimal Aspirin Dosing For Prevention of Preeclampsia', 'Gaur', 2026],
  ['ERIC', 'Education! Education!', 'Dillon', 2006],
  ['TR Dizin', 'Türkiye’deki Konaklama İstatistiklerinin İllere Göre Mekânsal Analizi', 'Kervankıran', 2017],
  ['İSAM', 'Tasavvuf Edebiyatımızda Hikemmiyat', 'Göksoy', 2005],
  ['CORE', 'Attention Is All You Need', 'Vaswani', 2017],
  ['OpenLibrary', 'Start with why', 'Sinek', 2009],
];
(async () => {
  const results = await Promise.allSettled(samples.map(async ([id, title, firstAuthor, year]) => {
    const items = await providers.search(id, { title, firstAuthor, year, doi: '', reference: `${firstAuthor} (${year}). ${title}.` }, engine.requestJson);
    return { provider: id, candidates: items.length, sample: items[0] ? { title: items[0].title, year: items[0].year, author: items[0].author[0], container: items[0].containerTitle, issue: items[0].issue } : null };
  }));
  results.forEach((result, index) => console.log(JSON.stringify(result.status === 'fulfilled' ? result.value : { provider: samples[index][0], error: result.reason.message })));
})();
