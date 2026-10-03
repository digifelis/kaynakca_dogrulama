# Kaynakça Masası – Docker Kurulum Yardımı

Bu belge, Docker imajlarını ayrı sunucularda ayağa kaldırmak için adım adım komutları içerir.

> **kaldera.beu.edu.tr sunucusu için** tek sunucuda Docker Compose kurulumu baştan sona **Bölüm 10**'da anlatılır (DNS, Nginx + TLS, ilk giriş, yedekleme, güncelleme, sorun giderme).

## 1. Genel bakış

| Bileşen | Image | Görevi | Kaç kopya? |
|---|---|---|---|
| `web` | `kaynakca-masasi/web` | Kullanıcı arayüzü ve API (port 4173) | 1 |
| `service` (kuyruk) | `kaynakca-masasi/service` | İş kuyruğu (port 4180) | **1** (durumlu, çoğaltılmaz) |
| `verify` | `kaynakca-masasi/verify` | Kaynakça doğrulama worker'ı | İstenildiği kadar, birden çok sunucu |
| `llm` | `kaynakca-masasi/service` | LLM worker'ı (`services/llm/index.cjs`) | İstenildiği kadar |

```
Kullanıcı ──► web ──► kuyruk (service) ◄── verify (sunucu B, C, ...)
                                       ◄── llm    (sunucu D, ...)
```

Worker'lar (verify, llm) kuyruğa **kendileri bağlanıp iş çeker**. Worker sunucularına dışarıdan
gelen bağlantı açmanız gerekmez, yalnızca kuyruğa giden bağlantı yeterlidir.

### Anahtar (JWT) mantığı

Servisler birbirini RS256 JWT ile doğrular. Üç anahtar çifti vardır: `web`, `verify`, `llm`.

| Dosya | Nerede olmalı |
|---|---|
| `keys/public/*.public.pem` (3 dosya) | **Her sunucuda** (web, kuyruk, verify, llm) |
| `keys/private/web.private.pem` | Yalnızca web sunucusunda |
| `keys/private/verify.private.pem` | Yalnızca verify sunucularında |
| `keys/private/llm.private.pem` | Yalnızca llm sunucularında |

Anahtarlar imajın içinde **yoktur** (`.dockerignore` dışarıda bırakır); her container'a dışarıdan bağlanır.
Private anahtarı yalnızca sahibi olan sunucuya koyun, git'e eklemeyin.

> **Uyarı:** `kaynakca-masasi/service` imajını bağlama/ortam değişkeni vermeden `docker run` ile
> çalıştırırsanız "Açık anahtar bulunamadı" hatasıyla kapanır. Aşağıdaki komutları kullanın.

---

## 2. Ortak hazırlık (her sunucuda)

### 2.1 Docker kurulumu (Ubuntu/Debian)
```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER      # çıkış yapıp tekrar girin
docker --version
```

### 2.2 Kodu alın
```bash
git clone https://github.com/digifelis/kaynakca_dogrulama.git kaynakca_dogrula
cd kaynakca_dogrula
git checkout makale_olusturucu
```

### 2.3 Anahtarları üretin (yalnızca bir kez, tek makinede)
```bash
node scripts/generate-keys.cjs
ls keys/public keys/private
```
Anahtarlar üretildikten sonra diğer sunuculara **kopyalanır**, yeniden üretilmez (Bölüm 2.4).
Yeniden üretirseniz tüm sunucuların anahtarlarını güncellemeniz gerekir.

### 2.4 Anahtarları sunuculara kopyalayın
Anahtarları ürettiğiniz makineden (örnek: `kullanici@SUNUCU`):
```bash
# Her sunucuya public anahtarlar
ssh kullanici@SUNUCU "mkdir -p ~/kaynakca_dogrula/keys/public ~/kaynakca_dogrula/keys/private"
scp keys/public/*.pem kullanici@SUNUCU:~/kaynakca_dogrula/keys/public/

# Sunucuya göre yalnızca ilgili private anahtar:
scp keys/private/web.private.pem    kullanici@WEB_SUNUCU:~/kaynakca_dogrula/keys/private/
scp keys/private/verify.private.pem kullanici@VERIFY_SUNUCU:~/kaynakca_dogrula/keys/private/
```

Container `node` kullanıcısıyla (uid 1000) çalıştığı için private anahtar dosyası okunabilir olmalıdır:
```bash
sudo chown 1000:1000 keys/private/*.pem
chmod 400 keys/private/*.pem
```

---

## 3. Senaryo A: web image'ını ayağa kaldırma

### A1. Tek makinede hızlı kurulum (her şey bir arada)
Web, kuyruk ve worker'ları birlikte denemek için en kolay yol Compose'tur:
```bash
cp services/verify/.env.example services/verify/.env     # API anahtarlarını doldurun
cp services/llm/.env.example    services/llm/.env
docker compose up --build -d
docker compose ps
```
Uygulama: http://127.0.0.1:4173

### A2. Web ayrı sunucuda (kuyruk başka yerde)
Önkoşul: Kuyruk çalışıyor ve web sunucusundan erişilebilir olmalı (Bölüm 4). Aşağıda kuyruk adresi
`https://kuyruk.ornek.com` olarak varsayılmıştır.

1. Web sunucusunda kodu alın (2.2) ve anahtarları yerleştirin (2.4):
   `keys/public/*.pem` (3 dosya) + `keys/private/web.private.pem`.

2. İmajı derleyin:
   ```bash
   docker build --target web -t kaynakca-masasi/web .
   ```

