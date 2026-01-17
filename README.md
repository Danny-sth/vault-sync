# Vault Sync

Real-time Obsidian vault synchronization via WebSocket.

## Components

- **server/** — Go WebSocket server for file sync
- **plugin/** — Obsidian plugin (TypeScript)

## Quick Start

```bash
# Build everything
make all

# Run server locally
make dev-server

# Build plugin
make plugin
```

## Architecture

```
Obsidian (Plugin) ──► WebSocket ──► VPS Server ──► File Storage
     │                                   │
     └───────────────────────────────────┘
              Multi-device broadcast
```

## Documentation

See [CLAUDE.md](./CLAUDE.md) for detailed technical specification.

## License

MIT
