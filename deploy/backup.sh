#!/usr/bin/env bash
# Бэкап данных vault-sync для переезда/восстановления: волт (E2EE-блобы) + H2-метаданные.
#   ./backup.sh            → /root/vault-sync-backup-<дата>.tar.gz
#   ./backup.sh -          → tar.gz в stdout (install.sh --restore-from user@old-host)
# Сервис останавливается на время снятия (консистентность H2 и волта), затем стартует.
set -euo pipefail
OUT="${1:-/root/vault-sync-backup-$(date +%Y%m%d-%H%M%S).tar.gz}"
systemctl stop vault-sync
trap 'systemctl start vault-sync' EXIT
if [ "$OUT" = "-" ]; then
  tar -C / -czf - opt/obsidian-vault opt/vault-sync/data
else
  tar -C / -czf "$OUT" opt/obsidian-vault opt/vault-sync/data
  chmod 600 "$OUT"
  echo "$OUT"
fi
