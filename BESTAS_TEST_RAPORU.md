# BESTAS gerçek belge test raporu

Tarih: 30 Eylül 2026. Test belgesi: `1142_BESTAS_original.docx`.

## Düzeltmeler sonrası yeniden test

Raporlanan uygulama hataları giderildi ve aynı dosya yeniden test edildi. Aşağıdaki ilk-test bölümleri karşılaştırma için korunmuştur; güncel sonuçlar bu bölümde yer alır. Orijinal makale değiştirilmedi.

| Ölçüm | İlk test | Düzeltme sonrası |
|---|---:|---:|
| Ayrıştırılan kaynakça | 38 | **40** |
| Algılanan atıf | 64; yanlış pozitifler vardı | **53**; bu sayı kesin eksiksizlik iddiası değildir |
| Kaynakçası olmayan atıf uyarısı | 33 | **6**; insan incelemesi gereken adaylar |
| Yıl uyuşmazlığı | 7 | **8**; Li'nin ilk yazarı kaybolan bir atfı daha bulundu |
| Belirsiz aynı yazar/yıl eşleşmesi | 1 | 1; iki McIver adayı yanlışlıkla yetim sayılmıyor |
| Atıfsız kaynak uyarısı | 21 | **14**; biçimsel tarama sonucu, kesin kullanılmayan yayın listesi değil |
| Yinelenen kaynak tespiti | Yakalanmadı | **3 çift / 6 kayıt** |
| Toplam yapısal bulgu | 62 | **35**; yeni tekrar uyarıları da dâhil |
| Kaynak seçimi sonrası Word'e yıl yazma / geri alma | 3 başarılı, 4 başarısız | **8/8 başarılı** |

Yıl uyuşmazlığında otomatik değişiklik önerisi kaldırıldı. Kullanıcı önce yayın/sürüm eşleşmesini kabul eder, ardından düzeltmeyi ayrıca uygular. Sekme ve satır sonları korunarak yalnız metin aralığı değiştirilir. Gerçek makaledeki sekiz denemede her dışa aktarımın bütün paragraf metinleri beklenen seçili değişiklikle karşılaştırıldı. Makaledeki yıllar bu teknik denemeye dayanarak doğru/yanlış ilan edilmedi; kalıcı olarak değiştirilmedi.

Çok yazarlı anlatım atıfları, iyelik ekleri, noktasız `et al`, kurum kısaltmaları, kurum adındaki `&`, noktasız baş harfler ve Türkçe Word başlık stilleri için regresyon kontrolleri eklendi. Tarih aralıkları, açıklama içindeki yıllar, taahhüt hedef yılları ve `kWh` ölçüm yılı yanlış atıf üretmiyor. Tam tarihli kaynakçanın başlığı ay/gün bilgisine takılmadan ayrıştırılıyor. Kaynakçadaki arXiv kimliği DataCite DOI'sine çevriliyor; belirtilmiş sürüm numarası PDF erişiminde korunuyor.

Kanıt kontrolünde yalnız Unicode/boşluk farkları normalleştiriliyor; uydurulmuş veya niceliği farklı alıntılar reddediliyor. Ret durumunda karar ve açıklama birlikte güncelleniyor, ret gerekçesi gösteriliyor. Europe PMC erişimi veya ilk PDF engellendiğinde diğer açık erişim bağlantıları deneniyor. Dergi sürümü yerine ön baskı/yazar sürümü bulunursa kullanıcı onayı gerekiyor.

**Doğrulama:** Otomatik test paketinde 82 test geçti. Gerçek DOCX yükleme, ayrıştırma, kaynak seçimi, sekiz düzeltme, indirme ve geri alma yerel HTTP servisiyle test edildi. Tarayıcıdan da makale yeniden yüklendi; 40 kaynak, 53 atıf ve 35 bulgu görüntülendi; filtre düğmesi çalıştı. Sahip olunan önceki 57 kayıtlık kaynakça girişi korundu.

**Canlı dış servis testi:** Kamuya açık Jegham arXiv yayını doğru yazarlarla `verified` döndü. Mytton'ın açık erişim PDF'si ve bu yayındaki bilgilerden oluşturulan yapay cümle Groq'a gönderildi; iki iddia geçerli pasaj/alın­tılarla `supported` döndü. Gerçek Word bağlamını Groq'a gönderen son yeniden test, otomatik onay denetimi açık gönderim izni istediği için yapılmadı; yerine kamuya açık yapay örnek kullanıldı. Bu sonuç gerçek makalenin tüm içeriklerinin doğrulandığı anlamına gelmez.

