# Vault Sync

Real-time file synchronization for Obsidian between devices using WebSocket/STOMP.

## Architecture

```
+-------------------+     WebSocket/STOMP      +-------------------+
|  Obsidian Plugin  |<------------------------>|  Spring Boot      |
|  (TypeScript)     |                          |  Server (Java 21) |
|                   |      /topic/sync         |                   |
|  - @stomp/stompjs |<------------------------>|  - WebSocket      |
|  - IndexedDB      |      /app/file.*         |  - H2 Database    |
|  - Offline Queue  |                          |  - File Storage   |
+-------------------+                          +-------------------+
```

## Components

### Server (`../vault-sync-server/`)

Spring Boot 3.3 + Java 21 with Virtual Threads.

- **WebSocket/STOMP** for real-time bidirectional communication
- **H2 Database** for file metadata persistence
- **File Storage** for binary file content
- **Token Authentication** for security

### Plugin (`plugin/`)

TypeScript Obsidian plugin with:

- **@stomp/stompjs** for WebSocket/STOMP client
- **IndexedDB** for local state persistence (hashes, pending operations)
- **Debounced file detection** to prevent rapid uploads
- **Offline queue** for operations when disconnected

## Installation

### Server

```bash
cd vault-sync-server
./mvnw clean package -DskipTests
scp target/vault-sync-*.jar user@server:/opt/vault-sync/
```

### Plugin

```bash
cd plugin
npm install
npm run build
cp main.js manifest.json ~/.obsidian/plugins/vault-sync/
```

## Configuration

### Server (`application.yml`)

```yaml
server:
  port: 8444

vault-sync:
  storage-path: /opt/vault-sync/files
  token: your-secret-token
  tombstone-ttl-days: 14
```

### Plugin (`data.json`)

```json
{
  "serverUrl": "ws://your-server:8444/ws",
  "token": "your-secret-token",
  "deviceId": "unique-device-id",
  "autoConnect": true,
  "syncOnStart": true,
  "debounceMs": 500
}
```

## Protocol

### WebSocket Endpoints

| Endpoint | Direction | Purpose |
|----------|-----------|---------|
| `/ws` | - | WebSocket connection |
| `/topic/sync` | Server -> All | Broadcast file changes |
| `/user/queue/sync` | Server -> Client | Private sync responses |
| `/app/file.change` | Client -> Server | File change notification |
| `/app/file.delete` | Client -> Server | File deletion |
| `/app/sync.request` | Client -> Server | Request sync state |

### REST Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/upload` | POST | Upload file content |
| `/api/download/{path}` | GET | Download file content |
| `/api/delete/{path}` | DELETE | Delete file |
| `/api/list` | GET | List all files |

## Development

### Build Plugin

```bash
cd plugin
npm run dev    # Watch mode
npm run build  # Production build
```

### Build Server

```bash
cd vault-sync-server
./mvnw spring-boot:run  # Development
./mvnw package          # Production JAR
```

## Changelog

### v2.0.0 (2026-04-07)
- **Complete rewrite** - Spring Boot + STOMP instead of Go + SSE
- **WebSocket/STOMP** - true bidirectional communication
- **IndexedDB** - persistent client-side state
- **FileWatcher** - detects external filesystem changes
- **H2 Database** - proper server-side metadata storage
- **Large file support** - tested with 5MB+ files
- **Unicode support** - Cyrillic, emoji filenames work correctly
- **Nested directories** - full path support with proper URL encoding

## License

MIT
