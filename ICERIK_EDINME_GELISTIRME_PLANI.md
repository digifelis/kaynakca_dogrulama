# İçerik Edinme ve Atıf Kanıtı Denetimi Geliştirme Planı

## Amaç

İçerik denetimi yalnız DOI üzerinden açık tam metin veya özet aramamalıdır. Doğrulanmış kaynak bir web yazısı, DOI yönlendirmesi, doğrudan PDF, arXiv kaydı, ön baskı veya yayıncı sayfası olabilir. Sistem bu kaynak türlerini güvenli biçimde edinmeli, yayın kimliğini doğrulamalı, ilgili pasajları seçmeli ve yalnız gerekli kanıt metnini Groq modeline göndermelidir.

Hedef akış:

1. Kaynak kimliğini ve erişim adreslerini belirle.
2. Adres türünü gerçek HTTP yanıtına göre tanı.
3. Yönlendirmeleri güvenli biçimde takip et.
4. HTML, PDF, XML veya metadata kaynağından metni çıkar.
5. Elde edilen içeriğin doğru yayına ait olduğunu doğrula.
6. Atıf bağlamıyla en ilgili pasajları seç.
7. Pasajları Groq’a gönder ve kanıta dayalı karar üret.
8. Edinme ve değerlendirme sonuçlarını kaynak bazında sakla; aynı yayını tekrar indirme.

## Mevcut sorunlar

- `word-content.cjs` içerik edinmeyi doğrulanmış DOI varlığına bağlıyor. DOI’siz web kaynakları daha başlamadan eleniyor.
- HTML web kaynağı doğrulaması ile içerik edinme aynı şeymiş gibi ele alınıyor. Künye doğrulanabildiği halde sayfa metni içerik denetimine aktarılmıyor.
- Doğrudan PDF URL’leri web doğrulama katmanında `HTML değil` gerekçesiyle eleniyor.
- DOI yönlendirmesi yayıncı veya depo sayfasına ulaştığında bu sayfadaki PDF, özet, citation metadata ve yapılandırılmış veri sistematik biçimde taranmıyor.
- Bir yayının erişim sorunu o yayına bağlı bütün atıflarda ayrı hata üretiyor. Edinme kaynak bazında tek iş olarak yönetilmiyor.
- Güçlü DOI eşleşmeleri bazı başlık normalizasyonu ve yıl farkları nedeniyle gereksiz kullanıcı onayına düşebiliyor.
- arXiv API yazar bilgisi ayrıştırılmadığında doğru DOI ve başlık eşleşmesi bile `İnceleme gerekli` durumunda kalabiliyor.
- Hata mesajı çoğu zaman yalnız son hatayı gösteriyor; denenmiş adresler, yönlendirme zinciri ve içerik türleri yeterince açıklanmıyor.

## Yeni mimari

### Birleşik yayın çözümleyici

Yeni bir `content-resolver.cjs` modülü oluşturulacaktır. Modül kaynak kaydından sıralı aday adresler üretir:

1. Kullanıcının yüklediği PDF
2. Kaynakçada bulunan doğrudan PDF URL’si
3. arXiv PDF URL’si
4. DOI yönlendirme adresi
5. OpenAlex açık erişim konumları
6. Europe PMC tam metni
7. Kaynakçada bulunan web sayfası
8. Crossref/OpenAlex özeti

Her aday ortak bir sonuç biçimine dönüştürülür:

```text
sourceType       html | pdf | xml | abstract
requestedUrl     ilk istek adresi
finalUrl         yönlendirmelerden sonraki adres
redirectChain    durum kodu ve adres listesi
contentType      gerçek Content-Type
title            içerikten çıkarılan başlık
authors          içerikten çıkarılan yazarlar
publishedAt      içerikten çıkarılan tarih
doi              içerikte bulunan DOI
version          published | accepted | submitted | preprint | unknown
text             temizlenmiş belge metni
passages         sayfa veya bölüm bazlı parçalar
identityScore    kaynak kaydıyla kimlik benzerliği
warnings         sürüm ve erişim uyarıları
```

