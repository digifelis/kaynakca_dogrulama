// The Python workers are reused between requests: same answers, errors do not kill them, recycling and fallback work.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makePdf } = require('./pdf-fixture.cjs');

const L = (...t) => t.map((x, i) => [72, 760 - i * 16, x]);
const PDF = makePdf([[...L('Digital transformation in higher education', 'Digital learning platforms increased student engagement in universities during the pandemic years and this effect remained stable.', 'Student engagement was strongly related to the quality of feedback that learners received from their instructors in all courses.')]]).toString('base64');
const fresh = () => { delete require.cache[require.resolve('../lib/python.cjs')]; return require('../lib/python.cjs'); };

test('pooled workers give the same answers as one process per request, in parallel and in turn', async () => {
  const pooled = fresh(); process.env.PYTHON_POOL = '2';
  try {
    const first = await pooled.python({ operation: 'inspect_pdf', data: PDF });
    const parallel = await Promise.all(Array.from({ length: 6 }, () => pooled.python({ operation: 'inspect_pdf', data: PDF })));
    assert.ok(parallel.every(r => JSON.stringify(r.paragraphs) === JSON.stringify(first.paragraphs)));
    process.env.PYTHON_POOL = '0';
    assert.deepEqual((await pooled.python({ operation: 'inspect_pdf', data: PDF })).paragraphs, first.paragraphs, 'one-shot mode answers the same');
  } finally { delete process.env.PYTHON_POOL; pooled.stop(); }
});

test('a rejected file does not break the worker; the next request is answered', async () => {
  const pooled = fresh(); process.env.PYTHON_POOL = '1';
  try {
    await assert.rejects(pooled.python({ operation: 'inspect_pdf', data: Buffer.from('bu bir pdf değil').toString('base64') }), /Geçerli PDF değil/);
    await assert.rejects(pooled.python({ operation: 'bilinmeyen', data: PDF }), /işlenemedi|tamamlanamadı/);
    assert.equal((await pooled.python({ operation: 'inspect_pdf', data: PDF })).paragraphs.length >= 1, true);
    // a per-request size limit does not leak into the next request
    await assert.rejects(pooled.python({ operation: 'inspect_pdf', data: PDF, limit: 10 }), /en fazla|sınır|MB/i);
    assert.equal((await pooled.python({ operation: 'inspect_pdf', data: PDF })).paragraphs.length >= 1, true);
  } finally { delete process.env.PYTHON_POOL; pooled.stop(); }
});

test('workers are replaced after PYTHON_RECYCLE requests, and a missing Python reports the usual error', async () => {
  const pooled = fresh(); process.env.PYTHON_POOL = '1'; process.env.PYTHON_RECYCLE = '2';
  try {
    for (let i = 0; i < 5; i++) assert.ok((await pooled.python({ operation: 'inspect_pdf', data: PDF })).paragraphs.length >= 1);
  } finally { delete process.env.PYTHON_RECYCLE; pooled.stop(); }
  const broken = fresh(); process.env.WORD_PYTHON = 'bu-python-yok-xyz';
  try { await assert.rejects(broken.python({ operation: 'inspect_pdf', data: PDF }), /Python/); }
  finally { delete process.env.WORD_PYTHON; delete process.env.PYTHON_POOL; broken.stop(); }
});
