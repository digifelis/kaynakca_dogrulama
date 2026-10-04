# Yazım yardımcısı: yüklenen kaynaklarla soru-cevap ve kademeli makale yazımı

Tarih: 2 Ekim 2026
Durum: Uygulandı (makale_olusturucu dalı). İlk sürüm kapsamındaki tüm adımlar tamamlandı; sonraki aşama maddeleri (OCR, seçili metni skill ile yeniden yazma, gerçek giriş ve paketler) açık. Uygulama notları en altta.

## Amaç

Kullanıcı bir proje açar, bir veya birden çok PDF/Word kaynak yükler ve bu kaynaklara dayanarak soru sorar. Cevaplar, yöneticinin (proje sahibinin) belirlediği skill dosyalarının çerçevesinde LLM ile üretilir ve kaynak atfı taşır. Kullanıcı isterse cevabı ekrandaki WYSIWYG editöre ekler; böylece makale kademe kademe yazılır. Editöre eklenen atıfın kaynağı makalenin kaynakçasına da yazılır ve mevcut doğrulama motoruyla kontrol edilebilir.

Kural: Cevaplar yalnızca yüklenen kaynaklardan beslenir. Kaynaklarda karşılığı olmayan iddia için model "kaynaklarda bulunamadı" demelidir; atıf uydurmamalıdır.

## Kapsam kararları

| Konu | Karar |
|---|---|
| Kaynaklara erişim | Parçalama + Gemini embedding ile anlamsal arama |
| Skill seçimi | Kullanıcı seçebilir; seçmezse sistem önerir |
| Editör | `contenteditable` tabanlı, bağımlılıksız, kendi yazdığımız hafif editör |
| Atıf davranışı | Atıflı cevap; editöre eklenince kaynak kaydı kaynakçaya da eklenir |
| Kimlik | İlk sürümde anonim; sonra giriş ve paketler (bkz. Kimlik ve paket katmanı) |
| Saklama | Kalıcı, proje bazlı; kullanıcı silince temizlenir |
| Skill yönetimi | Yalnızca yönetici, depodaki `skills/` klasörü |
| İlk sürüme dahil | Sohbet geçmişi, editördeki metni bağlam yapma |
| İlk sürüme dahil değil | OCR, seçili metni skill ile yeniden yazma |

## Mimari

```
Tarayıcı ── web ──► kuyruk ──► llm servisi ──► Gemini (embedding), Groq/OpenRouter (cevap)
              │
              └── web-data: SQLite (kullanıcı, proje, belge, parça, vektör, sohbet)
```

Mevcut mikroservis yapısı korunur. Embedding ve cevap üretimi `llm` servisine yeni iş türleri olarak eklenir; API anahtarları yalnızca LLM servisinde kalır. Web, belge çıkarma ve veri deposundan sorumlu olur.

## 1. Kimlik ve paket katmanı

Hedef: giriş sistemi sonra eklendiğinde yalnızca bu katman değişsin.

- `lib/identity.cjs`: `resolveUser(req)` → `{ userId, plan }`.
  - Şimdi: tarayıcıya verilen imzalı çerezle anonim `userId`; `plan` sabit `basic`.
  - Sonra: gerçek girişten `userId` ve `plan`. Çağıran kodlar değişmez.
- `lib/plans.cjs`: paket limitlerinin tek kaynağı (basic, premium, gold). Alanlar: proje sayısı, projedeki belge sayısı, belge boyutu, günlük soru sayısı, kullanılabilir skill'ler. Başlangıçta yalnızca `basic` değerleri dolu; değerleri yönetici belirler.
- Her API uç noktası önce `resolveUser`, sonra `plans` limit kontrolü yapar. Limit aşımı açık bir hata koduyla döner.

## 2. Veri modeli ve izolasyon

SQLite (`node:sqlite`, ek bağımlılık yok), `web-data` volume'unda.

