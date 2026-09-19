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
- Делать В ТОЧНОСТИ то, что сказал Danny: не переспрашивать, не додумывать.
- Тестировать ВСЕГДА целиком E2E в обе стороны (устройство→сервер и сервер→устройство),
  для теста можно править локальные файлы волта; тестовый мусор убрать.

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
│   │   │                                    #   FileStorageService, VaultWatcherService
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
│   │   │                                    #   vault-cli.mjs — CLI чтения/записи волта (E2EE)
│   │   ├── commands/                        # whitelist shell: git-pull, git-status, vpn-russia
│   └── Dockerfile
├── plugin/                                  # Obsidian плагин (TypeScript)
│   ├── main.ts / main.js                    # main.js едет СИНКОМ (с 2026-07-07); data.json — per-device
│   ├── crypto/                              # VaultCrypto, VaultCipher (AES-256-GCM, путь+контент)
│   ├── sync/                                # SyncManager(incremental+merge), StompClient,
│   │                                        #   ConflictResolver, FileWatcher, FileOperationService,
│   │                                        #   TombstoneLogic, SyncFilter, SyncApiClient, LocalState
│   ├── icons/                               # FileIcons (frontmatter icon / file-icons.json /
│   │                                        #   folder-icons.json), Lucide/Brand/Dev наборы
│   ├── pdf/                                 # PdfProgressStore, ReadingDashboard (фича чтения)
│   ├── storage/ commands/ daily/
│   └── types.ts
├── local-mcp/                               # stdio MCP-мост для Claude Code на ноуте Danny:
│   │                                        #   index.mjs (офиц. @modelcontextprotocol/sdk),
│   │                                        #   тулзы vault_read/write/append/delete/list/search,
│   │                                        #   E2EE локально, апстрим https://.../vault-mcp
│   │                                        #   (Bearer mcp-token + edge X-Auth-Token vault-sync-nginx),
│   │                                        #   креды в ~/.config/vault-sync/
├── deploy/                                  # ПРОД-деплой ОДНОЙ командой (всё в git, кроме deploy/.env):
│   ├── install.sh                           #   идемпотентный деплой/переезд: пакеты, сборка jar, /opt/vault-sync,
│   │                                        #   systemd, TLS (выпуск если нет), edge, fail2ban, ufw, проверки
│   ├── backup.sh                            #   бэкап волта + H2 (для переезда: install.sh --restore-from root@old)
│   ├── .env.example                         #   секреты (DOMAIN, токены, ключ vault-cli); реальный .env — НЕ в git
│   ├── application.yml.template             #   → /opt/vault-sync/application.yml (envsubst)
│   ├── docker-compose.yml                   #   edge: vault-sync-nginx (TLS+edge-токен) + vault-sync-certbot
│   ├── nginx/templates/*.template           #   штатные шаблоны образа nginx (envsubst DOMAIN/VAULT_SYNC_TOKEN)
│   ├── fail2ban/                            #   jail.local (sshd) + jail/filter vault-sync-edge
│   └── systemd/vault-sync.service           #   юнит jar-сервера
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
  на VPS в `/root/vault-sync-key.txt` (для vault-cli). Сервер видит только шифр.
- Клиент шифрует ДО отправки, расшифровывает ПОСЛЕ; sync и MCP гоняют только шифротекст.
- На VPS аудит: всё в `/opt/obsidian-vault` (кроме `.vault-sync*`) — зашифровано, 0 плейнтекста.
- ⚠️ Осознанный tradeoff: шифрование **конвергентное** (детерминированный nonce =
  HMAC(key, path|plain)) — одинаковый (путь, контент) даёт одинаковый блоб. Это нужно
  протоколу (стабильный blob-hash для dedup/конфликтов), но раскрывает серверу факт
  равенства/изменения контента. Для GCM безопасно (nonce-reuse только на идентичном сообщении).
- Защита от неверного ключа: full sync абортится, если >50% серверных путей не расшифровались
  (иначе пустой serverFiles выглядел бы как «сервер всё удалил» и снёс бы локальный волт);
  VSE-блоб с упавшим GCM-тегом = громкая ошибка ключа, а не тихий скип.

## ⛔⛔⛔ REKEY (смена ключа E2EE) — ТОЛЬКО ОФЛАЙН. НИКОГДА НА ЖИВОМ СЕРВЕРЕ.

```
Новый ключ меняет ВСЕ шифропути и ВСЕ блобы. Для живого сервера это не «тот же
волт», а «всё удалено + появились 800 чужих файлов»: вотчер честно раздаёт это
устройствам как события синка.

ИНЦИДЕНТ 2026-07-09: rekey гоняли на живом сервере с работающим вотчером и
откатом из бэкапа → ~1600 фантомных seq-событий, 781 фантомный tombstone
(deleted_by=filesystem, пути под чужим ключом), воскрешение .trash-мусора на
устройствах, конфликт-копии. НЕ ПОВТОРЯТЬ.

ПОРЯДОК ПРАВИЛЬНОГО REKEY:
1. Синкануть все устройства (нет pending), ЗАКРЫТЬ Obsidian на всех.
2. systemctl stop vault-sync (вотчер умирает вместе с сервисом — обязательно).
3. Бэкап: tar волта /opt/obsidian-vault + H2 (/opt/vault-sync/data) + старый key.txt.
4. Перешифровать волт на месте (старый ключ → plaintext → новый ключ),
   обновить /root/vault-sync-key.txt.
5. ОЧИСТИТЬ метаданные сервера (H2: таблицы files, tombstones, sync_meta) —
   старые записи ссылаются на старые шифропути/хэши; вотчер на старте
   переиндексирует волт с нуля.
6. systemctl start vault-sync.
7. На КАЖДОМ устройстве: новые passphrase/salt в настройках плагина, сброс
   lastSeq=0 (полный ресинк; absence≠deletion защищает локальные файлы),
   reload Obsidian.
8. Проверка: vault-cli list расшифровывает пути; счётчики файлов
   сервер/десктоп/телефон сходятся; в логах нет undecryptable.

Если rekey всплывёт снова — писать служебный скрипт, который делает шаги 2–6
атомарно, а не руками на живом сервере.
```

**Sync — инкрементальная дельта:** клиент шлёт сохранённый `lastSeq`, сервер отдаёт
`getChangesSince` (только seq>lastSeq) с флагом `fullState=false`, либо полный стейт
(`fullState=true`) если `lastSeq < tombstone-floor` (max seq вычищенных по TTL tombstone'ов,
в таблице `sync_meta`) или lastSeq=0. **Никогда не удалять файл, который сервер держит живым**
(absence ≠ deletion — это case загрузки). Конфиг-карты (`folder-icons.json`/`file-icons.json`)
мержатся union'ом при download НА КЛИЕНТЕ (сервер контента не видит — E2EE).
Удаление с сервера при несинкнутой локальной правке сохраняет «(conflict …)»-копию;
lastSeq не перепрыгивает через упавшие загрузки (retry в следующей дельте); тихий
STOMP-реконнект сам догоняется (incremental + pending ops).

## Дейли-заметки

Создание сегодняшней заметки и архивация прошлых месяцев (`Daily/<Month>.<Year>/`, иконка 📦) —
**в плагине** (`plugin/daily/DailyNotes.ts`): под E2EE сервер zero-knowledge и не может ни
написать шифрованную заметку, ни увидеть имя `Daily/`. Серверный `DailyNoteScheduler` и
systemd `vault-sync-daily-note.*` УДАЛЕНЫ (аудит 2026-07-07). Плагин гоняет проход на старте
и раз в час (rollover при незакрытом Obsidian).

⚰️ 2026-07-07: фича folder-sync (зеркало workspace ↔ `cortex/`) ВЫРЕЗАНА вместе с openclaw:
скрипт/юниты удалены из репо и с VPS, `cortex/` удалён из волта.

## Деплой

**ТОЛЬКО через `deploy/install.sh`** — никаких ручных шагов на сервере. Всё в git, кроме одного файла
секретов `deploy/.env` (шаблон `deploy/.env.example`, копия — вольт `Coding/Vault Sync/Creds/vault-sync-deploy.env.md`).

```bash
# обычный деплой (после git push): на VPS
/root/vault-sync/deploy/install.sh

# переезд на НОВЫЙ сервер (A-запись домена уже на нём):
git clone https://github.com/Danny-sth/vault-sync.git /root/vault-sync
# положить deploy/.env (из вольта), затем:
/root/vault-sync/deploy/install.sh --restore-from root@<СТАРЫЙ_IP>   # или --restore backup.tar.gz

# бэкап данных (волт + H2):
/root/vault-sync/deploy/backup.sh
```

`install.sh` идемпотентен и сам проверяет результат (api 200 / без токена 401 / mcp 401 / ws 101 /
vault-cli расшифровывает пути). VPS: `187.124.131.127`, домен `on-za-menya.online`, пароль SSH — в Creds.
Прод-порт **8444 (http, за nginx TLS)**. Конфиг прод: `/opt/vault-sync/application.yml` (рендерится
из шаблона). H2: `/opt/vault-sync/data`. Файлы волта (source of truth): `/opt/obsidian-vault`.

## Важно

- **НЕ редактировать файлы волта на VPS напрямую** — только через sync.
- Сервер — source of truth.
- Tombstone (deletion log) TTL по умолчанию **14 дней** (`TOMBSTONE_TTL_DAYS`).
- **`.trash` НЕ синкается** (с 2026-07-09): корзина device-local; синк корзины
  плодил воскресший мусор и петлю conflict-копий. Клиент: `SyncFilter`
  EXCLUDE_PATTERNS; сервер: EXCLUDED_DIRS. «Удаление в корзину» синкает только
  само удаление.
- `VaultWatcherService` отслеживает ВСЕ изменения волта на VPS в реальном времени
  (WatchService + периодический reconcile).
- **Клапан массовых filesystem-удалений** (`util/FsDeletionValve`, с 2026-07-09):
  reconcile отклоняет батч, где с диска пропало > порога файлов; событийный путь
  вотчера ограничен окном. Дефолт 20, конфиг `vault-sync.fs-deletion-valve.{threshold,window-ms}`.
  Удаления от устройств/MCP не клапанятся. «VALVE TRIPPED» в логе = вид диска
  сломан (маунт/перенос/rekey) — чинить причину, не поднимать порог вслепую.
