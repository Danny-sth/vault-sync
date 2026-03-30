# Vault Sync v2.0

Real-time Obsidian vault synchronization via WebSocket with sequence-based sync.

## Architecture (v2.0)

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ Linux Desktop│     │Windows Laptop│     │Android Phone │
│   Obsidian   │     │   Obsidian   │     │   Obsidian   │
│   + Plugin   │     │   + Plugin   │     │   + Plugin   │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       └────────────────────┼────────────────────┘
                            │ WebSocket (ws://)
                            ▼
              ┌─────────────────────────┐
              │   VPS (vault-sync)      │
              │   Port: 8080            │
              │   /opt/obsidian-vault/  │
              │                         │
              │   + File Watcher        │ ← NEW: real-time detection
              │   + Sequence counter    │ ← NEW: efficient sync
              │   + Deletion log (14d)  │ ← NEW: no tombstones
              └─────────────────────────┘
```

## Key Features (v2.0)

- **Sequence-based sync**: Client tracks `lastSeq`, server sends only changes after that
- **Real-time file watcher**: Deletions on VPS are detected immediately (fsnotify)
- **Deletion log with TTL**: 14-day retention, no permanent tombstones
- **Last-Write-Wins**: Conflict resolution by mtime
- **All file types**: Syncs any file, not just .md

## Protocol

### Client → Server
- `sync` - Request changes since `lastSeq`
- `file_change` - Send file content (base64)
- `file_delete` - Delete file

### Server → Client
- `sync_response` - List of changes (files + deletions)
- `change` - Real-time file change broadcast
- `delete` - Real-time deletion broadcast
- `conflict` - Server version wins (client mtime older)

## Setup

### 1. VPS

```bash
# Environment variables
AUTH_TOKEN=<your-secret-token>
VAULT_PATH=/opt/obsidian-vault
VAULT_SYNC_PORT=8080
TTL_DAYS=14

# Systemd service
systemctl enable vault-sync
systemctl start vault-sync
```

### 2. Plugin

1. Copy `plugin/main.js` + `manifest.json` to `.obsidian/plugins/vault-sync/`
2. Enable plugin in Obsidian
3. Configure:
   - Server URL: `http://your-vps-ip:8080`
   - Token: Same as AUTH_TOKEN
   - Enable sync

## API Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `/health` | No | Server status (sequence, files, clients) |
| `/status` | Yes | Detailed status |
| `/ws` | Yes | WebSocket connection |

## Changelog

### v2.0.0 (2026-03-30)
- **Complete rewrite** - sequence-based sync
- **Real-time file watcher** - deletions on VPS sync immediately
- **Deletion log** - 14-day TTL instead of permanent tombstones
- **Simplified protocol** - no vector clocks, no file_move
- **All file types** - not just .md
- **No TLS** - simplified setup (use reverse proxy for HTTPS)

### v1.x
- Vector clock-based sync
- Tombstones for deletions
- No real-time VPS file watching

## License

MIT