```
users(id, created_at)
projects(id, user_id, title, created_at)
documents(id, project_id, user_id, file_name, mime, status, page_count, error)
chunks(id, document_id, project_id, user_id, page, section, text, embedding BLOB)
messages(id, project_id, user_id, role, text, skill, citations, created_at)
manuscripts(project_id, user_id, html, updated_at)
```

İzolasyon kuralları:
- Her sorgu `user_id` ve `project_id` ile filtrelenir. Bu filtre sunucuda, oturumdan çıkarılan `userId` ile uygulanır; istemcinin gönderdiği kimliğe güvenilmez.
- Benzerlik araması yalnızca ilgili projenin parçaları üzerinde yapılır; başka proje veya kullanıcı aday kümesine hiç girmez.
- Proje veya belge silinince parçalar ve vektörler de silinir.
- Gemini embedding API'si durumsuzdur; gruplar Google tarafında karışmaz. Ayrım yalnızca bu veri deposunda yapılır.
- Testler: iki kullanıcı ve iki proje ile aynı sorunun yalnızca kendi kaynaklarından cevap aldığı, başka projenin parçasının asla dönmediği doğrulanır.

## 3. Belge işleme hattı

1. Yükleme: `.pdf` ve `.docx`. Tür, boyut ve paket limiti kontrol edilir.
2. Metin çıkarma: PDF için mevcut `pypdf`; Word için mevcut DOCX kodu. Sayfa/başlık bilgisi korunur.
3. Metin katmanı olmayan (taranmış) PDF: "okunamadı" olarak işaretlenir, başarıyla işlenmiş gibi gösterilmez.
4. Parçalama: yaklaşık 200–400 sözcüklük, örtüşmeli parçalar; her parça sayfa/bölüm bilgisini taşır. Kaynakça bölümü parçalanıp aranır hale getirilmez veya ayrı işaretlenir.
5. Embedding: parçalar toplu olarak LLM servisine kuyrukla gönderilir (`RETRIEVAL_DOCUMENT` görev tipi); sonuç vektörler depoya yazılır. Hız ve kota için artımlı ilerleme gösterilir; bir belgenin hatası diğerlerini durdurmaz.
6. Belge durumu: `yükleniyor → çıkarılıyor → vektörleniyor → hazır | hata`.

Embedding modeli, boyutu ve istek başına parça sınırı uygulamadan önce güncel Gemini dokümantasyonundan doğrulanır.

## 4. Soru-cevap hattı

1. Soru embedding'e çevrilir (`RETRIEVAL_QUERY`).
2. Projenin parçaları arasında cosine benzerliğiyle en yakın N parça seçilir (anahtar kelime eşleşmesiyle desteklenebilir).
3. İstem şunlardan kurulur: seçili skill talimatı, kaynak parçaları (belge adı, sayfa, metin), kısa sohbet geçmişi, istenirse editördeki metin.
4. LLM yapılandırılmış çıktı üretir: cevap metni + her iddia için kullanılan parça kimlikleri.
5. Sunucu, cevaptaki atıfları parça kimliklerinden **kendisi** üretir (Yazar, Yıl, sayfa); modelin yazdığı atıf metnine güvenilmez. Kaynak parçasında karşılığı olmayan atıf cevaptan çıkarılır.
6. Kaynaklarda yeterli kanıt yoksa cevap bunu açıkça söyler.

## 5. Skill dosyaları

`skills/*.md`, başlıkta (frontmatter) şu alanlarla:

```
---
name: giris-yaz
title: Giriş bölümü yaz
description: Kaynaklara dayanarak giriş paragrafı üretir.
plans: [basic, premium, gold]
---
Talimat metni…
```