3. Container'ı başlatın:
   ```bash
   docker run -d --name web --restart unless-stopped \
     -e QUEUE_URL=https://kuyruk.ornek.com \
     -e JWT_KEYS_DIR=/keys \
     -e JWT_PRIVATE_KEY_FILE=/run/secrets/web_key \
     -v "$PWD/keys/public:/keys/public:ro" \
     -v "$PWD/keys/private/web.private.pem:/run/secrets/web_key:ro" \
     -v web-data:/data \
     -p 127.0.0.1:4173:4173 \
     kaynakca-masasi/web
   ```

4. Doğrulayın:
   ```bash
   docker logs web
   ```
   Beklenen: `Kaynakça Masası: http://localhost:4173/ (kuyruk: https://kuyruk.ornek.com; doğrulama servisi: N, LLM servisi: M)`.
   `(yerel mod)` yazıyorsa `QUEUE_URL` verilmemiştir, kuyruk kullanılmıyor demektir.

5. Kullanıcılara açmak için web sunucusunda bir TLS reverse proxy (Caddy/nginx) kurun
   (`4173` doğrudan internete açılmaz). Caddy örneği `/etc/caddy/Caddyfile`:
   ```
   kaynakca.ornek.com {
       reverse_proxy 127.0.0.1:4173
   }
   ```
   ```bash
   sudo apt install -y caddy && sudo systemctl reload caddy
   ```

---

## 4. Senaryo B: service (kuyruk) container'ını başka sunucuda ayağa kaldırma

Kuyruk tek kopya çalışır. Web ve tüm worker'lar buna bağlanır.

1. Kuyruk sunucusunda kodu alın (2.2) ve **yalnızca public anahtarları** yerleştirin:
   `keys/public/*.pem` (3 dosya). Kuyruk private anahtara ihtiyaç duymaz.

2. İmajı derleyin:
   ```bash
   docker build --target service -t kaynakca-masasi/service .
   ```

3. Container'ı başlatın:
   ```bash
   docker run -d --name service --restart unless-stopped \
     -e QUEUE_HOST=0.0.0.0 \
     -e QUEUE_PORT=4180 \
     -e QUEUE_DATA_DIR=/data \
     -e JWT_KEYS_DIR=/keys \
     -v "$PWD/keys/public:/keys/public:ro" \
     -v queue-data:/data \
     -p 127.0.0.1:4180:4180 \
     kaynakca-masasi/service
   ```
   `queue-data` volume'u iş günlüğünü (`queue.jsonl`) tutar; container yeniden başlayınca bekleyen işler geri yüklenir.

4. Sağlık kontrolü:
   ```bash
   docker logs service
   curl http://127.0.0.1:4180/health
   ```
   Beklenen: `Kuyruk servisi: http://0.0.0.0:4180 (yayıncılar: llm, verify, web)` ve `{"ok":true,...}`.

5. **TLS ile dışarı açın.** Kuyruğun kendi TLS'i yoktur; iş içerikleri (kaynakça metinleri) ağda açık
   gitmesin diye 4180'i doğrudan internete açmayın. Caddy örneği:
   ```
   kuyruk.ornek.com {
       reverse_proxy 127.0.0.1:4180
   }
   ```
   ```bash
   sudo apt install -y caddy && sudo systemctl reload caddy
   ```
   DNS'te `kuyruk.ornek.com` adresini bu sunucuya yönlendirin.

6. Güvenlik duvarı (yalnızca 80/443 ve SSH açık):
   ```bash
   sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
   ```
   İsterseniz 443'ü yalnızca web ve worker sunucularının IP'lerine kısıtlayın:
   `sudo ufw allow from <SUNUCU_IP> to any port 443 proto tcp`.

7. Web sunucusu veya worker sunucusundan erişimi test edin:
   ```bash
   curl https://kuyruk.ornek.com/health
   ```

> **LLM worker'ı:** Aynı `service` imajıyla çalışır, yalnızca komut farklıdır. Ayrı sunucuda:
> ```bash
> cp services/llm/.env.example services/llm/.env    # GROQ_API_KEY vb. doldurun
> docker run -d --name llm --restart unless-stopped \
>   -e QUEUE_URL=https://kuyruk.ornek.com \
>   -e JWT_KEYS_DIR=/keys \
>   -e JWT_PRIVATE_KEY_FILE=/run/secrets/llm_key \
>   --env-file services/llm/.env \
>   -v "$PWD/keys/public:/keys/public:ro" \
>   -v "$PWD/keys/private/llm.private.pem:/run/secrets/llm_key:ro" \
>   kaynakca-masasi/service node services/llm/index.cjs
> ```
> Eşzamanlı iş sayısını `-e LLM_CONCURRENCY=3` ile artırabilirsiniz. Tüm kopyalar aynı Groq/OpenRouter
> anahtarını kullanıyorsa asıl sınır API rate limit'idir.

---

## 5. Senaryo C: verify image'ını başka sunucuda ayağa kaldırma

Verify worker'ı kuyruktan doğrulama işi çeker. Yük arttıkça yeni sunucu ekleyerek veya aynı sunucuda
birden çok container çalıştırarak ölçeklenir (her worker aynı anda 1 iş yapar).

Önkoşul: Kuyruk çalışıyor ve bu sunucudan erişilebilir (Bölüm 4, adım 7).

1. Verify sunucusunda kodu alın (2.2) ve anahtarları yerleştirin (2.4):
   `keys/public/*.pem` (3 dosya) + `keys/private/verify.private.pem`
   (ardından `chown 1000:1000` ve `chmod 400`).

