# Kaynakça Masası

Kaynakçayı yapıştırıp açık akademik kayıtlarla karşılaştıran, güçlü eşleşmeleri APA 7 biçiminde düzelten tek sayfalık ilk sürüm.

## Çalıştırma

Node.js 20 veya üzeri gerekir. Kurulum veya derleme adımı yoktur. Proje klasöründe:

```powershell
node server.cjs
```

Sonra `http://localhost:4173/` adresini açın.

## Akış

Üst menüde üç ayrı sayfa bulunur: `/#/kaynakca` kaynakça doğrulaması, `/#/word` Yetim Kaynak kontrolü, `/#/icerik` yayınlarla içerik karşılaştırması. Yetim Kaynak kontrolü ve içerik kontrolü ayrı Word yüklemeleri ve bağımsız belge oturumları kullanır. Dosya değiştirme, silme, düzeltme ve durdurma yalnız ilgili sayfanın belgesini etkiler. Sayfalar arasında geçiş her sayfanın kendi dosyasını, sonuçlarını ve işlemlerini korur. Sayfa yenilendiğinde son açılan belge arşivden geri yüklenir. İçerik kontrolü sayfasına Word dosyanızı ayrıca yükleyin; kaynak kimliklerini ve atıf eşleşmelerini aynı sayfada inceleyin.

Word incelemesinde **Atıf sorunları**, **Yetim atıflar**, **Yetim kaynakça**, **Atıflar ve içerik kanıtları** ve **Kaynakça kayıtları** ayrı listelerde gösterilir. Sayaçlara tıklayarak liste değiştirebilir, etkin listede arama yapabilirsiniz. Bulguların **İlgili paragrafı göster** çekmecesi metni kartın içinde açar. İçerik listesinde sonuç durumuna göre filtreler bulunur. Açık çekmeceler ve toplu düzeltme seçimleri liste değişikliklerinde korunur. İndirilen denetim raporu arama ve filtrelerden bağımsız olarak tüm kayıtları içerir.

1. Kaynakçayı metin alanına yapıştırın veya örneklerden birini seçin.
2. APA 7 biçimini seçin.
3. `Doğrula ve düzelt` düğmesine basın.
4. Kayıt kartlarında eşleşme puanını, sağlayıcıyı ve yapılan değişiklikleri inceleyin.
5. Düzeltilmiş kaynakçayı kopyalayın.

Sorgular yerel Node sunucusundan akademik servislerin uç noktalarına iletilir; bu katman tarayıcı CORS kısıtlarını azaltır. Kayıt sayısı sınırı yoktur. Önce tüm kayıtlar Crossref üzerinden taranır; yalnız eşleşmeyenler ikinci aşamada ek kaynaklara gönderilir. Crossref başlık/yazar kimlik eşleşmesi varsa yıl veya DOI uyuşmazlığı inceleme gerektirir, Semantic Scholar'a gönderilmez. Crossref DOI istekleri arasında en az 200 ms (en çok 5/s), liste/başlık aramalarında 1000 ms (en çok 1/s) beklenir; sunucu yanıt başlıklarında daha düşük hız bildirildiğinde aralığı büyütür. Semantic Scholar için en az 1000 ms (en çok 1/s) beklenir. Her sağlayıcıda aynı anda yalnız bir istek gönderilir. Yanıtlar yalnız bellekte önbelleğe alınır. Ağ veya erişim sorunları “Kontrol tamamlanamadı” olarak gösterilir; “Bulunamadı” sonuçlarından ayrı sayılır. Uygulama kaynakça metnini kalıcı olarak saklamaz. Dizinlere arama için başlık, yazar veya DOI iletilir.

