# API anahtar havuzu — Groq, OpenRouter ve Gemini için çoklu anahtar planı

Durum: **plan** (uygulanmadı). Karar tarihi: 2026-10-03.

## 1. Amaç ve kapsam

Groq, OpenRouter ve Gemini için ücretsiz katman limitleri tek bir anahtarla çabuk doluyor. Amaç, her sağlayıcı için **sınırsız sayıda anahtar** tanımlanabilen, bir anahtar kota verince isteğin **bekletilmeden** sıradaki anahtarla sürdüğü bir havuz kurmak ve bunu **yönetim panelinden** yönetmek.

Kapsam (kullanıcı kararları):

| Konu | Karar |
|---|---|
| Yönetim yeri | Yönetim paneli (anahtarlar sunucuyu yeniden başlatmadan eklenir/silinir) |
| Dağıtım | Akıllı sıralı kullanım: sırayla kullan, kota veren anahtarı dinlendir, hemen sonrakine geç |
| Kullanan çağrılar | Groq ve OpenRouter sohbet (içerik denetimi, yazım yardımcısı cevapları, web künye çıkarımı) ve Gemini embedding |
| Gemini sohbet | Bu planın **dışında** (Gemini şimdilik yalnızca embedding) |
| İzleme | Panelde tam durum (etkin/dinleniyor/pasif, son hata, çağrı ve token sayıları, test düğmesi) |
| Docker/kuyruk modu | Anahtarlar **LLM serviste kalır**; web sunucusunda hiç saklanmaz |
| Anahtar alanları | Etiket + isteğe bağlı dakikalık ve günlük istek sınırı |
| Doğrulama | Anahtar eklenirken test edilir; geçersizse kaydedilmez |

Kapsam dışı: kullanıcıların kendi anahtarını getirmesi, Gemini'yi sohbet sağlayıcısı yapmak, ücretli paket yönetimi.

### Önemli uyarı: limitler anahtara değil hesaba bağlıdır
Groq, OpenRouter ve Google limitleri çoğunlukla **hesap / kuruluş / proje** başına uygulanır. Aynı hesaptan üretilen 10 anahtar limiti 10 katına **çıkarmaz**; yalnızca farklı hesap/projelere ait anahtarlar çıkarır. Ayrıca bu sağlayıcıların kullanım koşulları, limit aşmak amacıyla çoklu hesap açılmasını kısıtlıyor olabilir; bu, anahtarları temin edenin sorumluluğundadır. Plan bu yüzden iki şeyi destekler: (a) her anahtarın kendi dinlenme süresi, (b) isteğe bağlı **grup** alanı (aynı hesaba ait anahtarlar aynı grupta olur; birine hesap düzeyinde 429 gelirse gruptaki hepsi birlikte dinlenir, boş yere denenmez).

## 2. Bugünkü durum (kodda bulunanlar)

- `word-content.cjs` `chat()`: tek `GROQ_API_KEY` ve tek `OPENROUTER_API_KEY`; sağlayıcı başına tek `providerNext` bekleme zamanı. 429'da bekler ya da diğer sağlayıcıya geçer; anahtar döndürme yok. `llmAvailable()` ve `openRouterEnabled()` ortam değişkenine bakar.
- `web-groq.cjs`: web künye çıkarımı için aynı Groq anahtarını ayrıca okur.
- `lib/gemini-embed.cjs`: tek `GEMINI_API_KEY`; 429'da `{ quota: { retryAt } }` döner, çağıran bekler (`lib/writer-embed.cjs`).
- `services/llm/index.cjs`: kuyruk işi işleyicisi; anahtarlar yalnızca `services/llm/.env`'de, işlerde taşınmaz. Yetenekler (`capabilities()`) başlangıçta bir kez hesaplanır.
- `lib/secrets.cjs`: AES-256-GCM mühürleme (`createSealer`) hazır.
- Yönetim paneli: `admin-service.cjs` (`/api/admin/*`) ve `admin-app.js` (sekmeler: `TABS`). Denetim kaydı hazır.

