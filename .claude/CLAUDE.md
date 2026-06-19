# Vault-Sync

## ⛔ РАБОТАТЬ АВТОНОМНО — НЕ ЗАДАВАТЬ ТУПЫЕ ВОПРОСЫ

```
ДОСТУП ЕСТЬ ВЕЗДЕ (VPS, БД, логи, устройства через adb/CDP). ИСПОЛЬЗУЙ ЕГО.

- НЕ спрашивать «посмотреть логи?», «подключиться к VPS?», «собрать консоль?»,
  «закоммитить?», «задеплоить?», «протестировать?» — ПРОСТО ДЕЛАЙ.
- Задача ясна → выполняй до конца сам (правка → commit → push → деплой на VPS →
  реальная проверка результата). НЕ «вот план, делать?».
- Отладка = читать ВСЕ логи сразу (сервер journalctl + клиент Obsidian через
  adb/CDP), сверять обе стороны, потом отвечать по фактам.
- Спрашивать ТОЛЬКО когда реально неоднозначно И ответ меняет действие.

Тупой вопрос про то, что можешь сделать сам = провал и потеря времени.
```

---

## Документация

**ОБЯЗАТЕЛЬНО** после любых изменений обновляй:
`/home/danny/Documents/Obsidian/Coding/Vault Sync/Vault Sync.md`

---

## Структура проекта

Сервер — **Spring Boot 4.0.2 / Java 21** (НЕ Go), хранилище H2 (file) + JPA.

```
vault-sync/
├── server/                                  # Spring Boot, vault-sync-server 2.0.0
│   ├── pom.xml                              # spring-boot 4.0.2, spring-ai-mcp 2.0.0-M8
│   ├── src/main/java/com/vaultsync/
│   │   ├── VaultSyncApplication.java
│   │   ├── config/                          # Security(static-token), WebSocket, Jackson, Web
│   │   ├── controller/                      # FileController(/api/**), SyncController
│   │   ├── service/                         # SyncService, FileStorageService,
│   │   │                                    #   VaultWatcherService(WatchService),
│   │   │                                    #   DailyNoteScheduler
│   │   ├── repository/                      # FileRepository, TombstoneRepository (JPA)
│   │   ├── model/                           # FileRecord, SyncMessage, Tombstone
│   │   ├── mcp/                             # VaultMcpTools, VaultNoteService,
│   │   │                                    #   CommandController, McpSecurityConfig
│   │   ├── util/                            # HashUtil, TokenValidator
│   │   └── resources/application.yml        # + application-docker.yml
│   ├── commands/                            # whitelist shell: git-pull, git-status, vpn-russia
│   ├── systemd/                             # daily-note .service + .timer
│   └── Dockerfile
├── plugin/                                  # Obsidian плагин (TypeScript)
│   ├── main.ts / main.js                    # main.js деплоится через сам синк
│   ├── sync/                                # SyncManager, StompClient(WS STOMP),
│   │                                        #   ConflictResolver, FileWatcher,
│   │                                        #   TombstoneLogic, SyncFilter, SyncApiClient
│   ├── pdf/                                 # PdfProgressStore, ReadingDashboard (фича чтения)
│   ├── storage/ icons/ commands/ daily/
│   └── types.ts
├── docker-compose.yml
└── .claude/CLAUDE.md
```

## Аутентификация

- `/api/**` требует заголовок `X-Auth-Token` = `VAULT_SYNC_TOKEN`.
- MCP-эндпоинт `/mcp` — отдельный токен `VAULT_SYNC_MCP_TOKEN` (static bearer,
  Keycloak/OAuth выпилен полностью).
- `/actuator/health` открыт без токена.

## Деплой

systemd-сервис `vault-sync` на ЖИВОМ VPS `187.124.131.127` (Vilnius, домен
on-za-menya.online). Старые IP `88.222.245.74` (Mumbai) и `90.156.230.49` — МЁРТВЫ.
Сборка тяжёлая — собирать на VPS, не локально.

```bash
# 1) локально: правка → commit → push
git push origin main

# 2) на VPS: pull + maven build + замена jar + рестарт
ssh root@187.124.131.127   # пароль (ключей нет), см. ~/.claude/CLAUDE.md
cd /root/vault-sync && git pull
cd server && mvn -q -DskipTests clean package
cp target/vault-sync-server-2.0.0.jar /opt/vault-sync/vault-sync.jar
systemctl restart vault-sync

# 3) проверка
systemctl is-active vault-sync
journalctl -u vault-sync -n 20 --no-pager
# health без токена (actuator):
curl -sk https://localhost:8443/actuator/health
# health с токеном (FileController):
curl -sk https://localhost:8443/api/health -H "X-Auth-Token: <VAULT_SYNC_TOKEN>"
```

Порт `8443` (SSL, PKCS12 keystore). Конфиг прод: `/opt/vault-sync/application.yml`
(токены, storage-path). H2-метаданные: `${VAULT_SYNC_DATA:/opt/vault-sync/data}/metadata`.
Файлы волта (source of truth): `/opt/obsidian-vault`. Daily-note TZ по умолчанию
`Asia/Almaty`.

## Важно

- **НЕ редактировать файлы волта на VPS напрямую** — только через sync.
- Сервер — source of truth.
- Tombstone (deletion log) TTL по умолчанию **14 дней** (`TOMBSTONE_TTL_DAYS`).
- `VaultWatcherService` отслеживает ВСЕ изменения волта на VPS в реальном времени
  (WatchService + периодический reconcile).