Li için alternatif tam metin denemesi dış servislerden HTTP 503/403 aldı. Kod alternatifleri deniyor; erişim engelini kaldıramıyor. Bu durumda yayın PDF'si yüklenmeli; erişim hatası içerik çelişkisi olarak raporlanmıyor. Bütün kaynakların ve bütün atıfların dış servislerle yeniden denetimi bu düzeltme testi kapsamında yapılmadı.

Güncel çıktılar: `tests/tmp/bestas-after.json`, `tests/tmp/bestas-live-after.json`. Gerçek belge testi: `node scripts/retest-bestas.cjs`. Varsayılan kamuya açık canlı test: `node scripts/check-bestas-fixes.cjs`.

![Düzeltmeler sonrası arayüz](C:/Users/bes-t/Documents/kaynakca_dogrula/tests/tmp/bestas-after-ui.jpg)

## İlk testin bulguları

**İlk test sonucu:** Uygulama bu belgeyi okuyabiliyordu, ancak kaynakça/atıf ayrıştırması ve düzeltme önerilerinde önemli hatalar vardı. Aşağıdaki eski otomatik sayaçlar makalede gerçekten bu kadar hata bulunduğu anlamına gelmez.

Orijinal dosya değiştirilmedi. Okuma öncesi/sonrası SHA-256 aynı: `c959480764f8a48fd5e3725f9606f35e5098450211dea1cdaea59f901c2a2598`.

## Test kapsamı ve sayılar

Belgenin gerçek DOCX içeriği Python ayrıştırıcısı, Node analiz modülü ve çalışan yerel HTTP servisiyle test edildi. Kaynakça kayıtlarının tamamı birincil doğrulama akışından geçirildi; içerik denetimi dört örnekle sınandı. Tarayıcıdaki bütün düğmelerin görsel testi ve bütün atıfların içerik denetimi bu raporun kapsamında değildir.

| Ölçüm | Sonuç | Yorum |
|---|---:|---|
| Okunan paragraf | 342 | Ana metin ve desteklenen not bölümleri |
| Kaynakça kaydı | Elle incelemede 40; uygulamada 38 | İki ayrı kayıt önceki kayıtla birleşmiş |
| Otomatik atıf tespiti | 64 | Yanlış pozitifler ve kaçırılan yazarlar var |
| Otomatik bulgu | 62 | 33 eksik kaynakça, 7 yıl uyuşmazlığı, 1 belirsiz eşleşme, 21 atıfsız kaynak |
| Birincil kaynak doğrulaması | 8 doğrulandı, 9 inceleme, 21 eşleşmedi | Crossref/DataCite birincil akışı; ek sağlayıcılar çalıştırılmadı |
| Önerilen yıl düzeltmesinin Word'e yazılması | 3 başarılı, 4 başarısız | Başarı yalnız teknik yazılabilirliği gösterir; önerinin doğruluğunu göstermez |
| HTTP belge yükleme/indirme | İkisi de HTTP 200 | Hatalı düzeltme isteği HTTP 400 |

Eşleşmeyen 21 kayıt “yayın yok” olarak yorumlanamaz. Listede web haberleri, kurum sayfaları ve bozuk ayrıştırılmış kayıtlar bulunuyor. Bu testte 429 nedeniyle kalan iş gözlenmedi; bu, kota bekleme/yeniden deneme davranışının ayrıca doğrulandığı anlamına gelmez.

## Uygulamada doğrulanan hatalar

Paragraf numaraları uygulamanın ana metindeki 1 tabanlı numaralarıdır; Word sayfa numarası değildir.

