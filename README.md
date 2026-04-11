# Vault Sync

Real-time Obsidian vault synchronization between Desktop, Mobile, and VPS.

## Structure

```
vault-sync/
├── plugin/     # Obsidian plugin (TypeScript)
└── server/     # Spring Boot server (Java 21)
```

## Server Setup

```bash
cd server
./mvnw clean package -DskipTests
scp target/vault-sync-*.jar root@your-server:/opt/vault-sync/
```

**application.yml:**
```yaml
server:
  port: 8443
  ssl:
    enabled: true
    key-store: /opt/vault-sync/keystore.p12
    key-store-password: your-password

vault-sync:
  storage-path: /opt/vault-sync/files
  token: your-secret-token
```

**systemd service:**
```ini
[Unit]
Description=Vault Sync Server
After=network.target

[Service]
ExecStart=/usr/bin/java -jar /opt/vault-sync/vault-sync.jar --spring.config.location=/opt/vault-sync/application.yml
Restart=always

[Install]
WantedBy=multi-user.target
```

## Plugin Setup

```bash
cd plugin
npm install
npm run build
```

Copy `main.js`, `manifest.json`, `styles.css` to:
- Desktop: `~/.obsidian/plugins/vault-sync/`
- Android: via ADB to `/storage/emulated/0/Documents/Obsidian/.obsidian/plugins/vault-sync/`

## Plugin Settings

- **Server URL:** `wss://your-server:8443/ws`
- **Token:** same as server config
- **Device ID:** unique per device
- **Auto Connect:** enable for automatic sync

## License

MIT
