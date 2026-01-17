# ТЗ: Obsidian Vault Sync — Real-time синхронизация

## Цель

Заменить LiveSync на свой легковесный sync между устройствами и VPS.
Sombra получает доступ к актуальным .md файлам на VPS.

---

## Архитектура

```
┌─────────────────────────────────────────────────────────────────┐
│                        DEVICES                                   │
├─────────────────────────────────────────────────────────────────┤
│  Linux Desktop    Windows Laptop    Android Phone               │
│  ┌───────────┐    ┌───────────┐    ┌───────────┐               │
│  │ Obsidian  │    │ Obsidian  │    │ Obsidian  │               │
│  │  Plugin   │    │  Plugin   │    │  Plugin   │               │
│  └─────┬─────┘    └─────┬─────┘    └─────┬─────┘               │
│        │                │                │                      │
│        └────────────────┼────────────────┘                      │
│                         │ WebSocket (TLS)                       │
│                         ▼                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              VPS 90.156.230.49                          │   │
│  │  ┌─────────────────────────────────────────────────┐   │   │
│  │  │         vault-sync (Go)  :8443                  │   │   │
│  │  │  • WebSocket server                             │   │   │
│  │  │  • File storage                                 │   │   │
│  │  │  • Multi-device broadcast                       │   │   │
│  │  │  • Conflict resolution (last-write-wins)        │   │   │
│  │  └─────────────────────────────────────────────────┘   │   │
│  │                         │                               │   │
│  │                         ▼                               │   │
│  │  ┌─────────────────────────────────────────────────┐   │   │
│  │  │  /opt/sombra/obsidian-vault/                    │   │   │
│  │  │  ├── Coding/Sombra/                             │   │   │
│  │  │  ├── Daily Notes/                               │   │   │
│  │  │  └── ...                                        │   │   │
│  │  └─────────────────────────────────────────────────┘   │   │
│  │                         │                               │   │
│  │                         ▼                               │   │
│  │  ┌─────────────────────────────────────────────────┐   │   │
│  │  │         Sombra (Spring Boot)                    │   │   │
│  │  │  ObsidianVaultManager читает файлы напрямую     │   │   │
│  │  └─────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Компоненты

### 1. vault-sync (Go сервер)

**Репозиторий**: `Danny-sth/vault-sync` (monorepo)

**Структура**:
```
vault-sync/
├── server/                 # Go backend
│   ├── main.go
│   ├── websocket.go       # WebSocket handler
│   ├── storage.go         # File operations
│   ├── sync.go            # Sync logic
│   ├── auth.go            # Token auth
│   └── config.go
├── plugin/                 # Obsidian plugin (TypeScript)
│   ├── main.ts
│   ├── sync.ts
│   ├── settings.ts
│   ├── manifest.json
│   └── package.json
├── docker-compose.yml
├── Makefile
└── README.md
```

---

## Протокол синхронизации

### Сообщения (JSON over WebSocket)

```typescript
// Client → Server
interface SyncMessage {
  type: 'file_change' | 'file_delete' | 'request_full_sync' | 'ping';
  deviceId: string;
  timestamp: number;
  payload: FileChange | FileDelete | null;
}

interface FileChange {
  path: string;           // "Coding/Sombra/Dev Log.md"
  content: string;        // Base64 encoded
  mtime: number;          // Modification time
  hash: string;           // SHA256 for conflict detection
}

interface FileDelete {
  path: string;
}

// Server → Client
interface ServerMessage {
  type: 'file_changed' | 'file_deleted' | 'full_sync' | 'conflict' | 'pong';
  originDevice: string;   // Who made the change
  payload: any;
}

interface ConflictMessage {
  path: string;
  serverVersion: FileChange;
  clientVersion: FileChange;
  resolution: 'server_wins' | 'client_wins' | 'manual';
}
```

### Flow

1. **Connect**: Plugin connects via WSS, sends auth token
2. **Initial sync**: Server sends file list with hashes, client compares
3. **Real-time**: On file change, client sends to server, server broadcasts to others
4. **Conflict**: If hash mismatch, server decides (last-write-wins by default)

---

## Server (Go)

### Endpoints

```
WSS /ws              — WebSocket для sync
GET /health          — Health check
GET /api/files       — List all files (для debug)
POST /api/token      — Generate device token (owner only)
```

### Config

```yaml
# config.yaml
server:
  port: 8443
  tls:
    cert: /etc/vault-sync/cert.pem
    key: /etc/vault-sync/key.pem

