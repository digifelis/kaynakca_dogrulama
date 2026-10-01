# Web kaynakları için doğrulama yöntemi

Tarih: 30 Eylül 2026
Durum: URL üzerinden ilk entegrasyon tamamlandı. Aşağıdaki yöntem uzun vadeli tasarımdır; uygulanmış kapsam ve farklar bu bölümde belirtilmiştir.

Uygulanan kapsam: güvenli HTTP(S) sayfa alma, H1/JSON-LD/meta alanları, açık etiketli yayın tarihi, alan bazında karşılaştırma, öneriyi kullanıcı seçimiyle uygulama, metin ve Word akışları, bellek önbelleği ve alan adına göre kota erteleme. Web kotasında bu sürüm hemen erteleyip diğer kayıtlara geçer; aşağıdaki iki denemeli/60 saniyelik politika uygulanmadı. Yeniden doğrula kullanıcı tarafından başlatılır.

Henüz uygulanmayan kapsam: otomatik arama motoru ve arşiv yedeği, tarayıcıda JavaScript çalıştırma, görünür yazar satırlarının genel amaçlı ayrıştırılması, PDF/rapor/akademik sayfanın otomatik başka doğrulama yoluna aktarılması. Yazar JSON-LD veya author metadata alanından alınır; eksik/çelişkili sonuçlar inceleme durumunda korunur. Web içerik iddiaları için tam metin analizi bu entegrasyonun kapsamında değildir.

Canlı kontrol: 30 Eylül 2026 tarihinde üç örnek sayfa da uygulamanın HTTP istemcisiyle okunabildi. Statik metadata ve görünen başlık/tarih alanları çıkarıldı. Bu erişim garantisi değildir; sonraki istekler site koşullarına bağlıdır.

## Amaç

Haber, kurumsal blog ve diğer web kaynaklarında sayfa kimliğini ve künyeyi doğrulamak. Sayfanın varlığı, künyenin doğruluğu ve içerikteki iddiaların doğruluğu ayrı sonuçlardır. Bu akış ilk ikisini değerlendirir; iddialara doğruluk onayı vermez.

## 1. Tür ve URL ayrıştırma

- Özgün kayıt saklanır. Markdown bağlantısının görünen metni ile hedef URL ayrı alınır; aynı URL iki kez sorgulanmaz.
- Fazla boşluklar, satır sonları ve bölünemez boşluklar karşılaştırma için normalleştirilir. Başlığın noktaları ve tarihin ay/gün bilgileri korunur.
- DOI URL'si akademik akışa gider. DOI olmayan URL önce sayfa türü açısından incelenir. URL taşıyan her kayıt web haberi sayılmaz: dergi makalesi, rapor ve PDF ayrımı yapılır.
- URL yoksa ve web kaynağı izleri varsa başlık/yazar/site araması aday üretir. Sadece DOI yokluğundan web kaynağı kararı verilmez.
- Web kaydı olarak tanınan kaynaklar genel akademik dizin zincirine otomatik gönderilmez.

## 2. Sayfaya erişim

- İlk tercih verilen URL'dir. Giriş URL'si, yönlendirmeler, son URL, canonical URL ve denetim zamanı ayrı tutulur.
- HTTP 200 tek başına başarı değildir: giriş, bot kontrolü, ana sayfa ve hata şablonları ayıklanır.
- Canonical işareti tek başına kimlik kanıtı değildir. Başlık ve yazı kimliğiyle karşılaştırılır; başka alan adına işaret etmesi inceleme gerektirir.
- Önce statik HTML alınır. Eksikse ve erişime izin veriliyorsa tarayıcıda oluşturulan sayfa denenebilir. Üyelik veya CAPTCHA aşılmaz.
- Sunucu entegrasyonunda yalnız HTTP(S), dış ağ adresi denetimi, DNS adresi sabitleme, her yönlendirmede yeniden doğrulama, süre/boyut/yönlendirme sınırı gerekir. Siteye akademik servis anahtarları veya kullanıcı oturum bilgileri iletilmez.

## 3. Alan bazında kanıt toplama

Her değer şu bilgilerle tutulur: değer, çıkarım yöntemi, kaynak URL, alınma zamanı, kanıt konumu ve çelişkiler.

