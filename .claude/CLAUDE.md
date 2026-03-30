# Vault-Sync

## Документация

**ОБЯЗАТЕЛЬНО** после любых изменений обновляй:
`/home/danny/Documents/Obsidian/Coding/Sombra/Vault Sync.md`

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

```bash
# Сборка
cd server
GOOS=linux GOARCH=amd64 go build -o vault-sync .

# Деплой
scp vault-sync root@90.156.230.49:/opt/vault-sync/
ssh root@90.156.230.49 "systemctl restart vault-sync"

# Проверка
ssh root@90.156.230.49 "systemctl status vault-sync"
ssh root@90.156.230.49 "journalctl -u vault-sync -n 20"
```

## Важно

- **НЕ редактировать файлы на VPS напрямую** — только через sync
- Сервер — source of truth для sequence
- Deletion log хранит удаления 14 дней (TTL)
- File watcher отслеживает ВСЕ изменения на VPS в реальном времени