storage:
  path: /opt/sombra/obsidian-vault

auth:
  master_token: ${VAULT_SYNC_TOKEN}  # Для генерации device tokens

sync:
  conflict_resolution: last_write_wins  # или 'manual'
  debounce_ms: 500
  max_file_size_mb: 50
```

### Ключевой код

```go
// websocket.go
func (s *Server) handleConnection(conn *websocket.Conn, deviceId string) {
    s.clients[deviceId] = conn
    defer delete(s.clients, deviceId)

    for {
        var msg SyncMessage
        if err := conn.ReadJSON(&msg); err != nil {
            return
        }

        switch msg.Type {
        case "file_change":
            s.handleFileChange(deviceId, msg.Payload)
        case "file_delete":
            s.handleFileDelete(deviceId, msg.Payload)
        case "request_full_sync":
            s.sendFullSync(conn)
        }
    }
}

func (s *Server) handleFileChange(origin string, change FileChange) {
    // 1. Check for conflicts
    existing := s.storage.GetFileHash(change.Path)
    if existing != "" && existing != change.PreviousHash {
        s.resolveConflict(origin, change)
        return
    }

    // 2. Save file
    s.storage.WriteFile(change.Path, change.Content)

    // 3. Broadcast to other devices
    s.broadcast(origin, ServerMessage{
        Type: "file_changed",
        OriginDevice: origin,
        Payload: change,
    })
}
```

---

## Plugin (TypeScript)

### manifest.json

```json
{
  "id": "vault-sync",
  "name": "Vault Sync",
  "version": "0.1.0",
  "minAppVersion": "1.0.0",
  "description": "Real-time vault sync via WebSocket",
  "author": "Danny",
  "isDesktopOnly": false
}
```

### Ключевой код

```typescript
// main.ts
export default class VaultSyncPlugin extends Plugin {
  private ws: WebSocket | null = null;
  private pendingChanges: Map<string, NodeJS.Timeout> = new Map();

