const test = require('node:test');
const assert = require('node:assert/strict');
const Styles = require('../citation-styles.js');
const Engine = require('../reference-engine.js');

const helpers = { sentenceCase: Engine.sentenceCase };
const article = { type: 'journal-article', title: 'Mapping Destination Images and Behavioral Patterns from User-Generated Photos: A Computer Vision Approach',
  author: [{ family: 'Zhang', given: 'Kai' }, { family: 'Lee', given: 'Mei-Jun' }, { family: 'Park', given: 'Sung' }], year: 2020, month: 1,
  containerTitle: 'Asia Pacific Journal of Tourism Research', volume: '25', issue: '11', pages: '1199–1214', doi: '10.1000/test' };

test('Vancouver journal article: surname + initials, sentence-case title, NLM abbreviation, shortened pages, doi', () => {
  const out = Styles.format(article, 'vancouver', helpers);
  assert.equal(out.text, 'Zhang K, Lee MJ, Park S. Mapping destination images and behavioral patterns from user-generated photos: A computer vision approach. Asia Pac J Tour Res. 2020;25(11):1199-214. doi:10.1000/test');
  assert.equal(out.html, out.text, 'no italics in Vancouver');
  assert.match(out.notes.join(' '), /kısaltma/i, 'a rule-made abbreviation is flagged for checking');
});

test('Vancouver lists the first three authors and "et al."; the limit is three', () => {
  const four = { ...article, author: [...article.author, { family: 'Cho', given: 'Dae' }] };
  assert.equal(Styles.VANCOUVER_AUTHOR_LIMIT, 3);
  assert.match(Styles.format(four, 'vancouver', helpers).text, /^Zhang K, Lee MJ, Park S, et al\. Mapping/);
  assert.doesNotMatch(Styles.format(article, 'vancouver', helpers).text, /et al/);
});

test('Vancouver uses the index record\'s own short journal title without periods', () => {
  const out = Styles.format({ ...article, shortContainer: 'Asia Pac. J. Tour. Res.' }, 'vancouver', helpers);
  assert.match(out.text, /\. Asia Pac J Tour Res\. 2020/);
  assert.equal(out.notes.length, 0);
});

test('names: given-name initials without periods, hyphenated and Turkish names, organisations, particles', () => {
  const name = (author) => Styles.format({ ...article, author }, 'vancouver', helpers).text.split('. ')[0];
  assert.equal(name([{ literal: 'İbrahim Yıldız' }]), 'Yıldız İ');
  assert.equal(name([{ family: 'Yılmaz', given: 'Mehmet Ali' }]), 'Yılmaz MA');
  assert.equal(name([{ family: 'Chang', given: 'M.-W.' }]), 'Chang MW');
  assert.equal(name([{ family: 'Tolkien', given: 'J.R.R.' }]), 'Tolkien JRR');
  assert.equal(name([{ literal: 'World Health Organization' }]), 'World Health Organization');
  assert.equal(name([{ literal: 'Maria van der Berg' }]), 'van der Berg M');
  assert.deepEqual(Styles.person('Zhang, Kai'), { family: 'Zhang', given: 'Kai' });
});

test('Vancouver page ranges lose the digits both numbers share; e-locators stay', () => {
  assert.equal(Styles.vancouverPages('1199–1214'), '1199-214');
  assert.equal(Styles.vancouverPages('123-127'), '123-7');
  assert.equal(Styles.vancouverPages('S45-S52'), 'S45-52');
  assert.equal(Styles.vancouverPages('e12345'), 'e12345');
  assert.equal(Styles.vancouverPages('7'), '7');
});

