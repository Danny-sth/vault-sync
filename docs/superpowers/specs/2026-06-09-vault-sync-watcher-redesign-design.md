# Vault-Sync: event-driven change detection + memory-safe hashing

**Date:** 2026-06-09
**Status:** Approved (Danny)
**Author:** Claude (Opus 4.8)

## Problem

The live server (`vault-sync`, Spring Boot, `88.222.245.74`, systemd) accumulated
**60× `java.lang.OutOfMemoryError: Java heap space`** since 2026-06-03, and the
Android client logs a stream of sync errors (`Failed to download after retries`,
`Remote file change failed to download`).

Root causes, established from logs + code:

1. **OOM — whole files read into a tiny heap.** `SyncService.periodicFilesystemScan()`
   is `@Scheduled(fixedRate = 30000)`: every 30 s it walks the whole vault and, for each
   new/changed file, calls `Files.readAllBytes(file)` to hash it. `HashUtil.sha256(Path)`
   *also* does `readAllBytes`, so even multipart uploads buffer the whole file. Heap is
   `-Xmx128m`; the vault is 126 MB / 713 files with a 22.7 MB docx (plus 12.6, 7.4, 6.4 MB
   files). One big file + 4 MB×2 WebSocket buffers + base64-JSON upload strings exhausts
   the heap → OOM in the scan thread (`pool-2-thread-1`) and in HTTP request threads.

2. **Android errors — 404 download race.** Machine-generated agent state under
   `cortex/memory/.dreams/*` and `cortex/memory/dreaming/*` is created and deleted
   continuously on the server. The 30 s poll detects each create/delete and broadcasts
   `file_changed` / `file_deleted` to all clients. Android receives `file_changed`,
   requests the file, but the next poll cycle has already deleted it → **HTTP 404** →
   `SyncApiClient.download()` throws → client retries 3× → logs error + `Notice('Failed')`.

3. **Architecture — poll-everything-into-memory + base64-in-JSON.** Periodic full-tree
   polling is the wrong model when there is already an explicit upload/delete API and a
   local OS file-change facility (inotify). `max-json-string-length: 50000000` (50 M chars)
   lets a single base64 upload allocate ~50 MB in heap.

## Goals

- Sync **everything** (no path exclusions added — `.dreams`/`dreaming` keep syncing).
- Eliminate OOM regardless of file size.
- Eliminate the Android 404 error storm.
- Replace periodic full-tree polling with event-driven detection + a low-frequency
  reconciliation safety net.

## Non-goals

- Changing the sequence model, tombstones, optimistic-concurrency conflict guard, or
  version backups — all keep working unchanged.
- Replacing the base64-JSON transport (kept for Obsidian `requestUrl` CORS), only bounded.

## Design

### 1. Streaming SHA-256 (`HashUtil`) — the OOM root fix

Add a true streaming hash and use it for all file hashing:

```java
public static String sha256(Path filePath) throws IOException {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    try (InputStream in = Files.newInputStream(filePath);
         DigestInputStream dis = new DigestInputStream(in, digest)) {
        byte[] buf = new byte[8192];
        while (dis.read(buf) != -1) { /* digest updates */ }
    }
    return HexFormat.of().formatHex(digest.digest());
}
```

Constant ~8 KB memory for any file size. `sha256(byte[])` stays for already-in-memory
content (base64 uploads). Every `readAllBytes`-for-hashing call site switches to the
streaming `Path` overload.

### 2. `VaultIndexService` (new) — single indexing authority

Extract the "given a path, reconcile DB + disk + broadcast" logic out of the
`SyncService` god-object. Owns:

- `indexPath(relativePath)` — stat the file; if new or `size`/`mtime` differs from the DB
  record, stream-hash it; if the hash changed, save `FileRecord` (clear any tombstone) and
  broadcast `file_changed`. Skips excluded paths.
- `indexDeletion(relativePath)` — delete `FileRecord`, write tombstone, broadcast
  `file_deleted`.
- `reconcile()` — the safety-net sweep (see §4).
- folder-marker maintenance (moved from `SyncService.syncEmptyFolderMarkers`).

