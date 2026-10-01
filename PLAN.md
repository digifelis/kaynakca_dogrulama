# Kaynakça doğrulama ve düzeltme — geliştirme planı

Tarih: 30 Eylül 2026

Yeni Word dosyası yükleme, metin içi atıf denetimi, belge içinde kullanıcı seçimiyle düzeltme ve içerik desteği kontrolünün planı [WORD_PLAN.md](WORD_PLAN.md) içindedir. Aşağıdaki ilk sürüm kapsamının Word ve atıf denetimini dışarıda bırakan maddeleri, bu yeni genişleme için geçerli değildir.

## 1. Amaç

Kullanıcı kaynakça listesini yapıştırır. Uygulama kayıtları akademik veri kaynaklarıyla karşılaştırır, güvenilir eşleşmelerde hatalı veya eksik bilgileri düzeltir ve kopyalanabilir kaynakça üretir.

Referans ürün: https://kaynakcadogrula.com/
İncelenen üründen temel iş akışı alınacak; yeni uygulama bu tek işleve odaklanacak.

## 2. İlk sürümün kapsamı

- Türkçe, mobil uyumlu tek sayfa.
- Metin yapıştırma; numaralı ve birden fazla satıra taşmış kayıtları ayırma.
- Algılanan kaynak sayısı ve kayıtları gözden geçirme/düzenleme.
- DOI bulunan ve bulunmayan dergi makalelerini doğrulama.
- Crossref üzerinden DOI çözümleme ve bibliyografik arama.
- OpenAlex üzerinden ikinci arama katmanı; erişim şartları uygulama başlangıcında teyit edilecek.
- Başlık, yazar, yıl, dergi, cilt, sayı, sayfalar ve DOI karşılaştırması.
- APA 7 biçiminde düzeltilmiş kaynakça.
- Kayıt başına durum, kanıt bağlantısı ve yapılan değişiklikler.
- Belirsiz eşleşmelerde kullanıcıya aday seçtirme.
- Düzeltilmiş listenin tamamını veya tek kaydı kopyalama.
- İşlem ilerlemesi, iptal ve başarısız kayıtları tekrar deneme.

Başlangıç varsayımı: kişisel kullanım; kullanıcı hesabı ve kalıcı rapor saklama gerekmiyor. Kullanıcı talebiyle toplu işlemde kayıt sayısı sınırı kaldırıldı. Tüm kayıtlar servislerin hız sınırlarına uygun sırayla işlenecek.

İlk sürüm dışında: dosya yükleme, üyelik, ödeme, Word eklentisi, makale yazma, metin içi atıf kontrolü, dergi önerisi, sohbet asistanı ve e-posta alarmları. Kitap, tez, web sayfası ve dizin dışı yayınlar destek sınırı açıkça belirtilerek özgün halleriyle korunacak.

## 3. Kullanıcı akışı

1. Kaynakça yapıştırılır.
2. Uygulama kaynakları ayırır ve sayısını gösterir. Kullanıcı gerektiğinde birleştirme, bölme veya metin düzeltme yapabilir.
3. Kullanıcı “Doğrula ve düzelt” düğmesine basar.
4. Her kaydın ilerlemesi ve sonucu görünür.
5. Güçlü eşleşmelerde düzeltmeler uygulanır. Belirsiz eşleşmelerde adaylar karşılaştırılır ve kullanıcı seçimi beklenir.
6. Eksiksiz çıktı gösterilir; çözülemeyen kayıtlar özgün haliyle korunur ve inceleme listesinde ayrıca belirtilir.
7. Kullanıcı tüm kaynakçayı kopyalar.

Çıktı varsayılan olarak giriş sırasını korur. APA alfabetik sıralama ayrıca seçilebilir; çözülemeyen kayıtlarda sıralamanın eksik bilgiye dayanabileceği belirtilir.

## 4. Ekran düzeni

- Üst bölüm: kısa başlık ve tek cümle açıklama.
- Giriş: büyük metin alanı, kaynak sayısı, örnek yükleme, temizleme ve doğrulama düğmesi.
- Özet: toplam, doğrulanan, düzeltme yapılan ve inceleme gereken kayıt sayıları.
- Sonuçlar: özgün kaynak, bulunan kayıt, durum, veri kaynağı, DOI/yayın bağlantısı ve alan bazında değişiklikler.
- Çıktı: düzeltilmiş kaynakça, kopyalama ve çözülmemiş kayıtlar listesi.

