# Word makalesi üzerinden kaynakça ve atıf denetimi

Tarih: 30 Eylül 2026
Durum: Word yükleme, kaynak doğrulama, atıf eşleştirme, seçilmiş düzeltmelerle Word indirme ve Groq içerik denetimi uygulandı. İlk sürümün kapsam ve sınırları README.md içinde açıklanır. Otomatik OCR, bütün yayıncıların tam metin kapsamı ve geniş uzman etiketli anlamsal doğruluk ölçümü bu sürümde bulunmaz; erişilemeyen/okunamayan kaynaklar açıkça değerlendirilemedi olarak raporlanır.

## Amaç ve mevcut uygulamayla ilişki

Kullanıcı makalesini Word dosyası olarak yükler. Uygulama kaynakça bölümünü çıkarır, mevcut kaynak doğrulama motoruyla kontrol eder, metin içi atıflarla eşleştirir ve sorunları belgedeki konumlarıyla raporlar. Kullanıcı önerileri seçerek uygular ve düzeltilmiş Word dosyasını indirir. Ayrıca her atıf için atıf cümlesi ve önceki üç cümle, ilgili yayından erişilen kanıtla karşılaştırılır.

Mevcut HTML/JavaScript arayüzü, Node sunucusu, sağlayıcı adaptörleri, API anahtarları ve hız/kota yönetimi kullanılacak. Bunun için tüm uygulamayı başka bir çatıya taşımak gerekmiyor. Kaynakça yapıştırma akışı korunacak; ayrı bir “Word makalesini kontrol et” akışı eklenecek.

Başlangıç kapsamı: `.docx`, Türkçe ve İngilizce, APA yazar–yıl atıfları. Eski `.doc`, `.docm`, şifreli dosyalar ve sayısal Vancouver/IEEE atıfları ilk sürümde açıkça kapsam dışında bildirilecek; başarıyla kontrol edilmiş gibi gösterilmeyecek.

## Kullanıcı akışı

1. `.docx` yüklenir; belge değiştirilmeden bir çalışma kopyası oluşturulur.
2. Kaynakça bölümü “Kaynakça / Kaynaklar / References / Bibliography” başlıkları, paragraf stilleri ve kayıt örüntüleriyle belirlenir. Bölüm belirsizse kullanıcı başlangıç ve bitiş paragraflarını seçebilir. Birden çok kaynakça bölümü ayrı gösterilir.
3. Çıkarılan kaynakça ve algılanan metin içi atıflar önizlenir. Kullanıcı yanlış ayrılmış kayıtları birleştirebilir/bölebilir veya eşleştirmeyi değiştirebilir.
4. Kaynak doğrulama ve atıf–kaynakça tutarlılık denetimi çalışır. Sonuçlar artımlı gelir; bir dizinin kotası diğer kayıtları durdurmaz.
5. Kullanıcı isterse içerik desteği denetimini başlatır. Bu aşamanın neyi dış servise göndereceği ve tam metin erişiminin durumu gösterilir.
6. Sorun kartlarında belge konumu, özgün metin, öneri, gerekçe ve varsa yayın kanıtı görünür. “Belgede göster”, “Düzeltmeyi uygula” ve “Geri al” işlemleri sunulur.
7. “Nihai Word dosyasını indir” ile sadece kabul edilmiş değişiklikleri içeren `.docx` alınır. Ayrı bir denetim raporu da indirilebilir. Çözülemeyen sorunlar indirmenin yanında sayılır; bunlar dosyadan silinmez.

## 1. Word'den kaynakçayı ve atıfları çıkarma

Word belgesi yeniden düz metinden oluşturulmayacak. DOCX paketindeki XML parçaları okunacak ve özgün belge yapısı korunacak. Paragraflar, metin parçaları, tablolar, dipnotlar ve sonnotlar ayrı konumlarla işlenecek. Üstbilgi/altbilgi ve kaynakça bölümü, ana metindeki atıf taramasından ayrılacak. Tablolardaki ve notlardaki atıflar kendi bağlamlarında denetlenecek.

Her metin aralığı için dosya parçası, paragraf kimliği, metin parçası/aralık konumu ve özgün metin özeti tutulacak. Word metni birden fazla `w:r` içinde bölünmüş olsa da bir atıf tek bütün olarak okunabilecek. Sayfa numarası yerleşim motoruyla hesaplanmadan kesin konum diye kullanılmayacak; rapor bölüm/paragraf ve metin alıntısıyla konum gösterecek.

