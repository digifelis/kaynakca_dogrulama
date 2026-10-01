# İçerik Denetiminde Değerlendirilemeyen Atıflar Raporu

**Belge:** 1142_BESTAS_copyedited (1).docx  
**İncelenen uygulama bölümü:** İçerik kontrolü > Atıflar ve içerik kanıtları  
**İnceleme tarihi:** 1 Ekim 2026  
**Veri kaynağı:** Uygulamada saklanan belge oturumu ve güncel doğrulama sonuçları

**Dosya karşılaştırma notu:** İletilen Word dosyası ile uygulamanın analiz ettiği arşiv kopyasında 350 paragrafın 349’u aynıdır. Tek fark kaynakça paragrafı 340’tadır. İletilen dosyada kayıt `EPA. (2025)...`, uygulamadaki analiz kopyasında `US Environmental Protection Agency EPA. (2025)...` biçimindedir. Aşağıdaki sonuçlar uygulamada görünen mevcut analiz oturumunu raporlar. Güncel dosya yeniden yüklendiğinde EPA’ya bağlı üç eşleşme sorunu farklı sonuç verebilir.

## Sonuç

Belgede 71 metin içi atıf kaydı bulunuyor. Bunların 24’ü yayın içeriğine göre değerlendirilmiş, 47’si `Değerlendirilemedi` sonucunda kalmıştır. Değerlendirilen 24 kaydın 2’si desteklenmiş, 8’i kısmen desteklenmiş ve 14’ünde incelenen yayın pasajlarında destek bulunamamıştır. `Destek bulunamadı` sonucu bir değerlendirme sonucudur; bu kayıtlar aşağıdaki 47 kayda dahil değildir.

| Engel | Atıf sayısı | Pay |
|---|---:|---:|
| Kaynak kimliği kullanıcı tarafından kabul edilmemiş | 26 | %55,3 |
| Alternatif PDF sürümü kabul edilmemiş | 8 | %17,0 |
| DOI bulunmadığı için içerik edinilememiş | 7 | %14,9 |
| Atıf ve kaynakça eşleşmesi çözülmemiş | 4 | %8,5 |
| Tam metne ve özete ulaşılamamış | 2 | %4,3 |
| **Toplam** | **47** | **%100** |

Bu dağılım, ana engelin Groq olmadığını gösteriyor. Groq’a gönderimden önce çalışan kimlik, eşleşme ve yayın metni edinme kapıları kayıtların çoğunu durdurmuştur.

## Alternatif PDF sürümü kabul edilmemiş 8 atıf

### Lei ve diğerleri 2025

Aynı yayına bağlı beş atıf durmuştur:

1. Atıf 4 — `Lei et al., 2025` — Ana metin paragraf 37
2. Atıf 11 — `Lei, Lu, Shehabi, and Masanet, 2025` — Ana metin paragraf 49
3. Atıf 18 — `Lei et al., 2025` — Ana metin paragraf 66
4. Atıf 41 — `Lei et al.'s, 2025` — Ana metin paragraf 91
5. Atıf 63 — `Lei et al.’s, 2025` — Ana metin paragraf 255

Kaynak Crossref’te DOI `10.1016/j.resconrec.2025.108310` ile doğrulanmıştır. Uygulama dergi PDF’si yerine eScholarship üzerindeki açık erişimli `submittedVersion` dosyasını bulmuştur. Başlık ve yazarlar eşleşse de dosya yayıncının nihai sürümü değildir. Bu nedenle `needsConfirmation=true` kalmış ve beş atfın tamamı aynı yayın sürümü onayını beklemiştir.

**Gerekli işlem:** Kaynakça kayıtları bölümünde bulunan alternatif sürümü bir kez kabul etmek veya yayıncının nihai PDF’sini yüklemek. Tek onay aynı kaynağa bağlı beş atfı yeniden değerlendirmeye açar.

### Herrera ve diğerleri 2025

Aynı yayına bağlı üç atıf durmuştur:

6. Atıf 14 — `Herrera et al., 2025` — Ana metin paragraf 57
7. Atıf 16 — `Herrera et al., 2025` — Ana metin paragraf 65
8. Atıf 19 — `Herrera et al., 2025` — Ana metin paragraf 70