## 3. Hedef mimari

```
Yönetim paneli ──► /api/admin/llm-keys ──► (yerel mod) KeyPool ─┐
                                      └─► (kuyruk) "keys" işi ──► LLM servisi ──► KeyPool ─┤
                                                                                           ▼
word-content.chat()  ──► KeyPool.acquire('groq'|'openrouter') ──► istek ──► KeyPool.report(...)
gemini-embed.embed() ──► KeyPool.acquire('gemini')            ──► istek ──► KeyPool.report(...)
```

### 3.1 `lib/key-pool.cjs` (yeni)
Anahtar havuzu ve deposu. Sağlayıcılar: `groq`, `openrouter`, `gemini`.

Anahtar kaydı:
`id`, `provider`, `label`, `group` (isteğe bağlı), `sealedKey` (AES-GCM), `last4`, `enabled`, `status` (`active` | `cooling` | `disabled` | `invalid`), `rpm` ve `rpd` (isteğe bağlı sınırlar), `cooldownUntil`, `lastError`, `lastUsedAt`, sayaçlar (`ok`, `fail`, `promptTokens`, `completionTokens`, günlük sayaç ve günü).

API:
- `acquire(provider, { exclude })` → `{ id, key, label }` ya da `null`; yoksa `nextAvailableAt(provider)` döner.
- `report(id, { ok, status, tokens, retryAfterMs, error })` → sayaçları günceller; 429/kota → `cooldownUntil` (sağlayıcı bildirdiği süre, yoksa üssel geri çekilme); 401/403 → `invalid` + `enabled=false` + neden; 5xx/ağ → kısa dinlenme.
- `isAvailable(provider)`, `nextAvailableAt(provider)`, `list()`, `add()`, `update()`, `remove()`, `test()`.

Seçim kuralı (akıllı sıralı): etkin anahtarlar tanımlı sırada gezilir; `cooldownUntil` geçmemiş, dakikalık/günlük kendi sınırını aşmış ya da pasif/geçersiz olanlar atlanır; ilk uygun olan seçilir. Bir anahtar kota verirse isteğe **bekleme olmadan** sonraki uygun anahtarla devam edilir; hiçbiri uygun değilse en erken uygun zamana kadar bugünkü gibi beklenir (`onWait`/`quota` mekanizması korunur). Aynı `group` içindeki anahtarlar hesap düzeyi 429'da birlikte dinlenir.

