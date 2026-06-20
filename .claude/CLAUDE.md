# Vault-Sync

## ⛔⛔⛔ ОДНО ПРЕДЛОЖЕНИЕ. НИКАКИХ ПОЛОТЕН.

```
ОТВЕТ = НЕ БОЛЬШЕ ОДНОГО ПРЕДЛОЖЕНИЯ, пока Danny ЯВНО не попросил «подробно».
Отвечать РОВНО на поставленный вопрос. НЕ добавлять пояснения, оговорки,
«нюансы», варианты, отчёты о проделанном. Сделал что просили → одна фраза.
Длиннее одного предложения без явной просьбы = провал.
```

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
│   │   ├── service/                         # SyncService(getChangesSince/floor),
│   │   │                                    #   FileStorageService, VaultWatcherService,
│   │   │                                    #   DailyNoteScheduler
│   │   ├── repository/                      # FileRepository, TombstoneRepository,
│   │   │                                    #   SyncMetaRepository (tombstone floor)
│   │   ├── model/                           # FileRecord, SyncMessage, Tombstone, SyncMeta
│   │   ├── mcp/                             # VaultMcpTools (get/put/list/delete_blob — E2EE),
│   │   │                                    #   VaultBlobService, McpSecurityConfig
│   │   ├── util/                            # HashUtil, TokenValidator
│   │   └── resources/application.yml        # + application-docker.yml
│   ├── scripts/                             # Node E2EE-инструменты сервера (на VPS):
│   │   │                                    #   vault-crypto.mjs — крипта (зеркало VaultCrypto)
│   │   │                                    #   vault-mcp-client.mjs — общий MCP-клиент+creds
│   │   │                                    #   vault-cli.mjs — duq читает/пишет волт (E2EE)
│   │   │                                    #   folder-sync.mjs — зеркалит локальную папку↔волт
│   │   ├── commands/                        # whitelist shell: git-pull, git-status, vpn-russia
│   ├── systemd/                             # daily-note + vault-folder-sync .service/.timer
│   └── Dockerfile
├── plugin/                                  # Obsidian плагин (TypeScript)
│   ├── main.ts / main.js                    # main.js деплоится out-of-band (adb/cp), НЕ синком
│   ├── crypto/                              # VaultCrypto, VaultCipher (AES-256-GCM, путь+контент)
│   ├── sync/                                # SyncManager(incremental+merge), StompClient,
│   │                                        #   ConflictResolver, FileWatcher, FileOperationService,
│   │                                        #   TombstoneLogic, SyncFilter, SyncApiClient, LocalState
│   ├── icons/                               # FileIcons (frontmatter icon / file-icons.json /
│   │                                        #   folder-icons.json), Lucide/Brand/Dev наборы
│   ├── pdf/                                 # PdfProgressStore, ReadingDashboard (фича чтения)
│   ├── storage/ commands/ daily/
│   └── types.ts
├── docker-compose.yml
└── .claude/CLAUDE.md
```

## Аутентификация

- `/api/**` требует заголовок `X-Auth-Token` = `VAULT_SYNC_TOKEN`.
- MCP-эндпоинт `/mcp` — отдельный токен `VAULT_SYNC_MCP_TOKEN` (static bearer,
  Keycloak/OAuth выпилен полностью).
- `/actuator/health` открыт без токена.

## E2EE (шифрование волта)

Волт **end-to-end зашифрован, сервер zero-knowledge** (ключа не имеет):
- **Контент** — AES-256-GCM, формат блоба `VSE`-magic|version|nonce|ciphertext+tag.
- **Пути/имена** — per-component AES-GCM (детерминированный nonce) + base32, FS-safe.
- Ключ: PBKDF2-HMAC-SHA256 600k из passphrase+salt, только на устройствах (плагин) и
  на VPS в `/root/vault-sync-key.txt` (для duq-инструментов). Сервер видит только шифр.
- Клиент шифрует ДО отправки, расшифровывает ПОСЛЕ; sync и MCP гоняют только шифротекст.
- На VPS аудит: всё в `/opt/obsidian-vault` (кроме `.vault-sync*`) — зашифровано, 0 плейнтекста.

**Sync — инкрементальная дельта:** клиент шлёт сохранённый `lastSeq`, сервер отдаёт
`getChangesSince` (только seq>lastSeq) с флагом `fullState=false`, либо полный стейт
(`fullState=true`) если `lastSeq < tombstone-floor` (max seq вычищенных по TTL tombstone'ов,
в таблице `sync_meta`) или lastSeq=0. **Никогда не удалять файл, который сервер держит живым**
(absence ≠ deletion — это case загрузки). Конфиг-карты (`folder-icons.json`/`file-icons.json`)
мержатся union'ом при download (не теряют ключи).

## folder-sync — openclaw workspace ↔ зашифрованный cortex

duq/openclaw живёт в `/root/.openclaw/workspace` (плейнтекст, движок читает напрямую).
`server/scripts/folder-sync.mjs` two-way зеркалит его в волт как `cortex/*` — **зашифрованным**
тем же механизмом (vault-crypto + MCP put/get_blob), т.к. сервер сам шифровать не может.
Так мозги duq видно и правишь в Obsidian на устройствах, правки едут обратно. Конфиг путей —
`/opt/vault-sync/folder-sync.json`; гоняет systemd `vault-folder-sync.timer` (15 мин). `cortex/`
НЕ исключён из синка (раньше был — когда лежал плейнтекстом). Удаление не пропагируется
(защита мозга). Старый `duq-workspace-sync` бридж снесён.

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

Прод-порт **8444 (http, за nginx TLS)**; дефолт в application.yml — 8443 (SSL). Конфиг прод: `/opt/vault-sync/application.yml`
(токены, storage-path). H2-метаданные: `${VAULT_SYNC_DATA:/opt/vault-sync/data}/metadata`.
Файлы волта (source of truth): `/opt/obsidian-vault`. Daily-note TZ по умолчанию
`Asia/Almaty`.

## Важно

- **НЕ редактировать файлы волта на VPS напрямую** — только через sync.
- Сервер — source of truth.
- Tombstone (deletion log) TTL по умолчанию **14 дней** (`TOMBSTONE_TTL_DAYS`).
- `VaultWatcherService` отслеживает ВСЕ изменения волта на VPS в реальном времени
  (WatchService + периодический reconcile).