Bu veri modeli HTML, PDF ve DOI akışlarının aynı doğrulama ve Groq değerlendirme hattını kullanmasını sağlar.

## Aşama 1 Doğrudan PDF desteği

Kaynakçada `https://...pdf`, PDF döndüren uzantısız URL veya `Content-Type: application/pdf` bulunan bağlantılar doğrudan indirilecektir.

Yapılacaklar:

- URL uzantısına güvenmek yerine ilk baytların `%PDF-` olduğunu kontrol et.
- En fazla dört HTTPS yönlendirmesini takip et.
- Her yönlendirmede DNS ve özel ağ kontrollerini yeniden uygula.
- 20 MB mevcut boyut sınırını koru; sınır aşıldığında açık hata göster.
- PDF metnini mevcut `word-package.py` PDF ayrıştırıcısıyla sayfa bazında çıkar.
- Metin katmanı yoksa `OCR gerekli` sonucunu üret; sessizce Groq’a boş metin gönderme.
- İlk sayfalardan başlık, yazar, DOI ve sürüm beyanını çıkar.
- PDF kimliği güçlü biçimde eşleşirse otomatik kullan; ön baskı/yazar sürümü ise açık sürüm uyarısıyla kullanıcı onayı iste.

İlk kabul kaynakları:

- Microsoft Environmental Sustainability Report PDF
- Soares 2018 PDF
- Wang 2026 Yale PDF
- Data Driven Lab 2026 PDF

## Aşama 2 Web sayfası içerik çıkarma

Roundy, Smith, Bhat, Yañez-Barnuevo ve benzeri DOI’siz web yazıları için güvenli HTML edinme desteği eklenecektir.

Çıkarma sırası:

1. `application/ld+json` içindeki `Article`, `NewsArticle`, `Report` ve `ScholarlyArticle`
2. OpenGraph ve citation meta etiketleri
3. `<article>` ve `<main>` alanları
4. Readability benzeri ana içerik çıkarımı
5. Son çare olarak yoğun metin blokları

Temizleme kuralları:

- Script, stil, navigasyon, çerez bildirimi, reklam, yorum ve ilgili içerik bloklarını kaldır.
- Üçüncü taraf sayfa metnindeki talimatları veri olarak ele al; sistem talimatı olarak yorumlama.
- Metni bölüm ve paragraf konumlarıyla sakla.
- Kaynak URL’sini, erişim zamanını ve nihai canonical adresi kaydet.
- Çok kısa, giriş duvarından ibaret veya erişim engeli içeren sayfayı içerik olarak kabul etme.
- Sayfa başlığı, yazar/kurum ve tarih ile kaynakça kaydı arasında kimlik puanı hesapla.

Web kaynağı doğrulanmış ancak DOI’sizse artık `Doğrulanmış DOI yok` hatası üretilmeyecektir. Sistem doğrulanan web sayfasının metnini kullanacaktır.

## Aşama 3 DOI yönlendirme ve yayıncı sayfası çözümleme

Barnett-Itzhaki ve de Vries gibi DOI adresleri için `https://doi.org/<doi>` bağlantısı takip edilecektir.

Akış:

1. DOI adresine GET isteği gönder.
2. Her 301, 302, 303, 307 ve 308 yanıtını kaydet ve güvenli biçimde takip et.
3. Nihai yayıncı sayfasında aşağıdaki alanları ara:
   - `citation_pdf_url`
   - `citation_abstract`
   - `citation_title`
   - `citation_author`
   - `citation_publication_date`
   - `citation_doi`
   - JSON-LD `ScholarlyArticle`
   - OpenGraph makale alanları
4. PDF bağlantısı varsa PDF edinme aşamasına gönder.
5. Tam metin HTML olarak sunuluyorsa ana makale gövdesini çıkar.
6. Yalnız özet erişilebiliyorsa `Yalnız özet incelendi` uyarısıyla devam et.
7. Giriş/paywall sayfasıysa bunu tam metin sanma; başka açık konumlara devam et.