| Alan | Karşılaştırılacak kanıtlar | Karar |
|---|---|---|
| Başlık | Yazıya ait görünen H1, JSON-LD headline, Open Graph başlığı, HTML title | Görünen yazı başlığı tercih edilir; SEO başlıkları alternatif olarak saklanır. Birbiriyle ilgisiz değerler inceleme gerektirir. |
| Yazar | Görünen yazar satırı, JSON-LD author, ilgili meta alanları | Kişi, kurumsal yazar, yayıncı, editör, inceleyen ve fotoğraf kredisi ayrılır. Kişisel yazar varken site adı otomatik yazar yapılmaz. |
| Yayın tarihi | Açıkça etiketlenmiş yayın tarihi, datePublished | Gün/ay/yıl ayrı karşılaştırılır. |
| Güncelleme tarihi | Açıkça etiketlenmiş güncelleme tarihi, dateModified | Yayın tarihinden ayrı saklanır. Otomatik olarak yayın tarihinin yerine geçirilmez. |
| Site/yayıncı | Sayfanın yayıncı bilgisi, publisher, site adı | Yazar alanından bağımsız saklanır. |
| URL | Giriş, son URL, canonical, yazıya ait kimlik | Yönlendirme ana sayfaya gidiyorsa kaynak bulundu sayılmaz. |

JSON-LD'de bütün author veya date alanları toplanıp birleştirilmez. Article/NewsArticle/BlogPosting düğümünün incelenen sayfaya ait olduğu URL, mainEntityOfPage veya kimlik ilişkisiyle kontrol edilir. WebSite, Organization ve ilgili yazıların alanları karıştırılmaz. Aynı sitenin farklı metadata alanları bağımsız doğrulama kaynakları sayılmaz.

Telif yılı, HTTP Date, Last-Modified, URL yolundaki yıl, sitemap lastmod ve arama motoru tarama zamanı yayın tarihi yerine kullanılmaz. Tarih kanıtı yoksa eksik olarak bırakılır. Kullanıcının verdiği yıl sessizce değiştirilmez.

Alan tanımları: https://schema.org/Article

## 4. Kimlik ve künye kararları

Tek bir ağırlıklı puanla otomatik düzeltme yapılmaz. Önce sayfanın aynı kaynak olup olmadığı, sonra her alanın uyumu değerlendirilir.

| Sonuç | Gerekçe | Çıktı |
|---|---|---|
| Web künyesi doğrulandı | Yazı kimliği belirli, verilen alanlar sayfayla uyumlu, önemli çelişki yok | Künye biçimlendirilebilir. |
| Kaynak bulundu — düzeltme önerisi | Aynı sayfa, fakat yazar/tarih/başlık farklı | Alan farkları ve kanıt gösterilir; kullanıcı uygulayana kadar özgün kayıt korunur. |
| Kısmen doğrulandı | Kimlik için yeterli kanıt var; bazı alanlar eksik veya yalnız sınırlı metadata görülebiliyor | Doğrulanan ve doğrulanamayan alanlar ayrı gösterilir. |
| İnceleme gerekli | URL ve başlık farklı yayınları gösteriyor veya sayfa içi kanıtlar çelişiyor | Otomatik kaynak değişimi yapılmaz. |
| Erişim engeli | 401/403, bot kontrolü veya üyelik nedeniyle gerekli künye kanıtı alınamıyor | Kaynağın yokluğuna hükmedilmez. |
| Bağlantı bulunamadı | URL 404/410 veriyor | Alternatif adres/arşiv araştırılır; yayın yok sayılmaz. |
| Kota nedeniyle ertelendi | 429 ve bu tur içinde yeniden deneme mümkün değil | Tur tamamlanır; tekrar deneme zamanı sunulur. |

Başlık benzerliği aday sıralama için kullanılabilir. Geçici sayısal eşikler başarı olasılığı diye gösterilmez; otomatik karar eşiği daha geniş etiketli test kümesiyle belirlenir. Yazar veya tarih eksikliği tek başına farklı kaynak anlamına gelmez.

## 5. Arama ve arşiv yedeği

Doğrudan URL'de kimlik/alanlar çözülemezse şu sıra uygulanır:

1. Aynı alan adında tam başlık araması.
2. Aynı alan adında ayırt edici başlık sözcükleri ve yazar.
3. Tam URL araması ve yayıncının kendi arama/arşiv sayfası.
4. Varsa tarihli web arşivi görüntüsü. Arşiv görüntüsünün tarihi ile sayfanın yayın tarihi ayrı gösterilir.