2. API anahtarlarını doldurun (kendi sunucunuzdaki `.env`; kuyruğa veya web'e hiç gönderilmez):
   ```bash
   cp services/verify/.env.example services/verify/.env
   nano services/verify/.env
   ```
   Alanlar: `OPENALEX_API_KEY`, `NCBI_API_KEY`, `SEMANTIC_SCHOLAR_API_KEY`, `CORE_API_KEY`,
   `GOOGLE_BOOKS_API_KEY`, `CROSSREF_MAILTO`. Hepsi opsiyoneldir; boş olanın kaynağı daha sınırlı çalışır.

3. İmajı derleyin (Python + pypdf içerir, ilk derleme birkaç dakika sürer):
   ```bash
   docker build --target python -t kaynakca-masasi/verify .
   ```

4. Container'ı başlatın:
   ```bash
   docker run -d --name verify-1 --restart unless-stopped \
     -e QUEUE_URL=https://kuyruk.ornek.com \
     -e JWT_KEYS_DIR=/keys \
     -e JWT_PRIVATE_KEY_FILE=/run/secrets/verify_key \
     --env-file services/verify/.env \
     -v "$PWD/keys/public:/keys/public:ro" \
     -v "$PWD/keys/private/verify.private.pem:/run/secrets/verify_key:ro" \
     kaynakca-masasi/verify
   ```
   Komut imajda varsayılan olarak `node services/verify/index.cjs`'tir, ayrıca vermeniz gerekmez.

5. Doğrulayın:
   ```bash
   docker logs verify-1
   ```
   Hata yoksa worker kuyruğa bağlanmıştır. Web sunucusunun logunda da `doğrulama servisi: N` sayısı artar.
   `QUEUE_URL tanımlı değil.` hatası `-e QUEUE_URL` eksik demektir.

6. **Aynı sunucuda ek worker (yatay ölçekleme):** Çekirdek sayınıza göre ad ve komutu tekrarlayın:
   ```bash
   for i in 2 3; do
     docker run -d --name verify-$i --restart unless-stopped \
       -e QUEUE_URL=https://kuyruk.ornek.com -e JWT_KEYS_DIR=/keys \
       -e JWT_PRIVATE_KEY_FILE=/run/secrets/verify_key --env-file services/verify/.env \
       -v "$PWD/keys/public:/keys/public:ro" \
       -v "$PWD/keys/private/verify.private.pem:/run/secrets/verify_key:ro" \
       kaynakca-masasi/verify
   done
   ```

7. **Yeni sunucu eklemek:** Yeni makinede Bölüm 2.1, 2.2, ardından bu bölümün 1–5. adımlarını uygulayın.
   Web ve kuyrukta değişiklik gerekmez.

---

## 6. Güncelleme ve bakım

```bash
git pull
docker build --target python -t kaynakca-masasi/verify .          # verify sunucuları
docker rm -f verify-1 && <Bölüm 5, adım 4'teki docker run komutu>
```
Aynı yöntem `web` ve `service` için de geçerlidir (ilgili `--target` ve komutla).

| İşlem | Komut |
|---|---|
| Log izleme | `docker logs -f <ad>` |
| Durum | `docker ps` |
| Yeniden başlatma | `docker restart <ad>` |
| Durdurma | `docker stop <ad>` |

Önerilen güncelleme sırası: önce kuyruk, sonra worker'lar, en son web.

## 7. Sorun giderme

| Belirti | Neden / çözüm |
|---|---|
| `Açık anahtar bulunamadı` (kuyruk) | `keys/public` bağlanmamış veya boş; `-v ...:/keys/public:ro` ve `JWT_KEYS_DIR=/keys` kontrol edin. |
| `QUEUE_URL tanımlı değil.` | `-e QUEUE_URL=...` verilmemiş. |
| Web `(yerel mod)` diyor | Web'e `QUEUE_URL` verilmemiş; kuyruğa bağlı değil. |
| Worker kuyruğa bağlanamıyor | DNS, TLS, güvenlik duvarı; sunucudan `curl https://kuyruk.ornek.com/health` deneyin. |
| `401`/imza hatası | Sunucudaki public/private anahtarlar farklı üretimden; aynı anahtar setini kullanın (2.4). |
| Private anahtar okunamıyor | `sudo chown 1000:1000 keys/private/*.pem` ve `chmod 400`. |
| Port zaten kullanımda | Eski container/süreç aynı portu tutuyor: `docker ps`, `docker rm -f <ad>`. |

---

## 8. Yazım yardımcısı için ek ayarlar

Yazım yardımcısı (`#/yazim`) ek bir servis gerektirmez; mevcut `web` ve `llm` imajları kullanılır.

| Ayar | Nerede | Açıklama |
|---|---|---|
| `GEMINI_API_KEY` | **llm servisinin** `.env` dosyası (`services/llm/.env`) | Kaynakların embedding'i için. Yoksa yalnız anahtar kelime araması çalışır. |
| `GEMINI_EMBEDDING_MODEL`, `GEMINI_EMBEDDING_DIM` | llm servisi `.env` | İsteğe bağlı; varsayılan `gemini-embedding-001` ve 768. |
| `web-data` birimi (`/data`) | web sunucusu | `/data/writer` altında `writer.db` (SQLite: projeler, kaynak parçaları, vektörler, makaleler) ve `identity.secret` bulunur. **Kalıcı birim olmalı ve yedeklenmelidir.** |
| `IDENTITY_SECRET` | web (isteğe bağlı) | Aynı kullanıcı kimliklerini birden çok web sunucusunda geçerli kılmak için ortak gizli değer. Verilmezse `identity.secret` dosyası kullanılır. |
| `prompts.db` (`WRITER_DATA_DIR`) | web | Panelden düzenlenen istemler ve skill'ler; `skills/*.md` dosyaları varsayılandır, panel düzenlemeleri onların yerine geçer. |
| `skills/` | web imajı | Skill dosyaları imajla gelir; değiştirmek için dosyayı düzenleyip imajı yeniden derleyin veya klasörü bağlayıp `SKILLS_DIR` verin. |

Web sunucusunda doğrudan çalıştırma örneği (kuyruklu kurulum, Bölüm 3'e ek olarak veri birimi zaten `-v web-data:/data` ile bağlıdır):
```bash
docker run -d --name web --restart unless-stopped \
  -e QUEUE_URL=https://kuyruk.ornek.com -e JWT_KEYS_DIR=/keys \
  -e JWT_PRIVATE_KEY_FILE=/run/secrets/web_key \
  -v "$PWD/keys/public:/keys/public:ro" \
  -v "$PWD/keys/private/web.private.pem:/run/secrets/web_key:ro" \
  -v web-data:/data -p 127.0.0.1:4173:4173 kaynakca-masasi/web
```
Kontrol: `curl -s -H "x-word-request: 1" http://127.0.0.1:4173/api/writer/bootstrap` yanıtında `services.llm` ve `services.embedding` alanları `true` olmalıdır (kuyruklu kurulumda llm servisi çalışıyorsa).

Yedekleme: `docker run --rm -v web-data:/data -v "$PWD:/backup" alpine tar czf /backup/web-data.tgz /data`.

---

## 9. Hesaplar, yönetici girişi ve ayarlar

Web sunucusu artık giriş ister (yalnız kaynakça doğrulama sayfası açıktır). Bağımlılıklar imajda `npm ci` ile kurulur; elle çalıştırıyorsanız önce `npm ci` yapın.

**İlk giriş:** web ilk kez başladığında günlükte "İlk yönetici hesabı oluşturuldu" yazar. `http://SUNUCU:4173/#/giris` adresinde **`admin@admin.com` / `admin`** ile girin; sistem parolayı hemen değiştirmenizi ister. Başka bir ilk hesap istiyorsanız `-e ADMIN_USERNAME=... -e ADMIN_PASSWORD=...` verin (parola 10+ karakter olmalı). Kurulumdan hemen sonra parolayı değiştirmeden sunucuyu internete açmayın.

| Ayar | Açıklama |
|---|---|
| `PUBLIC_URL` | Dışarıdan görünen adres (`https://kaynak.ornek.com`). E-postadaki doğrulama/sıfırlama bağlantıları ve `Secure` çerez için. TLS ters vekil kullanıyorsanız **verin**. |
| `ALLOWED_HOSTS` | `localhost` dışında hangi ana bilgisayar adlarıyla erişilebileceği (virgülle). `PUBLIC_URL` adresi otomatik kabul edilir; diğer adlar 403 alır. |
| `TRUST_PROXY=1` | Ters vekil (nginx vb.) arkasında istemci IP'sini `X-Forwarded-For` başlığından okur; hatalı giriş kilitleri için gerekir. Vekil yoksa **vermeyin**. |
| `SETTINGS_SECRET` | LDAP/SMTP parolalarını şifreleyen anahtar. Verilmezse `/data/writer/settings.secret` dosyası üretilir. |
| `IDENTITY_SECRET` | Bkz. Bölüm 8. |

**Veri ve yedek:** hesaplar, paketler, ayarlar ve token günlüğü `/data/writer/app.db` içindedir (`web-data` birimi). Birimi yedekleyin; `settings.secret` kaybolursa kayıtlı LDAP/SMTP parolaları çözülemez ve panelden yeniden girilmelidir. Hesaplar tek bir `app.db` dosyasındadır; bu yüzden **şimdilik tek web sunucusu** kullanın (verify ve service sunucularını çoğaltabilirsiniz).

**Eski Word arşivi:** hesaplara geçildiğinde sahibi olmayan eski Word/içerik belgeleri ilk açılışta **bir kez silinir** (günlükte sayısı yazılır).

**Yönetim paneli:** yönetici girişinden sonra üst menüde "Yönetim" görünür. LDAP için *Ayarlar → LDAP girişi*; sunucu (`ldaps://ldap.kurum.edu.tr:636`), servis hesabı, arama tabanı ve filtre girilip *Bağlantıyı sına* ile denenir. SMTP için *Ayarlar → E-posta (SMTP)*; *Test iletisi gönder* ile denenir. E-posta ayarlanmazsa "Parolamı unuttum" gizlenir ve adres doğrulama yapılamaz.

**Ağ notu:** web sunucusu LDAP sunucusuna (389/636) ve SMTP sunucusuna (587/465) giden bağlantı açabilmelidir.

**API anahtarları (Groq / OpenRouter / Gemini):** `.env` dosyaları yalnızca başlangıç anahtarları içindir. Daha fazla anahtar, sunucuyu yeniden başlatmadan **Yönetim → API anahtarları** sayfasından eklenir. Docker'da bu anahtarlar `llm` servisinin `llm-data` biriminde (`LLM_DATA_DIR=/data/llm`, `llm-keys.db` + `settings.secret`) şifreli saklanır; **yedekleyin** ve LLM servisini tek kopya çalıştırın. `.env` anahtarları panelde düzenlenemez; silinirse yalnızca havuzdan çıkarılır (dosya değişmez). Ayrıntı: README → "API anahtar havuzu".

---

## 10. Adım adım kurulum: kaldera.beu.edu.tr (Docker Compose, tek sunucu)

Bu bölüm, tüm bileşenlerin **tek bir Linux sunucuda Docker Compose ile** çalıştığı kurulumu baştan sona anlatır. Adresler:

| Adres | Ne için | Arkasında |
|---|---|---|
| `https://kaldera.beu.edu.tr` | Kullanıcıların ve yöneticilerin kullandığı web uygulaması | `web` container'ı, `127.0.0.1:4173` |
| `https://kuyruk.kaldera.beu.edu.tr` | İş kuyruğu (worker'lar ve web buna bağlanır) | `queue` container'ı, `127.0.0.1:4180` |

```
Tarayıcı ──HTTPS──► Nginx (443) ──► web  :4173 ──┐
                                 └► queue :4180 ◄─┤  (Docker iç ağı: http://queue:4180)
Dış worker (isteğe bağlı) ─HTTPS─► kuyruk.kaldera.beu.edu.tr
                                    queue ◄── verify ×2, llm  (aynı Compose)
```

Aynı sunucudaki `web`, `verify` ve `llm` kuyruğa **Docker iç ağından** (`http://queue:4180`) bağlanır; `kuyruk.kaldera.beu.edu.tr` adresi, ileride **başka bir sunucuya** verify/llm worker'ı koymak istediğinizde kullanılır. Yine de adresi şimdiden açmak ve test etmek iyi olur.

### 10.1 Başlamadan önce

- Ubuntu 22.04/24.04 (veya Debian 12) sunucu, en az **4 CPU, 8 GB RAM, 40 GB disk** önerilir (verify ve llm birlikte PDF okuyup doğrulama yapar).
- Sunucuya SSH ve `sudo` yetkisi.
- Bilgi İşlem'den: `kaldera.beu.edu.tr` ve `kuyruk.kaldera.beu.edu.tr` DNS kayıtlarının (A kaydı) **aynı sunucunun IP'sine** yönlendirilmesi. Kontrol: `dig +short kaldera.beu.edu.tr`, `dig +short kuyruk.kaldera.beu.edu.tr`.
- Sunucuda **80 ve 443** portlarının internetten (veya kampüs ağından) erişilebilir olması. 4173 ve 4180 portları dışarı **açılmaz**.
- Sunucudan dışarıya (443) çıkış: Crossref, OpenAlex, Semantic Scholar, Groq/OpenRouter/Gemini ve LDAP/SMTP (kullanacaksanız) adreslerine erişim gerekir. Kurumsal güvenlik duvarında bunlara izin verildiğini doğrulayın.
- İsteğe bağlı: kurumun LDAP/SMTP bilgileri, Groq/OpenRouter/Gemini API anahtarları (Bölüm 10.6'da panelden de eklenebilir).

### 10.2 Docker ve yardımcı araçları kurun

```bash
sudo apt update && sudo apt install -y git nginx certbot python3-certbot-nginx ufw curl
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER        # oturumu kapatıp yeniden açın
docker --version && docker compose version
```

Güvenlik duvarı (yalnızca SSH ve web):
```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```
> Docker, yayınlanan portları `ufw` kurallarını atlayarak açabilir. Bu kurulumda 4173 ve 4180 yalnızca `127.0.0.1`'e bağlandığı (`docker-compose.yml`) için dışarıdan erişilemez; bu satırları değiştirmeyin.

### 10.3 Kodu alın

```bash
sudo mkdir -p /opt/kaldera && sudo chown $USER: /opt/kaldera
git clone https://github.com/digifelis/kaynakca_dogrulama.git /opt/kaldera
cd /opt/kaldera
git checkout makale_olusturucu
```
Bundan sonraki tüm komutlar `/opt/kaldera` içinde çalıştırılır.

### 10.4 Servis anahtarlarını (JWT) üretin

Servisler birbirini RS256 imzalı belgelerle doğrular. Anahtarlar imajda yoktur; sunucuda bir kez üretilir:
```bash
# Node.js yoksa geçici bir container ile üretin:
docker run --rm -v "$PWD:/app" -w /app node:24-alpine node scripts/generate-keys.cjs
ls keys/public keys/private
```
Container'lar `node` kullanıcısıyla (uid 1000) çalıştığı için private anahtarlar ona ait ve yalnızca okunur olmalı:
```bash
sudo chown -R 1000:1000 keys/private
sudo chmod 400 keys/private/*.pem
sudo chmod 755 keys/private && sudo chmod 644 keys/public/*.pem
```
> **Yedekleyin:** `keys/` klasörünü sunucu dışında güvenli bir yere kopyalayın (örn. parola korumalı arşiv). Kaybolursa anahtarlar yeniden üretilir ve ayrı sunucudaki tüm worker'ların anahtarı güncellenmelidir. Private anahtarları git'e eklemeyin (`.gitignore` zaten dışarıda bırakır).

### 10.5 Yapılandırma dosyalarını hazırlayın

**a) Compose'un okuduğu `.env` (web adresi):** `/opt/kaldera/.env`
```bash
cat > .env <<'EOF'
PUBLIC_URL=https://kaldera.beu.edu.tr
ALLOWED_HOSTS=kaldera.beu.edu.tr
TRUST_PROXY=1
EOF
```
| Değişken | Neden |
|---|---|
| `PUBLIC_URL` | Dışarıdan görünen adres. E-postadaki doğrulama/sıfırlama bağlantıları ve `Secure` çerez bunu kullanır. |
| `ALLOWED_HOSTS` | Uygulamanın yanıt vereceği ana bilgisayar adı; başka adla gelen istekler reddedilir (403). |
| `TRUST_PROXY=1` | Nginx arkasında istemcinin gerçek IP'sini `X-Forwarded-For`'dan okur (hatalı giriş kilidi için gerekli). **Yalnız** Nginx'in önünde olduğu bu kurulumda verin. |

**b) LLM servisi anahtarları:** `services/llm/.env`
```bash
cp services/llm/.env.example services/llm/.env
nano services/llm/.env
```
En az bir sağlayıcı anahtarı yazın (`GROQ_API_KEY`, `OPENROUTER_API_KEY` veya `GEMINI_API_KEY`). Kaynakların embedding'i ve yazım yardımcısı için `GEMINI_API_KEY` gerekir. **Sonradan** Yönetim paneli → *API anahtarları* sayfasından da (yeniden başlatmadan) anahtar eklenebilir; bu dosya yalnızca başlangıç anahtarları içindir.

**c) Doğrulama servisi anahtarları (isteğe bağlı):** `services/verify/.env`
```bash
cp services/verify/.env.example services/verify/.env
nano services/verify/.env     # CROSSREF_MAILTO=<kurum e-postası> yazmanız önerilir
```
> Bu `.env` dosyaları git'e girmez (`.gitignore`) ve imaja kopyalanmaz (`.dockerignore`); yalnızca ilgili container'a ortam değişkeni olarak verilir.

**d) İlk yönetici hesabı (isteğe bağlı):** Varsayılan ilk hesap `admin@admin.com` / `admin`'dir ve ilk girişte parola değişimi zorunludur. Kendi hesabınızla başlamak isterseniz `docker-compose.yml`'de `web` servisinin `environment` bölümüne `ADMIN_USERNAME` ve `ADMIN_PASSWORD` (10+ karakter) ekleyin.