| Öncelik | Hata ve gerçek örnek | Etki / önerilen düzeltme |
|---|---|---|
| Kritik | `Food & Water Watch (2026)` önceki Ferreira kaydına; `Privette, CV, et al. (2026)` önceki Nicoletti kaydına birleşiyor | Kayıt başlangıçları kurum adlarını, `&` ve noktasız baş harfleri desteklemeli; 40 kayıt ayrılmalı |
| Kritik | Başlıktaki `(2020–2050)` → `Study, 2020` ve `Study, 2050` | Tarih aralıkları, hedef yılları ve ölçüm yılları atıf sayılmamalı |
| Kritik | P33: `Ristic, Madani, and Makuch (2015)` → yalnız `Madani and Makuch`; P40: `Lei, Lu, Shehabi, and Masanet (2025)` → yalnız son iki yazar | İlk yazar kaybolduğu için yanlış yetim atıf/kaynak uyarıları üretiliyor; bütün yazar dizisi korunmalı |
| Yüksek | `Mytton’s`, `Mytton's`, `Jegham et al.'s`, `de Vries's`, `de Vries-Gao’s` | İyelik ekleri temizlenmeli; `de` gibi soyadı parçaları korunmalı |
| Yüksek | `Jiang et al, 2025`; `Mistral` / `Mistral AI`; `Epoch AI's` | Noktalama çeşitleri ve kurum kısaltmaları desteklenmeli; takma ad eşleştirmeleri açık gösterilmeli |
| Kritik | Lee 2018 atfına 2017 önerisi; aynı yazarın farklı yıllardaki çalışmalarını tek kayıt sanma | Kaynakçadaki yıl tek başına gerçek kabul edilmemeli; yayın kimliği ve sürümü doğrulanmadan yıl düzeltmesi sunulmamalı |
| Kritik | P80 ve P81'de dört yazma denemesi: `Sekme/satır sonlu paragraf yalnız raporlanabilir.` | Analiz düzeltme öneriyor, yazma katmanı reddediyor. Bu paragraflarda güvenli konum eşlemesi yapılmalı veya düğme önceden gerekçesiyle devre dışı olmalı |
| Yüksek | Mytton içerik sonucu `unassessable`; açıklaması iki iddianın doğrulandığını söylüyor | Kanıt denetimi kararı düşürdüğünde açıklama da yenilenmeli; geçersiz alıntının neden reddedildiği görünmeli |
| Yüksek | Tarihli web kaydında başlık `May 8)` / `August 4)` gibi ayrıştırılabiliyor | Gün/ay içeren kaynakça tarihleri tek alan olarak işlenmeli; arama başlığı bozulmamalı |
| Yüksek | Aynı arXiv ID / haber URL'sine sahip farklı yazarlı kayıtlar yinelenen kaynak olarak yakalanmıyor | DOI, arXiv ID ve normalleştirilmiş URL üzerinden tekrar tespiti eklenmeli |
| Orta | Mytton bağlamının ilk öğesi `Introduction` başlığı | Türkçe Word stil adı `Balk1` de bölüm sınırı olarak tanınmalı; önceki üç gerçek cümle seçilmeli |

Sekmeli paragraf hatası gerçek HTTP `apply` isteğiyle de tekrarlandı. Başarısız işlemden sonra indirme çalışıyor. Değişikliksiz dışa aktarımda DOCX'in 48 paket parçasının içerikleri aynı kaldı; ZIP paketinin dosya baytları yeniden paketleme nedeniyle farklı olabilir. Word'de görsel düzen karşılaştırması yapılmadı.

## Makalede ayrıca kontrol edilmesi gereken noktalar

### 1. Li 2023 / 2025: sürüm uyuşmazlığı

