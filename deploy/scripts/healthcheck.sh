#!/usr/bin/env bash
# Сторож vault-sync: если /actuator/health не отвечает в разумное время — рестарт сервиса.
# Ставится systemd-таймером (vault-sync-healthcheck.timer), не cron — см. install.sh.
#
# Зачем: инцидент 2026-10-01 — зависший async-контекст (MCP Streamable HTTP) копил
# сокеты в CLOSE_WAIT, пока Tomcat не исчерпал maxConnections и не перестал отвечать
# даже на localhost, без единой записи об ошибке в логе. spring.mvc.async.request-timeout
# лечит причину; этот таймер — страховка на случай других похожих зависаний.
set -euo pipefail

if ! curl -sf -o /dev/null --max-time 5 http://127.0.0.1:8444/actuator/health; then
  logger -t vault-sync-healthcheck "health check failed, restarting vault-sync"
  systemctl restart vault-sync
fi