### 10.5-e Docker ağı: `mansur_laravel_net`

Tüm container'lar (queue, verify, llm, web) Compose'un kendi ağına ek olarak sunucudaki mevcut **`mansur_laravel_net`** ağına da bağlanır (`docker-compose.yml` → `networks`; ağ `external` olduğu için Compose onu oluşturmaz, var olmalıdır):
```bash
docker network inspect mansur_laravel_net >/dev/null 2>&1 || docker network create mansur_laravel_net
```
Bu ağdaki başka container'lar (örn. Laravel projesinin Nginx'i) servislere şu adlarla ulaşır: web → `http://kaldera-web:4173`, kuyruk → `http://kaldera-queue:4180`. Ters vekil bu ağdaki bir container ise Bölüm 10.7'deki `proxy_pass http://127.0.0.1:4173;` yerine `proxy_pass http://kaldera-web:4173;` (kuyruk için `http://kaldera-queue:4180`) yazın. Ters vekil sunucuda doğrudan (container değil) çalışıyorsa `127.0.0.1` adresleri aynen kalır. Bu ağa bağlanan başka uygulamalarla ad çakışmaması için `kaldera-` ön ekli takma adlar kullanılmıştır. `docker run` ile elle başlatılan container'lara da `--network mansur_laravel_net` ekleyin.