Kaynak Crossref’te DOI `10.1016/j.jclepro.2025.146528` ile doğrulanmıştır. Bulunan EarthArXiv dosyası aynı başlık ve yazarları taşımaktadır ancak PDF açıkça **“This is a non-peer reviewed preprint submitted to EarthArXiv.”** demektedir. Kaynakçada ise *Journal of Cleaner Production* içindeki yayımlanmış makale gösterilmektedir. İçerik değişikliği olasılığı nedeniyle sistem bu üç atfı kullanıcı onayı olmadan Groq’a göndermemiştir.

**Gerekli işlem:** EarthArXiv ön baskısını bilinçli olarak kabul etmek veya derginin nihai PDF’sini yüklemek. Bir kez kabul edildiğinde üç atıf yeniden değerlendirilebilir.

## Atıf ve kaynakça eşleşmesi çözülmemiş 4 atıf

9. **Atıf 6 — `Food & Water Watch, 2026` — paragraf 42.** Kullanıcı tarafından seçilen kaynakla atıftaki yazar/yıl kimliği uyuşmuyor. Kaynak web türünde ve doğrulama sonucu `Web türü desteklenmiyor` durumunda. **İşlem:** doğru kaynakça kaydını seçmek veya atıf yazar/yıl metnini düzeltmek.
10. **Atıf 20 — `EPA, 2025` — paragraf 73.** Seçilen EPA kaydıyla yazar/yıl eşleşmesi uygulamada çözülmemiş. Kaynak `Web künyesi incelenmeli` durumunda. **İşlem:** EPA kaydını eşleşme panelinden yeniden seçip atıf metnindeki kurum adını kaynakçayla aynı kimliğe getirmek.
11. **Atıf 21 — `EPA, 2025` — paragraf 78.** Atıf 20 ile aynı eşleşme sorunu nedeniyle durmuştur. **İşlem:** aynı EPA eşleşme düzeltmesi.
12. **Atıf 24 — `EPA, 2025` — paragraf 79.** Atıf 20 ve 21 ile aynı eşleşme sorunu nedeniyle durmuştur. **İşlem:** aynı EPA eşleşme düzeltmesi.

Bu dört kayıtta yayın metni araması başlamadan önce eşleşme kontrolü hata vermiştir.

İletilen son Word dosyasında EPA kaynakça yazarı `EPA` olarak kısaltılmıştır. Bu biçim metin içi `EPA, 2025` atıflarıyla daha uyumludur. Son dosya yeniden yüklendiğinde 20, 21 ve 24 numaralı atıfların eşleşme engelinin kalkması beklenir; yine de web kaynağının içerik metninin edinilmesi ayrıca gerekecektir.

## DOI bulunmadığı için içerik edinilemeyen 7 atıf

Mevcut içerik edinme zinciri DOI üzerinden Europe PMC, OpenAlex, açık PDF ve Crossref özetini aramaktadır. Aşağıdaki web veya doğrudan PDF kaynakları kaynakça düzeyinde kısmen ya da tamamen doğrulansa da DOI olmadığı için bu zincire girememiştir.

13. **Atıf 9 — `Roundy, 2025` — paragraf 47.** TechTarget web yazısı doğrulanmış, DOI yok. **İşlem:** sistemin web sayfası içerik çıkarma desteğini kullanması gerekir; mevcut durumda sayfa/PDF metni kullanıcı tarafından sağlanmalıdır.
14. **Atıf 25 — `Smith, 2025` — paragraf 79.** Quench/Culligan web yazısı doğrulanmış, DOI yok. **İşlem:** sayfanın içerik metnini edinme desteği veya kullanıcı PDF’si gerekir.
15. **Atıf 31 — `Microsoft’s, 2026` — paragraf 87.** Kaynak doğrudan Microsoft PDF bağlantısıdır; doğrulama akışı bağlantıyı HTML olmayan web türü olarak işaretlemiş ve DOI bulamamıştır. **İşlem:** PDF’yi kaynak kaydına yüklemek veya doğrudan PDF indirme desteğini etkinleştirmek.
16. **Atıf 32 — `Yañez-Barnuevo, 2025` — paragraf 87.** EESI web yazısı kısmen doğrulanmış, DOI yok. **İşlem:** web sayfası metnini içerik kanıtı olarak edinmek ya da kullanıcı belgesi sağlamak.
17. **Atıf 50 — `Smith, 2025` — paragraf 154.** Atıf 25 ile aynı DOI’siz web kaynağı nedeniyle durmuştur.
18. **Atıf 55 — `Bhat, 2025` — paragraf 212.** Rest of World web yazısı doğrulanmış, DOI yok. **İşlem:** web içeriği edinilmeli ya da kullanıcı kopyası sağlanmalı.
19. **Atıf 58 — `Bhat, 2025` — paragraf 238.** Atıf 55 ile aynı kaynağa bağlı ve aynı nedenle durmuştur.

