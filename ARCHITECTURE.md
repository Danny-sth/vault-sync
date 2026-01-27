# Vault Sync Architecture v2 - Proper Conflict-free Sync

## Problem with v1

**Critical flaw:** "Server is source of truth" in full_sync caused data loss
- When server loses files → full_sync deletes them from all clients
- No way to distinguish "deleted intentionally" vs "server lost data"

## Solution: Tombstones + Vector Clocks

### Core Principles

1. **Never delete during full_sync** - only explicit delete operations
2. **Tombstones track deletions** - persist deletion events
3. **Vector clocks for ordering** - determine which operation happened first
4. **Eventually consistent** - all devices converge to same state

---

## Data Structures

### Server Storage

```go
// File metadata
type FileMetadata struct {
    Path      string
    Hash      string
    Size      int64
    ModTime   int64
    VectorClock map[string]int64  // deviceId -> clock value
}

// Tombstone - marks deleted file
type Tombstone struct {
    Path        string
    DeletedAt   int64  // Unix timestamp
    DeletedBy   string // device ID
    VectorClock map[string]int64
    TTL         int64  // Cleanup after 30 days
}

// Storage now maintains:
// - files: map[path]FileMetadata
// - tombstones: map[path]Tombstone
```

### Client State

```typescript
interface ClientState {
  deviceId: string;
  vectorClock: Map<string, number>;  // Track all known device clocks
  localFiles: Map<string, FileMetadata>;
}
```

---

## Operations

### 1. File Change

**Client → Server:**
```json
{
  "type": "file_change",
  "deviceId": "laptop",
  "vectorClock": {"laptop": 42, "phone": 15},
  "payload": {
    "path": "note.md",
    "content": "base64...",
    "hash": "sha256..."
  }
}
```

**Server logic:**
```go
1. Check if tombstone exists
   - If yes && tombstone.VectorClock > msg.VectorClock:
     → Reject (file was deleted after this version)
   - Else: Delete tombstone (file resurrected)

2. Check existing file version
   - Compare vector clocks to determine ordering
   - If incoming is newer: accept
   - If concurrent: use conflict resolution (last-write-wins or merge)

3. Update file + increment vector clock

4. Broadcast to all devices
```

### 2. File Delete

**Client → Server:**
```json
{
  "type": "file_delete",
  "deviceId": "laptop",
  "vectorClock": {"laptop": 43, "phone": 15},
  "payload": {
    "path": "note.md"
  }
}
```

**Server logic:**
```go
1. Delete physical file

2. Create tombstone with current vector clock
   tombstones[path] = Tombstone{
     Path: path,
     DeletedAt: now(),
     DeletedBy: deviceId,
     VectorClock: msgClock,
     TTL: now() + 30days,
   }

3. Broadcast delete to all devices
```

### 3. Full Sync (NEVER DELETES)

**Client → Server:**
```json
{
  "type": "request_full_sync",
  "deviceId": "laptop",
  "vectorClock": {"laptop": 40, "phone": 10}
}
```

**Server → Client:**
```json
{
  "type": "full_sync",
  "payload": {
    "files": [...],           // All server files with vector clocks
    "tombstones": [...],      // Recent tombstones (last 30 days)
    "vectorClock": {"laptop": 43, "phone": 15, "desktop": 8}
  }
}
```

**Client logic:**
```typescript
1. For each server file:
   - If local doesn't exist: Download
   - If local exists: Compare vector clocks
     • Server newer: Download
     • Local newer: Upload
     • Concurrent: Conflict resolution

2. For each tombstone:
   - If local file exists && tombstone.VectorClock > localClock:
     → Delete local file (was deleted on other device)

3. For each local file NOT on server:
   - Check if tombstone exists:
     • Yes → Delete local (was deleted elsewhere)
     • No → Upload to server (server lost it)

4. Update local vector clock = max(local, server)
```

---

## Vector Clock Operations

### Comparison