Zotero, Mendeley ve Word alan kodları; içerik denetimleri ve mevcut değişiklik izleme verileri algılanacak. Atıf alanının yalnız görünen metnini değiştirip alanı gizlice bozmak yasak olacak. Güvenilir güncelleme adaptörü bulunmayan alanlar raporlanacak; kullanıcı belgeye uygulama yerine harici referans yöneticisinde düzeltmeye yönlendirilecek. Mevcut değişiklik izlemeli veya karmaşık öğeler güvenle değiştirilemiyorsa yalnız raporlama yapılacak.

Kaynakça kayıtları mevcut motorla doğrulanacak. APA italikleri Word'de `w:i` özelliğiyle yazılacak; HTML etiketleri Word metnine yapıştırılmayacak. Kayıt sıra numarası ve belge konumu, metadata güncellense de aynı kayıt kimliğine bağlı kalacak.

## 2. Atıf–kaynakça eşleştirmesi ve yetim kayıtlar

Bir atıf ile bir kaynakça kaydı arasında çoktan çoğa eşleşme kurulacak. Aynı kaynağın bütün atıf konumları birlikte görülebilecek.

| Bulgu | Tanım | Önerilen davranış |
|---|---|---|
| Kaynakçası olmayan atıf | Metinde atıf var, kaynakçada güvenilir eşleşmesi yok | Eksik kaydı ve atıf konumunu raporla; kaynak kimliği doğrulanırsa ekleme öner |
| Atıf almayan kaynak | Kaynakçada kayıt var, taranan metin/notlarda atıf yok | Kullanım bulunamadığını raporla; otomatik silme |
| Yazar uyuşmazlığı | Aynı yayın olduğu belirlenen kayıtta soyad/yazar grubu farklı | Önce/sonra göster; kullanıcı seçerse belirli atıf konumunu düzelt |
| Yıl uyuşmazlığı | Eşleşen atıf ve kaynakça yılları farklı | Çevrimiçi/basılı/önbaskı tarihlerini incele; belirsizse aday seçtir |
| Belirsiz eşleşme | Aynı soyad/yıl veya çok benzer yayınlar var | Otomatik bağlama; adayları göster |
| Yinelenen kaynak | Aynı yayın birden çok kayıtla yazılmış | Birleştirme öner; atıf bağlantılarını koru |
| Denetlenemeyen alan | Atıf bölgesi veya alan kodu güvenle okunamıyor | Kapsam eksikliğini göster; kesin “yetim” kararı verme |

Desteklenecek örüntüler: `(Yılmaz, 2020)`, `Yılmaz (2020)`, iki yazarlı atıflar, `et al.` / `vd.`, bir parantezde birden fazla kaynak, sayfa belirteçleri ve `2020a/2020b` ayrımı. Kurumsal yazarlar, birleşik soyadlar, Türkçe karakterler ve aynı soyadı taşıyan farklı yazarlar için özel kurallar olacak. Kişisel iletişim gibi APA'da kaynakçaya alınmayan atıflar yetim olarak işaretlenmeyecek. `t.y.` / `n.d.` gibi tarihsiz kayıtlar da ayrı eşleştirilecek.

Yaklaşık soyad eşleşmesi yalnız öneri üretir; yazarı başka bir kişiyle değiştirmek için yeterli olmaz. Soyad/yıl eşleşmesi bulunamaması tek başına yayın yokluğu değildir. `a/b` harfleri bir grup içindeki alfabetik sıralama ve bütün ilgili atıflar birlikte ele alınarak önerilecek.

## 3. Kullanıcı seçimiyle Word içinde düzeltme

Her öneri ayrı bir değişiklik nesnesi olacak: hedef belge/aralık, beklenen özgün metin, önerilen metin, gerekçe, kanıt, etkilenen atıf/kaynakça kayıtları ve uygulanma durumu.

“Düzeltmeyi uygula” yalnız o öneriyi çalışma kopyasına uygular. Aynı kaynağın birçok atfı etkilenecekse konumları gösterilir; tek konum veya seçilmiş tüm konumlar uygulanabilir. Kaynakçadaki yılın değiştirilmesi ile atıf yılının değiştirilmesi ayrı ve açık işlemlerdir. Kullanıcı kabulü, kaydın otomatik doğrulandığı anlamına gelmez.