Depolama: SQLite `llm-keys.db` (`node:sqlite`, projede zaten kullanılıyor), konumu `LLM_DATA_DIR` (varsayılan: yerel modda `WRITER_DATA_DIR`, Docker'da `/data/llm`). Mühürleme anahtarı: `LLM_SETTINGS_SECRET` ya da dizinde üretilen `settings.secret` (`lib/secrets.cjs` yeniden kullanılır). Dakikalık pencere bellekte, günlük sayaç diskte tutulur.

Başlangıç içe aktarma: bir sağlayıcıda hiç anahtar yoksa ve ortamda `GROQ_API_KEY` / `OPENROUTER_API_KEY` / `GEMINI_API_KEY` varsa bir kez içe aktarılır (etiket `.env`); sonrasında `.env` değerleri yok sayılır, böylece panelden yapılan silme geri gelmez.

### 3.2 Kuyruk (Docker) modu
- Havuz yalnızca **LLM servisinde** çalışır. Web sunucusu anahtarı saklamaz.
- Panel işlemleri LLM servisine yeni iş türüyle gider: `kind: 'keys'`, `op: list | add | update | remove | test` (`services/llm/index.cjs` `handle()` içinde). Yalnızca web yayıncısının (`trustedPublishers`) ve yalnızca yönetici oturumundan gelen işler yayımlanır.
- **Anahtar değeri kuyruğa düz metin girmez:** `add` işinde anahtar, LLM servisinin RSA genel anahtarıyla (zaten `keys/public/llm.pem` olarak mevcut) `RSA-OAEP` ile şifrelenir; yalnızca LLM servisi çözer.
- `list` yanıtı anahtar değerini **asla** içermez, yalnızca son 4 hane.
- `capabilities()` artık sabit değil, her `claim` çağrısında havuzdan hesaplanır (`startWorker` yetenek nesnesini işlev olarak kabul edecek şekilde genişletilir); anahtar eklenince web tarafı `Backend.merged('llm')` ile en geç 10 sn içinde görür.
- Kısıt: havuz tek bir LLM servisi örneğinde tutulur (`replicas: 1`); çoğaltma için paylaşımlı depo gerekir (bu planın dışında; KURULUM.md'ye not).

### 3.3 Sohbet çağrıları (`word-content.cjs`)
- `process.env.GROQ_API_KEY` ve `OPENROUTER_API_KEY` okumaları `KeyPool.acquire` ile değişir. `providerNext` sağlayıcı bekleme zamanı, havuzun `nextAvailableAt(provider)` değerinden gelir.
- 429 → `report(..., retryAfterMs)`; döngü aynı sağlayıcıdaki sonraki anahtarla **hemen** yeniden dener; hiçbiri uygun değilse mevcut davranış (diğer sağlayıcıya geçiş ya da bekleme) sürer.
- 401/403 → anahtar `invalid` olur, panelde uyarı görünür, istek sonraki anahtarla tekrarlanır.
- Başarılı yanıt → `usage` alanındaki token'lar `report` ile anahtara işlenir; `UsageContext.record` içine `keyLabel` eklenir (kullanıcı token günlüğü korunur).
- `llmAvailable()` ve `openRouterEnabled()` havuza bakar ("en az bir etkin anahtar"). Hata iletisi güncellenir: "Etkin bir Groq veya OpenRouter anahtarı yok; Yönetim → API anahtarları sayfasından ekleyin."
- `web-groq.cjs` aynı havuzdan alır.

### 3.4 Gemini embedding (`lib/gemini-embed.cjs`)
- `embed()` her çağrıda `acquire('gemini')` ile anahtar alır; 429/5xx'te sıradaki anahtarla hemen yeniden dener. Tüm anahtarlar dinleniyorsa mevcut `{ quota: { retryAt } }` yanıtı döner ve `writer-embed.cjs` bugünkü gibi bekler.
- `configured()` havuza bakar. Hata ve günlük çıktılardaki gizli değer maskesi (`safe()`) `gsk_…`, `sk-or-…` ve `AQ.…` kalıplarını da kapsayacak şekilde genişletilir.

### 3.5 Yönetim paneli
- `admin-service.cjs`: `GET /api/admin/llm-keys`, `POST` (ekle + test), `PATCH /:id` (etiket, grup, sınırlar, etkin/pasif), `DELETE /:id`, `POST /:id/test`. Hepsi yönetici oturumu ister; ekleme, silme, pasifleştirme ve test **denetim kaydına** yazılır (`llm.key_added` vb.; anahtar değeri asla yazılmaz).
- `admin-app.js`: yeni sekme **"API anahtarları"**. Sağlayıcı başına bölüm; satırlar: etiket, `…son4`, durum rozeti (Etkin / Dinleniyor — kalan sn / Pasif / Geçersiz), sınırlar, bugünkü çağrı (başarılı/başarısız) ve token, son hata, son kullanım; eylemler: Test et, Pasifleştir/Etkinleştir, Düzenle, Sil (iki tıklamalı onay). "Anahtar ekle" formu: sağlayıcı, etiket, anahtar (parola türünde alan; gönderildikten sonra bir daha gösterilmez), isteğe bağlı grup, rpm, rpd. Eklerken test başarısızsa neden gösterilir ve kayıt yapılmaz. Liste ~10 sn'de bir yenilenir (cooldown sayaçları için).
- Genel bakış sekmesine "Kullanılabilir anahtar: Groq 3/4, OpenRouter 2/2, Gemini 5/6" özeti.

## 4. Güvenlik

- Anahtarlar diskte AES-256-GCM ile mühürlü; açık hâli yalnızca LLM servisi belleğinde, istek anında bulunur.
- Hiçbir API yanıtı, günlük satırı, hata iletisi veya denetim kaydı anahtar değerini içermez (yalnızca son 4 hane).
- Anahtar ekleme işi kuyrukta RSA-OAEP ile şifreli; kuyruk sunucusu düz değeri görmez.
- Panel uçları yalnızca yönetici; `x-word-request` ve Origin denetimleri mevcut sistemdeki gibi.
- Geçersiz (401/403) anahtar otomatik devre dışı kalır; sızmış anahtarın sürekli denenmesi önlenir.

## 5. Uygulama sırası ve kabul ölçütleri

1. **Havuz çekirdeği:** `lib/key-pool.cjs` (depo, mühürleme, seçim, dinlenme, sınırlar, içe aktarma) + birim testleri (sahte saatle). *Kabul:* 429 alan anahtar dinlenir; sıradaki seçilir; kendi dakikalık/günlük sınırı aşılan atlanır; grup birlikte dinlenir; env içe aktarma bir kez olur.
2. **Sohbet entegrasyonu:** `word-content.cjs` ve `web-groq.cjs`. *Kabul:* sahte `fetch` ile 429 → aynı istekte sonraki anahtar, bekleme yok; 401 → anahtar geçersiz; hepsi dolu → mevcut kota bekleme davranışı; mevcut testler geçer.
3. **Embedding entegrasyonu:** `lib/gemini-embed.cjs`. *Kabul:* 429'da anahtar değişir; hepsi doluysa `quota` yanıtı korunur.
4. **LLM servisi:** dinamik `capabilities`, `keys` iş türü, RSA-OAEP ile anahtar ekleme, `LLM_DATA_DIR` birimi (`docker-compose.yml`'de `llm-data`). *Kabul:* panelden eklenen anahtar servis yeniden başlamadan kullanılır; kuyrukta düz anahtar yok.
5. **Yönetim uçları ve panel sekmesi:** `admin-service.cjs`, `admin-app.js`, denetim kaydı. *Kabul:* başsız Chrome ile ekleme (test başarılı/başarısız), pasifleştirme, silme, durum rozetleri; yanıtlarda tam anahtar yok.
6. **Belgeler:** README, KURULUM.md (`LLM_DATA_DIR`, tek LLM servisi kısıtı, yedekleme: `settings.secret` kaybolursa anahtarlar çözülemez), `.env.example` notları.

Her adım kendi testleriyle birleşir; adım 2'den sonra sistem yalnızca `.env` anahtarıyla bugünkü gibi çalışmaya devam eder (geri uyumluluk).

## 6. Riskler ve açık noktalar

- **Hesap bazlı limitler:** anahtar sayısı kapasiteyi doğrusal artırmayabilir (bkz. §1 uyarısı). `group` alanı bunu hafifletir.
- **Tek LLM servisi:** çoğaltılırsa havuz durumu ve depo ayrışır. Şimdilik tek örnek.
- **Yedekleme:** `llm-keys.db` ve `settings.secret` birlikte yedeklenmeli.
- **Ek karar gerektirebilecekler:** OpenRouter'da modele göre ayrı kota var; ilk sürümde dinlenme anahtar düzeyindedir (model düzeyi sonraya). Günlük sınır sayacı UTC gününe göre sıfırlanır (Groq ile uyumlu, Gemini farklı saatte sıfırlanabilir; sınır isteğe bağlı olduğundan sorun değil).