## Tam metne ve özete ulaşılamayan 2 atıf

20. **Atıf 10 — `Barnett-Itzhaki, 2026` — paragraf 47.** DOI `10.1016/j.watres.2026.125866` Crossref’te doğrulanmış; açık tam metin bulunamamış ve metadata kaynakları kullanılabilir özet sağlamamıştır. **İşlem:** makalenin PDF’sini yüklemek.
21. **Atıf 28 — `de Vries's, 2023` — paragraf 86.** DOI `10.1016/j.joule.2023.09.004` doğrulanmış; açık tam metin ve kullanılabilir özet bulunamamıştır. **İşlem:** makalenin PDF’sini yüklemek.

Bu iki kayıtta kimlik sorunu yoktur. Yalnız içerik kanıtı edinilemediği için değerlendirme yapılamamıştır.

## Kaynak kimliği kabul edilmemiş 26 atıf

Bu grupta uygulama olası kaydı bulmuş veya web sayfasını açmış olsa da sonucu kesin kimlik olarak kabul etmemiştir. Kullanıcı kabulü olmadan yayın içeriğine geçilmemiştir.

22. **Atıf 22 — `Doyle, 2025` — paragraf 78.** Waterdrop sayfası bulundu; canonical adres ile girilen adres farklı ve Groq metadata tamamlaması kota beklemesinde kaldı. Durum `Web künyesi kısmen doğrulandı`. **İşlem:** başlık, yazar ve tarihi kontrol edip kimliği kabul etmek.
23. **Atıf 23 — `Irish CSO, 2023` — paragraf 78.** Sayfa bulundu ancak web metadata alanları eksik kaldı; Groq tamamlaması kota beklemesinde. **İşlem:** kurum, başlık ve tarihi kontrol edip kabul etmek.
24. **Atıf 26 — `Josh, 2025` — paragraf 86.** Epoch AI sayfası bulundu ancak metadata eksik; Groq tamamlaması kota beklemesinde. **İşlem:** gerçek yazar adını ve tarihi kontrol etmek. Kaynakçada `Josh, Y.` biçimi ayrıca şüphelidir.
25. **Atıf 33 — `Siddik, Shehabi, Rao and Marston, 2024` — paragraf 89.** DOI ve yazar/yıl eşleşiyor; başlık puanı 0,769 olduğu için eşik altında kalmış. Bu, büyük/küçük harf ve başlık normalizasyonundan doğan olası yanlış pozitiftir. **İşlem:** Crossref eşleşmesini kabul etmek; ayrıca başlık puanlama normalizasyonu iyileştirilebilir.
26. **Atıf 34 — `Lee et al., 2017` — paragraf 89.** DOI ve başlık eşleşiyor ancak Crossref yayın yılı 2018, kaynakça yılı 2017. **İşlem:** kullanılan çevrimiçi-yayın/basılı-yayın yılını doğrulayıp doğru yılı kabul etmek.
27. **Atıf 35 — `Siddik et al., 2024` — paragraf 89.** Atıf 33 ile aynı kaynağa bağlı ve aynı başlık puanı sorunu nedeniyle durmuştur.
28. **Atıf 38 — `Mistral AI, 2025` — paragraf 90.** Başlık ve yıl bulunmuş; web künyesi eksik/farklı alanlar nedeniyle incelemede, Groq metadata tamamlaması kota beklemesinde kalmış. **İşlem:** kurumsal yazar ve tarihi kabul etmek.
29. **Atıf 42 — `LBNL, 2026` — paragraf 101.** LBNL sayfası HTTP 403 ile web doğrulamasını engellemiş. **İşlem:** kaydı manuel kabul etmek veya rapor PDF’sini yüklemek; uygulama tarafında bu alan adı için doğrudan belge edinme yolu gerekir.
30. **Atıf 43 — `Swinhoe, 2025` — paragraf 108.** Sayfa bulundu ancak görünen yazı başlığı alınamadı; yalnız meta bilgiler mevcut ve Groq tamamlaması kota beklemesinde. **İşlem:** başlık/yazar/tarihi manuel kontrol edip kabul etmek.
31. **Atıf 47 — `Altman, 2025` — paragraf 129.** Blog sayfası bulundu fakat metadata tam kesinleşmedi. **İşlem:** Sam Altman, başlık ve yayın tarihini kontrol edip kabul etmek.
32. **Atıf 48 — `Elsworth et al., 2025` — paragraf 132.** arXiv DOI, başlık ve yıl eşleşiyor; arXiv yanıtında yazar listesi alınamadığı için ilk yazar kesinleşmemiş ve puan 80’de kalmış. **İşlem:** arXiv kaydını kabul etmek; arXiv yazar ayrıştırması düzeltilirse bu onay otomatikleşebilir.
33. **Atıf 49 — `Verma & Tan, 2024` — paragraf 138.** Washington Post başlığı ve yılı bulunmuş; web künyesi yine de inceleme durumunda ve Groq metadata tamamlaması kota beklemesinde. **İşlem:** yazarları ve tarihi kontrol edip kabul etmek.
34. **Atıf 51 — `Nicoletti et al., 2025` — paragraf 204.** Bloomberg sayfası bulundu; sayfa başlığı kaynakçadaki başlıktan farklı biçimde `How AI Demand Is Draining Local Water Supplies` olarak geldi. **İşlem:** aynı yayın olduğunu kontrol edip eşleşmeyi kabul etmek.
35. **Atıf 52 — `Nicoletti et al., 2025` — paragraf 205.** Atıf 51 ile aynı Bloomberg kaynağı ve aynı başlık farkı nedeniyle durmuştur.
36. **Atıf 53 — `Ren & Luers, 2026` — paragraf 208.** IEEE Spectrum sayfası bulundu ancak metadata yılı 2025, kaynakçada 2026. **İşlem:** yayın tarihini düzeltmek veya doğru sürümü seçmek.
37. **Atıf 56 — `Seawards, n.d.` — paragraf 213.** Sayfa bulundu; tarih ve diğer metadata alanları kesinleşmedi, Groq tamamlaması kota beklemesinde. **İşlem:** tarih yok bilgisini ve kurumsal yazarı manuel doğrulayıp kabul etmek.
38. **Atıf 57 — `Swinhoe, 2025` — paragraf 238.** Atıf 43 ile aynı kaynağa bağlı ve başlığın alınamaması nedeniyle durmuştur.
39. **Atıf 59 — `Middle East Council on Global Affairs, 2026` — paragraf 238.** Sayfa bulundu ancak alınan başlık yalnız `Desert Bytes:` biçiminde eksik kaldı; Groq tamamlaması kota beklemesinde. **İşlem:** tam başlığı ve kurumsal yazarı doğrulayıp kabul etmek.
40. **Atıf 61 — `de Vries-Gao’s, 2025` — paragraf 244.** DOI, başlık ve yazar eşleşiyor; Crossref yılı 2026, kaynakça yılı 2025. **İşlem:** çevrimiçi/yayın yılı ayrımını doğrulayıp doğru yılı seçmek.
41. **Atıf 64 — `MultiState, 2026` — paragraf 265.** Sayfa bulundu ancak metadata eksik ve Groq tamamlaması kota beklemesinde. **İşlem:** kurumsal yazar, başlık ve yılı kontrol edip kabul etmek.
42. **Atıf 65 — `Soares, 2018` — paragraf 265.** Bağlantı doğrudan PDF; web doğrulama akışı HTML dışı kaynağı desteklemediği için `Web türü desteklenmiyor` durumunda. **İşlem:** PDF’yi kaynak kaydına yüklemek veya doğrudan PDF bağlantısını içerik edinme akışına almak.
43. **Atıf 66 — `Wang, 2026` — paragraf 265.** Yale bağlantısı doğrudan PDF ve aynı nedenle web doğrulamasında desteklenmemiş. **İşlem:** PDF’yi yüklemek veya doğrudan indirme desteğini kullanmak.
44. **Atıf 67 — `Privette et al., 2026a` — paragraf 265.** Sayfa bulundu ancak metadata eksik; Groq tamamlaması kota beklemesinde. **İşlem:** başlık, kurum/yazar ve yılı kontrol edip kabul etmek.
45. **Atıf 69 — `Data Driven Lab, 2026` — paragraf 266.** Bağlantı doğrudan PDF ve web doğrulama akışı bunu desteklememiş. **İşlem:** PDF’yi kaynak kaydına yüklemek veya doğrudan PDF edinme desteğini kullanmak.
46. **Atıf 70 — `McIver, 2026a` — paragraf 269.** Congress.gov sayfası HTTP 403 döndürmüş. **İşlem:** yasama kaydını manuel kabul etmek veya belgenin metin/PDF kopyasını sağlamak.
47. **Atıf 71 — `McIver, 2026b` — paragraf 269.** Temsilciler Meclisi basın açıklaması bulundu ancak metadata eksik; Groq tamamlaması kota beklemesinde. **İşlem:** başlık, yazar/kurum ve tarihi kontrol edip kabul etmek.