HTTP 429 kota/hız sınırında kayıt atlanmaz: [Retry-After](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Retry-After) başlığındaki saniye veya tarih kadar beklenir, ardından aynı sorgu yeniden gönderilir. Başlık yoksa/geçersizse 60, 120, 240 saniye şeklinde artan, en çok 15 dakikalık bekleme aralıkları kullanılır. Servis yanıt verene veya kullanıcı durdurana kadar yeniden deneme sürer; günlük kotanın açılmasını da bekleyebilir. Arayüz sağlayıcı adını ve geri sayımı gösterir. Tamamlanan kayıtlar korunur, bekleme bitince aynı kayıttan devam edilir. Durdur düğmesi etkin sorguyu/beklemeyi iptal eder; kalan kayıtlar çıktıda özgün bırakılır. Yerel sunucu da sağlayıcıya ait bekleme süresini paylaşır; başka sorgular bekleme sırasında dış servise gönderilmez. Sayfa yenilenirse devam eden işlemin konumu korunmaz. Ağ/5xx hatalarında üç deneme ve istek zaman aşımı geçerlidir.

DOI Crossref'te bulunamazsa DataCite kontrol edilir; DOI başarısızlığı başlık aramasını engellemez. Arama sonuçlarından beş aday başlık/yazar/yıl bilgileriyle karşılaştırılır. Belirsiz adaylar öneri olarak gösterilir ve toplu çıktıda özgün kaynak korunur.

APA çıktısında makale başlığı cümle düzenine çevrilir: başlığın ve alt başlığın ilk sözcüğü büyük yazılır. Kısaltmalar, bilimsel karma harfli terimler ve tanınan özel adlar korunur; özel ad tanıma eksiksiz değildir ve kullanıcı kontrolü gerekir. Dergi adı ve cilt italik, makale başlığı/sayı/sayfalar düz yazılır; kitap önerilerinde kitap adı italiktir. Biçimli çıktı hem kartlarda hem toplu kaynakçada gösterilir. Kopyala düğmesi HTML ve düz metni birlikte panoya yazar; Word'e yapıştırırken kaynak biçimlendirmesini koruyun. Biçimli pano desteklenmezse düz metin kopyalanır ve italiklerin korunmadığı belirtilir.

## Veri kaynakları

### Web kaynakları

Haber ve blog bağlantıları artık hem metin alanından hem Word kaynak doğrulamasından kontrol edilir. **Web kaynakları** örnek düğmesi üç örneği yükler. DOI içeren kayıtlar akademik akışta kalır; diğer HTTP(S) bağlantılar doğrudan web künye kontrolüne gider. Akademik makale/rapor olduğu tespit edilen sayfalar, PDF'ler ve okunamayan sayfalar açık durum mesajıyla özgün bırakılır.

Web doğrulaması görünen başlık, JSON-LD/author metadata, yayın tarihi, site adı ve canonical adresi inceler. Yayın/güncelleme tarihi ayrı gösterilir; telif yılı yayın tarihi yapılmaz. Sonuç kartındaki **Web künye kanıtları**, girilen/bulunan değerleri ve çıkarıldıkları alanları gösterir. Uyumlu künyeler biçimlendirilir; farklı veya eksik künyeler incelemeye sunulur. Yazar/tarih eksikse tahmini düzeltme üretilmez. Öneriler metin ekranında **Çıktıya uygula**, Word ekranında **Kaynakçada düzeltmeyi uygula** ile seçilir.

Web 429 yanıtında kayıt hemen ertelenir ve diğer kaynaklar devam eder; sonsuz yeniden deneme yapılmaz. Gösterilen zamandan sonra **Yeniden doğrula** ile tekrar deneyin. Bekleme alan adına paylaşılır, başarılı metadata beş dakika bellekte tutulur. İstek süresi 15 saniye, HTML boyutu 3 MB, yönlendirme sayısı dört ile sınırlıdır. İç ağ adresleri ve her yönlendirmenin hedefi kontrol edilir.