DOI yönlendirmesi içerik erişimi garantisi olarak görülmeyecektir. Nihai sayfa yalnız metadata sağlıyorsa sistem açık erişim konumlarını aramaya devam eder.

## Aşama 4 Kimlik ve sürüm doğrulaması

İçerik, Groq’a gönderilmeden önce kaynakça kaydıyla doğrulanacaktır.

Otomatik kabul koşulları:

- DOI PDF veya sayfa içinde birebir eşleşiyor; veya
- arXiv kimliği birebir eşleşiyor; veya
- başlık çok güçlü eşleşiyor, ilk yazar eşleşiyor ve yıl en fazla çevrimiçi/basılı yayın farkı gösteriyor.

Kullanıcı onayı gerektiren koşullar:

- `submittedVersion`, `acceptedVersion`, author manuscript veya preprint
- PDF’de `non-peer reviewed preprint` benzeri açık sürüm beyanı
- Başlık güçlü ancak yazar veya DOI doğrulanamıyor
- Kaynakçada dergi sürümü varken yalnız ön baskı bulunuyor

Reddedilecek koşullar:

- DOI farklı
- Başlık belirgin biçimde farklı
- PDF başka bir yayına ait
- İçerik yalnız kaynakçada atıf yapılan yayını anıyor ancak yayının kendisi değil

Sürüm uyarıları PDF’den doğrulanmış kısa alıntıyla gösterilecektir. Herrera kaydındaki `This is a non-peer reviewed preprint submitted to EarthArXiv.` bunun kabul örneğidir.

## Aşama 5 Kaynak kimliği yanlış pozitiflerini azaltma

- DOI birebir eşleştiğinde başlık biçim farkının sonucu gereksiz yere `İnceleme gerekli` durumuna düşürmesine izin verme.
- Unicode, noktalama, tire, apostrof, büyük/küçük harf ve alt başlık normalizasyonunu iyileştir.
- Çevrimiçi yayın yılı ile cilt/basılı yayın yılı farkını ayrı alanlarda sakla; kullanıcıya iki tarihi göster.
- arXiv Atom yanıtındaki yazar listesini ayrıştır ve ilk yazar karşılaştırmasını düzelt.
- Kurumsal yazar kısaltmalarını normalize et: `EPA` ile `US Environmental Protection Agency` gibi kontrollü eş anlamlıları kullanıcı onayıyla bağla.
- Aynı kaynağa bağlı bütün atıflarda tek kaynak onayı kullan.

Bu aşamanın hedef örnekleri Siddik 2024, Elsworth 2025, Lee 2017/2018, de Vries-Gao 2025/2026 ve EPA 2025’tir.

## Aşama 6 Groq kanıt değerlendirmesi

Tam HTML veya PDF’nin tamamı Groq’a gönderilmeyecektir.

1. Atıf cümlesi ve önceki üç cümleden anahtar kavramlar çıkar.
2. Yayın metnini bölüm/paragraf veya sayfa bloklarına ayır.
3. Sözcüksel puan ve gerektiğinde yerel benzerlik hesabıyla en ilgili pasajları seç.
4. Groq’a atıf cümlesi, bağlam, yayın kimliği, sürüm bilgisi ve seçilen pasajları gönder.
5. Modelden her iddia için kısa, birebir kanıt alıntısı iste.
6. Alıntının gerçekten gönderilen pasajda bulunduğunu mevcut deterministik kontrolle doğrula.
7. Özet kullanıldıysa karar kapsamını özetle sınırla.

Web sayfası metni de üçüncü taraf ve güvenilmeyen veri olarak işaretlenecektir. Sayfadaki talimatlar modele komut olarak uygulanmayacaktır.

## Aşama 7 Kaynak bazlı iş kuyruğu ve önbellek