```typescript
function compareVectorClocks(a: VectorClock, b: VectorClock): 'before' | 'after' | 'concurrent' {
  let aGreater = false;
  let bGreater = false;

  const allDevices = new Set([...a.keys(), ...b.keys()]);

  for (const device of allDevices) {
    const aVal = a.get(device) || 0;
    const bVal = b.get(device) || 0;

    if (aVal > bVal) aGreater = true;
    if (bVal > aVal) bGreater = true;
  }

  if (aGreater && !bGreater) return 'after';   // a is newer
  if (bGreater && !aGreater) return 'before';  // b is newer
  return 'concurrent';                         // conflict!
}
```

### Update on operation

```typescript
// Client increments own clock on every operation
client.vectorClock.set(client.deviceId, (client.vectorClock.get(client.deviceId) || 0) + 1);

// Client merges clocks when receiving messages
for (const [device, clock] of Object.entries(msg.vectorClock)) {
  client.vectorClock.set(device, Math.max(
    client.vectorClock.get(device) || 0,
    clock
  ));
}
```

---

## Conflict Resolution

### Concurrent Modifications

When vector clocks show concurrent edits:

**Strategy 1: Last-Write-Wins (MVP)**
```go
if compareClocks(incoming, existing) == "concurrent" {
  if incoming.ModTime > existing.ModTime {
    // Accept incoming
  } else {
    // Keep existing, send back to client
  }
}
```

**Strategy 2: Merge (Future)**
- Use CRDT or text diff-merge
- Create conflict markers
- Let user resolve manually

---

## Tombstone Cleanup

```go
// Run daily cleanup
func (s *Storage) CleanupTombstones() {
  now := time.Now().Unix()

  for path, tomb := range s.tombstones {
    if tomb.TTL < now {
      delete(s.tombstones, path)
    }
  }
}
```

**Why 30 days?**
- Long enough for offline devices to sync
- Short enough to not bloat storage
- If device offline > 30 days → needs manual full resync

---

## Migration from v1 to v2

1. Add tombstone storage to server
2. Initialize all files with vector clock = {"server": 1}
3. Clients reset vector clocks on first v2 connection
4. Backward compatible: v1 clients still work (no vector clock = assume old)

---

## Edge Cases

### Resurrection

File deleted on phone, recreated on laptop:
```
1. Phone deletes → tombstone created (clock: {phone: 5})
2. Laptop creates → new file (clock: {laptop: 3})
3. Laptop syncs:
   - Sees tombstone with {phone: 5}
   - Compares with local {laptop: 3}
   - Concurrent! Use ModTime to decide
   - If laptop's ModTime newer → keep file, delete tombstone
```

### Network Partition

Laptop offline for a week:
```
1. Phone deletes file → tombstone created
2. Laptop reconnects after 7 days
3. full_sync receives tombstone
4. Laptop deletes local file
5. ✅ Works correctly!
```

### Duplicate Writes

Both devices modify same file offline:
```
1. Phone: note.md (clock: {phone: 10})
2. Laptop: note.md (clock: {laptop: 8})
3. Phone syncs first → server has {phone: 10}
4. Laptop syncs → concurrent!
5. Use last-write-wins (ModTime)
6. Loser gets updated version back
```

---

## Benefits

✅ **Never loses data** - server doesn't delete during full_sync
✅ **Proper delete tracking** - tombstones persist deletion intent
✅ **Handles offline devices** - vector clocks track causality
✅ **Eventually consistent** - all devices converge
✅ **Conflict detection** - knows when edits are concurrent

## Performance

- Vector clocks: O(n devices) space per file (~8 bytes per device)
- Tombstone storage: ~100 bytes per deleted file
- Cleanup: Runs daily, removes tombstones > 30 days old
- Full sync: Slightly slower (sends vector clocks + tombstones)

---

## Implementation Priority

**Phase 1 (Critical):**
1. Add tombstone storage
2. Change full_sync to never delete
3. Use tombstones for delete detection

**Phase 2 (Important):**
4. Add vector clocks for ordering
5. Proper conflict detection

**Phase 3 (Nice to have):**
6. CRDT merge for text files
7. Conflict UI for manual resolution