Durumlar renk yanında metin ve simgeyle gösterilecek. Klavyeyle kullanım, okunabilir kontrast ve mobil ekranda taşmayan düzen sağlanacak.

## 5. Doğrulama kuralları

| Durum | Karar | Çıktı davranışı |
|---|---|---|
| Doğrulandı | Güçlü, tutarlı kayıt eşleşmesi | Bulunan bilgilerle düzelt ve biçimlendir |
| Olası eşleşme | Benzer aday var, kimliği kesinleşmedi | Kullanıcı seçimine kadar özgün kaydı koru |
| Bulunamadı | Tamamlanan aramalarda yeterli eşleşme yok | Özgün kaydı koru; inceleme öner |
| Bilgi çelişkisi | DOI başka yayına ait veya alanlar ciddi biçimde uyuşmuyor | Çelişkiyi ve varsa alternatif adayı göster |
| Kontrol tamamlanamadı | Ağ, kota veya servis hatası | Tekrar deneme sun; kaynağın gerçekliğine hükmetme |
| Kapsam dışında | Kaynak türü ilk sürümde desteklenmiyor | Özgün kaydı koru ve kapsamı açıkla |

- DOI biçimi normalleştirilecek; çalışması kadar kaynak kimliğiyle uyuşması da kontrol edilecek.
- Crossref'te bulunmayan DOI doğrudan geçersiz sayılmayacak; kayıt ajansı ve alternatif çözümleme değerlendirilecek.
- Başlık benzerliği, yazar uyumu ve yıl birlikte değerlendirilecek; aramanın ilk sonucu otomatik kabul edilmeyecek.
- Önbaskı, çevrimiçi ilk yayın ve basılı yayın tarihleri arasındaki farklar ayrıca ele alınacak.
- Bibliyografik hatalar ve APA biçim hataları ayrı açıklanacak.
- Eşleşme puanı kullanılırsa gerekçeleri gösterilecek; gerçeklik olasılığı olarak sunulmayacak. Eşikler test kümesiyle belirlenecek.
- Hiçbir eksik bilgi tahminle doldurulmayacak. Düzeltmenin hangi kayıttan geldiği tutulacak.
- Belirsiz kayıtlar kullanıcı seçimi olmadan başka yayınlarla değiştirilmeyecek.
- Geri çekilme kontrolü ayrıca bir alan olacak. İlk sürümde kayıt sağlayıcısının sunduğu sinyaller gösterilecek; kontrol yapılamaması “geri çekilmemiş” anlamına gelmeyecek.

## 6. Teknik tasarım

Önerilen yapı: Next.js + TypeScript; tek uygulamada arayüz ve sunucu API'si. APA 7 üretimi için CSL ve citeproc tabanlı biçimlendirme kullanılacak.

İşlem hattı:

`Metin → kayıtları ayır → alanları çıkar → adayları getir → karşılaştır → karar ver → değişiklikleri çıkar → APA 7 üret`

Modüller:

- Ayrıştırma: ham metni ve giriş sırasını koruyarak kayıtları bölme, DOI ve alanları çıkarma.
- Sağlayıcılar: Crossref ve OpenAlex için ayrı adaptörler; zaman aşımı, kontrollü yeniden deneme ve kota yönetimi.
- Eşleştirme: aday kimliği, alan karşılaştırması, çelişkiler ve açıklanabilir karar.
- Düzeltme: doğrulanmış metadata, alan farkları ve kaynak bilgisi.
- Biçimlendirme: normalize metadata → CSL-JSON → APA 7 çıktı.
- İşlem yönetimi: sınırlı eşzamanlı sorgu, işlem içi önbellek, kısmi sonuçlar ve iptal.

Her sonuçta ham kayıt, ayrıştırılmış alanlar, adaylar, seçilen kayıt, sağlayıcı/kayıt kimliği, kanıt URL'si, karar gerekçesi, değişiklikler ve son çıktı tutulacak.

Kaynakça içeriği varsayılan olarak kalıcı saklanmayacak ve uygulama günlüklerine yazılmayacak. Harici sağlayıcılara arama için hangi bilgilerin gönderildiği kullanıcıya açıklanacak. API anahtarları gerekiyorsa sunucuda tutulacak. Kullanıcı metni güvenli biçimde gösterilecek; URL'ler doğrulanacak.

İlk sürümde yapay zekâ zorunlu değil. Ayrıştırmanın gerçek örneklerde yetersiz kaldığı görülürse ayrıca değerlendirilecek; doğrulama kanıtı erişilen yayın kayıtları olacak.