**Ters vekil sunucunun IP'si üzerinden bağlanıyorsa** (örn. `proxy_pass http://10.1.2.116:4173;`): web portu varsayılan olarak yalnız `127.0.0.1`'de yayınlanır, bu yüzden o adrese bağlanan Nginx "Connection refused" / 502 alır. Compose dosyasının yanındaki `.env` dosyasına sunucu IP'sini yazın ve yeniden başlatın:
```bash
echo 'WEB_BIND=10.1.2.116' >> .env       # kuyruk için de gerekirse: QUEUE_BIND=10.1.2.116
docker compose up -d
docker port kaynakca-masasi-web-1         # 4173/tcp -> 10.1.2.116:4173
```
Port o ağdan erişilebilir olur; güvenlik duvarında yalnızca ters vekile izin verin. `0.0.0.0` yazmaktan kaçının. Ad yerine IP kullanmak, container yeniden oluşunca Nginx'in eski IP'de kalması sorununu da önler.

### 10.6 Container'ları derleyin ve başlatın

```bash
docker compose build           # ilk derleme birkaç dakika sürer
docker compose up -d
docker compose ps
```
Beklenen: `queue` (healthy), `verify` ×2, `llm` ve `web` **running**. Kontroller:
```bash
curl -s http://127.0.0.1:4180/health          # {"ok":true,...}
docker compose logs web | tail -n 20          # "Kaynakça Masası: ... (kuyruk: http://queue:4180; doğrulama servisi: 2, LLM servisi: 1)"
docker compose logs web | grep -i "yönetici"  # ilk yönetici hesabı oluşturuldu
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4173/
```
`(yerel mod)` yazıyorsa `web` kuyruğa bağlanmamıştır: `docker compose logs queue web` çıktısına bakın. `doğrulama servisi: 0` ise verify container'ları henüz bağlanmamıştır (birkaç saniye bekleyip tekrar bakın); `Açık anahtar bulunamadı` / `401` görürseniz Bölüm 10.4'teki anahtar izinlerini kontrol edin.

