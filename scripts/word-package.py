"""Bounded DOCX inspection and targeted OOXML edits. JSON transport via stdin."""
import sys, json, io, zipfile, base64, re, copy
import xml.etree.ElementTree as ET
sys.stdin.reconfigure(encoding='utf-8')

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
    if len(data) > 20 * 1024 * 1024: raise ValueError('DOCX en fazla 20 MB olabilir.')
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

def main():
    request = json.load(sys.stdin)
    data = base64.b64decode(request['data'], validate=True)
    if request['operation'] == 'pdf':
        from pypdf import PdfReader
        if len(data) > 20*1024*1024: raise ValueError('PDF boyut sınırı aşıldı.')
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted or len(reader.pages) > 500: raise ValueError('Şifreli veya çok büyük PDF.')
        pages = [{'location': 'Sayfa '+str(i+1), 'text': page.extract_text() or ''} for i, page in enumerate(reader.pages)]
        if sum(len(p['text']) for p in pages) > 2000000: raise ValueError('PDF metin sınırını aşıyor.')
        print(json.dumps({'passages': pages}, ensure_ascii=True)); return
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
        print(json.dumps({'paragraphs': ps, 'warnings': ['Üstbilgi/altbilgi taranmaz. Sayısal atıflar kapsam dışıdır. Alan kodları ve izlenen değişiklikler yalnız raporlanır.']}, ensure_ascii=True))
    elif request['operation'] == 'export':
        print(json.dumps({'data': base64.b64encode(apply(z, request['patches'])).decode('ascii')}))

if __name__ == '__main__':
    try: main()
    except Exception as e:
        print(json.dumps({'error': str(e) if isinstance(e, ValueError) else 'Dosya işlenemedi; biçimi veya bütünlüğünü kontrol edin.'})); sys.exit(1)