Arama sonuçları aday bulur; sonuç özeti tek başına tam doğrulama sağlamaz. Başka sitelerdeki yeniden yayımlar özgün URL yerine sessizce kullanılmaz. Arama erişimi için ürün içinde ayrıca sağlayıcı entegrasyonu gerekir; bu sohbetin web aracı uygulamada mevcut bir API değildir.

Örnek sorgular:

```text
site:bloomberg.com/graphics/ "2025-ai-impacts-data-centers-water-data"
site:restofworld.org "Big Tech is building AI in the desert" "Bhat"
site:quench.culligan.com "average-water-usage-per-person-in-offices"
```

## 6. Sınırlı bekleme politikası

Başlangıç uygulama kararı: alan adı başına aynı anda bir istek, en az 1 saniye aralık, istek başına 15 saniye sınır; bir turda ilk isteğe ek en fazla iki yeniden deneme. Bunlar servislerin izin verdiği hız garantisi değildir.

429 yanıtında Retry-After korunur. En az bildirilen süre beklenir; bu süre turun 60 saniyelik bekleme bütçesini aşıyorsa daha erken istek gönderilmez, kayıt ertelenir. Başlık yoksa ilk bekleme 60 saniye kabul edilir. Tekrar 429 alınırsa kalan bütçe ölçülür ve gerekirse ertelenir. İşlem sonsuza kadar açık kalmaz.

Bekleme aynı alan adına paylaşılır; başka sitelerdeki kayıtlar devam eder. Erteleme süresinin dolması kendi başına yeni istek başlatmaz; kullanıcı yeniden denemeyi seçer. Başarılı künye sonuçları kısa süreli yerel bellek önbelleğinde tutulur. Tam sayfa ve kullanıcı kaynakçası varsayılan olarak kalıcı kaydedilmez.

## 7. Verilen örneklerden çıkarılan kabul durumları

30 Eylül 2026 tarihinde sohbet web aracıyla yayıncı sayfalarının erişilebilen metinleri incelendi. Bu, ürünün kendi HTTP istemcisinin aynı sayfalara erişebildiğini veya ham JSON-LD alanlarının doğrulandığını göstermez. Arama/tarama önbellekleri bulunabilir.

- Bloomberg örneği: kaynak bulundu, künye değişikliği incelemeye sunulmalı. Kanıt: https://www.bloomberg.com/graphics/2025-ai-impacts-data-centers-water-data/
- Rest of World örneği: verilen künye görünür yazı bilgileriyle uyumlu; SEO başlığının farklı olması yanlış eşleşme üretmemeli. Kanıt: https://restofworld.org/2025/gulf-ai-water-crisis/
- Culligan örneği: kaynak bulundu, yazar ve tarih farkı incelemeye sunulmalı; footer yılı yayın tarihi kabul edilmemeli. Kanıt: https://quench.culligan.com/blog/average-water-usage-per-person-in-offices/

## 8. Entegrasyon ve test kapsamı

Önerilen bileşenler: sunucuda güvenli sayfa getirme ve metadata ayrıştırma; ortak motorda tür yönlendirme ve web alan karşılaştırması; hem metin hem Word akışında aynı sonuç modeli; web türüne uygun APA biçimlendirme; kartta alan bazında kanıt ve öneri uygulama.

Mevcut motordaki ilk-yıl ve ilk-nokta yaklaşımı tam tarihler ve çok cümleli web başlıkları için genişletilmelidir. Mevcut akademik puanlama ve dergi biçimlendiricisi web künyesine aynen uygulanmamalıdır. Word kaynak doğrulama bu türü destekleyebilir; mevcut DOI temelli içerik indirme yolu web metinlerini otomatik destekliyor sayılmaz.

Kabul testleri: Markdown URL tekrarları; çoklu boşluk; noktalı başlık; kişisel/kurumsal yazar; inceleyen/fotoğrafçı ayrımı; H1/SEO farkı; yayın/güncelleme/telif tarihi ayrımı; aynı yıl farklı gün; ilgili yazı JSON-LD'sinin dışlanması; canonical çelişkisi; ana sayfaya yönlendirme; HTTP 200 hata şablonu; 403/404/429; uzun Retry-After; erişilebilir metadata fakat kapalı gövde; kötü amaçlı dış ağ hedefi; kullanıcı öneri seçiminin korunması; metin ve Word akışlarında kayıt sırası.

Üç canlı örnek yöntem tasarımına temel olur; genel başarı oranını ölçmek için yeterli değildir. Tekrarlanabilir testler yapay HTML örnekleriyle, site erişimi ise ayrı ve sınırlı canlı kontrollerle ölçülmelidir.
