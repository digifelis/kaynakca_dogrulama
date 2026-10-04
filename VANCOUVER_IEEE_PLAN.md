# Vancouver ve IEEE atıf stili desteği — geliştirme planı

Durum: uygulandı (2026-10-04). Aşama 1-6'nın tamamı yapıldı; testler `tests/citation-styles.test.cjs`, `tests/numbered-styles.test.cjs`.

Plandan sapmalar:
- **Dergi kısaltması:** NLM Catalog sorgusu yapılmadı. Önce Crossref'in `short-container-title` alanı, yoksa ISO 4 benzeri sözcük tablosu kullanılıyor; kural ile üretilen kısaltma kaynakçada "kontrol edin" notuyla işaretleniyor, bilinmeyen sözcükler tahmin edilmiyor.
- **Stil, doğrulama sonucuna gömülmez:** Sonuçlar yapılandırılmış kayıtla (`matched`) saklanır, stil gösterim anında `ReferenceEngine.restyle` ile uygulanır. Bu yüzden önbellek stilden bağımsızdır ve stil değişince yeniden doğrulama gerekmez.
- **Sohbet cevapları** yazar–yıl biçiminde kalır; numaralama yalnız makale metninde ve kaynakçada yapılır.
- **Üst simge** ve parantezli `(1)` numaralar kapsam dışı.
- Kaynakça sayfasında stil seçimi tarayıcıda uygulanır (Vancouver/IEEE alanı arayüzde kilitlenir); sunucu yalnız yazım yardımcısı ve Word tarafında zorlar.

## Verilen kararlar

| Konu | Karar |
|---|---|
| Metin içi biçim | Köşeli ayraç: `[1]`. Aralık ve liste biçimleri aşağıda. Parantezli ve üst simge varsayılan değildir. |
| Yazar sınırı (Vancouver) | 3. Üçten fazla yazar varsa ilk 3 yazar listelenir ve `et al.` eklenir. Sınır tek bir sabitte tutulur (`VANCOUVER_AUTHOR_LIMIT = 3`). |
| Word denetimi | Bu kapsamda. Sayısal atıf denetimi eklenecek. |
| IEEE | Aynı kapsamda, Vancouver ile birlikte. Ortak sayısal atıf altyapısı kullanılır. |

## Mevcut durum

- `index.html:291-295` içindeki `#style-select` alanında "Vancouver (yakında)" ve "IEEE (yakında)" seçenekleri var. `app.js` bu değeri hiç okumuyor. Sistem fiilen yalnızca APA üretiyor.
- APA biçimlendirme `reference-engine.js` içinde (`apaParts`, `formatApa`, `formatApaHtml`, `crossrefApa`, satır 351-418). `verifyReference` sonuca yalnızca APA metnini gömüyor (satır 536-554).
- Yazım yardımcısında `writer-cite.js` içindeki `referenceEntry` ve `sourceLabel` APA'ya sabit. Künye önbelleği `meta.apa` / `meta.apaHtml` olarak tutuluyor (`lib/writer-meta.cjs:77`, `writer-service.cjs:315`). `{{c:docId@sayfa}}` belirteçleri stilden bağımsız.
- `word-analysis.cjs` içindeki `citationsIn` yalnızca yazar–yıl atıflarını tanıyor.
- `parseReference` içinde Vancouver biçimli girdi için kısmi destek var (satır 119-127).

## Hedef biçim kuralları

### Vancouver (NLM / ICMJE, yazar sınırı 3)

| Öğe | Kural |
|---|---|
| Yazar | `Soyad Başharfler`, noktasız ve boşluksuz: `Zhang K, Lee MJ, Park S, et al.` |
| Makale | `Yazarlar. Başlık. Dergi Kısaltması. Yıl;Cilt(Sayı):sayfalar. doi:...` |
| Başlık | Cümle biçimi, italik yok |
| Dergi | NLM kısaltması, noktasız, italik yok |
| Sayfa | Bitiş sayfası kısaltılır: `1199-214` |
| Kitap | `Yazar. Başlık. Baskı. Yer: Yayınevi; Yıl.` |
| Web | `Yazar. Başlık [Internet]. Yer: Yayıncı; Yıl [erişim tarihi]. Available from: URL` |
| Metin içi | `[1]`, aralık `[1-3]`, liste `[1,3,5]` |
| Liste sırası | İlk atıf sırasına göre |