Bu sürüm statik HTML künyesini kontrol eder; otomatik arama motoru/arşiv taraması ve JavaScript ile oluşan sayfalar desteklenmez. Yazarın görünür satırı genel amaçlı ayrıştırılmaz; yazar için sayfanın yapılandırılmış bilgileri kullanılır. Bot/üyelik engeli kaynak yokluğu anlamına gelmez. Web künyesi doğrulaması içerik iddialarının doğrulandığı anlamına gelmez; Word içerik denetiminin mevcut PDF/DOI kapsamı sürer.

Yöntem ve kapsam: [WEB_VERIFICATION_PLAN.md](WEB_VERIFICATION_PLAN.md). Test: `node --test tests/web-reference.test.cjs`. İsteğe bağlı üç sayfalık canlı kontrol: `node scripts/check-web.cjs`.

Ek kaynak aşamasında kota bekleyen kayıt ertelenir ve diğer kayıtlar kontrol edilir. Toplu kaynakça bu aşamada görünür durumdadır; bekleyen kayıtlar özgün bırakılır ve ayrıca işaretlenir. Bekleme süresi dolduğunda yalnız bekleyen kayıtlar tekrar sorgulanır. Crossref hız sınırları için [güncel istek türü açıklaması](https://community.crossref.org/t/refining-rest-api-limits-for-improved-stability-and-reliability/16137) esas alınır.

Özet sayıları tıklanabilir filtrelerdir. İncelenmeli/doğrulandı/ek kaynak bekliyor gibi kategorilere tıklayın; Tümü tüm kartları geri getirir. Kaynakların özgün sıra numarası korunur; filtreleme toplu kaynakça çıktısını değiştirmez. Tarama güncellemeleri seçili filtreyi korur. Kota kartında bekleyen servis, sonraki deneme zamanı, yeniden kontrol sayısı ve son dış sorgu gösterilir. Bekleme süresi sağlayıcının en son bildirdiği süreyle güncellenir; sıradaki kayıt önceliği her tur değiştirilerek sürekli kotaya takılan bir kaydın diğer kayıtları engellemesi önlenir.

İnceleme gerekli kartlarında Çıktıya uygula düğmesi olası eşleşmeyi aynı sıradaki toplu kaynakça kaydına uygular; italikler ve biçimli kopyalama korunur. Özgün kayda dön düğmesi bu seçimi geri alır. Kullanıcının kabulü otomatik doğrulama durumunu değiştirmez; kayıt incelenmeli olarak kalır. Seçim, diğer kayıtlar arka planda güncellenirken korunur; yeni bir tarama veya sayfa yenileme seçimi sıfırlar. Otomatik doğrulanmamış tüm kartlarda Google Scholar’da ara bağlantısı özgün başlık/yazar/yıl ile yeni sekmede arama açar; başlık ayrıştırılamazsa özgün künye kullanılır. Arama yalnız bağlantıya tıklanınca açılır.

| Kaynak | Kullanım |
|---|---|
| Crossref, DataCite, OpenAlex | İlk akademik kayıt araması |
| PubMed, Europe PMC | Biyomedikal içerik algılandığında ek arama |
| DBLP | Bilgisayar bilimleri; bot kontrolü otomatik erişimi engelleyebilir |
| ERIC | Eğitim bilimleri |
| TR Dizin, İSAM | Türkçe kayıtlar; İSAM arşiv önerileri ayrıca incelenir |
| Semantic Scholar | Genel ek arama; anahtarsız kota sınırlı olabilir |
| CORE | Açık erişim arşivlerinde ek arama; sonuçlar inceleme önerisidir |
| OpenLibrary | DOI'siz kayıtlarda kitap önerileri; baskı/yıl kullanıcı kontrolü gerekir |
| Google Books | Sunucuda API anahtarı varsa kitap önerileri |
| ISSN | Dergi kimliği için manuel portal bağlantısı; makale varlığına kanıt sayılmaz |
| SOBIAD, TO-KAT | Manuel kontrol bağlantısı; doğrulanmış otomatik API erişimi kurulmadı |

Güçlü eşleşme bulununca gereksiz sorgular durur. Her kartta gerçekten sorgulanan dizinler gösterilir. API adaptörünün bulunması o servisin her zaman erişilebilir olduğu anlamına gelmez; kota, erişim reddi ve JSON yerine bot kontrolü gelmesi ayrıca işaretlenir.

30 Eylül 2026 canlı erişim kontrolünde PubMed, Europe PMC, ERIC, TR Dizin, İSAM, CORE ve OpenLibrary JSON yanıt verdi. DBLP HTML bot kontrolü, Semantic Scholar HTTP 429 ve anahtarsız Google Books HTTP 429 verdi. Bunlar o anki erişim durumlarıdır.

## İsteğe bağlı anahtarlar

`.env.example` dosyasını `.env` olarak kopyalayıp yalnız sahip olduğunuz anahtarları girin; ardından sunucuyu yeniden başlatın. OpenAlex, NCBI/PubMed, Semantic Scholar, CORE, Google Books ve Unpaywall için alanlar hazırdır. Unpaywall, `UNPAYWALL_EMAIL` alanında gerçek bir iletişim e-postası ister; bu alan boşsa `CROSSREF_MAILTO` kullanılır. Anahtarlar ve e-posta sunucuda tutulur; tarayıcıya yalnız yapılandırılmış olup olmadığı iletilir. `.env` web üzerinden sunulmaz.

Referans belgeler: [TR Dizin](https://development.trdizin.gov.tr/), [NCBI](https://www.ncbi.nlm.nih.gov/home/develop/api/), [ERIC](https://eric.ed.gov/pdf/Using_ERIC_API_for_Research_Topics.pdf), [Google Books](https://developers.google.com/books/docs/v1/reference/volumes/list), [OpenLibrary](https://openlibrary.org/dev/docs/api/search), [CORE](https://core.ac.uk/services/api).

## Dosyalar

- `index.html`: Türkçe arayüz ve erişilebilir yapı
- `styles.css`: renk/yazı tokenları, açık ve koyu tema, responsive düzen
- `ui.js`: Word yükleme alanında sürükle-bırak durumu ve belge listesinin katlanması
- `word-store.cjs`: belge arşivi; DOCX, PDF ve yayın metinleri ayrı dosyalarda, yalnız değiştiklerinde yazılır
- `app.js`: kullanıcı akışı, sonuç gösterimi ve kopyalama
- `reference-engine.js`: ayrıştırma, hız/kota yönetimi, sağlayıcı sorguları ve eşleştirme
- `providers.js`: ek kaynak adaptörleri, yayın türüne göre seçim ve kaynak kataloğu
- `server.cjs`: yerel API geçidi, sunucu anahtarları ve sağlayıcı hız yönetimi
- `PLAN.md`: kapsam, karar kuralları, aşamalar ve kabul ölçütleri

Uygulama makale ağırlıklıdır. Kitap ve arşiv adayları ayrıca incelenir. URL'li web kaynakları ayrı akışta kontrol edilir; kesinleşmeyen web, tez veya dizin dışı kaynakların özgün metni korunur.

## Test

## Word makalesi ve içerik denetimi

### PDF makaleler

Yetim kaynak ve içerik kontrolü sayfaları Word (.docx) yanında PDF de kabul eder. PDF salt okunur incelenir: metin sayfa düzeninden yeniden kurulur (pypdf yerleşim kipi); üstbilgi, altbilgi ve sayfa numaraları ayıklanır, sayfa sonunda bölünen paragraflar ve satır sonu tireleri birleştirilir, kaynakça asılı girintiden veya yazar–yıl kalıbından künyelere ayrılır. Atıf eşleştirme, kaynak doğrulama ve LLM içerik denetimi Word ile aynı çalışır; düzeltmeler dosyaya yazılamaz, düzeltilmiş dosya indirilmez, öneriler kartlarda ve raporda görünür. Metin katmanı olmayan (taranmış) PDF’ler için önce OCR gerekir; şifreli PDF’ler ve iki sütunlu düzenler desteklenmez veya sınırlıdır. Aynı makalenin Word ve PDF sürümleriyle yapılan karşılaştırmada künye ve atıf sayıları büyük ölçüde örtüştü; sınırlar şüpheliyse kaynakça bölümünü elle seçin. Test: `node --test tests/word-pdf.test.cjs`.

Ana sayfadaki Word alanına `.docx` yükleyin (en fazla 20 MB). Kaynakça başlığı bulunamazsa ilk/son paragrafı seçin. Kaynakları doğruladıktan sonra atıf–kaynakça bulgularındaki önerileri tek tek veya seçerek uygulayın. Belirsiz atıflarda kaynağı elle seçebilir, dört cümlelik bağlamı düzenleyebilirsiniz. Kaynakça satırlarının yanlış ayrılması durumunda komşu kayıtları birleştirin veya çok paragraflı kaydı ayırın. Yeniden ayırma önceki belge düzeltmelerini sıfırlar.

İçerik kontrolü Groq ve OpenRouter sağlayıcılarını destekler. `GROQ_API_KEY`, `GROQ_MODEL`, `OPENROUTER_API_KEY`, `OPENROUTER_ENABLED`, `OPENROUTER_MODELS` ve `OPENROUTER_SHARE` ayarları `.env` dosyasındadır; anahtarlar tarayıcıya gönderilmez. `OPENROUTER_ENABLED=false` olduğunda anahtar dosyada kalsa bile OpenRouter'a istek gönderilmez ve Groq için yedek olarak kullanılmaz. Atıf cümlesi, önceki üç cümle ve seçilen yayın pasajları etkin LLM sağlayıcısına iletilir. DOI kaynaklarında Europe PMC ardından Unpaywall açık erişim konumları, OpenAlex konumları, arXiv, Semantic Scholar açık PDF'si ve DOI yayıncı sayfası denenir. Unpaywall `best_oa_location` ile diğer OA konumlarındaki PDF ve tam metin sayfalarını sırayla kullanır. Hiçbir tam metin edinilemezse son çare olarak DOI kimliği eşleşen özet kullanılır; özet de yoksa PDF yükleme istenir. PDF kimliği otomatik DOI ile kesinleşmezse önizlemeyi inceleyip kabul edin. LLM sonuçları, kanıt alıntısının kaynak pasajında bulunması şartıyla raporlanır.

Uzun yayınlarda metin bölümleri BM25 benzeri sözcük/sayı eşleşmesiyle atıf cümlesine göre sıralanır; başlık/özet bölümü her zaman ilk istekte yer alır. Bölümler bu alaka sırasıyla LLM'e gönderilir; doğrulanmış alıntıyla tam destek bulunduğunda kalan bölümler için istek gönderilmez. Destek bulunamazsa veya kısmi/çelişkili sonuç çıkarsa kaynakça dışındaki tüm bölümler taranmaya devam eder; birleştirme isteği yalnız kanıt birden fazla bölümden geldiğinde yapılır. Atıf cümlesi ile yayın farklı dildeyse (Türkçe/İngilizce) önce tek bir küçük LLM isteğiyle iddia yayın dilinde arama terimlerine çevrilir ve sonuç bellekte önbelleğe alınır; bu adım `CONTENT_QUERY_EXPANSION=false` ile kapatılabilir. Sonuçtaki `coverage` alanı taranan/toplam bölüm sayısını ve erken durmayı gösterir. LLM istekleri veri tutarlılığı için seri işlenir. Varsayılan olarak isteklerin %20'si OpenRouter'a gönderilir; Groq HTTP 429/5xx döndürdüğünde uygun OpenRouter modeli hemen yedek olarak denenir. OpenRouter ücretsiz katmanı için istekler en az üç saniye aralıklıdır ve model hatasında yapılandırılmış model sırası kullanılır. Her iki sağlayıcının `Retry-After` ve hız sınırı başlıkları gerçek bekleme süresini belirler. Durdur düğmesi beklemeyi sonlandırır. İçerik denetimini tekrar başlatırken tamamlanmış ve değişmemiş sonuçlar korunur.

Yıl uyuşmazlığında aynı yazarın başka yayını veya ön baskı sürümü bulunabileceği için otomatik yıl düzeltmesi sunulmaz. Önce kaynakçayı doğrulayın, ardından atıf kartında kullanılan kaynağı seçip eşleşmeyi kabul edin; bundan sonra düzeltme önerisini uygulayabilirsiniz. Belirsiz eşleşmedeki adaylar kesin atıfsız kaynak sayılmaz. Yinelenen DOI, arXiv kimliği ve belirli yayın URL'leri ayrıca işaretlenir.

Tam metin erişiminde ilk sağlayıcı veya PDF engellenirse diğer açık erişim bağlantıları denenir. Açıkça belirtilmiş arXiv sürüm numarası korunur. Dergi yayını yerine ön baskı/yazar sürümü edinilirse bu sürüm içerik denetiminden önce kullanıcı tarafından kabul edilmelidir. PDF alıntılarında yalnız Unicode yazı biçimi ve boşluk farkları normalleştirilir; içerik/kelime farkı olan kanıt kabul edilmez. Kanıt reddedilirse sonuç açıklaması da buna göre değiştirilir.

Sekme veya satır sonu bulunan paragraflarda metin aralığı bu öğeleri kapsamıyorsa seçilen atıf düzeltilebilir; sekmeler, satır sonları ve yazı biçimleri korunur. Gerçek BESTAS belge regresyon testi: `node scripts/retest-bestas.cjs "makale.docx"`. Bu test yalnız kullanıcı seçimini taklit eden geçici kopyalar üzerinde yazma/geri alma yapar; giriş dosyasını değiştirmez.

Word dosyası özgün ZIP paketi üzerinden yalnız seçilen XML aralıkları değiştirilerek dışa aktarılır. Kaynakça dergi/cilt italikleri OOXML olarak uygulanır. Makale iddiaları otomatik yeniden yazılmaz; atıfı olmayan kaynaklar otomatik silinmez. Word dosyaları, yüklenen kaynak PDF’leri, düzenlemeler ve sonuçlar `data/documents` klasöründe kalıcı saklanır. `WORD_ARCHIVE_DIR` ile konum değiştirilebilir. Yeni yükleme eski belgeleri silmez. Belgelerim listesinden eski dosyalar ve PDF’ler açılır. Yalnız Belgeyi sil o belgenin arşivini kaldırır. Sunucu yeniden başladığında tamamlanan sonuçlar geri gelir; yarıda kalan işlemler düğmeyle yeniden başlatılır. İndirilen Word ve ayrı HTML raporu kullanıcıda kalır.

Kapsam: Türkçe/İngilizce APA yazar–yıl, tablo/dipnot/sonnot metni. `.doc`, `.docm`, şifreli Word, sayısal atıflar, üstbilgi/altbilgi taraması ve otomatik OCR desteklenmez. Zotero/Mendeley/Word alanları, içerik denetimleri, çizimler ve izlenen değişiklikler korunur; bu bölgelere düzeltme uygulanmaz. Aynı paragraftaki birden fazla kaynakça kaydı önce Word'de ayrılmalıdır. Yazar ve cümle ayrıştırması kurallara dayanır; özel durumlar elle eşleştirme/bağlam düzenleme gerektirebilir. Otomatik tam metin erişimi bütün yayınları kapsamaz. Genel anlamsal doğruluk için uzman etiketli geniş bir ölçüm yapılmadı.

DOCX/PDF işleme Python 3 ve `pypdf` gerektirir. Codex'in mevcut paketli Python'u otomatik bulunur; başka kurulumda `WORD_PYTHON` ile Python yolunu belirleyin. Word dosyasında dış varlık/ZIP yolu/boyut kontrolleri, yayın indirmesinde DNS adresi sabitlenmiş dış ağ kontrolü yapılır.

Bağlantı testleri: `node scripts/check-groq.cjs`, `node scripts/check-word-content.cjs` (yalnız yapay test metni ve açık yayın). Otomatik testler: `node --test tests/*.test.cjs`.

```powershell
node --test tests/reference-engine.test.cjs tests/providers.test.cjs tests/proxy-rate-limit.test.cjs tests/apa-format.test.cjs tests/ui-results.test.cjs
```

Testler gerçek ağ çağrıları yerine sabit servis yanıtları kullanır: 61 kayıtla sınırın kalkması, Unicode başlık/soyad, yanlış DOI sonrası arama, DataCite geçişi, aday sıralama, belirsiz kaydın korunması ve HTTP 429 yeniden deneme/durum ayrımı kontrol edilir.

### İçerik editörü ve tek düğmeyle kontrol

Web kaynakçası doğrulamasında eksik veya değişen başlık, yazar ve tarih alanları için kart içinde düzenlenebilir bir öneri alanı açılır. Groq yalnız sayfada bulunan kanıtları kullanır; doğrulanamayan veya telif yılı gibi uygun olmayan tarihler öneriye alınmaz. Yayın tarihi yoksa açık güncelleme tarihi kullanılır, o da yoksa APA tarih alanı `t.y.` olarak gösterilir. Taslak metin yeniden filtreleme veya sorgulama sırasında korunur; **Çıktıya uygula** yalnızca kullanıcının son textarea metnini kaynakça çıktısına aktarır ve aynı düğme özgün kayda dönmeyi sağlar.

Bir web sitesi erişim engeli veya bot koruması döndürürse, aynı adres için daha önce başarıyla alınmış künye bellekteki son bilgilerle kullanılır ve kartta bu durum açıkça belirtilir. Eski künye yoksa kayıt özgün haliyle korunur.

İçerik sayfasındaki **Atıfları kontrol et**, kaynak doğrulaması gerekiyorsa önce onu yürütür, ardından Groq ile yalnız mevcut atıfları değerlendirir. Alternatif kaynak önerilmez. Kaynağın tam metni bulunamazsa DOI kimliği eşleşen OpenAlex/Crossref özeti kullanılır ve **Yalnız özet incelendi** yazılır. Özet de yoksa PDF yükleme istenir. Kaynak kimliği/yıl uyuşmazlığı varsa kullanıcıdan çözmesi istenir.

Ana metin paragrafları 1,2 saniyelik yazma arası sonrası otomatik kaydedilir; **Şimdi kaydet** hemen kaydeder. Tablolar, dipnotlar, görseller, alan kodları, işaretli paragraflar ve kaynakça salt okunurdur. Düzenlenen paragrafın içindeki farklı karakter biçimleri ilk metin biçimine uyarlanır; diğer paragraflar ve DOCX paket parçaları korunur. İlgili paragrafın ve bağlamı değişen diğer atıfların sonuçları geçersiz olur. **Bu paragrafı yeniden kontrol et** yalnız bu paragrafın atıflarını değerlendirir. **Bu bağlamla incele** bağlamı kaydedip değerlendirmeyi gerçekten başlatır. İndirme öncesinde bekleyen paragraf değişiklikleri kaydedilir.

Word kaynak doğrulamasında ilk ek-dizin turundan sonra kota bekleyen kayıtlar arka planda otomatik yeniden denenir. Bu bekleme, hazır kaynaklarla içerik denetimini başlatmayı engellemez. Tamamlanan ve bekleyen kayıtlar ayrı sayılır; Durdur hem içerik denetimini hem arka plan kaynak kuyruğunu durdurur. Doğrulanmış kayıtlar ve değişmemiş içerik sonuçları tekrar sorgulanmaz.