- İçerik edinme işi atıf başına değil kaynak başına çalışacaktır.
- Bir PDF veya web sayfası bir kez indirilecek; aynı kaynağa bağlı bütün atıflar aynı metni kullanacaktır.
- Önbellek anahtarı DOI, arXiv kimliği veya normalize edilmiş canonical URL olacaktır.
- Başarılı metin, yönlendirme zinciri, kimlik sonucu ve sürüm uyarısı belge oturumunda saklanacaktır.
- Geçici 429/5xx hataları gerçek `Retry-After` ve hız sınırı başlıklarıyla yeniden denenecektir.
- Kalıcı 401/403, robots/giriş duvarı veya paywall durumu diğer aday kaynaklara geçişi durdurmayacaktır.
- Kullanıcı yeni PDF yüklediğinde o kaynağın eski içerik sonuçları geçersiz kılınacak ve bağlı atıflar yeniden sıraya alınacaktır.

## Aşama 8 Arayüz ve canlı tanılama

Kaynak kartında aşağıdaki edinme durumu gösterilecektir:

- Kaynak sayfası açılıyor
- Yönlendirme takip ediliyor
- HTML makale metni çıkarılıyor
- PDF indiriliyor
- PDF metni çıkarılıyor
- Yayın kimliği doğrulanıyor
- Yalnız özet bulundu
- Alternatif sürüm onayı gerekiyor
- Groq değerlendirmesi bekliyor
- Değerlendirme tamamlandı

Canlı sorgu alanında istek adresi, nihai adres, HTTP durumu, içerik türü, dosya boyutu, yönlendirme sayısı ve seçilen edinme yöntemi gösterilecektir. API anahtarı, tam yayın metni ve Groq istemi gösterilmeyecektir.

Kullanıcı işlemleri:

- `Bu sürümü kabul et ve bağlı atıfları yeniden denetle`
- `Nihai PDF yükle`
- `Web kimliğini kabul et`
- `Kaynağı yeniden edin`
- `Edinme ayrıntılarını göster`

## Aşama 9 Hata modeli

Tek bir genel hata yerine yapılandırılmış nedenler kullanılacaktır:

```text
identity_unconfirmed
version_confirmation_required
redirect_blocked
access_denied
paywall
not_article_content
pdf_too_large
pdf_no_text
html_no_article_text
fulltext_unavailable
abstract_only
rate_limited
temporary_service_error
```

Kullanıcı mesajı, son hatanın yanında denenmiş yöntemleri de özetleyecektir. Örnek:

```text
Tam metin bulunamadı. DOI yayıncı sayfasına yönlendi; yayıncı PDF’si 403 döndürdü.
OpenAlex açık kopya sağlamadı. Crossref özeti bulunmadı. PDF yükleyebilirsiniz.
```

## Güvenlik sınırları

- Yalnız HTTPS adresleri kullanılacaktır.
- Her yönlendirmede DNS yeniden çözülecek; localhost, özel ağ, link-local ve metadata servisleri engellenecektir.
- Kullanıcı adı, parola, özel port ve kimlik bilgisi içeren URL’ler reddedilecektir.
- İndirme süresi, yönlendirme sayısı ve içerik boyutu sınırlanacaktır.
- Sıkıştırılmış içerik açma oranı sınırlandırılacaktır.
- HTML çalıştırılmayacak; DOM yalnız metin çıkarma amacıyla ayrıştırılacaktır.
- API anahtarları istemciye ve debug kayıtlarına yazılmayacaktır.
- Groq’a yalnız seçilmiş pasajlar gönderilecektir.

## Test planı

### Birim testleri

- HTML `Article` ve JSON-LD çıkarımı
- Script, menü, reklam ve prompt injection metni temizliği
- PDF imza ve içerik türü tanıma
- Uzantısız PDF URL’si
- Çok adımlı DOI yönlendirmesi
- Yönlendirme sırasında özel ağa geçişin engellenmesi
- Paywall ve giriş sayfasının tam metin sayılmaması
- Preprint beyanı çıkarımı
- DOI, başlık, yazar ve yıl kimlik puanı
- arXiv yazar ayrıştırması
- Aynı kaynağın yalnız bir kez indirilmesi
- 429/5xx yeniden denemesi ve iptal

### Entegrasyon testleri