- Kullanıcı arayüzde skill seçer; seçmezse sistem soruya göre bir skill önerir (kullanıcı onaylar veya değiştirir).
- Skill talimatı sistem istemine eklenir. Kullanıcı sorusu talimatı geçersiz kılamaz; kaynak metinleri veri olarak işaretlenir ve içlerindeki talimatlar uygulanmaz (prompt enjeksiyonuna karşı).
- Skill listesi `plans` alanına göre pakete göre süzülür.
- Skill dosyaları depoda sürüm kontrolündedir; değişiklik için yeniden dağıtım gerekir.

## 6. Editör ve "Editöre ekle"

- `contenteditable` tabanlı hafif editör: başlık, kalın/italik, liste, atıf.
- Cevap kartında "Editöre ekle": metin imlecin olduğu yere girer; atıflar editörde atıf olarak işaretlenir.
- Eklenen her atıf için kaynak kaydı makalenin kaynakçasına eklenir. Kayıt mevcut doğrulama motoruyla (Crossref vb.) kontrol edilebilir; kullanıcının yüklediği PDF'in metadata'sı yoksa kayıt "doğrulanmadı" olarak işaretlenir.
- Makale proje içinde otomatik kaydedilir; Word (`.docx`) olarak indirme mevcut DOCX koduyla yapılır.

## 7. Arayüz

Yeni sayfa "Yazım yardımcısı": sol panelde projeler ve kaynak listesi (durum, ekle/sil), ortada soru-cevap (skill seçici, atıflı cevaplar), sağda editör. Mevcut sayfa yapısı ve stil korunur.

## 8. Güvenlik ve gizlilik

- Yüklenen belgeler yalnızca sahibinin projesinde tutulur; başka kullanıcıya hiç gösterilmez.
- Kaynak metinleri embedding ve cevap üretimi için dış servislere (Gemini, Groq/OpenRouter) gider. Kullanıcıya bu açıkça belirtilir; gizlilik metni ve onay arayüzde yer alır.
- Dosya boyutu ve sayısı sınırlanır; zararlı dosyalara karşı yalnızca `.pdf`/`.docx` tür ve imza kontrolü yapılır.
- Anonim kimlik çerezi imzalıdır; başkasının `userId`'sini tahmin etmek mümkün olmamalıdır.
- API anahtarları yalnızca LLM servisinde kalır (mevcut mimari kuralı).

## 9. Uygulama sırası

1. Kimlik/paket katmanı (`identity`, `plans`) ve SQLite deposu, izolasyon testleri.
2. Belge yükleme, metin çıkarma, parçalama, embedding hattı (LLM servisinde yeni iş türü).
3. Soru-cevap, atıf üretimi ve skill dosyaları.
4. Editör, "Editöre ekle" ve kaynakçaya ekleme.
5. Sohbet geçmişi ve editör bağlamı, paket limitlerinin arayüzde gösterimi.
6. Sonraki aşama: OCR, seçili metni skill ile yeniden yazma, gerçek giriş ve paketler.

## Ek kararlar (2 Ekim 2026)

- **Basic paket limitleri (rahat başlangıç):** 10 proje, projede 20 belge, belge başına 50 MB, günde 200 soru. Premium ve gold değerleri sonra belirlenir. Ücretsiz Gemini/Groq kotaları hızla tükenebilir; kota hatası kullanıcıya açık mesajla gösterilir ve embedding/cevap işleri kuyrukta sırayla işlenir.
- **Atıf biçimi:** APA 7 yazar–yıl, sayfa numarasıyla: (Yazar, 2020, s. 12). Projedeki Word denetimiyle uyumludur. Vancouver ve IEEE sayısal biçimleri projeye özel atıf stili olarak desteklenir (bkz. VANCOUVER_IEEE_PLAN.md).
- **Künye:** Yüklenen PDF/Word'ün künyesi (yazar, yıl, başlık, DOI) önce otomatik çıkarılır (dosya metadata'sı, ilk sayfa, DOI) ve mevcut motorla (Crossref vb.) doğrulanır. Yükleme sonrası kullanıcı künyeyi görür ve düzeltebilir. Künye kesinleşmeden atıf "künye doğrulanmadı" uyarısıyla verilir; atıf yazar–yıl yerine dosya adıyla uydurulmaz.
- **İlk skill seti:** `skills/` klasörü ve şablon, makale bölümleri (giriş, yöntem, bulgular, tartışma), literatür özeti ve karşılaştırma, akademik dile çevirme. Talimat metinleri taslaktır; son içeriği yönetici yazar.