Depends on `SyncService` (for `nextSeq()`, exclusion predicates, broadcast helpers),
`FileRepository`, `TombstoneRepository`. `SyncService` slims to: sequence counter,
tombstone/delete API, `getFullState`/`getChangesSince`, broadcast plumbing, exclusion
predicates.

### 3. `VaultWatcherService` (new) — event-driven detection

- Java NIO `WatchService` (inotify on Linux) registered recursively on the vault root,
  skipping `EXCLUDED_DIRS`. Newly created directories are registered dynamically.
- A dedicated daemon thread drains events. Per-path **debounce**: an event schedules a
  "settle" task ~1.5 s out; repeated events for the same path reset the timer. When it
  fires, the watcher reads the *current* disk state once and calls `indexPath` (file
  exists) or `indexDeletion` (file gone). A rapid create+delete or a burst of saves
  collapses to a single net update — this is what removes the 404 race.
- Started on `ApplicationReadyEvent` (after the initial index), stopped on shutdown.

### 4. Reconciliation sweep (safety net)

`reconcile()` replaces `periodicFilesystemScan`, now `@Scheduled(fixedRate = 300000)`
(5 min, configurable via `vault-sync.reconcile-interval-ms`). It walks the tree but:

- uses `size` + `mtime` as a cheap pre-check and only stream-hashes when they differ;
- detects deletions (DB path absent on disk) → `indexDeletion`;
- never calls `readAllBytes`.

Catches events missed while the service was down or on inotify-queue overflow.

### 5. Client — 404 is benign (`SyncApiClient` + `SyncManager`)

- `SyncApiClient.download()` passes `throw: false`; returns `null` on **404** (file already
  gone upstream), throws only on other non-200.
- `SyncManager.downloadFile()`: a `null` result is treated as "deleted upstream" — advance
  the seq, no retry, no `console.error`, no `Notice('Failed')`. Other errors keep the
  existing retry behaviour.

### 6. Memory hardening (config / systemd)

- systemd `ExecStart`: `-Xmx128m` → `-Xmx512m` (VPS has 35 GB free disk, ample RAM).
- `application.yml`: `vault-sync.max-json-string-length` 50000000 → 15000000 (~15 MB);
  `logging.level` back to `INFO` (drop the DEBUG "diagnostic" block).

## Units / boundaries

| Unit | Responsibility | Depends on |
|------|----------------|-----------|
| `HashUtil` | hashing (streaming + byte[]) | — |
| `SyncService` | sequence, tombstones, delete API, full/incremental state, broadcast, exclusion | repositories, messaging |
| `VaultIndexService` | index one path / deletion, reconcile sweep, folder markers | SyncService, repositories |
| `VaultWatcherService` | inotify events → debounce → VaultIndexService | VaultIndexService |
| `FileStorageService` | store/load/delete bytes, version backups (stream-hash) | repository |
| `SyncManager`/`SyncApiClient` (TS) | client sync; 404 benign | — |

## Error handling

- Watcher thread catches per-event exceptions and logs at WARN; one bad file never kills
  the watcher loop. inotify `OVERFLOW` → trigger a `reconcile()`.
- `reconcile()` keeps its per-file try/catch.
- Client: 404 benign; network/5xx retain retry.

## Testing (run on VPS per project rule, build skips tests)

- `HashUtil`: streaming hash == byte[] hash for a small and a multi-MB file.
- `VaultIndexService`: new file → `file_changed`; unchanged file (same size/mtime) → no
  hash, no broadcast; deletion → tombstone + `file_deleted`.
- Debounce: create+delete within the window → single net event (manual/integration).
- Client: `download()` returns null on 404; `downloadFile` treats null as benign.

## Rollback

Full vault backup taken before any change:
`/opt/vault-backups/obsidian-vault-20260609-080935.tar.gz` (863 files, gzip-verified).
Revert = redeploy previous jar + restore systemd `-Xmx`.

## Risks

- Recursive `WatchService` registration + new-dir handling is fiddly → the 5 min
  reconcile is the guaranteed convergence backstop.
- inotify watch limits for 700+ files → watches are per-directory (hundreds), well within
  default `fs.inotify.max_user_watches`.
