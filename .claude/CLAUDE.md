# Vault-Sync

## Документация

**ОБЯЗАТЕЛЬНО** после любых изменений обновляй:
`/home/danny/Documents/Obsidian/Coding/Vault Sync/Vault Sync.md`

---

## Структура проекта

```
vault-sync/
├── server/          # Go сервер
│   ├── main.go      # HTTP/WS endpoint
│   ├── storage.go   # Sequence-based хранилище
│   ├── sync.go      # Протокол синхронизации
│   ├── hub.go       # WebSocket broadcast
│   ├── watcher.go   # File watcher (fsnotify)
│   └── auth.go      # Token auth
├── plugin/          # Obsidian плагин (TypeScript)
│   ├── main.ts
│   ├── sync.ts
│   ├── settings.ts
│   └── types.ts
└── .claude/
    └── CLAUDE.md
```

## Деплой

Сервер — Spring Boot (Java 21), не Go. Запущен как **systemd-сервис** `vault-sync`
на ЖИВОМ VPS `88.222.245.74` (домен on-za-menya.online). Старый IP `90.156.230.49` МЁРТВ.
Сборка тяжёлая — собирать на VPS, не локально.

```bash
# 1) локально: правка → commit → push
git push origin main

# 2) на VPS: pull + maven build + замена jar + рестарт
ssh root@88.222.245.74   # пароль (ключей нет), см. ~/.claude/CLAUDE.md
cd /root/vault-sync && git pull
cd server && mvn -q -DskipTests clean package
cp target/vault-sync-server-2.0.0.jar /opt/vault-sync/vault-sync.jar
systemctl restart vault-sync

# 3) проверка
systemctl is-active vault-sync
journalctl -u vault-sync -n 20 --no-pager
# health (HTTP, порт 8444, требует X-Auth-Token из /opt/vault-sync/application.yml):
curl -s http://localhost:8444/api/health -H "X-Auth-Token: <token>" -H "X-Device-Id: chk"
```

Конфиг прод: `/opt/vault-sync/application.yml` (порт 8444, токены, storage-path=/opt/obsidian-vault).
Бэкапы версий перед перезаписью: `/opt/obsidian-vault/.vault-sync-versions/` (TTL 30 дней).

## Важно

- **НЕ редактировать файлы на VPS напрямую** — только через sync
- Сервер — source of truth для sequence
- Deletion log хранит удаления 14 дней (TTL)
- File watcher отслеживает ВСЕ изменения на VPS в реальном времени