### IEEE

| Öğe | Kural |
|---|---|
| Yazar | `A. B. Soyad` (başharf önce, noktalı). 6 yazara kadar hepsi, 6'dan fazlaysa ilk yazar + `et al.` |
| Makale | `Yazarlar, "Başlık," *Dergi Kısaltması*, vol. X, no. Y, pp. A–B, Ay. Yıl, doi: ...` |
| Başlık | Çift tırnak içinde, yayımlandığı büyük/küçük harf korunur |
| Dergi | Kısaltılmış, italik |
| Kitap | `A. Soyad, *Başlık*, baskı. Yer: Yayınevi, Yıl.` |
| Metin içi | `[1]`, aralık `[1]–[3]`, liste `[1], [3], [5]` |
| Liste sırası | İlk atıf sırasına göre, her girdi `[n]` ile başlar |

Sayfa atfı: Vancouver `[3, s. 12]`, IEEE `[3, p. 12]` (Türkçe belgede `s.`).

## Aşamalar

### Aşama 1 — Biçimlendirme çekirdeği (`reference-engine.js`)

1. `vancouverParts` ve `ieeeParts` ekle; `apaParts` ile aynı `{text, italic}` yapısını kullan. Vancouver'da italik yok, IEEE'de dergi ve kitap adı italik.
2. Yazar biçimleyicileri: Vancouver (`Soyad AB`, 3 sınırı), IEEE (`A. B. Soyad`, 6 sınırı), kurumsal (`literal`) yazarlar, Türkçe başharflar (İ/ı).
3. Sayfa aralığı yardımcıları: Vancouver kısaltması (`1199–1214` → `1199-214`), IEEE `pp. 1199–1214`. `e12345` ve `S45-S52` gibi özel durumlar dahil.
4. Dergi kısaltması kaynağı:
   - `fromCrossref` ve `fromOpenAlex` içine `shortContainerTitle` alanı eklenir (Crossref `short-container-title`).
   - Yoksa NLM Catalog (E-utilities) sorgulanır, sonuç önbelleğe alınır.
   - Yine bulunamazsa tam ad korunur ve kayıt "kısaltma doğrulanamadı" olarak işaretlenir.
5. Crossref yolu için (`crossrefApa` karşılığı) yapılandırılmış alanlardan Vancouver ve IEEE üretimi yazılır.
6. Tek giriş noktası: `formatItem(item, style)` ve `engine.styles = { apa, vancouver, ieee }`. Seçili stile göre düz metin ve HTML döner.
7. `verifyReference(reference, settings)` `settings.style` kabul eder; `corrected`, `correctedHtml`, `suggested`, `suggestedHtml` bu stile göre üretilir.
8. Girdi ayrıştırma: `splitReferences` ve `parseReference` numaralı önekleri (`1.`, `[1]`, `(1)`) ayıklar ve IEEE girdisini (`A. Soyad, "Başlık," ...`) tanır. Önek `firstAuthor` ve `title` tespitini bozmamalı.
9. Önbellek: `lib/cache-store.cjs` ve `lib/verification.cjs` biçimlenmiş metni mi yoksa yapılandırılmış kaydı mı saklıyor kontrol edilir. Biçimlenmiş metin saklanıyorsa önbellek anahtarına `style` eklenir veya yalnızca yapılandırılmış kayıt saklanır. Aksi halde APA önbelleği diğer stillere sızar.

### Aşama 2 — Kaynakça doğrulama arayüzü (`index.html`, `app.js`, `pages.js`)