### 10.7 Nginx ters vekili ve TLS sertifikası

İki site tanımlayın. Önce sertifikasız (80 portu) açıp sertifikayı alın, sonra Certbot yapılandırmayı HTTPS'e çevirir.

**a) `/etc/nginx/sites-available/kaldera`**
```nginx
# --- Web uygulaması ---
server {
    listen 80;
    server_name kaldera.beu.edu.tr;

    client_max_body_size 30m;            # Word/PDF yüklemeleri (uygulama sınırı 20 MB; base64 ile ~27 MB)
    proxy_read_timeout 300s;             # uzun süren doğrulama/LLM istekleri
    proxy_send_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:4173;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# --- Kuyruk ---
server {
    listen 80;
    server_name kuyruk.kaldera.beu.edu.tr;

    client_max_body_size 5m;
    proxy_read_timeout 120s;             # worker'lar iş beklerken uzun süre bağlı kalır (long-poll)
    proxy_buffering off;

    location / {
        proxy_pass http://127.0.0.1:4180;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        # İsteğe bağlı: yalnızca belirli worker IP'lerine izin verin (aşağıdaki satırları açın)
        # allow 10.20.30.40;
        # deny all;
    }
}
```
> `X-Forwarded-For`'a `$remote_addr` yazılması bilinçlidir: istemcinin kendi gönderdiği başlığa güvenilmez, hatalı giriş kilidi sahte IP ile atlatılamaz.

**b) Etkinleştirin ve sertifika alın**
```bash
sudo ln -s /etc/nginx/sites-available/kaldera /etc/nginx/sites-enabled/kaldera
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d kaldera.beu.edu.tr -d kuyruk.kaldera.beu.edu.tr
```
Certbot e-posta adresi sorar, sertifikayı alır, HTTP'yi HTTPS'e yönlendirir ve yenilemeyi zamanlar (`sudo certbot renew --dry-run` ile sınayın).