Global metin değiştirme kullanılmayacak. Değişiklik, konum ve beklenen özgün metin hâlâ tutarlıysa uygulanacak. Çakışan, eski konuma dayanan veya başka bir kabul edilen düzeltmeyle örtüşen öneri yeniden değerlendirilecek. Her işlem geri alınabilecek. Kabul edilmiş değişiklikler arka plan sorguları yenilenince kaybolmayacak.

Dosya dışa aktarılırken özgün paket üzerinden yalnız değişen XML aralıkları güncellenecek. Resimler, tablo yapıları, stiller, bağlantılar, bölüm ayarları, notlar ve değiştirilmemiş XML parçaları korunacak. “Word'de sorunsuz açılıyor” kontrolünün yanında, değiştirilmeyen öğelerin korunması da test edilecek. Orijinal yükleme dosyasının üzerine yazılmayacak.

Önerilen dosyalar: `makale_duzeltilmis.docx` ve `makale_denetim_raporu.html`. Rapor Word olarak da dışa aktarılabilir; rapor içeriği makalenin gövdesine kendiliğinden eklenmeyecek.

## 4. Atfın ilgili yayın tarafından desteklenmesi

Bu denetim, cümlelerin yayında harfi harfine bulunmasından daha kapsamlıdır: aktarma, özetleme ve Türkçe/İngilizce çeviri doğru olabilir. Harfi harfine eşleşme, yalnız doğrudan alıntılarda ek bir kontrol olarak kullanılacak.

Her atıf için atfın bulunduğu cümle ve önceki üç cümle alınır. Cümle sınırlarında baş harfler, kısaltmalar, ondalık sayılar ve `et al.` gibi örüntüler dikkate alınır. Önceki paragraftan bağlam alınabilir; bölüm başlığını, kaynakçayı veya ilgisiz tablo/not sınırını aşılmaz. Üç önceki cümle yoksa bulunan bağlam kullanılır ve bu eksiklik belirtilir. Kullanıcı bağlam önizlemesini görür ve atfın bağlı olduğu cümleyi değiştirebilir.

İşlem hattı:

1. Atfın kaynakça eşleşmesini kesinleştir; belirsiz kaynağı içerik denetimine göndermeden kullanıcıya bildir.
2. Yayının kimliğini ve sürümünü doğrula. Metadata kaydı, özet ve tam metin ayrı erişim düzeyleri olarak tutulur.
3. Öncelikle erişime açık XML/JATS veya HTML tam metni kullan; ardından metin içeren PDF. Yayıncı/açık arşiv bağlantıları doğrulanarak indirilir. Tarama PDF'leri için OCR kalitesi gösterilir. Erişilemiyorsa kullanıcı ilgili yayının PDF'sini yükleyebilir; bu dosya da kimlik eşleşmesinden geçer.
4. Tam metni bölüm/paragraf parçalarına ayır. Önce anahtar terim ve anlamsal aramayla ilgili pasajları getir; sonra iddia ile kanıtı karşılaştır.
5. Dört cümlelik bağlamın içindeki iddiaları ayır. Her iddia için destek, kapsam, örneklem, sayısal değerler, yöntem ve nedensellik ifadeleri değerlendirilir. Önceki üç cümle bağlamdır; hepsinin otomatik olarak aynı atfa yüklenmesi gerekmez.
6. Çok kaynaklı atıfta her yayın ayrı kontrol edilir; iddianın birlikte desteklenme olasılığı da raporlanır. Yayının kendi kaynakça listesinde bir ifadenin geçmesi, ana metinde destek olduğu şeklinde değerlendirilmez.
7. Kararı, kısa kanıt pasajı, bölüm/sayfa veya paragraf konumu, yayın bağlantısı/sürümü ve erişim düzeyiyle raporla. Kısa kanıt gösteriminde erişilen içeriğin lisansı gözetilir.

