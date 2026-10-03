// Skill files (skills/*.md): the owner's instructions that frame how the assistant answers.
// A skill is a markdown file with a small header; users choose one (or accept the suggestion), they never edit them.
// An administrator can edit, add, hide or restore skills in the admin panel; those edits live in prompts.db and win over the files.
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
const { defaultStore } = require('./prompt-store.cjs');

const dir = () => process.env.SKILLS_DIR || path.join(__dirname, '..', 'skills');
const DEFAULT_SKILL = 'genel';
let cache = { key: '', value: { skills: [], problems: [] } };

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
function loadFiles() {
  const folder = dir();
  let names = [];
  try { names = fs.readdirSync(folder).filter(n => n.endsWith('.md') && !n.startsWith('_') && !/^readme/i.test(n)).sort(); } catch { return { skills: [], problems: [] }; }
  const key = folder + '|' + names.map(n => n + fs.statSync(path.join(folder, n)).mtimeMs).join(',');
  if (cache.key === key) return cache.value;
  const skills = [], problems = [];
  for (const name of names) {
    const skill = parse(fs.readFileSync(path.join(folder, name), 'utf8'), name);
    if (skill) skills.push({ ...skill, origin: 'file' }); else problems.push(name);
  }
  cache = { key, value: { skills, problems } };
  return cache.value;
}
const storedRows = () => { try { return defaultStore().skills(); } catch { return []; } };
const fromRow = (row, origin) => ({ name: row.name, title: row.title, description: row.description, minPlan: row.minPlan, keywords: row.keywords, needsSources: row.needsSources, instruction: row.instruction, origin });
// The files, with the administrator's edits laid over them: an edit replaces the file's skill, a "deleted" row hides it,
// a row without a file is a skill created in the panel.
function load() {
  const base = loadFiles(), rows = storedRows();
  if (!rows.length) return base;
  const files = new Set(base.skills.map(s => s.name)), byName = new Map(base.skills.map(s => [s.name, s]));
  for (const row of rows) {
    if (row.deleted) byName.delete(row.name);
    else if (row.title && row.instruction) byName.set(row.name, fromRow(row, files.has(row.name) ? 'edited' : 'custom'));
  }
  const order = [...base.skills.map(s => s.name), ...rows.map(r => r.name).filter(n => !files.has(n)).sort()];
  return { skills: order.filter((n, i) => byName.has(n) && order.indexOf(n) === i).map(n => byName.get(n)), problems: base.problems };
}

const fail = (status, message) => { const error = Error(message); error.status = status; return error; };
// Everything the panel needs, including file skills the administrator has hidden (so they can be restored).
function adminList() {
  const base = loadFiles(), rows = new Map(storedRows().map(r => [r.name, r])), active = new Map(load().skills.map(s => [s.name, s]));
  const out = [];
  for (const file of base.skills) {
    const row = rows.get(file.name), shown = active.get(file.name);
    out.push({ ...(shown || file), origin: row?.deleted ? 'hidden' : row ? 'edited' : 'file', hasFile: true, fileInstruction: file.instruction, updatedAt: row?.updatedAt || null, updatedBy: row?.updatedBy || null });
  }
  for (const row of rows.values()) if (!row.deleted && !base.skills.some(s => s.name === row.name)) out.push({ ...fromRow(row, 'custom'), hasFile: false, updatedAt: row.updatedAt, updatedBy: row.updatedBy });
  return { skills: out, problems: base.problems };
}
function clean(input, name) {
  const text = (value, max) => String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
  const skill = { name, title: text(input.title, 120), description: text(input.description, 300), instruction: text(input.instruction, 8000), needsSources: input.needsSources !== false && !/^(?:false|no|0)$/i.test(String(input.needsSources ?? 'true')),
    minPlan: text(input.minPlan, 40), keywords: (Array.isArray(input.keywords) ? input.keywords : String(input.keywords ?? '').split(',')).map(k => String(k).trim()).filter(Boolean).slice(0, 40).map(k => k.slice(0, 60)) };
  if (!/^[a-z0-9-]{1,40}$/.test(name)) throw fail(400, 'Skill adı yalnız küçük harf, rakam ve "-" içerebilir (en fazla 40 karakter).');
  if (!skill.title) throw fail(400, 'Başlık gerekli.');
  if (!skill.instruction) throw fail(400, 'Talimat metni gerekli.');
  if (skill.minPlan && !Plans.all().some(p => p.id === skill.minPlan)) throw fail(400, 'Geçersiz paket.');
  return skill;
}
// create: a new name only; otherwise an existing skill is changed.
function save(input, by = '', { create = false } = {}) {
  const name = String(input.name ?? '').trim();
  const exists = adminList().skills.find(s => s.name === name);
  if (create && exists) throw fail(409, 'Bu adla bir skill zaten var.');
  if (!create && !exists) throw fail(404, 'Skill bulunamadı.');
  defaultStore().saveSkill(clean(input, name), by);
  return adminList().skills.find(s => s.name === name);
}
// A file skill is hidden (kept, so it can be restored); a skill created in the panel is deleted for good.
function remove(name, by = '') {
  const found = adminList().skills.find(s => s.name === name);
  if (!found) throw fail(404, 'Skill bulunamadı.');
  if (name === DEFAULT_SKILL) throw fail(400, 'Varsayılan "' + DEFAULT_SKILL + '" skill\'i silinemez.');
  if (found.hasFile) defaultStore().saveSkill({ ...found, deleted: true }, by); else defaultStore().deleteSkillRow(name);
  return { removed: true, hidden: found.hasFile };
}
// Drops the administrator's edit: the file's version applies again (a panel-created skill disappears).
function reset(name) {
  if (!adminList().skills.some(s => s.name === name)) throw fail(404, 'Skill bulunamadı.');
  defaultStore().deleteSkillRow(name);
  return adminList().skills.find(s => s.name === name) || null;
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

module.exports = { load, forPlan, get, suggest, publicView, parse, adminList, save, remove, reset, DEFAULT_SKILL };
