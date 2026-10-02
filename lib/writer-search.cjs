// Finding the passages that answer a question: BM25 keyword score and embedding similarity, fused by rank.
// Without vectors (no embedding key, or a document that could not be embedded) the keyword score alone is used.
const STOP = new Set(('ve veya ile bir bu şu o için gibi daha çok en de da ki mi mı mu mü ne olarak olan olarak göre kadar ancak fakat ama '
  + 'the a an and or of in to for is are was were be been with as at by on from that this these those it its not no but which who what how why when where '
  + 'nedir nasıl neden hangi kim kaç').split(' '));

// Turkish is agglutinative: cutting words to their first five letters is a crude but effective stemmer for retrieval.
function tokenize(text) {
  return (String(text).toLocaleLowerCase('tr').match(/[\p{L}\p{N}]+/gu) || [])
    .filter(word => word.length > 1 && !STOP.has(word))
    .map(word => word.length > 6 ? word.slice(0, 5) : word);
}

function bm25(queryTokens, chunks, { k1 = 1.5, b = 0.75 } = {}) {
  const docs = chunks.map(chunk => tokenize((chunk.section ? chunk.section + ' ' : '') + chunk.text));
  const average = docs.reduce((sum, d) => sum + d.length, 0) / (docs.length || 1) || 1;
  const frequency = new Map();
  for (const tokens of docs) for (const term of new Set(tokens)) frequency.set(term, (frequency.get(term) || 0) + 1);
  const terms = [...new Set(queryTokens)];
  return docs.map(tokens => {
    const counts = new Map();
    for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
    let score = 0;
    for (const term of terms) {
      const tf = counts.get(term);
      if (!tf) continue;
      const df = frequency.get(term);
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * tokens.length / average));
    }
    return score;
  });
}
const dot = (a, b) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i] * b[i]; return sum; };

// chunks: [{ id, documentId, vector|null, ... }]. Returns the best `limit` passages with their scores.
function rank({ query, queryVector = null, chunks, limit = 8, perDocument = 5, rrfK = 60 }) {
  if (!chunks.length) return [];
  const lexical = bm25(tokenize(query), chunks);
  const dense = queryVector ? chunks.map(c => c.vector && c.vector.length === queryVector.length ? dot(c.vector, queryVector) : null) : chunks.map(() => null);
  const order = values => values.map((v, i) => [v, i]).filter(([v]) => v !== null && v > 0).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  const fused = new Map();
  for (const list of [order(lexical), order(dense)]) list.forEach((index, position) => fused.set(index, (fused.get(index) || 0) + 1 / (rrfK + position + 1)));
  const picked = [], perDoc = new Map();
  for (const [index, score] of [...fused].sort((a, b) => b[1] - a[1])) {
    const chunk = chunks[index];
    // Several uploaded sources should all get a say; one document cannot fill every slot.
    if ((perDoc.get(chunk.documentId) || 0) >= perDocument) continue;
    perDoc.set(chunk.documentId, (perDoc.get(chunk.documentId) || 0) + 1);
    picked.push({ ...chunk, vector: undefined, score, lexical: lexical[index], similarity: dense[index] });
    if (picked.length >= limit) break;
  }
  return picked;
}
function normalize(vector) {
  const out = Float32Array.from(vector);
  const length = Math.hypot(...out) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= length;
  return out;
}

module.exports = { tokenize, bm25, rank, normalize };
