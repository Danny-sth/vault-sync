#!/usr/bin/env bash
# Развёртывание vault-sync на сервере ОДНОЙ командой (новый сервер или повторный деплой — идемпотентно).
#
#   git clone https://github.com/Danny-sth/vault-sync.git /root/vault-sync
#   cp /путь/к/.env /root/vault-sync/deploy/.env        # единственный секрет вне git (копия — вольт Coding/Vault Sync/Creds)
#   /root/vault-sync/deploy/install.sh [--restore FILE.tar.gz | --restore-from root@OLD_HOST]
#
# Делает: пакеты → git pull → сборка jar → /opt/vault-sync (jar, application.yml, commands) →
# ключ vault-cli → (перенос данных) → systemd vault-sync → TLS-сертификат (если нет) → edge nginx+certbot →
# fail2ban → ufw → проверки. Всё, что не секрет, — в git.
set -euo pipefail

DEPLOY="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$DEPLOY")"
OPT=/opt/vault-sync
VAULT=/opt/obsidian-vault
KEYFILE=/root/vault-sync-key.txt
RESTORE="" ; RESTORE_FROM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --restore) RESTORE="$2"; shift 2 ;;
    --restore-from) RESTORE_FROM="$2"; shift 2 ;;
    *) echo "неизвестный аргумент: $1" >&2; exit 2 ;;
  esac
done

log() { echo -e "\n== $*"; }
[ "$(id -u)" = 0 ] || { echo "запускать от root" >&2; exit 1; }
[ -f "$DEPLOY/.env" ] || { echo "нет $DEPLOY/.env (шаблон: .env.example, копия — вольт Coding/Vault Sync/Creds)" >&2; exit 1; }
chmod 600 "$DEPLOY/.env"
set -a; . "$DEPLOY/.env"; set +a
for v in DOMAIN VAULT_SYNC_TOKEN VAULT_SYNC_MCP_TOKEN VAULT_PASSPHRASE VAULT_SALT_B64; do
  [ -n "${!v:-}" ] || { echo "в .env не задан $v" >&2; exit 1; }
done

log "пакеты"
export DEBIAN_FRONTEND=noninteractive
need=()
for p in git curl openjdk-21-jdk-headless maven nodejs docker.io docker-compose-v2 fail2ban ufw gettext-base; do
  dpkg -s "$p" >/dev/null 2>&1 || need+=("$p")
done
# nodejs может стоять не из apt (nodesource) — тогда не трогаем
command -v node >/dev/null && need=("${need[@]/nodejs}")
if [ -n "$(echo "${need[@]:-}" | tr -d ' ')" ]; then apt-get update -qq && apt-get install -y -qq ${need[@]}; fi
systemctl enable --now docker >/dev/null

log "код (git pull)"
git -C "$REPO" pull --ff-only -q || echo "git pull пропущен (нет доступа к origin / локальные правки)"

log "сборка jar"
( cd "$REPO/server" && mvn -q -DskipTests clean package )
JAR="$(ls "$REPO"/server/target/vault-sync-server-*.jar | grep -v original | head -1)"
install -d -m 755 "$OPT" "$OPT/data" "$OPT/commands" "$VAULT"
if ! cmp -s "$JAR" "$OPT/vault-sync.jar"; then install -m 644 "$JAR" "$OPT/vault-sync.jar"; JAR_CHANGED=1; fi

