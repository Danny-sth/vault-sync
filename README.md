# Vault Sync

Real-time Obsidian vault synchronization across devices via WebSocket/STOMP.

## Features

- Real-time bidirectional sync across all connected devices
- Offline support with pending operation queue
- Hash-based conflict resolution with mtime fallback
- Plugin config sync (`.obsidian/plugins/*`)
- Tombstone-based deletion propagation

## Architecture

- **Plugin**: Obsidian plugin (TypeScript)
- **Server**: Spring Boot application with H2 embedded database

## Quick Start

### 1. Deploy Server

```bash
# Clone repository
git clone https://github.com/Danny-sth/vault-sync.git
cd vault-sync

# Create .env file
cp .env.example .env
# Edit .env and set VAULT_SYNC_TOKEN (use: openssl rand -hex 32)

# Build and start
cd server
mvn clean package -DskipTests
cd ..
docker-compose up -d
```

Server will be available at `ws://your-server:8443/ws`

### 2. Install Plugin

1. Copy `plugin/` folder to your vault's `.obsidian/plugins/vault-sync/`
2. Enable "Vault Sync" in Obsidian Settings > Community plugins
3. Configure:
   - **Server URL**: `wss://your-server:8443/ws` (or `ws://` without SSL)
   - **Token**: Same token as in `.env`

### 3. Connect

Plugin will auto-connect on Obsidian startup. First sync downloads all files from server.

## Configuration

### Server Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VAULT_SYNC_TOKEN` | (required) | Authentication token |
| `VAULT_SYNC_STORAGE_PATH` | `/data/files` | File storage path |
| `SERVER_SSL_ENABLED` | `false` | Enable HTTPS/WSS |
| `TOMBSTONE_TTL_DAYS` | `14` | Days to keep deletion records |

### Plugin Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Server URL | (required) | WebSocket server URL |
| Token | (required) | Same as server token |
| Auto Connect | `true` | Connect on Obsidian start |
| Sync on Start | `true` | Full sync on connect |
| Debounce (ms) | `500` | Delay before syncing changes |

## Development

### Build Plugin

```bash
cd plugin
npm install
npm run build
```

### Build Server

```bash
cd server
mvn clean package
```

### Run Server Locally

```bash
cd server
VAULT_SYNC_TOKEN=dev-token mvn spring-boot:run
```

## Manual Server Setup (without Docker)

```bash
cd server
./mvnw clean package -DskipTests
scp target/vault-sync-*.jar root@your-server:/opt/vault-sync/
```

**systemd service:**
```ini
[Unit]
Description=Vault Sync Server
After=network.target

[Service]
Environment=VAULT_SYNC_TOKEN=your-secret-token
Environment=VAULT_SYNC_STORAGE=/opt/vault-sync/files
ExecStart=/usr/bin/java -jar /opt/vault-sync/vault-sync.jar
Restart=always

[Install]
WantedBy=multi-user.target
```

## Conflict Resolution

1. **Hash match**: No action (already synced)
2. **Only server changed**: Download
3. **Only local changed**: Upload
4. **Both changed**:
   - Plugin configs (`.obsidian/plugins/*`): Newest wins (mtime)
   - Other `.obsidian/*`: Local wins
   - Vault files: Newest wins (mtime)

## Security

- Token-based authentication (constant-time comparison)
- All API endpoints require valid token
- WebSocket connections authenticated on CONNECT frame

## License

MIT
