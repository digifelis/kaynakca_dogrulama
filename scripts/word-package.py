"""Bounded DOCX inspection and targeted OOXML edits. JSON transport via stdin."""
import sys, json, io, zipfile, base64, re, copy
import xml.etree.ElementTree as ET
sys.stdin.reconfigure(encoding='utf-8')

LIMIT = 20 * 1024 * 1024
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
ET.register_namespace('w', W[1:-1])
ET.register_namespace('r', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
def read_xml(data):
    if re.search(br'<!DOCTYPE|<!ENTITY', data, re.I):
        raise ValueError('XML dış varlıkları desteklenmiyor.')
    for _, pair in ET.iterparse(io.BytesIO(data), events=['start-ns']):
        prefix, uri = pair
        if not re.match(r'ns\d+$', prefix):
            ET.register_namespace(prefix, uri)
    return ET.fromstring(data)

def package(data):
    if len(data) > LIMIT: raise ValueError('DOCX en fazla %d MB olabilir.' % (LIMIT // 1024 // 1024))
    z = zipfile.ZipFile(io.BytesIO(data))
    infos = z.infolist()
    if len(infos) > 2500 or sum(i.file_size for i in infos) > 80 * 1024 * 1024:
        raise ValueError('Açılmış Word paketi boyut sınırını aşıyor.')
    names = [i.filename for i in infos]
    if len(names) != len(set(names)): raise ValueError('Yinelenen paket parçaları.')
    if any('..' in n.split('/') or n.startswith('/') or '\\' in n for n in names): raise ValueError('Geçersiz ZIP yolu.')
    if any(i.flag_bits & 1 for i in infos): raise ValueError('Şifreli belgeler desteklenmiyor.')
    if any('vbaProject' in n for n in names): raise ValueError('Makrolu belgeler desteklenmiyor.')
    if 'word/document.xml' not in names: raise ValueError('Geçerli DOCX değil.')
    return z

def mapping(z):
    out, trees = [], {}
    total_text = 0
    for part in ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml']:
        if part not in z.namelist(): continue
        root = read_xml(z.read(part)); trees[part] = root
        parents = {c: parent for parent in root.iter() for c in parent}
        indexes = {n: i for i,n in enumerate(root.iter())}
        field_depth = 0
        for index, p in enumerate(root.iter(W+'p')):
            nodes = list(p.iter())
            protected = field_depth > 0
            for n in nodes:
                if n.tag == W+'fldChar':
                    protected = True
                    kind = n.get(W+'fldCharType')
                    if kind == 'begin': field_depth += 1
                    elif kind == 'end': field_depth = max(0, field_depth - 1)
            protected |= any(n.tag in {W+'fldSimple', W+'instrText', W+'del', W+'ins', W+'sdt', W+'drawing', W+'object'} for n in nodes)
            # Ancestor content controls and tracked changes are not editable either.
            ancestor = parents.get(p)
            group = part
            while ancestor is not None:
                if ancestor.tag in {W+'sdt', W+'ins', W+'del'}: protected = True
                if ancestor.tag in {W+'tc', W+'footnote', W+'endnote'} and group == part:
                    group = part + ':' + str(indexes[ancestor])
                ancestor = parents.get(ancestor)
            text = ''.join(n.text or '' if n.tag == W+'t' else '\t' if n.tag == W+'tab' else '\n' if n.tag in {W+'br', W+'cr'} else '' for n in nodes)
            total_text += len(text)
            if len(out) >= 25000 or total_text > 2000000: raise ValueError('Belge metin/paragraf sınırını aşıyor.')
            style = p.find('./'+W+'pPr/'+W+'pStyle')
            paragraph_locked = any(n.tag in {W+'bookmarkStart', W+'bookmarkEnd', W+'commentRangeStart', W+'commentRangeEnd', W+'footnoteReference', W+'endnoteReference', W+'hyperlink'} for n in nodes)
            out.append({'id': part+':'+str(index), 'part': part, 'index': index, 'text': text, 'protected': bool(protected), 'paragraphLocked': paragraph_locked, 'group': group,
                        'style': style.get(W+'val', '') if style is not None else ''})
    return out, trees

def char_offset(text, utf16):
    return len(text.encode('utf-16-le')[:utf16*2].decode('utf-16-le'))

def apply(z, patches):
    paragraphs, trees = mapping(z)
    by_id = {p['id']: p for p in paragraphs}
    groups = {}
    for patch in patches:
        info = by_id.get(patch['paragraph'])
        if not info or info['protected']: raise ValueError('Korunan veya bulunamayan paragraf değiştirilemez.')
        groups.setdefault(patch['paragraph'], []).append(patch)
    changed = set()
    for pid, edits in groups.items():
        info = by_id[pid]; p = list(trees[info['part']].iter(W+'p'))[info['index']]
        text = info['text']
        ranges = []
        for e in edits:
            start, end = char_offset(text, e['start']), char_offset(text, e['end'])
            if text[start:end] != e['original']: raise ValueError('Düzeltme konumu değişmiş; yeniden denetleyin.')
            ranges.append((start, end, e))
        ranges.sort(reverse=True, key=lambda v: v[0])
        for left, right in zip(ranges, ranges[1:]):
            if right[1] > left[0]: raise ValueError('Örtüşen düzeltmeler uygulanamaz.')
        for start, end, e in ranges:
            if e.get('whole'):
                if e.get('paragraphEdit') and (info['group'] != 'word/document.xml' or info['paragraphLocked']):
                    raise ValueError('Bu paragraf yalnız okunabilir.')
                if start != 0 or end != len(text) or len(edits) != 1: raise ValueError('Kaynakça aralığı geçersiz.')
                if any(n.tag in {W+'bookmarkStart', W+'bookmarkEnd', W+'commentRangeStart', W+'footnoteReference', W+'endnoteReference'} for n in p.iter()):
                    raise ValueError('İşaretli kaynakça yalnız raporlanabilir.')
                first = next(iter(p.iter(W+'r')), None)
                props = first.find(W+'rPr') if first is not None else None
                for child in list(p):
                    if child.tag != W+'pPr': p.remove(child)
                for span in e.get('spans') or [{'text': e['replacement'], 'italic': False}]:
                    run = ET.SubElement(p, W+'r'); rp = copy.deepcopy(props) if props is not None else ET.Element(W+'rPr')
                    for n in list(rp):
                        if not e.get('paragraphEdit') and n.tag in {W+'i', W+'iCs'}: rp.remove(n)
                    if span.get('italic'): ET.SubElement(rp, W+'i')
                    if len(rp): run.append(rp)
                    for piece in re.split(r'(\t|\n)', span['text']):
                        if piece == '\t': ET.SubElement(run, W+'tab')
                        elif piece == '\n': ET.SubElement(run, W+'br')
                        else:
                            t = ET.SubElement(run, W+'t'); t.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve'); t.text = piece
            else:
                offset = 0; inserted = False
                for t in p.iter():
                    if t.tag in {W+'tab', W+'br', W+'cr'}:
                        if start <= offset < end: raise ValueError('Düzeltme sekme/satır sonunu kapsayamaz; metin aralığını seçin.')
                        offset += 1
                        continue
                    if t.tag != W+'t': continue
                    value = t.text or ''; stop = offset + len(value)
                    if stop > start and offset < end:
                        a, b = max(0, start-offset), min(len(value), end-offset)
                        t.text = value[:a] + (e['replacement'] if not inserted else '') + value[b:]
                        t.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve'); inserted = True
                    offset = stop
                if not inserted: raise ValueError('Atıf metin aralığı bulunamadı.')
        changed.add(info['part'])
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as result:
        for info in z.infolist():
            data = z.read(info.filename)
            if info.filename in changed:
                serialized = ET.tostring(trees[info.filename], encoding='utf-8', xml_declaration=True)
                # mc:Ignorable and QName attributes can reference unused namespaces.
                # ElementTree omits those declarations unless explicitly restored.
                source_root = re.search(br'<(?!\?)[^>]+>', data).group(0)
                target_root = re.search(br'<(?!\?)[^>]+>', serialized).group(0)
                missing = b''
                for declaration in re.findall(br'\s+xmlns(?::[A-Za-z0-9_-]+)?\s*=\s*["\'][^"\']*["\']', source_root):
                    name = declaration.strip().split(b'=')[0].strip()
                    if not re.search(rb'\s'+re.escape(name)+rb'\s*=', target_root): missing += declaration
                serialized = serialized.replace(target_root, target_root[:-1]+missing+b'>', 1)
                read_xml(serialized)
                data = serialized
            result.writestr(info, data)
    package(output.getvalue())
    return output.getvalue()

REF_HEADING = re.compile(r'^(?:\d+[.)]?\s*)?(kaynakça|kaynaklar|references|bibliography|works cited)\s*[:.]?$', re.I)
END_HEADING = re.compile(r'^(?:ekler|ek\s*\d*|appendix|appendices)\b', re.I)
PAGE_NUMBER = re.compile(r'^(?:sayfa|page|s\.)?\s*\d{1,4}(?:\s*(?:/|of|-|–)\s*\d{1,4})?$', re.I)
ENTRY_YEAR = re.compile(r'\(\s*(?:1[89]|20)\d{2}[a-z]?\s*[,)]|\(\s*(?:t\.\s*y\.|n\.\s*d\.)\s*\)', re.I)
URLISH = re.compile(r'(?:https?://|doi\.org/|\b10\.\d{4,9}/)\S*$', re.I)

def entry_start(line):
    # "Yılmaz, A.", "van Dijk, T.", "World Health Organization. (2020)", "[12]", "12."
    if re.match(r'^(?:\[\d{1,3}\]|\d{1,3}\.)\s+\S', line): return True
    first = line[:1]
    if not first or not (first.isupper() or line[:4].lower() in ('van ', 'von ', 'de l', 'van-')): return False
    if re.match(r"^[^\W\d_][\w'’\-]*(?:\s+[^\W\d_][\w'’\-]*){0,3},\s*(?:[^\W\d_]{1,3}\.|[^\W\d_]+[,.])", line): return True
    return bool(ENTRY_YEAR.search(line[:160]))

def join_lines(text, line):
    if not text: return line
    if text.endswith('-') and len(text) > 1 and text[-2].isalpha() and line[:1].islower() and not URLISH.search(text):
        return text[:-1] + line
    if URLISH.search(text) and not text.endswith(('.', ',', ')')) and not line[:1].isupper():
        return text + line
    return text + ' ' + line

def pdf_lines(reader):
    """Visual lines in reading order as (page, indent, text); layout mode keeps word spacing and indentation."""
    import unicodedata
    pages = []
    for page in reader.pages:
        try: text = page.extract_text(extraction_mode='layout') or ''
        except Exception: text = page.extract_text() or ''
        text = unicodedata.normalize('NFKC', text).replace('\u00ad', '')
        rows = []
        for raw in text.split('\n'):
            raw = raw.replace('\u00a0', ' ').replace('\t', ' ').rstrip()
            stripped = raw.lstrip()
            rows.append((len(raw) - len(stripped), re.sub(r' {2,}', ' ', stripped)))
        while rows and not rows[-1][1]: rows.pop()
        while rows and not rows[0][1]: rows.pop(0)
        pages.append(rows)
    return pages

def pdf_paragraphs(data):
    from pypdf import PdfReader
    if len(data) > LIMIT: raise ValueError('PDF en fazla %d MB olabilir.' % (LIMIT // 1024 // 1024))
    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        try: ok = reader.decrypt('')
        except Exception: ok = 0
        if not ok: raise ValueError('Şifreli PDF desteklenmiyor; şifresiz bir kopya yükleyin.')
    if len(reader.pages) > 500: raise ValueError('PDF en fazla 500 sayfa olabilir.')
    pages = pdf_lines(reader)
    total = sum(len(t) for p in pages for _, t in p)
    if total > 2000000: raise ValueError('PDF metin sınırını aşıyor.')
    if total < 200: raise ValueError('PDF’de okunabilir metin katmanı yok; taranmış belgeler için önce OCR uygulayın.')
    # Running headers/footers repeat near the page edges on most pages; page numbers are dropped too.
    key = lambda t: re.sub(r'\d+', '#', t.lower())
    seen = {}
    for p in pages:
        body = [t for _, t in p if t]
        for k in {key(t) for t in body[:2] + body[-2:]}: seen[k] = seen.get(k, 0) + 1
    repeated = {k for k, c in seen.items() if len(pages) >= 2 and c >= max(2, len(pages) * 0.3)}
    lines = []
    for n, p in enumerate(pages):
        body = [t for _, t in p if t]
        edges = set(body[:2] + body[-2:])
        for indent, t in p:
            if t and t in edges and (key(t) in repeated or PAGE_NUMBER.match(t)): continue
            lines.append((n + 1, indent, t))
    widths = sorted(len(t) for _, _, t in lines if len(t) > 25)
    full = widths[int(len(widths) * 0.75)] if widths else 80
    indents = [i for _, i, t in lines if len(t) > 25]
    base = max(set(indents), key=indents.count) if indents else 0
    # Bibliography layout: with hanging indentation, continuation lines sit further right than entry starts.
    ref_base, hanging, counts = {}, {}, {}
    section = None
    for idx, (_, indent, t) in enumerate(lines):
        if REF_HEADING.match(t): section = idx; ref_base[section] = None; counts[section] = [0, 0]; continue
        if section is None or not t: continue
        if END_HEADING.match(t) and len(t) < 60: section = None; continue
        if ref_base[section] is None: ref_base[section] = indent
        counts[section][0] += 1
        if indent > ref_base[section] + 2: counts[section][1] += 1
    for key_, (all_, deeper) in counts.items(): hanging[key_] = all_ >= 4 and 0.25 <= deeper / all_ <= 0.85
    out, current, page_of, in_refs, section, previous = [], '', 1, False, None, ''
    def emit(style=''):
        nonlocal current
        text = current.strip()
        if text:
            if len(out) >= 25000: raise ValueError('Belge paragraf sınırını aşıyor.')
            out.append({'id': 'pdf:' + str(len(out)), 'part': 'word/document.xml', 'index': len(out), 'text': text, 'protected': False,
                        'paragraphLocked': True, 'group': 'word/document.xml', 'style': style, 'page': page_of})
        current = ''
    for idx, (page, indent, line) in enumerate(lines):
        if not line:
            # Vertical gaps end a block unless the text stops mid-sentence (page or column flow).
            if in_refs: done = not hanging.get(section) and bool(ENTRY_YEAR.search(current))
            else: done = bool(re.search(r'[.!?:"”)\]]$', previous)) or bool(previous and len(previous) < full * 0.72 and not re.search(r'[,;]$', previous))
            if done: emit(); previous = ''
            continue
        short_prev = bool(previous) and len(previous) < full * 0.72
        if REF_HEADING.match(line):
            emit(); page_of = page; current = line; emit('Heading'); in_refs, section, previous = True, idx, ''; continue
        if in_refs and END_HEADING.match(line) and len(line) < 60:
            emit(); page_of = page; current = line; emit('Heading'); in_refs, previous = False, ''; continue
        if in_refs:
            start = ref_base.get(section)
            if hanging.get(section): new_entry = current and start is not None and indent <= start + 1
            else: new_entry = current and entry_start(line) and (short_prev or ENTRY_YEAR.search(current) or re.match(r'^(?:\[\d|\d+\.)', line)) and not (re.search(r'(?:,|&|\band|\bve)$', previous) and not URLISH.search(current.rstrip(',')))
            if new_entry: emit()
        elif current:
            ends = re.search(r'[.!?:;"”’)\]]$', previous)
            indented = indent > base + 2 and len(line) > 25
            if short_prev and (ends or not re.search(r'[,;]$', previous)) or ends and indented: emit()
        if not current: page_of = page
        current = join_lines(current, line)
        previous = line
    emit()
    for p in out: p['text'] = tidy(p['text'])
    return out

def tidy(text):
    # Layout extraction inserts stray spaces from glyph gaps: "(202 5)", "(2026 b)", "( Fedus", "feed -forward".
    text = re.sub(r'\b((?:19|20)\d) (\d)\b', r'\1\2', text)
    text = re.sub(r'\b((?:19|20)\d{2}) ([a-z])\b(?=[)\s,;])', r'\1\2', text)
    text = re.sub(r'\(\s+', '(', text)
    text = re.sub(r'\s+\)', ')', text)
    text = re.sub(r'(?<=[^\W\d_]) -(?=[^\W\d_])', '-', text)
    return text

def core_properties(z):
    """Title/author from docProps/core.xml; empty strings when absent."""
    try:
        root = read_xml(z.read('docProps/core.xml'))
    except Exception:
        return {}
    pick = lambda name: next((''.join(n.itertext()).strip() for n in root.iter() if n.tag.split('}')[-1] == name), '')
    return {'title': pick('title')[:300], 'author': pick('creator')[:300]}

def pdf_info(data):
    try:
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        meta = reader.metadata or {}
        return {'title': str(meta.get('/Title') or '')[:300], 'author': str(meta.get('/Author') or '')[:300], 'pages': len(reader.pages)}
    except Exception:
        return {}

def build_docx(blocks):
    """Minimal DOCX from [{type: h1|h2|h3|p|li|ol, runs: [{text, bold, italic}]}]."""
    esc = lambda t: t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    if len(blocks) > 5000: raise ValueError('Makale blok sınırını aşıyor.')
    styles = {'h1': 'Heading1', 'h2': 'Heading2', 'h3': 'Heading3'}
    body = []
    for b in blocks:
        kind = b.get('type', 'p')
        ppr = ''
        prefix = ''
        if kind in styles: ppr = '<w:pPr><w:pStyle w:val="%s"/></w:pPr>' % styles[kind]
        elif kind == 'li': prefix = '• '; ppr = '<w:pPr><w:ind w:left="567" w:hanging="283"/></w:pPr>'
        elif kind == 'ol': ppr = '<w:pPr><w:ind w:left="567" w:hanging="283"/></w:pPr>'
        elif kind == 'ref': ppr = '<w:pPr><w:ind w:left="567" w:hanging="567"/></w:pPr>'
        runs = ''
        if prefix: runs += '<w:r><w:t xml:space="preserve">%s</w:t></w:r>' % prefix
        for r in b.get('runs', []):
            text = str(r.get('text', ''))
            if not text: continue
            rpr = ('<w:b/>' if r.get('bold') else '') + ('<w:i/>' if r.get('italic') else '')
            rpr = '<w:rPr>%s</w:rPr>' % rpr if rpr else ''
            runs += '<w:r>%s<w:t xml:space="preserve">%s</w:t></w:r>' % (rpr, esc(text))
        body.append('<w:p>%s%s</w:p>' % (ppr, runs))
    ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document %s><w:body>%s<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>' % (ns, ''.join(body))
    def style(sid, name, size, bold):
        return '<w:style w:type="paragraph" w:styleId="%s"><w:name w:val="%s"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr>%s<w:sz w:val="%d"/></w:rPr></w:style>' % (sid, name, '<w:b/>' if bold else '', size)
    styles_xml = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles %s>'
        '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/></w:rPr></w:rPrDefault>'
        '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>%s%s%s</w:styles>') % (
        ns, style('Heading1', 'heading 1', 32, True), style('Heading2', 'heading 2', 28, True), style('Heading3', 'heading 3', 26, True))
    content_types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    doc_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', content_types); z.writestr('_rels/.rels', rels)
        z.writestr('word/document.xml', document); z.writestr('word/styles.xml', styles_xml); z.writestr('word/_rels/document.xml.rels', doc_rels)
    return out.getvalue()

def main():
    global LIMIT
    request = json.load(sys.stdin)
    # The writing assistant raises the limit to the user's plan; word checks keep the 20 MB default.
    LIMIT = min(max(int(request.get('limit') or LIMIT), 1), 200 * 1024 * 1024)
    data = base64.b64decode(request['data'], validate=True)
    if request['operation'] == 'pdf':
        from pypdf import PdfReader
        if len(data) > 20*1024*1024: raise ValueError('PDF boyut sınırı aşıldı.')
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted or len(reader.pages) > 500: raise ValueError('Şifreli veya çok büyük PDF.')
        pages = [{'location': 'Sayfa '+str(i+1), 'text': page.extract_text() or ''} for i, page in enumerate(reader.pages)]
        if sum(len(p['text']) for p in pages) > 2000000: raise ValueError('PDF metin sınırını aşıyor.')
        print(json.dumps({'passages': pages}, ensure_ascii=True)); return
    if request['operation'] == 'inspect_pdf':
        if not data.startswith(b'%PDF-'): raise ValueError('Geçerli PDF değil.')
        print(json.dumps({'metadata': pdf_info(data), 'paragraphs': pdf_paragraphs(data), 'warnings': ['PDF metni sayfa düzeninden yeniden kurulur; paragraf ve kaynakça sınırları sezgiseldir, gerekirse kaynakça bölümünü elle seçin. Üstbilgi, altbilgi ve sayfa numaraları ayıklanır; tablo ve dipnot yapısı korunmaz. Düzeltmeler PDF dosyasına yazılamaz; denetim raporunu indirebilirsiniz.']}, ensure_ascii=True)); return
    if request['operation'] == 'build_docx':
        print(json.dumps({'data': base64.b64encode(build_docx(request['blocks'])).decode('ascii')})); return
    if request['operation'] == 'xml':
        root = read_xml(data)
        for parent in root.iter():
            for c in list(parent):
                if c.tag.split('}')[-1] in {'ref-list', 'back'}: parent.remove(c)
        title = next((''.join(n.itertext()) for n in root.iter() if n.tag.split('}')[-1] == 'article-title'), '')
        passages = [{'location': 'Paragraf '+str(i+1), 'text': ''.join(n.itertext())} for i,n in enumerate(root.iter()) if n.tag.split('}')[-1] == 'p']
        print(json.dumps({'title': title, 'passages': passages}, ensure_ascii=True)); return
    z = package(data)
    if request['operation'] == 'inspect':
        ps, _ = mapping(z)
        print(json.dumps({'metadata': core_properties(z), 'paragraphs': ps, 'warnings': ['Üstbilgi/altbilgi taranmaz. Sayısal atıflar kapsam dışıdır. Alan kodları ve izlenen değişiklikler yalnız raporlanır.']}, ensure_ascii=True))
    elif request['operation'] == 'export':
        print(json.dumps({'data': base64.b64encode(apply(z, request['patches'])).decode('ascii')}))

if __name__ == '__main__':
    try: main()
    except Exception as e:
        print(json.dumps({'error': str(e) if isinstance(e, ValueError) else 'Dosya işlenemedi; biçimi veya bütünlüğünü kontrol edin.'})); sys.exit(1)