## Önceliklendirilmiş düzeltme sırası

1. **Lei ve Herrera sürüm onaylarını çözün.** İki kaynak için iki kullanıcı işlemi sekiz atfı açacaktır.
2. **EPA eşleşmesini ve Food & Water Watch eşleşmesini düzeltin.** İki kaynak üzerinde yapılacak işlem dört atfı açacaktır.
3. **Crossref/arXiv akademik kayıtlarını kabul edin veya kural hatalarını düzeltin.** Siddik iki atfı; Lee, de Vries-Gao ve Elsworth birer atfı açacaktır. DOI eşleşmesi güçlü olan bu kayıtlar düşük riskli manuel inceleme adaylarıdır.
4. **Barnett-Itzhaki ve de Vries PDF’lerini yükleyin.** Kimlikleri zaten doğrulanmıştır; yalnız içerik eksiktir.
5. **Doğrudan PDF bağlantılarını sisteme aktarın.** Microsoft, Soares, Wang ve Data Driven Lab bağlantıları indirilebilir belge olduğu halde web metadata akışında elenmektedir.
6. **Web kaynaklarını topluca gözden geçirin.** Kısmi metadata veya 403 nedeniyle bekleyen kayıtlar için başlık, yazar/kurum ve tarih onayı gereklidir.