log "конфиг, commands, ключ vault-cli"
umask 077
envsubst '${VAULT_SYNC_TOKEN} ${VAULT_SYNC_MCP_TOKEN}' < "$DEPLOY/application.yml.template" > "$OPT/application.yml.new"
cmp -s "$OPT/application.yml.new" "$OPT/application.yml" 2>/dev/null && rm "$OPT/application.yml.new" || { mv "$OPT/application.yml.new" "$OPT/application.yml"; CFG_CHANGED=1; }
printf 'VAULT_PASSPHRASE=%s\nVAULT_SALT_B64=%s\n' "$VAULT_PASSPHRASE" "$VAULT_SALT_B64" > "$KEYFILE"
umask 022
rsync -a --delete "$REPO/server/commands/" "$OPT/commands/" 2>/dev/null || { rm -rf "$OPT/commands"; cp -a "$REPO/server/commands" "$OPT/commands"; }
chmod 755 "$OPT"/commands/*.sh

if [ -n "$RESTORE_FROM" ] || [ -n "$RESTORE" ]; then
  log "перенос данных"
  systemctl stop vault-sync 2>/dev/null || true
  if [ -n "$RESTORE_FROM" ]; then
    ssh "$RESTORE_FROM" "cd /root/vault-sync/deploy && ./backup.sh -" | tar -C / -xzf -
  else
    tar -C / -xzf "$RESTORE"
  fi
  echo "волт: $(find "$VAULT" -type f | wc -l) файлов"
  CFG_CHANGED=1
fi

log "systemd vault-sync"
install -m 644 "$DEPLOY/systemd/vault-sync.service" /etc/systemd/system/vault-sync.service
systemctl daemon-reload
systemctl enable vault-sync >/dev/null 2>&1
if [ -n "${JAR_CHANGED:-}${CFG_CHANGED:-}" ] || ! systemctl is-active -q vault-sync; then systemctl restart vault-sync; fi
for i in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:8444/actuator/health && break; sleep 2; done
curl -sf -o /dev/null http://127.0.0.1:8444/actuator/health || { journalctl -u vault-sync -n 30 --no-pager; echo "vault-sync не поднялся" >&2; exit 1; }

log "TLS + edge (nginx, certbot)"
cd "$DEPLOY"
install -d "$DEPLOY/nginx/log"
docker compose create -q 2>/dev/null || docker compose create
if ! docker run --rm -v vault-sync-edge_letsencrypt:/le alpine test -f "/le/live/$DOMAIN/fullchain.pem"; then
  echo "сертификата для $DOMAIN нет — выпускаю (standalone :80)"
  docker compose stop nginx >/dev/null 2>&1 || true
  docker run --rm -p 80:80 -v vault-sync-edge_letsencrypt:/etc/letsencrypt certbot/certbot certonly \
    --standalone --non-interactive --agree-tos --register-unsafely-without-email -d "$DOMAIN"
fi
docker compose up -d --force-recreate --remove-orphans

log "fail2ban"
install -m 644 "$DEPLOY/fail2ban/jail.local" /etc/fail2ban/jail.local
install -m 644 "$DEPLOY/fail2ban/vault-sync-edge.filter.conf" /etc/fail2ban/filter.d/vault-sync-edge.conf
sed "s#__REPO__#$REPO#" "$DEPLOY/fail2ban/vault-sync-edge.jail.conf" > /etc/fail2ban/jail.d/vault-sync-edge.conf
touch "$DEPLOY/nginx/log/access.log"
systemctl enable fail2ban >/dev/null 2>&1; systemctl restart fail2ban

log "ufw"
ufw allow 22/tcp comment ssh >/dev/null
ufw allow 80/tcp comment http-acme-redirect >/dev/null
ufw allow 443/tcp comment vault-sync-edge >/dev/null
ufw allow from 172.16.0.0/12 comment "docker→host (nginx → vault-sync)" >/dev/null
ufw --force enable >/dev/null

log "проверки"
sleep 3
# || true: WS-проверка держит соединение до -m и curl выходит с 28 — код ответа (101) уже получен.
code() { curl -s -o /dev/null -w '%{http_code}' --resolve "$DOMAIN:443:127.0.0.1" "$@" || true; }
API=$(code -H "X-Auth-Token: $VAULT_SYNC_TOKEN" "https://$DOMAIN/vault-sync/api/health")
NOAUTH=$(code "https://$DOMAIN/vault-sync/api/health")
MCP=$(code "https://$DOMAIN/vault-mcp")
WS=$(code --http1.1 -m 5 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
       -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "https://$DOMAIN/vault-sync/ws?token=$VAULT_SYNC_TOKEN")
DEC=$(cd "$REPO/server/scripts" && node vault-cli.mjs list "" </dev/null 2>/dev/null | wc -l || true)
echo "api=$API (200) noauth=$NOAUTH (401) mcp-noauth=$MCP (401) ws=$WS (101) vault-cli расшифровал путей=$DEC"
[ "$API" = 200 ] && [ "$NOAUTH" = 401 ] && [ "$MCP" = 401 ] && [ "$WS" = 101 ] && [ "$DEC" -gt 0 ] \
  && echo "OK: vault-sync развёрнут" || { echo "FAIL: проверки не прошли" >&2; exit 1; }
