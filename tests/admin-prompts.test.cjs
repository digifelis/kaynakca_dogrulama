// Administrators manage the model prompts and the writing assistant's skills; edits apply at once and are audited.
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/harness.cjs');

test('prompts can be edited, validated and reset; the next request uses the edit', async () => {
  const h = await harness();
  try {
    const admin = await h.adminClient(), user = await h.register('ayse');
    assert.equal((await user('GET', '/api/admin/prompts')).status, 403);
    assert.equal((await user('PUT', '/api/admin/prompts/writer_system', { content: 'x' })).status, 403);
    const listed = await admin('GET', '/api/admin/prompts');
    assert.equal(listed.status, 200); assert.ok(listed.prompts.length >= 6); assert.ok(listed.prompts.every(p => !p.customized && p.content === p.defaultContent));
    const Answer = require('../lib/writer-answer.cjs'), WordContent = require('../word-content.cjs');
    const skill = { title: 'Giriş', instruction: 'TALIMAT-METNI', needsSources: true };
    assert.match(Answer.system(skill, 'tr'), /writing assistant/);

    assert.equal((await admin('PUT', '/api/admin/prompts/writer_system', { content: 'Eksik yer tutucular' })).status, 400);
    assert.equal((await admin('PUT', '/api/admin/prompts/writer_system', { content: '  ' })).status, 400);
    assert.equal((await admin('PUT', '/api/admin/prompts/yok_boyle', { content: 'x' })).status, 404);
    const saved = await admin('PUT', '/api/admin/prompts/writer_system', { content: 'ÖZEL ÇERÇEVE\n{{FACTS}}\n{{LANGUAGE}}\n{{SKILL_TITLE}}: {{SKILL}} $& $1' });
    assert.equal(saved.status, 200, JSON.stringify(saved)); assert.equal(saved.prompt.customized, true);
    const used = Answer.system(skill, 'en');
    assert.match(used, /^ÖZEL ÇERÇEVE\n2\. Use ONLY facts/); assert.match(used, /Giriş: TALIMAT-METNI \$& \$1$/); assert.doesNotMatch(used, /\{\{/);

    await admin('PUT', '/api/admin/prompts/citation_evidence', { content: 'ÖZEL KANIT İSTEMİ' });
    const calls = [];
    WordContent.useChatTransport({ available: () => true, chat: async spec => { calls.push(spec.system); return { result: { verdict: 'not_found', explanation: 'x', claims: [{ verdict: 'not_found', claim: 'c', explanation: 'e', quote: '', passage: '' }] }, provider: 'test', model: 'm' }; } });
    try { await WordContent.evaluate({ sentence: 'Bir cümle.', context: [], authorText: 'A', year: '2020' }, { title: 'T', passages: [{ location: 'Sayfa 1', text: 'Metin gövdesi burada yer alır ve yeterince uzundur.' }] }, new AbortController().signal, () => {}); } finally { WordContent.useChatTransport(null); }
    assert.equal(calls[0], 'ÖZEL KANIT İSTEMİ');

    const reset = await admin('DELETE', '/api/admin/prompts/writer_system');
    assert.equal(reset.prompt.customized, false); assert.match(Answer.system(skill, 'tr'), /writing assistant/);
    const actions = (await admin('GET', '/api/admin/audit')).entries.map(a => a.action);
    for (const wanted of ['prompt.updated', 'prompt.reset']) assert.ok(actions.includes(wanted), wanted);
    assert.doesNotMatch(JSON.stringify((await admin('GET', '/api/admin/audit')).entries), /ÖZEL ÇERÇEVE/);
  } finally { await h.close(); }
});

test('skills: edit a file skill, hide and restore it, create and delete a panel skill', async () => {
  const h = await harness();
  try {
    const admin = await h.adminClient(), user = await h.register('can');
    const Skills = require('../lib/writer-skills.cjs');
    assert.equal((await user('GET', '/api/admin/skills')).status, 403);
    const listed = await admin('GET', '/api/admin/skills');
    assert.equal(listed.status, 200); assert.ok(listed.skills.some(s => s.name === 'giris-yaz' && s.origin === 'file'));

    const body = { title: 'Yeni skill', description: 'Açıklama', instruction: 'Kısa bir paragraf yaz.', keywords: 'deneme, örnek', needsSources: false };
    assert.equal((await admin('POST', '/api/admin/skills', { ...body, name: 'Kotu Ad' })).status, 400);
    assert.equal((await admin('POST', '/api/admin/skills', { ...body, name: 'giris-yaz' })).status, 409);
    assert.equal((await admin('POST', '/api/admin/skills', { ...body, name: 'deneme-skill', minPlan: 'yok' })).status, 400);
    const created = await admin('POST', '/api/admin/skills', { ...body, name: 'deneme-skill' });
    assert.equal(created.status, 201, JSON.stringify(created)); assert.equal(created.skill.origin, 'custom'); assert.deepEqual(created.skill.keywords, ['deneme', 'örnek']);
    assert.equal(Skills.load().skills.find(s => s.name === 'deneme-skill').needsSources, false, 'a new skill is used at once');
    assert.equal((await admin('DELETE', '/api/admin/skills/deneme-skill')).hidden, false);
    assert.ok(!Skills.load().skills.some(s => s.name === 'deneme-skill'));

    const original = Skills.load().skills.find(s => s.name === 'giris-yaz').instruction;
    const edited = await admin('PUT', '/api/admin/skills/giris-yaz', { title: 'Giriş (özel)', instruction: 'ÖZEL TALİMAT', keywords: ['giriş'] });
    assert.equal(edited.skill.origin, 'edited');
    assert.equal(Skills.load().skills.find(s => s.name === 'giris-yaz').instruction, 'ÖZEL TALİMAT');
    assert.equal((await admin('GET', '/api/admin/skills')).skills.find(s => s.name === 'giris-yaz').fileInstruction, original);
    await admin('POST', '/api/admin/skills/giris-yaz/reset');
    assert.equal(Skills.load().skills.find(s => s.name === 'giris-yaz').instruction, original, 'back to the file version');

    assert.equal((await admin('DELETE', '/api/admin/skills/giris-yaz')).hidden, true);
    assert.ok(!Skills.load().skills.some(s => s.name === 'giris-yaz'));
    assert.equal((await admin('GET', '/api/admin/skills')).skills.find(s => s.name === 'giris-yaz').origin, 'hidden');
    await admin('POST', '/api/admin/skills/giris-yaz/reset');
    assert.ok(Skills.load().skills.some(s => s.name === 'giris-yaz'), 'restored');
    assert.equal((await admin('DELETE', '/api/admin/skills/genel')).status, 400, 'the default skill stays');
    assert.equal((await admin('DELETE', '/api/admin/skills/yok-boyle')).status, 404);

    const actions = (await admin('GET', '/api/admin/audit')).entries.map(a => a.action);
    for (const wanted of ['skill.created', 'skill.updated', 'skill.removed', 'skill.reset']) assert.ok(actions.includes(wanted), wanted);
  } finally { await h.close(); }
});
