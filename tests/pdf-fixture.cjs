// Minimal text PDF writer for tests: each page is a list of [x, y, text] lines in Helvetica (WinAnsi).
function makePdf(pages) {
  const objects = [];
  const add = body => (objects.push(body), objects.length);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const pagesId = add(null);
  const kids = [];
  for (const lines of pages) {
    const escape = text => text.replace(/[\\()]/g, m => '\\' + m);
    const stream = lines.map(([x, y, text]) => `BT /F1 11 Tf ${x} ${y} Td (${escape(text)}) Tj ET`).join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map(k => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => { const at = Buffer.byteLength(out, 'latin1'); out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// A two-page manuscript: running header, page numbers, a paragraph crossing the page break,
// a hyphenated line end and a hanging-indent bibliography.
function manuscript() {
  const header = n => [[72, 800, 'Journal of Testing Studies 12(3) 2024']];
  const footer = n => [[290, 40, String(n)]];
  const page1 = [
    ...header(1),
    [72, 760, 'Introduction'],
    [72, 730, 'Online learning has been studied widely in recent years and self-regulation is'],
    [72, 715, 'reported as a key predictor of achievement (Smith, 2020). Motivation also matters'],
    [72, 700, 'for persistence in distance education according to Brown and Green (2019).'],
    [72, 670, 'A second paragraph describes the method in detail and reports the inter-'],
    [72, 655, 'national sample that was drawn from several universities across the region'],
    [72, 640, 'and it continues on the next page because the page ends here while the'],
    ...footer(1),
  ];
  const page2 = [
    ...header(2),
    [72, 760, 'sentence is still running (Lee, 2021).'],
    [72, 730, 'References'],
    [72, 700, 'Brown, A., & Green, B. (2019). Motivation and persistence in distance education:'],
    [90, 685, 'A longitudinal study. Journal of Online Learning, 10(2), 1-20.'],
    [72, 665, 'Lee, C. (2021). Self-regulated learning in international samples. Computers'],
    [90, 650, 'and Education, 45, 100-115. https://doi.org/10.1000/test.2021.1'],
    [72, 630, 'Smith, D. (2020). Predictors of achievement in online courses. Learning and'],
    [90, 615, 'Instruction, 30(4), 55-70.'],
    ...footer(2),
  ];
  return makePdf([page1, page2]);
}

module.exports = { makePdf, manuscript };
