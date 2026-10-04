# Kaynakça Masası

Kaynakçayı yapıştırıp açık akademik kayıtlarla karşılaştıran, güçlü eşleşmeleri APA 7, Vancouver veya IEEE biçiminde düzelten tek sayfalık ilk sürüm.

## Çalıştırma

Node.js 22.13 veya üzeri gerekir (yerleşik `node:sqlite`). İlk kurulumda bağımlılıklar (LDAP için `ldapts`, e-posta için `nodemailer`) yüklenir; derleme adımı yoktur. Proje klasöründe:

```powershell
npm ci
node server.cjs
```

İlk açılışta **`admin@admin.com` / `admin`** yönetici hesabı oluşturulur ve ilk girişte parolanın değiştirilmesi zorunludur (bkz. [Hesaplar ve yönetim paneli](#hesaplar-ve-yönetim-paneli)).

Sonra `http://localhost:4173/` adresini açın. `QUEUE_URL` tanımlı değilse uygulama bu **yerel modda** her işi kendi içinde yapar.

## Mikroservis mimarisi

Kaynak doğrulama ve LLM işleri ayrı servislerde, kuyruk üzerinden çalışabilir:

```text
tarayıcı ──> web (server.cjs) ──iş──> kuyruk (services/queue) <──boştaysa iş çeker── doğrulama servisi ×N (services/verify)
                 ^                       │  ^                  <──boştaysa iş çeker── LLM servisi ×N (services/llm)
                 └──── sonuç (yoklama) ──┘  └── web kaynağı için LLM işi ── doğrulama servisi
```

- **Kuyruk** (`services/queue/server.cjs`, varsayılan port 4180): bağımlılıksız Node servisi. İki kuyruk vardır: `verify` (kaynak doğrulama) ve `llm` (atıf–kaynak değerlendirmesi, arama terimi üretimi, web kaynağı alan tamamlama). Boştaki servis işi long-poll ile çeker; iş her zaman boşta bekleyen servise gider. Servis düşerse iş, kiralama süresi dolunca başka servise verilir. Bekleyen işler `QUEUE_DATA_DIR` altındaki günlükte saklanır, kuyruk yeniden başlasa da kaybolmaz. Durdur, kuyruktaki işi iptal eder ve çalışan servisi durdurur.
- **Doğrulama servisi** (`services/verify`): kaynak motorunu çalıştırır. İçerik kontrolü için yayının **tam metnini edinir**: Europe PMC, Unpaywall, Crossref bağlantıları ve kaynak adresi denenir, PDF'ler bu serviste Python ile okunur. Dizin ve tam metin anahtarlarını (OpenAlex, Semantic Scholar, CORE, Google Books, `UNPAYWALL_EMAIL`, `CROSSREF_MAILTO`…) **yalnızca kendi** `services/verify/.env` dosyasından okur. Her süreç aynı anda bir iş yapar; paralellik için birden çok kopya çalıştırın. Farklı IP'lerden ve farklı anahtarlarla çalışan kopyalar sağlayıcı kotalarını ayrı ayrı kullanır.
- **LLM servisi** (`services/llm`): Groq/OpenRouter anahtarlarını **yalnızca kendi** `services/llm/.env` dosyasından okur. Kota bekleme ve model yedekleme bu serviste yapılır.
- **API anahtarları kuyruğa hiç girmez.** Ana proje bu modda anahtar tutmaz; tarayıcıya açık `/api/proxy` kapatılır.

### Güvenlik (JWT)

Her servisin kendi RS256 anahtar çifti vardır (`web`, `verify`, `llm`):

- Her kuyruk çağrısı, servisin kendi özel anahtarıyla imzaladığı 5 dakikalık bir JWT taşır. Kuyruk yalnızca açık anahtarları bilir; özel anahtar hiçbir servisten çıkmaz.
- Roller kuyrukta denetlenir:
  - `web` iki kuyruğa da iş gönderir.
  - `verify`, `verify` kuyruğundan iş alır; web sayfası kaynaklarının eksik alanları için `llm` kuyruğuna iş gönderir.
  - `llm`, `llm` kuyruğundan iş alır.
- Her iş ayrıca yayıncı tarafından imzalanır: içeriğin SHA-256 özeti JWT içinde gider. Servis, imzası veya içeriği tutmayan işi reddeder. Kuyruk ele geçirilse bile sahte veya değiştirilmiş iş çalıştırılamaz.
- Servisler başka sunuculardaysa kuyruğu TLS (ör. ters vekil) arkasında açın. JWT kimliği doğrular, ama trafiği şifrelemez.

### Tek makinede çalıştırma

```powershell
node scripts/generate-keys.cjs        # bir kez: keys/public ve keys/private
node scripts/split-env.cjs            # proje .env anahtarlarını servislerin .env dosyalarına taşır (yedek: .env.yedek)
# ya da services\verify\.env.example ve services\llm\.env.example dosyalarını .env olarak kopyalayıp doldurun
node scripts/start-services.cjs       # kuyruk + 2 doğrulama + 1 LLM + web
```

Başlatıcı, bir servis düşerse onu yeniden başlatır. Ayarlar ortam değişkenleriyle verilir: `PORT`, `QUEUE_PORT`, `VERIFY_INSTANCES` ve `LLM_INSTANCES` (en çok 64). Web sürecine verilen `VERIFY_PARALLEL` (varsayılan 4), bir doğrulama çalışmasında aynı anda kuyruğa gönderilecek kayıt sayısıdır; çok sayıda doğrulama servisi varsa bunu da artırın.

Yerel mod (`QUEUE_URL` olmadan `node server.cjs`), anahtarları yalnızca proje `.env` dosyasından okur. Anahtarlar servislere taşındıysa bu mod anahtarsız sorgular yapar.

### Docker / başka sunucular

```powershell
node scripts/generate-keys.cjs
docker compose up --build
```

- `docker-compose.yml` kuyruğu, iki doğrulama servisini, bir LLM servisini ve web uygulamasını başlatır. Kopya sayısı için: `docker compose up --build --scale verify=20`. Doğrulama servisi imajı (`python` hedefi), tam metin PDF'leri için Python ve pypdf içerir.
- Her container yalnızca açık anahtarları ve **kendi** özel anahtarını (Docker secret) görür.
- Servisler başka sunucuda container olarak çalıştırılabilir. Gerekenler: aynı imaj, `QUEUE_URL=http(s)://kuyruk-adresi:4180`, `keys/public` klasörü ve o servisin özel anahtarı (`JWT_PRIVATE_KEY_FILE`).
- Linux'ta özel anahtar dosyalarının container kullanıcısı (uid 1000) tarafından okunabilmesi gerekir.

## Akış

Üst menüde üç ayrı sayfa bulunur: `/#/kaynakca` kaynakça doğrulaması, `/#/word` Yetim Kaynak kontrolü, `/#/icerik` yayınlarla içerik karşılaştırması. Yetim Kaynak kontrolü ve içerik kontrolü ayrı Word yüklemeleri ve bağımsız belge oturumları kullanır. Dosya değiştirme, silme, düzeltme ve durdurma yalnız ilgili sayfanın belgesini etkiler. Sayfalar arasında geçiş her sayfanın kendi dosyasını, sonuçlarını ve işlemlerini korur. Sayfa yenilendiğinde son açılan belge arşivden geri yüklenir. İçerik kontrolü sayfasına Word dosyanızı ayrıca yükleyin; kaynak kimliklerini ve atıf eşleşmelerini aynı sayfada inceleyin.

Word incelemesinde **Atıf sorunları**, **Yetim atıflar**, **Yetim kaynakça**, **Atıflar ve içerik kanıtları** ve **Kaynakça kayıtları** ayrı listelerde gösterilir. Sayaçlara tıklayarak liste değiştirebilir, etkin listede arama yapabilirsiniz. Bulguların **İlgili paragrafı göster** çekmecesi metni kartın içinde açar. İçerik listesinde sonuç durumuna göre filtreler bulunur. Açık çekmeceler ve toplu düzeltme seçimleri liste değişikliklerinde korunur. İndirilen denetim raporu arama ve filtrelerden bağımsız olarak tüm kayıtları içerir.

1. Kaynakçayı metin alanına yapıştırın veya örneklerden birini seçin.
2. APA 7, Vancouver veya IEEE biçimini seçin (Vancouver ve IEEE listeleri numaralıdır).
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

İçerik kontrolü Groq ve OpenRouter sağlayıcılarını destekler. `GROQ_API_KEY`, `GROQ_MODEL`, `OPENROUTER_API_KEY`, `OPENROUTER_ENABLED`, `OPENROUTER_MODELS`, `OPENROUTER_SHARE` ve `GROQ_TPM` (dakikalık token sınırı, varsayılan 30000; her Groq isteğinden sonra anahtar, harcanan token kadar ve en az 1 saniye bekletilir) ayarları `.env` dosyasındadır; anahtarlar tarayıcıya gönderilmez. `OPENROUTER_ENABLED=false` olduğunda anahtar dosyada kalsa bile OpenRouter'a istek gönderilmez ve Groq için yedek olarak kullanılmaz. Atıf cümlesi, önceki üç cümle ve seçilen yayın pasajları etkin LLM sağlayıcısına iletilir. DOI kaynaklarında Europe PMC ardından Unpaywall açık erişim konumları, OpenAlex konumları, arXiv, Semantic Scholar açık PDF'si ve DOI yayıncı sayfası denenir. Unpaywall `best_oa_location` ile diğer OA konumlarındaki PDF ve tam metin sayfalarını sırayla kullanır. Hiçbir tam metin edinilemezse son çare olarak DOI kimliği eşleşen özet kullanılır; özet de yoksa PDF yükleme istenir. PDF kimliği otomatik DOI ile kesinleşmezse önizlemeyi inceleyip kabul edin. LLM sonuçları, kanıt alıntısının kaynak pasajında bulunması şartıyla raporlanır.

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

## Yazım yardımcısı (`#/yazim`)

Sayfada iki bölüm vardır. **Kaynak koleksiyonları** (`#/yazim/koleksiyonlar`): kullanıcı PDF/Word kaynaklarını adlandırdığı koleksiyonlarda toplar (oluşturma, yeniden adlandırma, silme, yükleme, künye düzenleme). **Makale yazımı** (`#/yazim`): kullanıcı bir **proje** açar, o projede kullanacağı bir veya birden çok koleksiyonu seçer ve seçili koleksiyonların kaynaklarına dayanarak soru sorar; bir koleksiyon birden çok projede kullanılabilir, proje silinince koleksiyon ve kaynakları kalır. Önceden projeye yüklenmiş kaynaklar ilk açılışta otomatik olarak, proje adını taşıyan bir koleksiyona taşınır ve o projeye bağlanır. Projede **makale dili** (Türkçe veya English) seçilir; cevaplar, sorunun dilinden bağımsız olarak bu dilde yazılır (varsayılan Türkçe, proje bazında saklanır). Soru sorulunca cevap isterse altındaki geniş makale alanına eklenir ve makale kademe kademe yazılır. Ayrıntılı tasarım ve kararlar: [YAZIM_YARDIMCISI_PLAN.md](YAZIM_YARDIMCISI_PLAN.md).

- **Kaynak işleme:** metin çıkarılır (PDF: `pypdf`, Word: mevcut DOCX okuyucu), kaynakça bölümü hariç ~300 sözcüklük örtüşmeli parçalara bölünür (sayfa ve başlık bilgisiyle), Gemini embedding ile vektörlenir (`lib/writer-embed.cjs`; kuyruk modunda `llm` servisine `embed` işi olarak gider, anahtar yalnız orada durur). Arama, BM25 anahtar kelime ve embedding benzerliğinin birleşimidir; embedding yoksa yalnız anahtar kelime araması çalışır. Taranmış (OCR gerektiren) PDF'ler "okunamadı" olarak bildirilir.
- **Künye:** dosya özelliklerinden, ilk sayfadan ve DOI'den tahmin edilir, doğrulama motoruyla (Crossref vb.) denetlenir; kullanıcı düzeltip onaylayabilir. Doğrulanmamış künye arayüzde açıkça işaretlenir; künye düzeltilince cevaplardaki ve makaledeki atıflar ile kaynakça otomatik güncellenir.
- **Cevaplar ve atıf:** model yalnız hangi parçanın hangi cümleyi desteklediğini işaretler (`[P3]`); görünen **APA 7 (Yazar, Yıl, s. N)** atfını sunucu kaynağın künyesinden üretir, model atıf uyduramaz. Kaynaklarda bilgi yoksa cevap bunu söyler.
- **Hız ve token tasarrufu:** (1) Uzun yayınlarda her bölümü önce ucuz bir model (`GROQ_SCREEN_MODEL`, varsayılan `openai/gpt-oss-20b`) eler; yalnız ilgili bölümler ana modele gider, hepsi elenirse en alakalı bölüm yine de sorulur, eleme hata verirse bölüm ilgili sayılır (`CONTENT_SCREENING=false` kapatır). (2) Kanıt birden çok bölümde bulunursa sonuç ek LLM çağrısı yapılmadan yerelde birleştirilir. (3) Arama terimi çevirileri ortak önbellekte tutulur. (4) Yazım yardımcısı istemi küçültüldü: son 4 mesaj (cevaplar 600, sorular 500 karakter), taslağın son 3500 karakteri, pasajların tekrarlanan 40 kelimelik örtüşmesi bir kez gönderilir. (5) "Bulunamadı" doğrulama sonuçları 1 gün önbelleklenir, ama kullanıcı yeniden kontrol ettiğinde yeniden sorgulanır. (6) Yerel doğrulama aynı anda 3 kaydı işler (`VERIFY_LOCAL_PARALLEL`); sağlayıcı istekleri yine sağlayıcı başına sıraya girer. (7) PDF/Word okuma ile embedding ayrı sıralarda çalışır (`WRITER_PROCESS_PARALLEL`, `WRITER_EMBED_PARALLEL`). (8) Python işçileri kalıcıdır (`PYTHON_POOL`): dosya başına süreç açma maliyeti kalkar (ölçüm: 5 ardışık PDF okuma 1,3 sn → 0,01 sn).
- **Raporlar (Yönetim paneli > Raporlar):** Sistemin performansını ve kullanıcı deneyimini ölçer; kararlar için altı bölüm sunar. *Özet*: ana göstergeler ve "ne yapılabilir" önerileri (kural tabanlı içgörüler). *Performans*: API yollarına göre sorgu süresi (ortalama/ortanca/%95/%99), model cevap süresi ve kota beklemesi (modele ve çağrı türüne göre), dosya yükleme hızı ve sırada bekleme/okuma/vektörleme süreleri, kaynakça doğrulama süresi ve önbellek payı, hepsi zamana göre. *Hatalar*: 4xx/5xx/yarıda kesilen (499) yanıtlar; ne zaman, kaç kez, hangi yolda, hangi kullanıcıda; son 100 hata ve başarısız model çağrıları. *Kaynak ve token*: zamana göre ve kullanıcı bazında sorgulanan kaynak ile token, kullanıcı başına ortalama/ortanca, en çok kullanan %10'un payı. *Kullanıcı deneyimi*: kullanıcı başına 0–100 skor (Apdex, sunucu hatası, model süresi, dosya beklemesi, başarısız işlem) ve memnun kullanıcı oranı. *Kapasite*: CPU, bellek, olay döngüsü gecikmesi, eşzamanlı istek, günün saatlerine göre yoğunluk, sağlayıcı kota beklemesi. Her tablo CSV olarak indirilebilir. Veri `metrics.db` dosyasına yazılır (varsayılan 90 gün saklanır); yalnız üst veri tutulur (yol, durum, süre, boyut, token, kullanıcı kimliği), içerik ve anahtar değerleri tutulmaz. Hızlı başarılı API istekleri örneklenir (`METRICS_SAMPLE`), sayımlar ağırlıkla düzeltilir. Ayarlar: `METRICS_ENABLED`, `METRICS_RETENTION_DAYS`, `METRICS_SAMPLE`, `APDEX_T_MS`.
- **Ortak önbellek (`cache.db`):** kullanıcıdan bağımsız, yalnız genel veriler: doğrulanmış kaynak kayıtları (90 gün; `review` 14 gün), edinilmiş yayın tam metinleri (90 gün; yalnız özet 3 gün), Semantic Scholar'dan indirilen açık erişimli PDF'lerin metni ve embedding vektörleri. Aynı kaynak yeniden sorgulanmaz/indirilmez/embed edilmez. **Kota yine düşer:** önbellekten gelse de kaynak kullanıcının aylık sorgulanan kaynak hakkından sayılır. Kullanıcıların kendi yüklediği belgeler ve onay bekleyen metinler asla önbelleğe girmez. Yönetim → Ayarlar → Önbellek bölümünden boyut ve isabet görülür, türe göre temizlenir. `CACHE_ENABLED=false` kapatır, `CACHE_MAX_MB` (varsayılan 2048) sınırı belirler (dolunca en eski kullanılan silinir), `CACHE_VERSION` değiştirilerek tüm eski kayıtlar geçersiz kılınır, `CACHE_DIR` konumu belirler.
- **Makale arama (Semantic Scholar):** koleksiyon ekranında (veya koleksiyon oluştururken yazılan anahtar kelimelerle) Semantic Scholar'da makale aranır; sonuçlar başlık, yazar, yıl, dergi ve atıf sayısıyla listelenir. Kullanıcı açık erişimli PDF'i olan makaleleri tek tek ya da topluca seçer; sunucu PDF'leri indirir (yalnız https ve genel adresler, paketin dosya boyutu sınırı içinde) ve elle yüklenmiş gibi işler: metin parçalama, embedding, künye (başlık/yazar/yıl/DOI Semantic Scholar'dan hazır gelir ve normal doğrulama sürer). Tek istekte en çok 25 makale, kullanıcı başına dakikada 20 arama. API anahtarı **Yönetim → Ayarlar → Semantic Scholar** alanından girilir (şifreli saklanır, kaydederken sınanır); anahtar yoksa ortak, düşük sınırlı anahtarsız erişim kullanılır. `.env` içindeki `SEMANTIC_SCHOLAR_API_KEY` yedek olarak okunur, panel anahtarı önceliklidir ve kaynakça doğrulamasında da kullanılır (yerel modda).
- **İstem ve skill yönetimi:** Yönetim paneli → "Model istemleri" sekmesi modele giden sistem iletilerini (kaynakça içerik kontrolü, arama terimi çevirisi, web künyesi, yazım yardımcısı çerçevesi ve kural metinleri) düzenletir; "Yazım skill'leri" sekmesi skill'leri düzenler, ekler, gizler ve geri getirir. Değişiklikler `prompts.db` dosyasında (`WRITER_DATA_DIR`) saklanır, sunucuyu yeniden başlatmadan geçerli olur, "Varsayılana dön" yerleşik metni geri getirir; her değişiklik denetim kaydına yazılır (metnin kendisi yazılmaz).
- **Skill'ler:** `skills/*.md` dosyaları (başlık, açıklama, `plans`, `keywords`, `needsSources`, talimat). Kullanıcı seçer veya "Otomatik"te soruya göre önerilir. Yeni skill için `skills/_sablon.md` dosyasını kopyalayın; dosya adı ile `name` aynı olmalıdır. Yalnız yönetici düzenler (depodaki klasör; `SKILLS_DIR` ile değiştirilebilir).
- **Kimlik ve paketler:** gerçek hesaplar (aşağıdaki bölüm). Paketler ve limitleri veritabanındadır, yönetim panelinden düzenlenir; varsayılanlar `lib/plans.cjs` içindedir (basic: 10 proje, koleksiyonda 20 belge, belge başına 50 MB, günde 200 soru, ayda 300 000 token, belge başına 150 ve ayda 1 000 sorgulanan kaynak, en çok 20 kayıtlı Word/PDF belge; bu üç kaynak limitinde 0 = sınırsız; ay içinde yalnız gerçekten sorgulanan kaynaklar sayılır, önceden doğrulanmış kayıtlar sayılmaz; **premium ve gold değerleri geçicidir**). Limit aşımında kullanıcıya üst paket önerisi gösterilir.
- **İzolasyon:** her SQLite sorgusu `user_id` ile süzülür (`lib/writer-store.cjs`); bir kullanıcı veya proje başka birinin parçalarını, vektörlerini, mesajlarını ya da makalesini göremez. Bir kaynak tek koleksiyona aittir; embedding yalnız bir kez hesaplanır ve koleksiyonu kullanan tüm projelerde ortak kullanılır.
- **Veri:** `WRITER_DATA_DIR` (Docker: `/data/writer`, `web-data` birimi) altında `writer.db` (yazım yardımcısı), `app.db` (hesaplar, oturumlar, paketler, ayarlar, işlem günlüğü, denetim kaydı), `settings.secret` ve `identity.secret`.
- **Ayarlar (LLM servisi `.env`):** `GEMINI_API_KEY`, `GEMINI_EMBEDDING_MODEL` (varsayılan `gemini-embedding-001`; `gemini-embedding-2` de desteklenir), `GEMINI_EMBEDDING_DIM` (768). `WRITER_PASSAGES`: bir soruya verilen parça sayısı (6).
- **Makale:** otomatik kaydedilir (eski pencere eziyorsa 409 ile reddedilir); **Word olarak indir** atıfları güncel künyeyle yazar ve kaynakçayı ekler.
- **Gizlilik:** kaynak metinleri Gemini'ye (embedding) ve Groq/OpenRouter'a (cevap) gider; yükleme öncesi kullanıcı onayı istenir.

Testler: `node --test tests/writer-units.test.cjs tests/writer-service.test.cjs tests/writer-pdf.test.cjs tests/writer-embed-queue.test.cjs`. `node:sqlite` için Node 22.13+ gerekir (Docker imajı Node 24).

## Hesaplar ve yönetim paneli

Kaynakça doğrulama sayfası (`#/kaynakca`) girişsiz kullanılır; **Yetim kaynak kontrolü, İçerik kontrolü ve Yazım yardımcısı giriş gerektirir** ve her kullanıcı yalnız kendi verisini görür.

- **Giriş yöntemleri:** yerel hesap (açık kayıt; kullanıcı adı + parola, e-posta isteğe bağlı) ve **LDAP** (yönetim panelinden ayarlanır). Parolalar `scrypt` ile saklanır; oturum çerezi `HttpOnly` + `SameSite=Strict` (HTTPS arkasında `Secure`) ve veritabanında yalnız karması tutulur, 14 gün kayar. Hesap ve IP başına ardışık hatalı denemeler artan süreyle kilitlenir. Parola politikası: en az 10 karakter, kolay tahmin edilen ve kullanıcı adını içeren parolalar reddedilir.
- **İlk yönetici:** hiç yönetici yoksa `admin@admin.com` / `admin` oluşturulur (`ADMIN_USERNAME` / `ADMIN_PASSWORD` ile değiştirilebilir). **İlk girişte parola değişimi zorunludur;** değişene kadar başka hiçbir sayfa/API açılmaz. E-posta isteğe bağlıdır; profil sayfasından eklenir ve bağlantıyla doğrulanır.
- **E-posta ve parola sıfırlama:** yönetim panelindeki SMTP ayarıyla çalışır. Sıfırlama yalnız **doğrulanmış** adreslere gider, bağlantı 1 saat geçerlidir ve bir kez kullanılır; yanıtlar hesabın var olup olmadığını belli etmez.
- **LDAP:** panelden sunucu adresi (`ldap://`, `ldaps://` ya da StartTLS), servis hesabı, arama tabanı, kullanıcı filtresi (`(uid={username})`), öznitelikler ve **grup → paket / yönetici eşlemeleri** girilir; "Bağlantıyı sına" düğmesi adım adım sonuç verir. Servis hesabı parolası AES-256-GCM ile şifrelenir (`SETTINGS_SECRET` ya da `settings.secret` dosyası) ve arayüze geri gönderilmez. Kullanıcı ilk girişte otomatik oluşturulur; paketi her girişte gruplardan güncellenir. Dizinde bulunan bir adla yerel kayıt açılamaz.
- **Paketler:** panelden eklenir/düzenlenir (proje, projedeki kaynak, dosya boyutu, günlük soru, **aylık token kotası**; `0` = sınırsız). Kullanıcıya paket ve isteğe bağlı bitiş tarihi atanır; süresi dolan kullanıcı varsayılan pakete döner. Sıra yükseltme önerisini ve skill erişimini (`minPlan`) belirler.
- **İşlem takibi ve token:** yazım yardımcısındaki soru-cevap, kaynak işleme/vektörleme, Word kaynakça doğrulama ve içerik kontrolü ayrı işlem olarak kaydedilir (süre, durum, hata, çağrı başına sağlayıcı/model/token). Sağlayıcı token bildirdiğinde değer kesindir; bildirmediğinde (Gemini embedding) **tahmindir** ve `~` ile işaretlenir. Aylık kota aşıldığında istek 429 ve paket yükseltme önerisiyle reddedilir; sayaç ay başında sıfırlanır.
- **Yönetim paneli (`#/admin`):** genel bakış (günlük/aylık/toplam token, işlem türü ve modele göre kırılım, en çok kullananlar, son hatalar), kullanıcı yönetimi (oluştur, ara, paket/rol/durum, geçici parola sıfırlama, oturumları kapatma, silme; son yönetici ve kendi hesabınızı koruyan kurallarla), paketler, işlem listesi ve çağrı ayrıntısı, denetim kaydı ve ayarlar (kayıt aç/kapat, LDAP, SMTP). Panel **yalnız üst veri** gösterir; kullanıcıların belgeleri, soruları ve cevapları yöneticiye de açılmaz.
- **Eski Word arşivi:** hesaplara geçişte sahibi olmayan eski anonim Word/içerik arşivi (`WORD_ARCHIVE_DIR`) bir kez ve geri alınamaz biçimde silinir (`.owners-enabled` işareti).
- **Ortam değişkenleri:** `PUBLIC_URL` (e-posta bağlantıları ve `Secure` çerez için, örn. `https://kaynak.ornek.com`), `ALLOWED_HOSTS` (virgülle ayrılmış ek ana bilgisayar adları), `TRUST_PROXY=1` (ters vekil arkasında istemci IP'si için `X-Forwarded-For`), `SETTINGS_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `IDENTITY_SECRET`.

Testler: `node --no-warnings --test tests/auth.test.cjs tests/admin-usage.test.cjs`.

## API anahtar havuzu (Groq, OpenRouter, Gemini)

Her sağlayıcı için sınırsız sayıda API anahtarı tanımlanabilir; ücretsiz katman sınırları anahtarlar arasında yayılır.

- **Yönetim → API anahtarları:** anahtar eklenir (önce sağlayıcıya sorularak sınanır, geçersizse kaydedilmez), düzenlenir, pasifleştirilir, silinir, "Test et" ile yeniden sınanır. Sunucuyu yeniden başlatmak gerekmez. Anahtarın değeri bir daha gösterilmez (yalnızca son 4 hane); veritabanında AES-256-GCM ile şifreli durur; denetim kaydına değer yazılmaz.
- **Akıllı sıralı kullanım:** anahtarlar sırayla kullanılır; bir anahtar 429/5xx alırsa (veya kendi dakikalık/günlük sınırına ulaşırsa) dinlendirilir ve **beklemeden** sıradaki anahtarla aynı istek sürdürülür. 401/403 alan anahtar "geçersiz" işaretlenir. Hepsi doluysa en erken hazır olanı beklenir. Aynı hesaba ait anahtarlara aynı **grup** adı verilirse biri dolduğunda grup birlikte dinlenir.
- **Kapsam:** Groq ve OpenRouter sohbet isteklerinde (içerik denetimi, yazım yardımcısı yanıtları, web künyesi) ve Gemini embedding isteklerinde. Gemini sohbet kullanılmaz.
- **`.env` anahtarları:** `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY` (virgülle birden çok değer yazılabilir) havuza **salt okunur** girdiler olarak, panelden eklenenlerden sonra katılır; panelden düzenlenemez; "Sil" dediğinizde `.env` dosyası değişmez, anahtar yalnızca havuzdan çıkarılır (`llm-keys.db` içinde gizlenir). `OPENROUTER_ENABLED=false` OpenRouter `.env` anahtarını devre dışı bırakır.
- **Saklama:** `LLM_DATA_DIR` (yoksa `WRITER_DATA_DIR`, yoksa `data/writer`) içindeki `llm-keys.db`; şifre anahtarı `SETTINGS_SECRET` ya da aynı dizindeki `settings.secret`. Yedekte ikisi birlikte alınmalıdır.
- **Kuyruk/Docker modu:** anahtarlar yalnızca **LLM servisinde** tutulur (`llm-data` birimi); web uygulaması yeni anahtarı LLM servisinin RSA genel anahtarıyla şifreleyip bir kuyruk işi olarak iletir. Panelin çalışması için LLM servisi açık olmalıdır ve tek kopya (`replicas: 1`) çalışmalıdır.
- **Önemli:** Groq ve OpenRouter ücretsiz sınırları çoğunlukla **hesap/organizasyon başınadır**; aynı hesaptan alınan birden çok anahtar kotayı artırmaz. Gerçekten ayrı hesapların anahtarlarını kullanın.
