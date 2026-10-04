import io, zipfile, json, base64
W='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
document=f'''<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="{W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Giriş</w:t></w:r></w:p>
<w:p><w:r><w:t>Önceki çalışmalar [1], [3] ve [1,2,3] gösterdi. Ayrıca [5] ile [7, s. 12] de benzer sonuçlara ulaştı.</w:t></w:r></w:p>
<w:p><w:r><w:t>Kaynakça</w:t></w:r></w:p>
<w:p><w:r><w:t>1. Zhang K, Lee MJ. Mapping destination images from photos. Asia Pac J Tour Res. 2020;25(11):1199-214.</w:t></w:r></w:p>
<w:p><w:r><w:t>2. Smith J. Another study of things. J Stuff. 2019;1(2):3-4.</w:t></w:r></w:p>
<w:p><w:r><w:t>3. Kaya A, Demir B, Çelik C, Aydın D. Dört yazarlı bir çalışma başlığı. Dergi X. 2018;5:10-20.</w:t></w:r></w:p>
<w:p><w:r><w:t>5. Yılmaz E. Beşinci kayıt burada. Dergi Y. 2017;2:1-2.</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>'''
out=io.BytesIO()
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
    z.writestr('word/document.xml',document)
    z.writestr('[Content_Types].xml','''<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>''')
    z.writestr('_rels/.rels','''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>''')
    z.writestr('word/footnotes.xml',f'<w:footnotes xmlns:w="{W}"><w:footnote w:id="1"><w:p><w:r><w:t>Not (Kaya, 2021).</w:t></w:r></w:p></w:footnote></w:footnotes>')
    z.writestr('word/media/preserved.bin',b'unchanged-image-bytes')
    z.writestr('customXml/item1.xml','<metadata>Preserve me</metadata>')
print(json.dumps({'data':base64.b64encode(out.getvalue()).decode()}))