> **Kurumun kendi sertifikasını kullanıyorsanız** (Let's Encrypt'e dış erişim yoksa): her `server` bloğuna `listen 443 ssl;`, `ssl_certificate /etc/ssl/kaldera/fullchain.pem;`, `ssl_certificate_key /etc/ssl/kaldera/privkey.pem;` ekleyin ve 80 portundan `return 301 https://$host$request_uri;` ile yönlendirin. Sertifika `kaldera.beu.edu.tr` ve `kuyruk.kaldera.beu.edu.tr` adlarını kapsamalıdır (SAN veya joker `*.kaldera.beu.edu.tr`).

> **Caddy tercih ederseniz** Nginx ve Certbot yerine tek dosya yeterlidir (`/etc/caddy/Caddyfile`; sertifikayı kendisi alır ve yeniler):
> ```
> kaldera.beu.edu.tr {
>     request_body { max_size 30MB }
>     reverse_proxy 127.0.0.1:4173
> }
> kuyruk.kaldera.beu.edu.tr {
>     reverse_proxy 127.0.0.1:4180
> }
> ```

**c) Dışarıdan doğrulayın**
```bash
curl -s https://kuyruk.kaldera.beu.edu.tr/health      # {"ok":true,...}
curl -sI https://kaldera.beu.edu.tr/ | head -n 1      # HTTP/2 200
```

### 10.8 İlk giriş ve temel ayarlar