1. `#style-select` değeri okunur ve doğrulama isteğine `style` olarak geçirilir. "(yakında)" ibareleri kaldırılır.
2. Çıktı ekranı Vancouver ve IEEE'de numaralı liste gösterir (`1.` / `[1]`). Sıra girişteki sırayla korunur.
3. "Kopyala" düğmesi numaraları ve IEEE italiklerini korur (mevcut zengin HTML + düz metin yedeği mantığı).
4. `index.html:6,34,339` ve `pages.js:3` içindeki sabit "APA 7" ifadeleri seçili stile göre dinamik yapılır.
5. Seçilen stil `localStorage`'da hatırlanır (hata yakalamalı, erişilemezse APA).

### Aşama 3 — Word/PDF atıf denetimi

`word-analysis.cjs` yazar–yıl mantığına bağlı. Sayısal atıf ayrı bir yol olarak eklenir, mevcut yol bozulmaz.

1. **Stil tespiti:** kaynakça `1.` / `[1]` ile başlıyorsa sayısal yol, değilse mevcut yazar–yıl yolu. Kullanıcı elle de seçebilir. Vancouver ve IEEE aynı sayısal yolu kullanır; fark yalnızca kaynakça biçimi doğrulamasındadır.
2. **`numericCitationsIn(p, references)`:** `[1]`, `[1,3]`, `[1, 3]`, `[1-3]`, `[1]–[3]`, `[1], [3]`, `[3, p. 12]` kalıplarını bulur ve aralıkları açar. Yanlış pozitifleri ele: `[sic]`, `[Internet]`, `[Şekil 2]`, köşeli ayraç içi formül ve sayı aralıkları, alıntı içi düzenleme notları.
3. **Üst simge:** varsayılan biçim köşeli ayraç olduğu için kapsam dışı. Üst simge numaralar tanınmaz ve kullanıcıya belirtilir. PDF'de de köşeli biçim desteklenir.
4. **Yeni bulgu türleri:**
   - Metindeki numaranın kaynakçada karşılığı yok.
   - Kaynakçada olup metinde hiç atıf yapılmamış kaynak.
   - İlk geçiş sırası bozuk (örn. `[3]` `[1]`'den önce geçiyor).
   - Numara boşluğu veya tekrarı.
   - Aralık gösterimi tutarsız (`[1,2,3]` yerine `[1-3]` / `[1]–[3]` önerisi).
   - Kaynakça girdisi seçili stile uymuyor (yazar sınırı, başharf biçimi, dergi kısaltması, sayfa biçimi).
5. `word-content.cjs` içerik denetimi atıf nesnesini `authors`/`year` ile tüketiyor. Sayısal atıfta bu alanlar numaranın gösterdiği kaynakça kaydından doldurulur; böylece "atıf bu cümleyi destekliyor mu" denetimi sayısal biçimde de çalışır.
6. `lib/reports.cjs` ve `word-app.js` yeni bulgu türlerini ve metinlerini gösterir. Rapor şablonu (`makale_denetim_raporu`) güncellenir.
7. Kota, kuyruk ve arşiv (`word-store.cjs`, `word-quota`) mantığı değişmez; yalnızca çözümlenen atıf yapısı genişler.

### Aşama 4 — Yazım yardımcısı

1. Her taslağa `citationStyle` ayarı eklenir (`apa` | `vancouver` | `ieee`, `lib/writer-store.cjs`). Varsayılan `apa`; mevcut taslaklar etkilenmez.
2. `renderText` ve `renderGroup` şu an grup bazında çalışıyor. Sayısal stillerde **belge düzeyinde numara haritası** gerekir: kaynaklar metindeki ilk geçiş sırasıyla numaralanır. `lib/writer-manuscript.cjs` içindeki `renderCitations` önce tüm belirteçleri tarar, haritayı kurar, sonra görünen metni üretir. Aynı kaynak her yerde aynı numarayı alır.
3. Sayısal gruplar yukarıdaki biçimlerle birleştirilir: Vancouver `[1-3]`, `[1,3,5]`; IEEE `[1]–[3]`, `[1], [3], [5]`. Sayfa belirtilirse `[3, s. 12]`.
4. `referenceEntry(source, style)`: üç stil için girdi üretir. Sayısal stillerde liste alfabetik değil numara sırasıyla.
5. `meta.apa` / `meta.apaHtml` yerine `meta.formatted = { apa, vancouver, ieee }` (her biri `{text, html}`) yapısına geçilir. Eski kayıtlar için geriye uyumluluk: `meta.apa` varsa `formatted.apa` olarak okunur. `lib/writer-meta.cjs` ve `writer-service.cjs:315` buna göre güncellenir.
6. `lib/writer-answer.cjs` içindeki `applyCitations` seçili stile göre çalışır. LLM istemlerine (`lib/prompts.cjs`, `skills/*.md`) dokunulmaz: model atıf üretmiyor.
7. Dışa aktarma ve kopyalama numaralı atıf ile kaynakçayı birlikte verir.

### Aşama 5 — Test

- Yeni birim testleri: `tests/vancouver-format.test.cjs`, `tests/ieee-format.test.cjs`.
  - Vancouver: yazar sınırı (3/4), başharfler, sayfa kısaltma, kitap, web, kurumsal yazar, Türkçe karakterler, kısaltmasız dergi yedeği.
  - IEEE: yazar sınırı (6/7), başharf önce biçim, tırnaklı başlık, `vol./no./pp.`, kitap, tarih biçimi.
- Ayrıştırma: numaralı ve IEEE girdi önekleri, her stilde gidiş-dönüş (stil → çıktı → yeniden ayrıştırma).
- Word testleri (`word-fixture.py` ile): sayısal atıflı docx, tüm numara biçimleri, yanlış pozitif örnekleri, sıra/boşluk/eksik/kullanılmayan bulguları, PDF.
- Yazım yardımcısı: belge düzeyinde numaralama, aynı kaynağın tutarlı numarası, stil değişince yeniden üretim, eski `meta.apa` geriye uyumluluğu.
- Önbellek: stil değişince önceki stilin sonucu dönmemeli.
- Regresyon: mevcut APA testleri (`apa-format`, `reference-engine`, `writer-units`, `word*`) değişmeden geçmeli.
- Elle doğrulama: gerçek numaralı kaynakçalı bir makale uçtan uca çalıştırılır; çıktı NLM ve IEEE örnekleriyle karşılaştırılır.

### Aşama 6 — Belgeler

`README.md` içindeki "APA 7" ifadeleri, `YAZIM_YARDIMCISI_PLAN.md:136` notu ve bu plan güncellenir. Ardından `graphify update .` çalıştırılır.

## Uygulama sırası

1. **Aşama 1 + 2** birlikte: Vancouver ve IEEE ile kaynakça doğrulama (ilk kullanılabilir sürüm).
2. **Aşama 4:** yazım yardımcısı.
3. **Aşama 3:** Word denetimi. İş yükü ve risk en yüksek aşama; ayrı dalda ve ayrı PR'da yürütülür.
4. **Aşama 5 + 6** her aşamayla birlikte, nihai kontrol sonda.

## Riskler

- **Dergi kısaltması:** tek güvenilir kaynak NLM Catalog; ek ağ çağrısı ve kota yükü getirir. Önbelleğe alınır, bulunamazsa "doğrulanamadı" durumu arayüzde görünür. IEEE kısaltması için aynı alan kullanılır.
- **Sayısal atıf yanlış pozitifleri:** köşeli ayraç içindeki sayılar başka amaçlarla da kullanılır. Eşleşme kaynakça uzunluğu ve bağlamla sınırlanır.
- **Önbellek sızıntısı:** Aşama 1 madde 9 çözülmezse yanlış stilde çıktı görünebilir.
- **Stil çeşitliliği:** Vancouver tek bir standart değil. Yazar sınırı (burada 3), `doi:` öneki ve ayraçlar dergiye göre değişir. Sabitler tek yerde tutulur.
- **Yazım yardımcısı veri göçü:** `meta.apa` → `meta.formatted` geçişi mevcut kayıtlarla uyumlu olmalı.

## Açık noktalar (uygulama sırasında netleşecek)

- IEEE'de 6'dan fazla yazarda ilk yazar + `et al.` kuralı uygulanacak (IEEE Reference Guide). Farklı bir sınır istenirse tek sabitten değişir.
- Üst simge numaralar kapsam dışı; gerekirse sonraki sürümde eklenir.