  async onload() {
    await this.loadSettings();
    this.connect();

    // Watch file changes
    this.registerEvent(
      this.app.vault.on('modify', (file) => this.queueSync(file, 'change'))
    );
    this.registerEvent(
      this.app.vault.on('create', (file) => this.queueSync(file, 'change'))
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => this.queueSync(file, 'delete'))
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        this.queueSync({ path: oldPath } as TFile, 'delete');
        this.queueSync(file, 'change');
      })
    );
  }

  private connect() {
    this.ws = new WebSocket(this.settings.serverUrl);
    this.ws.onopen = () => this.authenticate();
    this.ws.onmessage = (e) => this.handleServerMessage(JSON.parse(e.data));
    this.ws.onclose = () => setTimeout(() => this.connect(), 5000);
  }

  private queueSync(file: TFile, type: 'change' | 'delete') {
    // Debounce: wait 500ms after last change
    const existing = this.pendingChanges.get(file.path);
    if (existing) clearTimeout(existing);

    this.pendingChanges.set(file.path, setTimeout(() => {
      this.sendChange(file, type);
      this.pendingChanges.delete(file.path);
    }, 500));
  }

  private async sendChange(file: TFile, type: 'change' | 'delete') {
    if (type === 'delete') {
      this.ws?.send(JSON.stringify({
        type: 'file_delete',
        deviceId: this.settings.deviceId,
        timestamp: Date.now(),
        payload: { path: file.path }
      }));
    } else {
      const content = await this.app.vault.read(file);
      this.ws?.send(JSON.stringify({
        type: 'file_change',
        deviceId: this.settings.deviceId,
        timestamp: Date.now(),
        payload: {
          path: file.path,
          content: btoa(unescape(encodeURIComponent(content))),
          mtime: file.stat.mtime,
          hash: await this.hashContent(content)
        }
      }));
    }
  }

  private async handleServerMessage(msg: ServerMessage) {
    if (msg.originDevice === this.settings.deviceId) return; // Skip own changes

    switch (msg.type) {
      case 'file_changed':
        await this.applyRemoteChange(msg.payload);
        break;
      case 'file_deleted':
        await this.app.vault.adapter.remove(msg.payload.path);
        break;
      case 'conflict':
        new ConflictModal(this.app, msg.payload).open();
        break;
    }
  }
}
```

### Settings UI

```typescript
// settings.ts
class VaultSyncSettingTab extends PluginSettingTab {
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('WebSocket server address')
      .addText(text => text
        .setPlaceholder('wss://90.156.230.49:8443/ws')
        .setValue(this.plugin.settings.serverUrl)
        .onChange(async (value) => {
          this.plugin.settings.serverUrl = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Device Token')
      .setDesc('Authentication token for this device')
      .addText(text => text
        .setPlaceholder('token')
        .setValue(this.plugin.settings.token)
        .onChange(async (value) => {
          this.plugin.settings.token = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Device Name')
      .setDesc('Friendly name for this device')
      .addText(text => text
        .setValue(this.plugin.settings.deviceName)
        .onChange(async (value) => {
          this.plugin.settings.deviceName = value;
          await this.plugin.saveSettings();
        }));
  }
}
```

---

## Deployment

### VPS Setup

```bash
# 1. Build server
cd server && go build -o vault-sync

# 2. Create systemd service
sudo cat > /etc/systemd/system/vault-sync.service << 'EOF'
[Unit]
Description=Vault Sync Server
After=network.target

[Service]
Type=simple
User=sombra
WorkingDirectory=/opt/vault-sync
ExecStart=/opt/vault-sync/vault-sync
Restart=always
Environment=VAULT_SYNC_TOKEN=<SECURE_TOKEN>

[Install]
WantedBy=multi-user.target
EOF

# 3. TLS certificate (Let's Encrypt или self-signed)
# Для начала self-signed, потом можно Caddy для auto-TLS

# 4. Start
sudo systemctl enable vault-sync
sudo systemctl start vault-sync
```

### Plugin Installation

1. Build: `cd plugin && npm run build`
2. Copy `main.js`, `manifest.json`, `styles.css` to `.obsidian/plugins/vault-sync/`
3. Enable in Obsidian settings
4. Configure server URL and token

---

## MVP Scope

### Phase 1 (MVP)
- [x] WebSocket server (Go)
- [x] File create/modify/delete sync
- [x] Multi-device broadcast
- [x] Last-write-wins conflicts
- [x] Obsidian plugin (desktop)
- [x] Basic auth (token)
- [x] TLS

### Phase 2
- [ ] Android support (Obsidian Mobile)
- [ ] Manual conflict resolution UI
- [ ] Selective sync (ignore patterns)
- [ ] Sync status indicator

### Phase 3
- [ ] E2E encryption
- [ ] File history/versioning
- [ ] Bandwidth optimization (delta sync)

---

## Security

- **TLS**: Обязательно для production
- **Token auth**: Каждое устройство имеет уникальный token
- **No public access**: Порт 8443 только для WebSocket
- **File validation**: Проверка путей (no path traversal)

---

## Тестирование

1. **Unit tests**: Go server logic
2. **Integration**: WebSocket connection, file sync
3. **E2E**:
   - Изменить файл на Linux → проверить на Windows
   - Создать файл на Android → проверить на VPS
   - Удалить файл → проверить что удалился везде

---

## Зависимости

### Server (Go)
```go
require (
    github.com/gorilla/websocket v1.5.0
    github.com/fsnotify/fsnotify v1.7.0  // optional: watch local changes
    gopkg.in/yaml.v3 v3.0.1
)
```

### Plugin (TypeScript)
```json
{
  "devDependencies": {
    "@types/node": "^20.0.0",
    "obsidian": "latest",
    "typescript": "^5.0.0",
    "esbuild": "^0.20.0"
  }
}
```

---

## Checklist для запуска Claude Code

- [ ] Создать репозиторий `Danny-sth/vault-sync` на GitHub
- [ ] Скопировать это ТЗ в `CLAUDE.md`
- [ ] **Параллельная разработка:**
  - Go сервер (server/)
  - Obsidian plugin (plugin/)
- [ ] Deploy на VPS
- [ ] Тест с реальным vault

## Порядок разработки

1. **Инициализация** — структура проекта, go.mod, package.json
2. **Server MVP** — WebSocket, file storage, broadcast
3. **Plugin MVP** — file watcher, WebSocket client, sync
4. **Integration** — TLS, auth, тестирование
5. **Deploy** — systemd, plugin installation

---

## Контекст Sombra

- **VPS**: 90.156.230.49 (Казахстан)
- **Vault path**: /opt/sombra/obsidian-vault
- **Sombra читает vault через**: ObsidianVaultManager.kt
- **Текущий sync**: LiveSync → MinIO (будет заменён)
