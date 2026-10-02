# Kaynakça Masası – Docker Kurulum Yardımı

Bu belge, Docker imajlarını ayrı sunucularda ayağa kaldırmak için adım adım komutları içerir.

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
git checkout mikroservis
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