Metindeki beş atıf 2023, kaynakça kaydı 2025. Ancak [arXiv kaydı](https://arxiv.org/abs/2304.03271) ilk gönderimin 6 Nisan 2023 olduğunu ve sonraki sürümün Communications of the ACM tarafından kabul edildiğini gösteriyor. Canlı DOI kaydı `10.1145/3724499` için 2025 döndü.

Bu, “2023 yanlıştır” demek değildir. Makalede kullanılan ön baskı mı, 2025 dergi sürümü mü belirlenmeli; ardından atıf ve kaynakça aynı sürüme bağlanmalı.

### 2. Lee: kaynakçanın yılı şüpheli

Kaynakça 2017, metin 2018. Canlı DOI metadatası `10.1016/j.apenergy.2017.05.025` için 2018 döndü ve aynı başlık/yazarları eşleştirdi. Uygulamanın 2018 → 2017 önerisi bu kanıtla çelişiyor. DOI içindeki `2017` yayın yılı olarak kullanılamaz. Çevrim içi/dergi sayı tarihi ayrımı kontrol edilerek kaynakça yılı değerlendirilmelidir.

### 3. Jegham / Ren: aynı yayın ve yanlış yazar

İki kaynakça kaydı aynı `arXiv:2505.09598` yayınına gidiyor. [Resmî arXiv kaydı](https://arxiv.org/abs/2505.09598) yazarları Jegham, Abdelatti, Koh, Elmoubarki ve Hendawi olarak listeliyor; Ren bu listede yok. Bu nedenle `Ren, S., et al. (2025). How hungry is AI? ...` kaydının yazarı yanlış ve kayıt yineleniyor. Birleştirilmeden önce metindeki Ren atıflarının hangi çalışmayı kastettiği kontrol edilmeli.

### 4. Diğer insan incelemesi adayları

- Bhat / Rest of World kayıtları aynı haber URL'sini, farklı yıl/tarih ve yazar etiketleriyle kullanıyor.
- BloombergNews / Nicoletti kayıtları aynı Bloomberg URL'sine gidiyor.
- McIver 2026 için iki kayıt var; aynı basın açıklaması mı, iki farklı yayın mı netleşmeli. Farklı yayınlarsa 2026a/2026b gerekebilir.
- `Mytton (2025)` için kaynakçada yalnız Mytton 2021 bulunuyor. 2025 ayrı bir çalışma olabilir; doğrudan 2021'e çevrilmemeli.
- Irish CSO 2022, Altman 2025, Microsoft 2026 ve UC Riverside 2023 gibi atıflar için açık karşılık belirlenmeli. Kurum duyurusu ile kurum araştırmacılarının makalesi otomatik olarak aynı kaynak kabul edilmemeli.

Bu adayların tamamı kesin makale hatası olarak doğrulanmış değildir. Ayrıştırma düzeldikten sonra yetim kaynak ve atıf listesi yeniden çıkarılmalıdır.

## İçerik denetimi: dört gerçek örnek

| Kaynak / konum | Canlı test | Değerlendirme |
|---|---|---|
| Mytton 2021 / P25 | Açık erişim PDF indirildi; Groq yanıt verdi; sonuç `unassessable` | Kaynak PDF'sinin ilk sayfasında günlük 1,7 milyar litre ve operatörlerin üçte birinden azının ölçüm yaptığı bilgileri görülüyor. İki nicel iddia elle destekleniyor. Uygulama alıntı doğrulaması nedeniyle kararı düşürmüş, açıklamayı değiştirmemiş. “Proved” ifadesinin metodolojik uygunluğu ayrıca değerlendirilmeli |
| Li / P25 | Tam metin servisi HTTP 403 | Uygulama içerik hakkında karar veremedi. Resmî arXiv özeti 700.000 litre ve 2027 için 4,2–6,6 milyar m³ tahminlerini içeriyor; kullanılan sürüm belirlenmeli |
| Lee / P80 | Açık erişim tam metin bulunamadı | PDF sağlanmadan sayısal iddialar değerlendirilemedi |
| Ristic / P33 | Tam metin servisi HTTP 403 | PDF sağlanmadan değerlendirilemedi; ilk yazar ayrıştırması bozuk olduğu için bu örneğin kaynak eşleştirmesi testte elle seçildi ve tüm paragraf bağlamı kullanıldı |

Tam metin erişim hatası, yayında iddianın bulunmadığını göstermez. Bu dört örnek bütün makalenin içerik denetimi veya model doğruluk ölçümü değildir. Mytton dışındaki üç örnekte Groq içerik değerlendirmesine geçilemedi.

## Önerilen düzeltme sırası ve kabul ölçütleri

1. Kaynakça başlangıçları ve çok yazarlı/iyelikli atıflar: belge 40 kayıt vermeli; başlıktaki tarih aralığı atıf üretmemeli; Ristic, Lei, Qi ve Siddik ilk yazarları korunmalı.
2. Yıl/sürüm ve tekrar kontrolü: Lee 2018 → 2017 yanlış önerisi kaldırılmalı; Li sürüm tercihi açık olmalı; Jegham/Ren ortak arXiv ID'si yakalanmalı.
3. Word'e yazma: sekmeli P80/P81 için düğme ile yazma katmanı aynı yetenek bilgisini kullanmalı; başarılı değişiklikte yalnız seçilen yıl değişmeli, başarısız işlemde hiçbir parça değişmemeli.
4. İçerik denetimi: karar/açıklama çelişkisi giderilmeli; kanıt reddi açıklanmalı; 403 veren açık erişim kaynağında başka resmî sürüme geçiş veya PDF yükleme yolu sunulmalı.
5. Bu belgeyle tüm akış yeniden çalıştırılmalı; ardından gerçek yetim kaynak/atıflar ve kalan içerik iddiaları değerlendirilmelidir.

Test çıktıları yerel `tests/tmp/bestas-*.json` dosyalarında; tekrar çalıştırma betiği `scripts/test-bestas.cjs`. Bunlar belge metni içerir; kamuya yayımlanmamalıdır. Raporlama aşamasında uygulama kodu ve orijinal makale değiştirilmedi.
