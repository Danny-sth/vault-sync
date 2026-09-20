#!/usr/bin/env bash
# Развёртывание vault-sync на сервере ОДНОЙ командой (новый сервер или повторный деплой — идемпотентно).
#
#   git clone https://github.com/Danny-sth/vault-sync.git /root/vault-sync
#   cp /путь/к/.env /root/vault-sync/deploy/.env        # единственный секрет вне git (копия — вольт Coding/Vault Sync/Creds)
#   /root/vault-sync/deploy/install.sh [--restore FILE.tar.gz | --restore-from root@OLD_HOST]
#
# TLS/edge — не здесь: 80/443 держит стек mallard (vault.on-za-menya.online → этот сервер :8444).
#
# Делает: пакеты → git pull → сборка jar → /opt/vault-sync (jar, application.yml, commands) →
# (перенос данных) → systemd vault-sync → fail2ban → ufw → проверки. Всё, что не секрет, — в git.
set -euo pipefail

DEPLOY="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$DEPLOY")"
OPT=/opt/vault-sync
VAULT=/opt/obsidian-vault
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
# Ключ шифрования сервер НЕ знает: он видит только шифротекст (zero-knowledge).
for v in DOMAIN VAULT_SYNC_TOKEN VAULT_SYNC_MCP_TOKEN; do
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

log "конфиг и commands"
umask 077
envsubst '${VAULT_SYNC_TOKEN} ${VAULT_SYNC_MCP_TOKEN}' < "$DEPLOY/application.yml.template" > "$OPT/application.yml.new"
cmp -s "$OPT/application.yml.new" "$OPT/application.yml" 2>/dev/null && rm "$OPT/application.yml.new" || { mv "$OPT/application.yml.new" "$OPT/application.yml"; CFG_CHANGED=1; }
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

# TLS и публичный вход ПЕРЕЕХАЛИ в стек mallard (2026-09-19): домен on-za-menya.online принадлежит
# Даку, его edge (nginx+certbot) держит 80/443 и обслуживает vault.on-za-menya.online → сюда, :8444.
# Здесь edge не поднимаем; устройства ходят напрямую ws://<ip>:8444.

log "fail2ban"
install -m 644 "$DEPLOY/fail2ban/jail.local" /etc/fail2ban/jail.local
# Джейл периметра переехал в стек mallard вместе с edge (там же и логи nginx).
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
EDGE_HOST="vault.$DOMAIN"   # публичный вход держит стек mallard
code() { curl -s -o /dev/null -w '%{http_code}' --resolve "$EDGE_HOST:443:127.0.0.1" "$@" || true; }
API=$(code -H "X-Auth-Token: $VAULT_SYNC_TOKEN" "https://$EDGE_HOST/vault-sync/api/health")
NOAUTH=$(code "https://$EDGE_HOST/vault-sync/api/health")
MCP=$(code "https://$EDGE_HOST/vault-mcp")
WS=$(code --http1.1 -m 5 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
       -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "https://$EDGE_HOST/vault-sync/ws?token=$VAULT_SYNC_TOKEN")
echo "api=$API (200) noauth=$NOAUTH (401) mcp-noauth=$MCP (401) ws=$WS (101)"
[ "$API" = 200 ] && [ "$NOAUTH" = 401 ] && [ "$MCP" = 401 ] && [ "$WS" = 101 ] \
  && echo "OK: vault-sync развёрнут" || { echo "FAIL: проверки не прошли" >&2; exit 1; }