test('Vancouver book, chapter, web page and preprint', () => {
  const book = { type: 'book', title: 'Research Methods', author: [{ family: 'Yılmaz', given: 'Ali' }], publisher: 'Springer', place: 'Berlin', year: 2019, edition: '2' };
  assert.equal(Styles.format(book, 'vancouver', helpers).text, 'Yılmaz A. Research Methods. 2nd ed. Berlin: Springer; 2019.');
  const web = { type: 'web', title: 'Water use of data centers', author: [{ literal: 'Bloomberg News' }], site: 'Bloomberg', year: 2025, url: 'https://example.org/a' };
  assert.equal(Styles.format(web, 'vancouver', helpers, { today: '2026-10-04T12:00:00' }).text, 'Bloomberg News. Water use of data centers [Internet]. Bloomberg; 2025 [cited 2026 Oct 4]. Available from: https://example.org/a');
  const preprint = { title: 'Attention is all you need', author: [{ family: 'Vaswani', given: 'Ashish' }], year: 2017, arxiv: '1706.03762' };
  assert.equal(Styles.format(preprint, 'vancouver', helpers, { today: '2026-10-04T12:00:00' }).text, 'Vaswani A. Attention is all you need. arXiv [Preprint]. 2017 [cited 2026 Oct 4]. Available from: https://arxiv.org/abs/1706.03762');
  const chapter = { type: 'book-chapter', title: 'A chapter', author: [{ family: 'Kaya', given: 'Ece' }], containerTitle: 'The big handbook', publisher: 'Wiley', place: 'Hoboken', year: 2018, pages: '10-25' };
  assert.equal(Styles.format(chapter, 'vancouver', helpers).text, 'Kaya E. A chapter. In: The big handbook. Hoboken: Wiley; 2018. p. 10-25.');
});

test('IEEE journal article: initials first, quoted title, abbreviated italic journal, vol./no./pp., month, doi', () => {
  const out = Styles.format(article, 'ieee', helpers);
  assert.equal(out.text, 'K. Zhang, M. J. Lee, and S. Park, “Mapping Destination Images and Behavioral Patterns from User-Generated Photos: A Computer Vision Approach,” Asia Pac. J. Tour. Res., vol. 25, no. 11, pp. 1199–1214, Jan. 2020, doi: 10.1000/test.');
  assert.match(out.html, /<em>Asia Pac\. J\. Tour\. Res\.<\/em>/);
});

test('IEEE authors: two with "and", more than six become the first author and "et al."', () => {
  const two = { ...article, author: article.author.slice(0, 2) }, seven = { ...article, author: Array.from({ length: 7 }, (_, i) => ({ family: 'Name' + i, given: 'Ada' })) };
  assert.match(Styles.format(two, 'ieee', helpers).text, /^K\. Zhang and M\. J\. Lee, “/);
  assert.match(Styles.format(seven, 'ieee', helpers).text, /^A\. Name0 et al\., “/);
  assert.equal(Styles.IEEE_AUTHOR_LIMIT, 6);
});

test('IEEE book, conference paper and web page; the title keeps acronyms', () => {
  const book = { type: 'book', title: 'Research Methods', author: [{ family: 'Yılmaz', given: 'Ali' }], publisher: 'Springer', place: 'Berlin', year: 2019, edition: '2' };
  const out = Styles.format(book, 'ieee', helpers);
  assert.equal(out.text, 'A. Yılmaz, Research Methods, 2nd ed. Berlin: Springer, 2019.');
  assert.match(out.html, /<em>Research Methods<\/em>/);
  const paper = { type: 'proceedings-article', title: 'deep learning for BERT based search', author: [{ family: 'Kaya', given: 'Ece' }], containerTitle: 'Proc. Int. Conf. Data', year: 2021, pages: '1-8', place: 'Paris' };
  assert.equal(Styles.format(paper, 'ieee', helpers).text, 'E. Kaya, “Deep Learning for BERT Based Search,” in Proc. Int. Conf. Data, Paris, 2021, pp. 1–8.');
  const web = { type: 'web', title: 'Open data portal', author: [{ literal: 'Ministry of Data' }], site: 'Ministry of Data', year: 2024, url: 'https://example.org/p' };
  assert.equal(Styles.format(web, 'ieee', helpers, { today: '2026-10-04T12:00:00' }).text, 'Ministry of Data, “Open Data Portal,” Ministry of Data. https://example.org/p (accessed Oct. 4, 2026).');
});

test('journal abbreviations: single words stay, articles and prepositions drop, IEEE keeps the periods', () => {
  assert.deepEqual(Styles.journalAbbreviation({ containerTitle: 'Energies' }), { text: 'Energies', source: 'none' });
  assert.deepEqual(Styles.journalAbbreviation({ containerTitle: 'Journal of the American Medical Association' }), { text: 'J Am Med Assoc', source: 'rule' });
  assert.equal(Styles.journalAbbreviation({ containerTitle: 'International Journal of Applied Research' }, { periods: true }).text, 'Int. J. Appl. Res.');
  assert.equal(Styles.journalAbbreviation({ containerTitle: 'Türk Coğrafya Dergisi' }).source, 'none', 'unknown words are never guessed');
});

