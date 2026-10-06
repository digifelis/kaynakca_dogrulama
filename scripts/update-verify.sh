#!/usr/bin/env bash
# Yalnızca verify çalışan sunucuda: kodu çeker, imajı yeniden derler, eski verify container'larını silip yenilerini başlatır.
# Compose KULLANMAZ (bkz. KURULUM.md, bölüm 5 ve 5.1). Proje klasöründen veya herhangi bir yerden çalıştırılabilir.
#
#   ./scripts/update-verify.sh                          # kuyruk adresi ve adet, çalışan container'dan okunur
#   QUEUE_URL=http://10.1.2.116:4180 ./scripts/update-verify.sh
#   QUEUE_URL=http://10.1.2.116:4180 REPLICAS=2 ./scripts/update-verify.sh
#
# Ortam değişkenleri (hepsi isteğe bağlı):
#   QUEUE_URL  Kuyruğun adresi. Verilmezse mevcut verify container'ından alınır.
#   REPLICAS   Başlatılacak container sayısı. Verilmezse mevcut sayı korunur (hiç yoksa 1).
#   NAME       Container adı öneki (varsayılan: verify -> verify-1, verify-2, ...).
#   IMAGE      İmaj adı (varsayılan: kaynakca-masasi/verify).
#   BRANCH     Çekilecek dal (varsayılan: mevcut dal).
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
NAME="${NAME:-verify}"
IMAGE="${IMAGE:-kaynakca-masasi/verify}"

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'HATA: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker bulunamadı."
command -v git >/dev/null || die "git bulunamadı."
[ -d .git ] || die "$ROOT bir git deposu değil (git clone ile kurulmalı; bkz. KURULUM.md)."

# --- Gerekli dosyalar (kodu çekmeden önce de kontrol edilir; eksikse boşuna build yapılmaz) ---
[ -f keys/private/verify.private.pem ] || die "keys/private/verify.private.pem yok."
ls keys/public/*.public.pem >/dev/null 2>&1 || ls keys/public/*.pem >/dev/null 2>&1 || die "keys/public/*.pem yok."
[ -f services/verify/.env ] || die "services/verify/.env yok (services/verify/.env.example dosyasını kopyalayıp doldurun)."

# --- Mevcut container'lardan kuyruk adresi ve adet ---
existing=$(docker ps -a --format '{{.Names}}' | grep -E "^${NAME}-[0-9]+$" || true)
if [ -z "${QUEUE_URL:-}" ] && [ -n "$existing" ]; then
  first=$(echo "$existing" | head -n1)
  QUEUE_URL=$(docker inspect "$first" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^QUEUE_URL=//p' | head -n1)
fi
[ -n "${QUEUE_URL:-}" ] || die "QUEUE_URL bilinmiyor. Örnek: QUEUE_URL=http://10.1.2.116:4180 $0"
if [ -z "${REPLICAS:-}" ]; then
  REPLICAS=$(printf '%s' "$existing" | grep -c . || true)
  [ "$REPLICAS" -ge 1 ] || REPLICAS=1
fi
case "$REPLICAS" in ''|*[!0-9]*) die "REPLICAS sayı olmalı: $REPLICAS" ;; esac

say "Kuyruk: $QUEUE_URL | Adet: $REPLICAS | İmaj: $IMAGE"

# --- Kodu çek ---
say "git pull"
if [ -n "${BRANCH:-}" ]; then git fetch origin "$BRANCH" && git checkout "$BRANCH"; fi
git pull --ff-only || die "git pull başarısız (yerelde commit edilmemiş değişiklik veya ayrışmış dal olabilir)."
git log --oneline -1

# --- Anahtar izinleri: container 'node' (UID 1000) kullanıcısıyla çalışır, private anahtarı okuyabilmeli ---
say "Anahtar izinleri"
if [ "$(id -u)" -eq 0 ]; then
  chown 1000:1000 keys/private/verify.private.pem
  chmod 400 keys/private/verify.private.pem
  chmod 755 keys/private
  chmod 644 keys/public/*.pem
else
  sudo chown 1000:1000 keys/private/verify.private.pem
  sudo chmod 400 keys/private/verify.private.pem
  sudo chmod 755 keys/private
  sudo chmod 644 keys/public/*.pem
fi

# --- İmajı derle (verify = python hedefi). Derleme başarısızsa eski container'lara dokunulmaz ---
say "docker build"
docker build --target python -t "$IMAGE" .

# --- Eski container'ları sil ---
say "Eski container'lar siliniyor"
if [ -n "$existing" ]; then echo "$existing" | xargs docker rm -f; else echo "(yok)"; fi

# --- Yenilerini başlat ---
for i in $(seq 1 "$REPLICAS"); do
  say "${NAME}-${i} başlatılıyor"
  docker run -d --name "${NAME}-${i}" --restart unless-stopped \
    -e QUEUE_URL="$QUEUE_URL" \
    -e JWT_KEYS_DIR=/keys \
    -e JWT_PRIVATE_KEY_FILE=/run/secrets/verify_key \
    --env-file services/verify/.env \
    -v "$ROOT/keys/public:/keys/public:ro" \
    -v "$ROOT/keys/private/verify.private.pem:/run/secrets/verify_key:ro" \
    "$IMAGE"
done

# --- Doğrulama ---
say "Kontrol (5 sn bekleniyor)"
sleep 5
status=0
for i in $(seq 1 "$REPLICAS"); do
  c="${NAME}-${i}"
  if [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" != true ]; then
    echo "[$c] ÇALIŞMIYOR:"; docker logs --tail 20 "$c" || true; status=1; continue
  fi
  echo "[$c] çalışıyor. Son log:"; docker logs --tail 3 "$c" 2>&1 | sed 's/^/    /'
done
if docker exec "${NAME}-1" test -f /app/providers.js 2>/dev/null; then
  echo "providers.js içinde CORE/DBLP kalıntısı: $(docker exec "${NAME}-1" grep -c -E "id === '(CORE|DBLP)'" /app/providers.js || true) (0 olmalı)"
fi
[ "$status" -eq 0 ] && say "Tamam." || die "Bazı container'lar başlamadı; yukarıdaki loglara bakın."