| Kaynak | Beklenen sonuç |
|---|---|
| Roundy 2025 TechTarget | HTML ana metni çıkarılır ve atıflar Groq’a gönderilir |
| Smith 2025 Quench | HTML ana metni çıkarılır; künye ile kimlik doğrulanır |
| Microsoft 2026 PDF | Doğrudan PDF indirilir, metin çıkarılır ve değerlendirilir |
| Barnett-Itzhaki 2026 | DOI yönlendirmesi takip edilir; tam metin/özet veya açık kopya bulunur, bulunamazsa ayrıntılı zincir raporlanır |
| de Vries 2023 | DOI yayıncı sayfası takip edilir; erişilebilir içerik veya özet kullanılır |
| Herrera 2025 | EarthArXiv ön baskısı bulunur; açık preprint uyarısı ve tek kaynak onayı gösterilir |
| Lei 2025 | eScholarship PDF 200 ile alınır; alternatif sürüm bilgisi gösterilir |
| Han 2026 | arXiv PDF otomatik kabul edilir; gereksiz sürüm uyarısı çıkmaz |
| Soares, Wang, Data Driven Lab | Doğrudan PDF bağlantıları HTML doğrulamasına takılmadan işlenir |
| LBNL ve Congress.gov 403 | Alternatif adaylara devam edilir; 403 tek başına tüm işi durdurmaz |

### Regresyon testleri

- Kaynakça doğrulama sayfasındaki mevcut Crossref ve arXiv sonuçları değişmemeli.
- Mevcut Groq kota bekleme ve devam mekanizması korunmalı.
- Kullanıcı PDF’si, özet ve açık erişim PDF akışları çalışmaya devam etmeli.
- Word paragraf düzenleme, otomatik kayıt ve indirme davranışı korunmalı.
- Aynı kaynağa bağlı sonuçlar belge yeniden açıldığında kaybolmamalı.

## Uygulama sırası

1. Ortak içerik sonucu veri modelini ve yapılandırılmış hata kodlarını ekle.
2. Doğrudan PDF ve içerik türü algılamasını uygula.
3. DOI yönlendirme ve yayıncı metadata çözümlemesini uygula.
4. Güvenli HTML makale metni çıkarımını uygula.
5. Kimlik ve sürüm doğrulamasını ortaklaştır.
6. arXiv yazar ayrıştırması ile DOI başlık/yıl yanlış pozitiflerini düzelt.
7. Kaynak bazlı önbellek ve bağlı atıfları toplu yeniden denetleme mekanizmasını ekle.
8. Canlı sorgu ekranını edinme aşamalarıyla genişlet.
9. Örnek kaynaklarla entegrasyon ve tam regresyon testlerini çalıştır.
10. Mevcut 1142_BESTAS_copyedited belgesini yeniden denetleyip önceki 47 değerlendirilemeyen kaydın yeni dağılımını raporla.

## Tamamlanma ölçütleri

- DOI’siz doğrulanmış HTML kaynakları içerik değerlendirmesine girebilmelidir.
- Doğrudan PDF URL’leri kullanıcıdan yeniden yükleme istemeden işlenebilmelidir.
- DOI yönlendirme zinciri ve yayıncı sayfasındaki erişilebilir içerik takip edilmelidir.
- Aynı kaynak birden fazla atıfta yalnız bir kez edinilmelidir.
- Ön baskı ve alternatif sürümler açık uyarıyla kullanıcı onayına sunulmalıdır.
- Kalıcı bir servis hatası diğer içerik adaylarının denenmesini engellememelidir.
- Kullanıcı her başarısız kayıtta hangi adreslerin ve yöntemlerin denendiğini görebilmelidir.
- Roundy, Smith ve Microsoft örnekleri Groq içerik değerlendirmesine ulaşmalıdır.
- Han kaydı otomatik ilerlemeli; Herrera kaydı preprint uyarısı göstermelidir.
- Yeni davranış mevcut testleri bozmamalı ve eklenen edinme testlerinin tamamı geçmelidir.
