import io, zipfile, json, base64
W='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
document=f'''<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="{W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Giriş</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>İlk cümle. İkinci cümle. Üçüncü cümle. Bulgular (Yılmaz, </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>2019</w:t></w:r><w:r><w:t>) ile uyumludur.</w:t></w:r></w:p>
<w:p><w:r><w:t>Kaya (2021) farklı bir bulgu raporladı. (Demir, 2022) kaynakçada yok.</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Tablo (Yılmaz, 2020).</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>ADDIN ZOTERO_ITEM</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>(Yılmaz, 2018)</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
<w:p><w:r><w:drawing/></w:r><w:r><w:t>Resim korunmalı.</w:t></w:r></w:p>
<w:p><w:r><w:t>Kaynakça</w:t></w:r></w:p>
<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:t>Yılmaz, A. (2020). Örnek araştırma. Dergi, 2, 1–9.</w:t></w:r></w:p>
<w:p><w:r><w:t>Kaya, B. (2021). Diğer araştırma. Dergi, 3, 1–5.</w:t></w:r></w:p>
<w:p><w:r><w:t>Ak, C. (2023). Atıfsız yayın. Dergi, 4, 5–8.</w:t></w:r></w:p>
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