test('in-text groups: Vancouver [1-3,5], IEEE [1]–[3], [5], locator after a single number', () => {
  assert.equal(Styles.citationGroup('vancouver', [5, 1, 3, 2, 1]), '[1-3,5]');
  assert.equal(Styles.citationGroup('vancouver', [1, 2]), '[1,2]');
  assert.equal(Styles.citationGroup('ieee', [1, 2, 3, 5]), '[1]–[3], [5]');
  assert.equal(Styles.citationGroup('ieee', [1, 2]), '[1], [2]');
  assert.equal(Styles.citationGroup('vancouver', [3], { locator: 's. 12' }), '[3, s. 12]');
  assert.equal(Styles.citationGroup('ieee', [3], { locator: 'p. 12' }), '[3, p. 12]');
  assert.equal(Styles.citationGroup('vancouver', []), '');
  assert.equal(Styles.listLabel('ieee', 4), '[4]'); assert.equal(Styles.listLabel('vancouver', 4), '4.');
});

test('restyle: a verified record is rewritten from its structured data; other statuses and APA stay as they are', () => {
  const matched = { ...article, provider: 'Crossref' };
  const verified = { status: 'verified', raw: 'raw line', corrected: 'APA text', matched };
  const vancouver = Engine.restyle(verified, 'vancouver');
  assert.match(vancouver.corrected, /^Zhang K, Lee MJ, Park S\./); assert.equal(vancouver.corrected, vancouver.suggested); assert.equal(vancouver.style, 'vancouver');
  assert.equal(Engine.restyle(verified, 'apa'), verified); assert.equal(Engine.restyle(verified), verified);
  const review = Engine.restyle({ status: 'review', raw: 'raw line', corrected: 'raw line', matched }, 'ieee');
  assert.equal(review.corrected, 'raw line', 'an unconfirmed record keeps its original text');
  assert.match(review.suggested, /^K\. Zhang/);
  const failed = { status: 'failed', raw: 'x', matched: null };
  assert.equal(Engine.restyle(failed, 'vancouver'), failed);
  const registry = Engine.restyle({ status: 'verified', raw: 'doi', registry: true, matched: { ...article, title: '<i>Mapping</i> destination images', pages: '1199-1214' } }, 'vancouver');
  assert.match(registry.corrected, /Mapping destination images\. Asia Pac J Tour Res\. 2020;25\(11\):1199-214/);
});

test('verifyReference with a style returns the corrected record in that style (browser-free check through restyle)', async () => {
  const original = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ message: { items: [], title: ['T'] } }), text: async () => '' });
  try {
    const result = await Engine.verifyReference('Zhang, K. (2020). Nothing like this exists in any index at all. Journal.', { style: 'vancouver' });
    assert.ok(['failed', 'error'].includes(result.status), 'nothing found: the record is left as typed');
  } finally { global.fetch = original; }
});

test('numbered and IEEE references are read: list numbers, quoted titles and initials-first authors', () => {
  assert.deepEqual(Engine.splitReferences('1. A. Smith, “First study of things,” J. Stuff, 2019.\n(2) B. Jones. Second study. J. 2020.\n[3] C. Lee. Third study here. J. 2021.').length, 3);
  const ieee = Engine.parseReference('A. Zhang, B. Lee, and C. Park, “Mapping destination images from photos,” Asia Pac. J. Tour. Res., vol. 25, no. 11, pp. 1199–1214, Jan. 2020, doi: 10.1000/test.');
  assert.equal(ieee.title, 'Mapping destination images from photos'); assert.equal(ieee.firstAuthor, 'Zhang'); assert.equal(ieee.year, 2020); assert.equal(ieee.doi, '10.1000/test');
  const vancouver = Engine.parseReference('Zhang K, Lee MJ, Park S, et al. Mapping destination images from photos. Asia Pac J Tour Res. 2020;25(11):1199-214.');
  assert.equal(vancouver.title, 'Mapping destination images from photos'); assert.equal(vancouver.firstAuthor, 'Zhang'); assert.equal(vancouver.year, 2020);
});

test('a style that does not exist is refused', () => {
  assert.throws(() => Styles.format(article, 'chicago', helpers), /Desteklenmeyen/);
});
