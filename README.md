# Vault Sync

Real-time Obsidian vault synchronization via WebSocket.

## How It Works

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ Linux Desktop│     │Windows Laptop│     │Android Phone │
│   Obsidian   │     │   Obsidian   │     │   Obsidian   │
│   + Plugin   │     │   + Plugin   │     │   + Plugin   │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       └────────────────────┼────────────────────┘
                            │ WebSocket
                            ▼
              ┌─────────────────────────┐
              │   VPS (vault-sync)      │
              │   /opt/sombra/          │
              │     obsidian-vault/     │
              └───────────┬─────────────┘
                          │
                          ▼
              ┌─────────────────────────┐
              │   Sombra reads files    │
              └─────────────────────────┘
```

- **Edit on any device** → Plugin sends to server → Server broadcasts to others
- **Conflict resolution**: Last-write-wins (by default)
- **Sombra** reads synced `.md` files directly from disk

## Setup

### 1. VPS Setup (one time)

```bash
# SSH to VPS
ssh root@90.156.230.49

# Clone repo
git clone https://github.com/Danny-sth/vault-sync.git
cd vault-sync/deploy

# Run setup
chmod +x setup-vps.sh
./setup-vps.sh

# Save the generated VAULT_SYNC_TOKEN!
```

### 2. GitHub Secrets

Add these secrets to your repo (`Settings → Secrets → Actions`):

| Secret | Value |
|--------|-------|
| `VPS_HOST` | `90.156.230.49` |
| `VPS_USER` | `root` (or user with sudo) |
| `VPS_SSH_KEY` | Private SSH key for VPS access |

### 3. Deploy Server

Push to `main` branch → GitHub Actions deploys automatically.

Or manually:
```bash
make server
scp bin/vault-sync root@90.156.230.49:/opt/vault-sync/
ssh root@90.156.230.49 "systemctl restart vault-sync"
```

### 4. Install Plugin

**Option A: From GitHub Release**
1. Go to [Releases](../../releases)
2. Download `main.js` and `manifest.json`
3. Create folder: `YourVault/.obsidian/plugins/vault-sync/`
4. Copy files there
5. Enable in Obsidian: Settings → Community Plugins → Vault Sync

**Option B: Build locally**
```bash
make plugin
# Copy plugin/main.js and plugin/manifest.json to your vault
```

### 5. Configure Plugin

In Obsidian: Settings → Vault Sync:
- **Server URL**: `ws://90.156.230.49:8443/ws` (or `wss://` with TLS)
- **Token**: The token from VPS setup
- **Device Name**: Something recognizable

## CI/CD

| Event | Action |
|-------|--------|
| Push to `main` | Deploy server to VPS |
| Push tag `v*` | Create GitHub Release with plugin files |

To release a new plugin version:
```bash
git tag v0.1.0
git push origin v0.1.0
```

## Development

```bash
# Run server locally
VAULT_SYNC_TOKEN=test VAULT_SYNC_STORAGE=./test-vault make dev-server

# Watch plugin (rebuild on change)
cd plugin && npm run dev
```

## TLS (Production)

For secure WebSocket (`wss://`):

1. Get certificates (Let's Encrypt or self-signed)
2. Set env vars:
   ```bash
   VAULT_SYNC_TLS_CERT=/path/to/cert.pem
   VAULT_SYNC_TLS_KEY=/path/to/key.pem
   ```
3. Update plugin URL to `wss://...`

## Roadmap

### Phase 1 - MVP (Done)
- [x] WebSocket server (Go)
- [x] File create/modify/delete sync
- [x] Multi-device broadcast
- [x] Last-write-wins conflict resolution
- [x] Obsidian plugin (desktop + mobile)
- [x] Token authentication
- [x] Linux/Android/Windows installers
- [x] CI/CD pipeline

### Phase 2 - UX Improvements
- [ ] Manual conflict resolution UI (modal in Obsidian)
- [ ] Selective sync (ignore patterns like `.git/`, `node_modules/`)
- [ ] Sync status indicator in Obsidian status bar
- [ ] Connection health monitoring

### Phase 3 - Security & Performance
- [ ] E2E encryption (client-side encryption before sync)
- [ ] File history/versioning
- [ ] Delta sync (send only changes, not full file)
- [ ] TLS via Caddy (auto HTTPS)

### Phase 4 - Advanced
- [ ] Web UI for server monitoring
- [ ] Multiple vault support
- [ ] Shared vaults between users

## License

MIT
