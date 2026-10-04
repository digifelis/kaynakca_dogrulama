#!/bin/bash
# Kaynakça Masası güncelleme betiği (Docker Compose, tek sunucu).
# Kullanım:  sudo bash scripts/guncelle.sh [proje-klasörü]
# Sırayla: yedek → kod güncelleme → .env kontrolü → derleme → başlatma → ağ ve sağlık kontrolü.
# Birimleri silmez, anahtarları yeniden üretmez. Bir adım hata verirse durur.
set -euo pipefail

BRANCH="makale_olusturucu"
NETWORK="mansur_laravel_net"
PROJECT="kaynakca-masasi"
BACKUP_DIR="/var/backups/kaldera"

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

# --- 0. Proje klasörünü bul -------------------------------------------------
DIR="${1:-}"
if [ -z "$DIR" ]; then
  DIR=$(docker inspect "${PROJECT}-web-1" --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' 2>/dev/null || true)
fi
[ -n "$DIR" ] && [ -f "$DIR/docker-compose.yml" ] || die "Proje klasörü bulunamadı. Şöyle çalıştırın: sudo bash guncelle.sh /proje/klasörü"
cd "$DIR"
ok "Proje klasörü: $DIR"
command -v docker >/dev/null || die "docker bulunamadı."
docker network inspect "$NETWORK" >/dev/null 2>&1 || die "$NETWORK ağı yok; önce oluşturun: docker network create $NETWORK"

# --- 1. Yerel değişiklik kontrolü -------------------------------------------
say "Git durumu"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short --untracked-files=no
  die "Sunucuda commitlenmemiş değişiklik var; güncelleme çakışabilir. Önce bunları inceleyin (git diff)."
fi
OLD_COMMIT=$(git rev-parse --short HEAD)
ok "Şu anki sürüm: $OLD_COMMIT (geri dönmek için not edin)"

# --- 2. Yedek ---------------------------------------------------------------
say "Yedek alınıyor"
mkdir -p "$BACKUP_DIR"
TS=$(date +%Y%m%d-%H%M)
restart_services() { docker compose start web llm >/dev/null 2>&1 || true; }
trap restart_services EXIT
docker compose stop web llm
for v in web-data llm-data; do
  docker volume inspect "${PROJECT}_$v" >/dev/null 2>&1 || die "Birim yok: ${PROJECT}_$v (docker volume ls ile bakın)"
  docker run --rm -v "${PROJECT}_$v":/data:ro -v "$BACKUP_DIR":/backup alpine \
    tar czf "/backup/$v-$TS.tgz" -C /data .
done
docker compose start web llm
trap - EXIT
tar czf "$BACKUP_DIR/ayarlar-$TS.tgz" keys .env services/llm/.env services/verify/.env 2>/dev/null || warn "Bazı ayar dosyaları yedeğe girmedi (bulunamadı)."
for f in "$BACKUP_DIR"/*-"$TS".tgz; do
  [ -s "$f" ] || die "Yedek boş: $f"
done
ls -lh "$BACKUP_DIR"/*-"$TS".tgz
ok "Yedek tamam: $BACKUP_DIR (zaman damgası $TS)"

# --- 3. Kodu güncelle -------------------------------------------------------
say "Kod güncelleniyor ($BRANCH)"
git fetch origin
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
NEW_COMMIT=$(git rev-parse --short HEAD)
ok "Sürüm: $OLD_COMMIT → $NEW_COMMIT"

# --- 4. .env kontrolü (mevcut anahtarlara dokunulmaz) ------------------------
say ".env kontrolü"
LLM_ENV="services/llm/.env"
if [ -f "$LLM_ENV" ]; then
  if grep -q '^GROQ_TPM=30000$' "$LLM_ENV"; then
    # Eski varsayılan Groq ücretsiz kotasının (8000 token/dk) üstünde; 429'a yol açıyordu.
    sed -i 's/^GROQ_TPM=30000$/GROQ_TPM=8000/' "$LLM_ENV"
    ok "GROQ_TPM=30000 -> 8000 güncellendi."
  elif grep -q '^GROQ_TPM=' "$LLM_ENV"; then
    ok "GROQ_TPM zaten tanımlı: $(grep '^GROQ_TPM=' "$LLM_ENV")"
  else
    # Dosya satır sonuyla bitmiyorsa önce bir satır sonu ekle.
    [ -z "$(tail -c1 "$LLM_ENV")" ] || echo >> "$LLM_ENV"
    echo 'GROQ_TPM=8000' >> "$LLM_ENV"
    ok "GROQ_TPM=8000 eklendi."
  fi
else
  warn "$LLM_ENV yok; atlandı."
fi

# --- 5. Derle ve başlat -----------------------------------------------------
say "Derleniyor"
docker compose build
say "Başlatılıyor (yalnızca değişen container'lar yeniden oluşturulur)"
docker compose up -d

# --- 6. Ağ kontrolü: Nginx ile aynı ağ --------------------------------------
say "Ağ kontrolü ($NETWORK)"
members=$(docker network inspect "$NETWORK" --format '{{range .Containers}}{{.Name}} {{end}}')
connect_if_missing() {  # $1 container, $2 takma ad
  if echo " $members " | grep -q " $1 "; then
    ok "$1 ağda"
  else
    warn "$1 ağda değil; bağlanıyor (kalıcı çözüm: docker-compose.yml'deki laravel ağı)"
    docker network connect --alias "$2" "$NETWORK" "$1"
  fi
}
connect_if_missing "${PROJECT}-web-1"   kaldera-web
connect_if_missing "${PROJECT}-queue-1" kaldera-queue
for c in "${PROJECT}-verify-1" "${PROJECT}-verify-2" "${PROJECT}-llm-1"; do
  echo " $members " | grep -q " $c " && ok "$c ağda" || warn "$c ağda değil (worker'lar kuyruğa kendi ağlarından bağlanır; sorun olmayabilir)"
done

# --- 7. Sağlık kontrolü -----------------------------------------------------
say "Sağlık kontrolü"
sleep 8
docker compose ps
fail=0
for s in web queue llm verify; do
  n=$(docker compose ps --status running -q "$s" | wc -l)
  [ "$n" -ge 1 ] && ok "$s çalışıyor ($n)" || { warn "$s çalışmıyor!"; fail=1; }
done
if curl -fsS -H "x-word-request: 1" http://127.0.0.1:4173/api/writer/bootstrap >/dev/null 2>&1; then
  ok "Web API yanıt veriyor"
else
  warn "Web API yanıt vermedi (kısa süre sonra tekrar deneyin: curl -s -H 'x-word-request: 1' http://127.0.0.1:4173/api/writer/bootstrap)"
  fail=1
fi
docker compose logs --tail=5 web | grep -i "yerel mod" && { warn "Web 'yerel mod'da: QUEUE_URL ulaşmıyor!"; fail=1; } || true

# --- Özet -------------------------------------------------------------------
say "Özet"
if [ "$fail" -eq 0 ]; then
  ok "Güncelleme tamam: $OLD_COMMIT → $NEW_COMMIT"
else
  warn "Bazı kontroller başarısız. Günlük: docker compose logs --tail=100 web llm queue"
fi
cat <<EOF

Geri dönmek için:
  cd $DIR && git checkout $OLD_COMMIT && docker compose build && docker compose up -d
Veri geri yüklemek için (yalnızca gerekirse):
  docker compose stop web llm
  docker run --rm -v ${PROJECT}_web-data:/data -v $BACKUP_DIR:/backup alpine \\
    sh -c "rm -rf /data/* && tar xzf /backup/web-data-$TS.tgz -C /data"
  docker compose start web llm
EOF
