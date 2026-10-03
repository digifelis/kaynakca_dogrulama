// Building the model request for a question and turning the model's answer into cited text.
// The model only marks which passage supports a sentence ([P3]); the visible author–year citation is produced
// by the server from the source's bibliographic data, so the model can never invent one.
const Cite = require('../writer-cite.js');
const Prompts = require('./prompts.cjs');

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['answer', 'insufficient'],
  properties: { answer: { type: 'string' }, insufficient: { type: 'boolean' } },
};
const PASSAGE_CHARS = 1800;
// Everything below is sent to the model with every question, so each part is kept short: the last few turns (answers cut
// shorter than questions, because they only give continuity), the end of the draft, and passages without their repeated overlap.
const HISTORY_TURNS = 4, HISTORY_USER_CHARS = 500, HISTORY_ANSWER_CHARS = 600, DRAFT_CHARS = 3500;
const OVERLAP_MIN_WORDS = 12, OVERLAP_MAX_WORDS = 45;

// The article language is chosen by the user and wins over the language of the question and of the passages.
function languageRule(language) {
  if (language !== 'en' && language !== 'tr') return "Write in the language of the user's question (Turkish unless the question is in another language).";
  const name = language === 'en' ? 'English' : 'Turkish';
  return `Write the whole answer in ${name}, whatever language the question, the "passages" or the "draft" are in; when a passage is in another language, express its content faithfully in ${name} and keep proper names, titles and quotations from sources accurate.`;
}

function system(skill, language) {
  const facts = Prompts.get(skill.needsSources ? 'writer_facts_sources' : 'writer_facts_text');
  return Prompts.fill(Prompts.get('writer_system'), { FACTS: facts, LANGUAGE: languageRule(language), SKILL_TITLE: skill.title, SKILL: skill.instruction });
}

const wordsOf = text => String(text).split(/\s+/).filter(Boolean);
// Consecutive passages of one source repeat the last ~40 words of the previous one; when both are selected the repeat is sent once.
function withoutOverlap(chunks) {
  return chunks.map(chunk => {
    const own = wordsOf(chunk.text);
    for (const other of chunks) {
      if (other === chunk || other.documentId !== chunk.documentId) continue;
      const before = wordsOf(other.text);
      for (let k = Math.min(OVERLAP_MAX_WORDS, own.length - 1, before.length); k >= OVERLAP_MIN_WORDS; k--) {
        if (before.slice(-k).join(' ') === own.slice(0, k).join(' ')) return own.slice(k).join(' ');
      }
    }
    return chunk.text;
  });
}
const shorten = (text, max) => text.length <= max ? text : text.slice(0, max).replace(/\s+\S*$/, '') + ' …';

// chunks: ranked passages with .documentId; sourcesById: { docId: { fileName, meta } }.
function request({ skill, question, chunks, sourcesById, history = [], draft = '', language = '' }) {
  const bodies = withoutOverlap(chunks);
  const passages = chunks.map((chunk, index) => {
    const source = sourcesById[chunk.documentId];
    return { id: 'P' + (index + 1), source: Cite.sourceLabel(source, [], 'en').text.replace(/, n\.d\.$/, ''), title: source?.meta?.title || '',
      location: [chunk.section, chunk.page ? 'page ' + chunk.page : ''].filter(Boolean).join(', '), text: bodies[index].slice(0, PASSAGE_CHARS) };
  });
  const user = JSON.stringify({
    question,
    passages,
    conversation: history.slice(-HISTORY_TURNS).map(m => ({ role: m.role, text: shorten(m.text, m.role === 'user' ? HISTORY_USER_CHARS : HISTORY_ANSWER_CHARS) })),
    ...(draft ? { draft: draft.slice(-DRAFT_CHARS) } : {}),
  });
  return { name: 'writer_answer', schema: SCHEMA, system: system(skill, language), user, maxTokens: 3000 };
}

// "[P1]", "[P1, P3]" and "[P1][P2]" runs become one source token; unknown ids are dropped, never guessed.
function applyCitations(answer, chunks) {
  const refs = chunks.map(chunk => ({ docId: chunk.documentId, page: chunk.page || null }));
  const text = String(answer || '').replace(/(?:\[\s*P\d+(?:\s*[,;]\s*P\d+)*\s*\]\s*)+/g, run => {
    const found = [...new Set([...run.matchAll(/P(\d+)/g)].map(m => Number(m[1]) - 1))].map(i => refs[i]).filter(Boolean);
    return found.length ? Cite.tokenFor(found) + ' ' : '';
  });
  // The token sits where the marker was: before the full stop, with no stray space before punctuation.
  return text.replace(/\s+(\{\{c:[^}]*\}\})\s*([.,;:!?])/g, ' $1$2').replace(/ {2,}/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
}

module.exports = { request, applyCitations, system, SCHEMA };