| Sonuç | Anlam |
|---|---|
| Destekleniyor | Erişilen yayın metninde iddiayı destekleyen açık pasaj var |
| Kısmen destekleniyor | İddianın yalnız bir kısmı destekleniyor veya kapsam daha dar |
| Çelişiyor | Yayında iddiayla açıkça ters düşen kanıt bulunuyor |
| Destek bulunamadı | Erişilen ve taranan metinde yeterli kanıt bulunamadı; kesin yanlışlık hükmü değildir |
| Yalnız özetle incelendi | Tam metin yok; sonuç sınırlı ve bu durum görünür |
| Değerlendirilemedi | Erişim, OCR, kimlik eşleşmesi, eksik bölüm veya model sorunu nedeniyle karar verilemedi |

Tam metnine erişilemeyen kaynak için “bu yayında geçmiyor” sonucu verilmeyecek. Konu benzerliği de tek başına destek kanıtı olmayacak. İçerik denetimi makaledeki iddiaları otomatik yeniden yazmayacak; bulgular raporlanacak.

Anlamsal değerlendirme için yapılandırılabilir bir model adaptörü gerekecek. Semantic Scholar API anahtarı bibliyografik veri erişimi sağlar; bu iş için tek başına yeterli değildir. Model sağlayıcısı/yerel model, maliyet ve metin aktarımı koşulları uygulama aşamasında kesinleştirilecek. Adaptör olmadan deterministik kaynakça/atıf kontrolleri çalışır; anlamsal kontrol başarı göstermeyecek, “yapılandırılmadı” diye bildirilecek. Model yanıtı şemaya uymalı ve dayandığı pasajda gerçekten bulunan kanıtla doğrulanmalı; kanıtsız model hükmü kabul edilmeyecek.

## Teknik bileşenler

| Bileşen | Sorumluluk |
|---|---|
| DOCX içe aktarma ve belge haritası | ZIP/XML okuma, paragraf/metin aralığı kimlikleri, kaynakça sınırları |
| Atıf ayrıştırıcı | Yazar–yıl, çoklu atıf, yıl harfleri, kurumsal/tarihsiz atıflar |
| Eşleştirme motoru | Atıf–kaynakça grafiği, yetim kayıtlar, uyuşmazlıklar |
| Yayın doğrulama | Mevcut sağlayıcılar, önbellek, hız/kota yönetimi |
| Tam metin erişimi | Açık erişim bağlantıları, XML/HTML/PDF, kullanıcı PDF'si, sürüm/lisans bilgisi |
| Kanıt denetimi | Bağlam çıkarma, ilgili pasajları bulma, iddia–kanıt karşılaştırması |
| Değişiklik yöneticisi | Önce/sonra, konum doğrulama, uygulama, geri alma, çakışma kontrolü |
| DOCX/rapor dışa aktarma | Seçilmiş değişikliklerle dosya üretimi ve belge bütünlüğü kontrolü |

Örnek sunucu işlemleri: belge yükleme, analiz başlatma, işlem ilerlemesi, öneri uygulama/geri alma, dosya indirme ve belgeyi silme. Büyük belgeler istek zaman aşımı içinde bitmeye zorlanmayacak; belgeye bağlı iş kuyruğu ve durdurulabilir işler kullanılacak. Bibliyografik ve anlamsal sonuçlar ayrı durum/sayaçlarla izlenecek. Model ve tam metin sorguları yayın kimliği ve sürüm bazında önbelleğe alınarak aynı yayının her atfı için yeniden indirilmesi önlenecek.

## Belge gizliliği ve dosya işleme

Yüklenen Word'ün tamamı bibliyografik API'lere gönderilmeyecek. Kaynak aramalarında gerekli künye alanları; dış model kullanılırsa yalnız gösterilmiş atıf bağlamı ve gerekli kanıt pasajları paylaşılacak. Bu yeni akışta mevcut “kalıcı saklanmaz” açıklaması gerçek geçici dosya davranışına göre güncellenecek.

Dosyalar rastgele oturum kimlikleriyle geçici tutulacak, web dosyaları arasından sunulmayacak; kapatma/silme veya süre aşımında temizlenecek. Boyut ve açılmış ZIP sınırları kontrol edilecek; ZIP yol kaçışı ve XML dış varlık çözümlemesi engellenecek. Uzak yayın indirmelerinde iç ağ/yerel adreslere yönlendirme engellenecek ve yönlendirmeler yeniden doğrulanacak. Belge metni veya API anahtarları günlüklere yazılmayacak. Makale ve yayın pasajları model için veri sayılacak; içlerindeki talimatlar uygulama yetkisi olarak kabul edilmeyecek.