- **Künye düzeltmesi:** Atıflar kaynak kimliğinden üretildiği için künye düzeltilince önceki cevaplardaki atıflar ve editöre eklenmiş atıflar ile kaynakça kaydı yeni künyeye göre güncellenir.
- **Aynı belge iki projede:** Embedding her projede yeniden hesaplanır; vektörler paylaşılmaz. Bu, izolasyonu basit tutar. Maliyet sonra ölçülür.
- **Limit/kota dolduğunda:** Kullanıcıya paket yükseltme önerisi gösterilir (hangi limite takıldığı, mevcut ve üst paketin değeri). Bu kullanıcı limiti içindir; sağlayıcı (Gemini/Groq) kotası dolarsa ayrıca "servis şu an yoğun, işiniz kuyrukta" mesajı verilir.

## Çalışma dalı

Geliştirme `makale_olusturucu` dalında sürdürülür (`mikroservis` dalından açıldı).

## Açık sorular

Şu an açık soru yok. Uygulama sırasında çıkan konular buraya eklenir.

## Uygulama notları (2 Ekim 2026)

- Uygulanan dosyalar: `lib/identity.cjs`, `lib/plans.cjs`, `lib/writer-store.cjs` (SQLite), `lib/writer-chunker.cjs`, `lib/writer-meta.cjs`, `lib/writer-search.cjs`, `lib/gemini-embed.cjs`, `lib/writer-embed.cjs`, `lib/writer-skills.cjs`, `lib/writer-answer.cjs`, `lib/writer-manuscript.cjs`, `writer-cite.js` (tarayıcı + Node ortak), `writer-service.cjs`, `writer-app.js`, `skills/*.md`; `scripts/word-package.py` künye (`metadata`), `limit` ve `build_docx` ile genişletildi; `llm` servisi `embed` işini ve `embedding` yeteneğini bildirir.
- Embedding: `gemini-embedding-001` varsayılan (taskType ile); `gemini-embedding-2` seçilirse görev tipi metin önekiyle verilir. Vektörler istemci tarafında birim uzunluğa normalize edilir.
- Kaynak parçaları PDF'de başladıkları sayfayla atıflanır; sayfa sınırını geçen paragraf okuyucu tarafından birleştirildiği için başladığı sayfa gösterilir. Word dosyalarında güvenilir sayfa numarası olmadığından sayfa atfı verilmez.
- Premium ve gold limitleri geçici değerlerdir (`lib/plans.cjs`); gerçek değerleri sahibi belirler.
- Paket limiti belge boyutu Python okuyucuya `limit` olarak iletilir (en çok 200 MB); çok büyük PDF'ler okuyucunun 45 saniyelik süre sınırına takılabilir ve açık bir hata iletisiyle reddedilir.
- Yapılmadı (kapsam dışı): OCR, seçili metni skill ile yeniden yazma, skill'leri arayüzden yönetme.
- Giriş sistemi ve yönetim paneli sonradan eklendi (3 Ekim 2026): yerel hesap + LDAP, DB'de paketler, aylık token kotası, işlem günlüğü. `lib/identity.cjs` artık oturum çözümleyiciyi (`lib/app.cjs`) kullanır; anonim çerez yalnız testlerde kalır. Skill erişimi `plans:` listesi yerine `minPlan` (paket sırası) ile belirlenir. Premium/gold limitleri ve aylık token varsayılanları hâlâ geçicidir; panelden değiştirilir.