## Sistemsel bulgular

- İçerik kontrolü yalnız DOI tabanlı yayın edinme zincirini kullanıyor. Doğrulanmış web sayfaları içerik açısından değerlendirilemiyor.
- Doğrudan PDF URL’leri web doğrulama katmanında `HTML değil` gerekçesiyle eleniyor; oysa içerik denetimi açısından bunlar en kolay edinilebilir kaynaklardır.
- Bir kaynakta oluşan engel, aynı kaynağa bağlı bütün atıflarda ayrı `Değerlendirilemedi` sonucu üretiyor. Kaynak bazında toplu onay daha verimli olur.
- Siddik kaydında DOI, yazar ve yıl eşleşmesine rağmen başlık puanı 0,769 kalmıştır. Başlık normalizasyonu akademik kaydın yalnız biçim farkını yanlış risk olarak değerlendirmiş olabilir.
- arXiv sonucunda yazar listesinin boş gelmesi Elsworth kaydını gereksiz kullanıcı onayına düşürmüştür.
- Bazı web kayıtlarında Groq metadata tamamlaması kota beklemesinde kaldığı için kaynak kimliği kesinleşmemiştir. Bu durum içerik Groq değerlendirmesinden önceki ayrı bir Groq kullanım noktasıdır.

## Raporun sınırı

Bu rapor, uygulamada 1 Ekim 2026 tarihinde saklanan analiz durumunu açıklar. Bir kaynağın `Değerlendirilemedi` olması, atıftaki iddianın yanlış olduğunu göstermez. Yalnızca sistemin atfı güvenli biçimde değerlendirecek doğrulanmış yayın metnine veya kullanıcı onayına henüz ulaşmadığını gösterir.