1. Tarayıcıda `https://kaldera.beu.edu.tr/#/giris` adresini açın.
2. `admin@admin.com` / `admin` ile girin; sistem **parolayı hemen değiştirmenizi** ister (Bölüm 10.5-d'de kendi hesabınızı tanımladıysanız onunla girin). Parolayı değiştirmeden siteyi duyurmayın.
3. Üst menüde **Yönetim** görünür. Sırayla:
   - **Ayarlar → Genel:** kayıt açık/kapalı ve varsayılan paket.
   - **Ayarlar → LDAP girişi** (kullanacaksanız): sunucu (`ldaps://...:636`), servis hesabı, arama tabanı, filtre → *Bağlantıyı sına*.
   - **Ayarlar → E-posta (SMTP):** sunucu, port, gönderen → *Test iletisi gönder*. Ayarlanmazsa "Parolamı unuttum" ve e-posta doğrulaması çalışmaz.
   - **Ayarlar → Semantic Scholar:** API anahtarını yazın → *Sına* (yazım yardımcısında makale arama/içe aktarma için).
   - **API anahtarları:** Groq/OpenRouter/Gemini anahtarlarını ekleyin, her birinde *Sına*'ya basın. Sınırsız sayıda anahtar eklenebilir; kota dolunca sıradakine geçilir.
   - **Paketler:** kullanıcı paketlerinin token, kaynak, belge ve soru sınırlarını kurumunuza göre ayarlayın.
   - **Model istemleri / Yazım skill'leri:** gerekirse metinleri özelleştirin.
4. Bir deneme kullanıcısıyla (kayıt veya LDAP) giriş yapıp bir kaynakça doğrulaması, bir PDF yükleme ve (Gemini anahtarı varsa) yazım yardımcısında kaynak ekleme deneyin.
5. **Yönetim → Raporlar** sekmesi, kullanım başladıkça sorgu süreleri, hatalar, token tüketimi ve kullanıcı deneyimi skorlarını göstermeye başlar (ölçümler sunucu başladığı andan itibaren birikir).

### 10.9 Veri, yedekleme ve geri yükleme

Kalıcı veriler Docker birimlerindedir (`docker volume ls` → `kaynakca-masasi_*`):

| Birim | İçerik | Önemi |
|---|---|---|
| `kaynakca-masasi_web-data` | Hesaplar, paketler, ayarlar, token günlüğü (`app.db`), projeler/kaynaklar/vektörler (`writer.db`), önbellek (`cache.db`), istemler (`prompts.db`), rapor metrikleri (`metrics.db`), `settings.secret`, `identity.secret` | **Kritik** (yedekleyin) |
| `kaynakca-masasi_llm-data` | Panelden eklenen API anahtarları (şifreli) ve anahtar sırrı | **Kritik** |
| `kaynakca-masasi_queue-data` | Bekleyen işler (`queue.jsonl`) | Geçici; kaybı yalnız bekleyen işleri etkiler |
| `/opt/kaldera/keys` | JWT anahtarları | **Kritik** (Bölüm 10.4) |
| `/opt/kaldera/.env`, `services/*/.env` | Yapılandırma | Yedekleyin |

Günlük yedek (veritabanı tutarlılığı için kısa süre durdurarak):
```bash
sudo mkdir -p /var/backups/kaldera
cat | sudo tee /usr/local/bin/kaldera-yedek >/dev/null <<'EOF'
#!/bin/sh
set -e
cd /opt/kaldera
DEST=/var/backups/kaldera
TS=$(date +%Y%m%d-%H%M)
docker compose stop web llm
for v in web-data llm-data; do
  docker run --rm -v kaynakca-masasi_$v:/data:ro -v $DEST:/backup alpine tar czf /backup/$v-$TS.tgz -C /data .
done
docker compose start web llm
tar czf $DEST/ayarlar-$TS.tgz keys .env services/llm/.env services/verify/.env
find $DEST -name '*.tgz' -mtime +14 -delete
EOF
sudo chmod 700 /usr/local/bin/kaldera-yedek
echo '30 3 * * * root /usr/local/bin/kaldera-yedek' | sudo tee /etc/cron.d/kaldera-yedek
```
Yedekleri başka bir makineye de kopyalayın (örn. `rsync`). Geri yükleme:
```bash
docker compose stop web llm
docker run --rm -v kaynakca-masasi_web-data:/data -v /var/backups/kaldera:/backup alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/web-data-ZAMAN.tgz -C /data"
docker compose start web llm
```

### 10.10 Güncelleme

```bash
cd /opt/kaldera
git pull
docker compose build
docker compose up -d            # yalnızca değişen container'lar yeniden oluşturulur
docker compose ps
```
Birimler korunur; hesaplar ve ayarlar kaybolmaz. Güncellemeden önce `sudo kaldera-yedek` çalıştırın. Geri dönmek için `git checkout <önceki-commit>` ve yeniden `docker compose build && docker compose up -d`.

Güncellemeden sonra yeni oluşan container'ların Nginx ile aynı ağda (`mansur_laravel_net`, Bölüm 10.5-e) olduğunu doğrulayın:
```bash
docker network inspect mansur_laravel_net --format '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{"\n"}}{{end}}'
```
Çıktıda Nginx ile birlikte `kaynakca-masasi-web-1` ve `kaynakca-masasi-queue-1` görünmelidir. Görünmüyorsa (örn. sunucudaki `docker-compose.yml` ağ tanımını içermiyorsa) elle bağlayın; bu bağlantı container yeniden oluşturulunca kaybolur, kalıcı çözüm `docker-compose.yml` içinde `laravel` ağının ve takma adların bulunmasıdır:
```bash
docker network connect --alias kaldera-web   mansur_laravel_net kaynakca-masasi-web-1
docker network connect --alias kaldera-queue mansur_laravel_net kaynakca-masasi-queue-1
```

### 10.11 İzleme ve günlük komutları

| İşlem | Komut |
|---|---|
| Durum | `docker compose ps` |
| Günlük izleme | `docker compose logs -f web` · `queue` · `verify` · `llm` |
| Yeniden başlatma | `docker compose restart web` |
| Doğrulama worker sayısı | `docker compose up -d --scale verify=4` (CPU yetiyorsa) |
| Kaynak kullanımı | `docker stats` |
| Disk | `docker system df` |
| Nginx günlüğü | `/var/log/nginx/access.log`, `error.log` |

Sunucu büyütme/ölçekleme kararları için **Yönetim → Raporlar → Kapasite** ve **Performans** sekmelerine bakın (CPU, olay döngüsü gecikmesi, model kota beklemesi, dosya işleme sırası). LLM servisini **tek kopya** tutun (panel anahtarları onun biriminde); `web` de tek kopya kalmalıdır (hesaplar tek `app.db` dosyasındadır).

### 10.12 Doğrulama servislerini sonradan başka sunucuya taşımak

Yük artarsa `verify` (ve istenirse `llm`) worker'ları ayrı sunucuya konabilir; bunun için yalnızca `kuyruk.kaldera.beu.edu.tr` adresi gerekir:
1. Yeni sunucuda Bölüm 2.1–2.2 ve Bölüm 5 (verify) / Bölüm 4'teki LLM notunu uygulayın; `QUEUE_URL=https://kuyruk.kaldera.beu.edu.tr` verin.
2. Bu sunucudan **yalnızca** ilgili private anahtarı (`verify.private.pem` veya `llm.private.pem`) ve üç public anahtarı kopyalayın.
3. Kuyruk Nginx'inde (10.7-a) `allow <yeni sunucu IP>; deny all;` satırlarını açarak kuyruğu yalnızca worker IP'lerine kısıtlayın.
4. Ana sunucuda `docker compose stop verify` ile yerel worker'ları kapatabilirsiniz.

### 10.13 Sorun giderme

| Belirti | Neden / çözüm |
|---|---|
| Tarayıcıda `403` | `ALLOWED_HOSTS` / `PUBLIC_URL` adresi, tarayıcıdaki adresle aynı değil; `.env` düzeltip `docker compose up -d`. |
| `502 Bad Gateway` | Container çalışmıyor: `docker compose ps`, `docker compose logs web`. |
| `413` (yükleme) | Nginx `client_max_body_size` düşük; 10.7-a'daki değerleri kontrol edin. |
| Çok uzun işlerde `504` | Nginx `proxy_read_timeout` değerini artırın. |
| Giriş sonrası hemen çıkış | Siteye `http://` ile girilmiş olabilir (`Secure` çerez); yalnız `https://` kullanın, `PUBLIC_URL` `https` olmalı. |
| Tüm kullanıcılar aynı IP görünüyor / kilitlenme | Nginx'te `X-Forwarded-For` ve `.env`'de `TRUST_PROXY=1` kontrol edin. |
| `web` günlüğünde `(yerel mod)` | Kuyruğa bağlanamıyor: `docker compose logs queue`; `QUEUE_URL` değiştirilmemiş olmalı (`http://queue:4180`). |
| `verify`/`llm` sürekli yeniden başlıyor | `docker compose logs verify`; çoğunlukla private anahtar izni (10.4) veya eksik public anahtar. |
| `Açık anahtar bulunamadı` | `keys/public` boş; Bölüm 10.4'ü tekrarlayın. |
| Embedding/yazım yardımcısı çalışmıyor | `services/llm/.env` veya panelde Gemini anahtarı yok/kotası dolu; **API anahtarları** sayfasında *Sına*. |
| Modeller yavaş / "kota bekleniyor" | Raporlar → Kapasite'de bekleme görünür; **API anahtarları** sayfasına ek anahtar ekleyin. |
| Sertifika yenilenmedi | `sudo certbot renew --dry-run`; 80 portu açık olmalı. |
| Disk doluyor | `docker system df`, `docker image prune -f`; eski yedekler `/var/backups/kaldera` altında 14 gün tutulur. |
