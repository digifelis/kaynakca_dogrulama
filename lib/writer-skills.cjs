// Skill files (skills/*.md): the owner's instructions that frame how the assistant answers.
// A skill is a markdown file with a small header; users choose one (or accept the suggestion), they never edit them.
//
//   ---
//   name: giris-yaz            (same as the file name)
//   title: Giriş bölümü yaz
//   description: One line shown next to the title.
//   minPlan: basic             (the lowest plan that may use it; higher plans inherit it)
//   keywords: [giriş, introduction, amaç]
//   needsSources: true         (false: rewrites the user's own text, no source passages required)
//   ---
//   Instruction text …
const fs = require('node:fs');
const path = require('node:path');
const Plans = require('./plans.cjs');
const { tokenize } = require('./writer-search.cjs');

const dir = () => process.env.SKILLS_DIR || path.join(__dirname, '..', 'skills');
const DEFAULT_SKILL = 'genel';
let cache = { key: '', skills: [] };

function parseList(value) {
  const inner = String(value).trim().replace(/^\[|\]$/g, '');
  return inner.split(',').map(v => v.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}
function parse(text, fileName) {
  const match = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const header = {};
  for (const line of match[1].split('\n')) {
    const pair = line.match(/^([A-Za-z]+)\s*:\s*(.*)$/);
    if (pair) header[pair[1]] = pair[2].trim();
  }
  const name = path.basename(fileName, '.md');
  const body = match[2].trim();
  if (!/^[a-z0-9-]{1,40}$/.test(name) || header.name !== name || !header.title || !body) return null;
  // `plans: [premium, gold]` from older files means "from the lowest listed plan up".
  const legacy = header.plans ? parseList(header.plans).sort((a, b) => Plans.rank(a) - Plans.rank(b))[0] : '';
  const minPlan = header.minPlan || legacy || '';
  return { name, title: header.title, description: header.description || '', minPlan, keywords: parseList(header.keywords || ''),
    needsSources: !/^(?:false|no|0)$/i.test(header.needsSources || 'true'), instruction: body };
}
// Invalid files are skipped (and named by `problems`) rather than breaking the whole list.
function load() {
  const folder = dir();
  let names = [];
  try { names = fs.readdirSync(folder).filter(n => n.endsWith('.md') && !n.startsWith('_') && !/^readme/i.test(n)).sort(); } catch { return { skills: [], problems: [] }; }
  const key = folder + '|' + names.map(n => n + fs.statSync(path.join(folder, n)).mtimeMs).join(',');
  if (cache.key === key) return cache.value;
  const skills = [], problems = [];
  for (const name of names) {
    const skill = parse(fs.readFileSync(path.join(folder, name), 'utf8'), name);
    if (skill) skills.push(skill); else problems.push(name);
  }
  cache = { key, value: { skills, problems } };
  return cache.value;
}
// A skill whose minimum plan no longer exists is kept for the highest plan only.
const required = skill => Plans.all().some(p => p.id === skill.minPlan) ? Plans.rank(skill.minPlan) : skill.minPlan ? Plans.all().length - 1 : 0;
const forPlan = plan => load().skills.filter(skill => Plans.rank(plan) >= required(skill));
const publicView = skill => ({ name: skill.name, title: skill.title, description: skill.description, needsSources: skill.needsSources, minPlan: skill.minPlan || Plans.all()[0]?.id || 'basic' });
function get(name, plan) { return forPlan(plan).find(skill => skill.name === name) || null; }

// Local keyword match between the question and each skill's keywords/title/description; no LLM call.
function suggest(question, plan) {
  const available = forPlan(plan);
  const asked = new Set(tokenize(question));
  let best = null, bestScore = 0;
  for (const skill of available) {
    if (skill.name === DEFAULT_SKILL) continue;
    const keywords = new Set(skill.keywords.flatMap(k => tokenize(k)));
    const rest = new Set(tokenize(skill.title + ' ' + skill.description));
    let score = 0;
    for (const token of asked) { if (keywords.has(token)) score += 2; else if (rest.has(token)) score += 1; }
    if (score > bestScore) { best = skill; bestScore = score; }
  }
  // One stray keyword is not enough to override the general skill ("katılımı" must not select the method skill).
  return (bestScore >= 3 ? best : available.find(s => s.name === DEFAULT_SKILL) || null)?.name || null;
}

module.exports = { load, forPlan, get, suggest, publicView, parse, DEFAULT_SKILL };