## 7. Geliştirme aşamaları

### Aşama 1 — İskelet ve ekran

Proje kurulumu, tek sayfa düzeni, kaynakça alanı, kayıt sayısı, sonuç kartları ve çıktı bölümü hazırlanır. Tasarım denemeleri örnek veri kullandığını açıkça belirtir.

Kabul: masaüstü ve mobilde kaynak girişi ve sonuç akışı anlaşılır; giriş kaybolmaz.

### Aşama 2 — Ayrıştırma

Numaralı listeler, boş satırlar, satır sonları, DOI normalleştirme ve kullanıcı düzeltme arayüzü geliştirilir.

Kabul: örnek kaynakçalarda kaynaklar kaybolmaz, yanlış bölünmeler kullanıcı tarafından düzeltilebilir.

### Aşama 3 — Gerçek doğrulama

Crossref entegrasyonu, DOI'siz arama, OpenAlex ek araması, aday karşılaştırması ve hata yönetimi uygulanır. DOI ajansı/çözümleme davranışı test edilir.

Kabul: gerçek kayıtlardan kanıt bağlantıları gelir; yanlış DOI, benzer başlıklı yayın ve servis hatası farklı sonuçlar üretir.

### Aşama 4 — Düzeltme ve APA 7

Alan bazında değişiklikler, aday seçimi, CSL biçimlendirmesi ve toplu kopyalama tamamlanır.

Kabul: yalnızca kabul edilen eşleşmeler düzeltilir; çözülemeyen kayıtlar çıktıdan düşmez; çıktı APA 7 örnekleriyle kontrol edilir.

### Aşama 5 — Uçtan uca doğrulama

İlerleme, iptal, tekrar deneme, mobil kullanım, erişilebilirlik ve gerçek servislerle küçük bir canlı deneme tamamlanır. Kurulum ve çalıştırma talimatları yazılır.

Kabul: yapıştırmadan kopyalamaya kadar tüm akış çalışır; canlı doğrulama ile örnek veri birbirinden açıkça ayrılır; destek sınırları belgelenir.

## 8. Test ve kabul ölçütleri

Test kümesi: doğru DOI; DOI'siz gerçek makale; yanlış yıl; yanlış DOI; başka makaleye ait DOI; eksik yazar; benzer başlıklı farklı yayınlar; Türkçe karakterler; çok satırlı ve numaralı liste; yinelenen kayıt; önbaskı/yayımlanmış sürüm; kapsam dışı kitap/tez; zaman aşımı ve kota hatası.

- Güvenilir bir referans kümesiyle yanlış otomatik eşleşmeler ve eşleşme kapsamı ayrı ölçülecek.
- Otomatik düzeltme testlerinde farklı bir yayınla değiştirme görülürse karar kuralları yeniden düzenlenecek.
- Künye doğruluğu ve APA biçim doğruluğu ayrı kontrol edilecek.
- Sağlayıcı testleri sabit örnek yanıtlarla tekrarlanabilir olacak; küçük bir canlı deneme entegrasyonu doğrulayacak.
- Her giriş kaydı için çıktı veya açık hata durumu bulunacak; sessiz kayıt kaybı olmayacak.
- Bir sağlayıcının kesintisi diğer başarılı sonuçları silmeyecek.
- Doğrulanan kayıtlarda veri kaynağı ve kanıt bağlantısı gösterilecek.
- Belirsiz kayıtlar değiştirilmeden korunacak.
- Kopyalama çıktısı bütün kaynakları içerecek.
- Boş giriş, aşırı uzun giriş ve hızlı tekrarlanan istekler kontrollü yönetilecek.

## 9. Sonraki genişletmeler

İlk sürüm tamamlandıktan sonra ihtiyaca göre: Vancouver/IEEE; PubMed/Europe PMC; kitap katalogları; Türkçe yerel yayın sağlayıcıları; kapsamlı geri çekilme verisi; Word/BibTeX/RIS dışa aktarma.

Yeni sağlayıcılar, erişim şartları ve gerçek kapsamları doğrulanmadan destek listesine eklenmeyecek.

## 10. Teslim çıktısı

Çalışan yerel uygulama, kaynak kodu, gerekli ortam değişkenleri örneği, kurulum/çalıştırma belgesi, doğrulama testleri ve bilinen sınırlamalar. Yayınlama hedefi ayrıca belirlenecek.

Uygulama sırası: ekran → ayrıştırma → gerçek arama ve eşleştirme → düzeltme ve biçimlendirme → uçtan uca kontrol.