## Uygulama sırası ve kabul ölçütleri

### Aşama A — DOCX yükleme ve kaynakça çıkarma

Belge haritası, kaynakça bölüm seçimi, kaynak önizlemesi ve mevcut doğrulama motoruyla entegrasyon. Kabul: çok satırlı ve tablo içindeki kaynaklar kaybolmuyor; belirsiz bölüm kullanıcı tarafından seçilebiliyor; değişiklik yapılmayan dosyanın yapısı korunuyor.

### Aşama B — Atıf–kaynakça tutarlılığı

Yazar–yıl ayrıştırma, atıf/kaynakça grafiği, iki tür yetim kayıt, yazar/yıl uyuşmazlıkları ve belge konumları. Kabul: önceden işaretlenmiş test belgelerindeki bulgular eşleşiyor; aynı soyad/yıl belirsizliği, kişisel iletişim ve kapsam dışı alanlar yanlış kesin karar üretmiyor.

### Aşama C — Belge içinde düzeltme ve indirme

Uygula/geri al, bir kaynağın seçilmiş atıflarını birlikte düzeltme, Word italikleri, çakışma denetimi ve indirilebilir dosya. Kabul: yalnız seçilmiş aralıklar değişiyor; Word dosyası onarım uyarısı olmadan açılıyor; resimler, tablolar, dipnotlar ve stiller korunuyor; bir düzeltme geri alınınca ilgili içerik eski haline dönüyor. Önceki uygulamada bulunan “Çıktıya uygula” kabul mantığı belge değişiklikleriyle tutarlı kullanılacak.

### Aşama D — Tam metin ve içerik desteği denetimi

Açık erişim/kullanıcı PDF'si, bağlamın dört cümle olarak çıkarılması, kanıt araması, model adaptörü ve içerik raporu. Kabul: sonuçlar kanıt konumuyla geliyor; erişilemeyen yayınlar değerlendirilemedi olarak kalıyor; yanlış kaynak/sürüm üzerinden karar verilmiyor; çeviri/parafrazlar yalnız kelime farkı nedeniyle reddedilmiyor.

### Aşama E — Birleşik doğrulama

Tam akış: yükle → kaynakçayı seç → kaynakları ve atıfları denetle → önerileri uygula → içerik raporunu incele → nihai Word'ü indir. Test kümesi basit APA, Türkçe/İngilizce, `a/b`, `et al./vd.`, kurumsal yazar, dipnot/tablo, bölünmüş Word metin parçaları, alan kodları, değişiklik izleme, bozuk/şifreli dosya, erişilemeyen yayın ve API kotası örneklerini içerecek.

İçerik denetimi ayrıca uzmanların işaretlediği destek/kısmi destek/çelişki/erişimsizlik örnekleriyle değerlendirilecek. Yanlış destek kararı, yanlış çelişki kararı ve karar verilmeyen örnekler ayrı ölçülecek; yalnız örnek bir başarılı makale üzerinden doğruluk iddiası yapılmayacak.

Önce A–C ile çalışan Word denetimi ve indirme tamamlanacak; ardından D–E eklenecek. Bu sıralama, tam metin/model erişiminden bağımsız olarak ilk üç isteğin kullanılabilir olmasını sağlar.

## Dayanaklar ve uygulama öncesi doğrulamalar

- [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/): bibliyografik metadata verir; tam metin varlığı garanti değildir.
- [PMC geliştirici araçları](https://pmc.ncbi.nlm.nih.gov/tools/developers/): bütün PMC içerikleri otomatik yeniden kullanım için aynı erişim koşullarında değildir.
- [PMC OAI-PMH](https://pmc.ncbi.nlm.nih.gov/tools/oai/): yeniden kullanıma uygun içerikler için tam metin erişimi sağlar; lisans ve erişim bilgisi kaydedilir.

Uygulama öncesinde ZIP/XML ve Word önizleme bileşenleri; alan kodlarının gerçek örneklerdeki yapısı; tam metin sağlayıcılarının güncel API koşulları ve anlamsal model adaptörü doğrulanacak. Tam metin kapsamı veya Word biçim koruması doğrulanmadan eksiksiz destek iddiasında bulunulmayacak.
