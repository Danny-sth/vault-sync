package com.vaultsync.service;

import com.vaultsync.model.FileRecord;
import com.vaultsync.model.SyncMeta;
import com.vaultsync.model.SyncMessage;
import com.vaultsync.model.Tombstone;
import com.vaultsync.repository.FileRepository;
import com.vaultsync.repository.SyncMetaRepository;
import com.vaultsync.repository.TombstoneRepository;
import com.vaultsync.util.HashUtil;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

@Service
@RequiredArgsConstructor
@Slf4j
public class SyncService {

    private final FileRepository fileRepository;
    private final TombstoneRepository tombstoneRepository;
    private final SyncMetaRepository syncMetaRepository;
    private final SimpMessagingTemplate messagingTemplate;
    private final FileStorageService fileStorageService;
    /**
     * Programmatic transactions for the indexing helpers: they are invoked internally
     * (reconcile → private methods), where {@code @Transactional} would be silently
     * ignored (self-invocation bypasses the Spring proxy). The template keeps
     * delete+tombstone atomic without dragging a whole vault walk into one transaction.
     */
    private final org.springframework.transaction.support.TransactionTemplate transactionTemplate;

    /** sync_meta key holding the highest seq among tombstones already pruned by TTL. */
    private static final String META_TOMBSTONE_FLOOR = "tombstoneFloorSeq";

    /**
     * A delta from a client whose lastSeq is below this value is unsafe — a deletion in its
     * gap may have already been swept — so the server falls back to a full reconcile for it.
     * Persisted in sync_meta so the guarantee survives restarts.
     */
    private volatile long tombstoneFloorSeq = 0;

    @Value("${vault-sync.tombstone-ttl-days:14}")
    private int tombstoneTtlDays;

    @Value("${vault-sync.storage-path}")
    private String storagePath;

    /**
     * Mass-deletion valve for filesystem-origin deletions (watcher/reconcile). Device- and
     * MCP-initiated deletions are deliberate and never valved. Incident 2026-07-09: a rekey
     * on the live server made the watcher tombstone 781 files nobody deleted — the valve
     * refuses such bursts instead of fanning them out to every device.
     */
    @Value("${vault-sync.fs-deletion-valve.threshold:20}")
    private int fsDeletionValveThreshold;

    @Value("${vault-sync.fs-deletion-valve.window-ms:60000}")
    private long fsDeletionValveWindowMs;

    private com.vaultsync.util.FsDeletionValve fsDeletionValve;

    private final AtomicLong sequenceCounter = new AtomicLong(0);

    private static final Set<String> EXCLUDED_DIRS = Set.of(
            ".git", ".idea", ".smart-env", ".DS_Store", "node_modules", ".vault-sync-versions", ".vault-sync-uploads"
    );

    private static final Set<String> EXCLUDED_PATTERNS = Set.of(
            ".DS_Store", "Thumbs.db", ".tmp", ".temp"
    );

    public boolean shouldExcludePath(String path) {
        for (String excluded : EXCLUDED_DIRS) {
            if (path.startsWith(excluded + "/") || path.equals(excluded)) {
                return true;
            }
            if (path.contains("/" + excluded + "/")) {
                return true;
            }
        }
        for (String pattern : EXCLUDED_PATTERNS) {
            // Word-boundary match, not bare contains(): ".tmp" must exclude "x.tmp" and
            // "x.tmp/y" but NOT "my.tmpl.md" or "a.temperature.md" (same rule as the
            // plugin's SyncFilter — a bare substring silently dropped legit files).
            int idx = path.indexOf(pattern);
            while (idx != -1) {
                int after = idx + pattern.length();
                char next = after < path.length() ? path.charAt(after) : '\0';
                if (next == '\0' || next == '.' || next == '/') {
                    return true;
                }
                idx = path.indexOf(pattern, idx + 1);
            }
        }
        return false;
    }

    public boolean shouldExcludeDir(String dirName) {
        return EXCLUDED_DIRS.contains(dirName);
    }

    @jakarta.annotation.PostConstruct
    public void init() {
        fsDeletionValve = new com.vaultsync.util.FsDeletionValve(fsDeletionValveWindowMs, fsDeletionValveThreshold);
        initializeSequenceCounter();
        tombstoneFloorSeq = syncMetaRepository.findById(META_TOMBSTONE_FLOOR)
                .map(SyncMeta::getValue).orElse(0L);
        log.info("Tombstone floor seq = {}", tombstoneFloorSeq);
        if (fileRepository.count() == 0) {
            scanExistingFiles();
        }
    }

    // NB: no @Transactional here — it's called from init() through `this` (self-invocation),
    // where the annotation is silently ignored anyway; these are two plain reads.
    protected void initializeSequenceCounter() {
        long maxFileSeq = fileRepository.findMaxSeq();
        long maxTombstoneSeq = tombstoneRepository.findMaxSeq();
        sequenceCounter.set(Math.max(maxFileSeq, maxTombstoneSeq));
        log.info("Initialized sequence counter to {}", sequenceCounter.get());
    }

    private void scanExistingFiles() {
        Path root = Paths.get(storagePath);
        if (!Files.exists(root)) {
            log.warn("Storage path does not exist: {}", storagePath);
            return;
        }

        log.info("Scanning existing files in {}", storagePath);
        AtomicInteger count = new AtomicInteger(0);

        try {
            Files.walkFileTree(root, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                    try {
                        String relativePath = root.relativize(file).toString().replace("\\", "/");

                        if (shouldExcludePath(relativePath)) {
                            return FileVisitResult.CONTINUE;
                        }

                        String hash = HashUtil.sha256(file);
                        long mtime = attrs.lastModifiedTime().toMillis();
                        long size = attrs.size();

                        long seq = nextSeq();
                        FileRecord record = FileRecord.builder()
                                .path(relativePath)
                                .hash(hash)
                                .mtime(mtime)
                                .size(size)
                                .seq(seq)
                                .lastModifiedBy("server-scan")
                                .build();
                        fileRepository.save(record);
                        int current = count.incrementAndGet();

                        if (current % 100 == 0) {
                            log.info("Scanned {} files...", current);
                        }
                    } catch (Exception e) {
                        log.error("Error scanning file: {}", file, e);
                    }
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                    String name = dir.getFileName() != null ? dir.getFileName().toString() : "";
                    if (shouldExcludeDir(name)) {
                        return FileVisitResult.SKIP_SUBTREE;
                    }
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException e) {
            log.error("Error scanning storage directory", e);
        }

        log.info("Scan complete: indexed {} files", count.get());
    }

    public long nextSeq() {
        return sequenceCounter.incrementAndGet();
    }

    public long currentSeq() {
        return sequenceCounter.get();
    }

    @Transactional
    public SyncMessage.FileDeleted processFileDelete(String path, String deviceId) {
        long seq = nextSeq();

        // Disk removal + DB row + empty-parent cleanup all live in FileStorageService —
        // one owner for physical storage, no duplicated cleanup logic here.
        try {
            fileStorageService.delete(path);
        } catch (IOException e) {
            log.warn("Could not delete file from disk: {} - {}", path, e.getMessage());
            fileRepository.deleteById(path); // still drop the index entry
        }

        Tombstone tombstone = Tombstone.builder()
                .path(path)
                .deletedAt(System.currentTimeMillis())
                .deletedBy(deviceId)
                .seq(seq)
                .build();
        tombstoneRepository.save(tombstone);

        log.info("File deleted: {} by {} (seq={})", path, deviceId, seq);

        return SyncMessage.FileDeleted.builder()
                .path(path)
                .seq(seq)
                .deviceId(deviceId)
                .build();
    }

    public SyncMessage.SyncResponse getFullState() {
        List<FileRecord> files = fileRepository.findAll();
        List<Tombstone> tombstones = tombstoneRepository.findAll();

        return SyncMessage.SyncResponse.builder()
                .currentSeq(currentSeq())
                .fullState(true)
                .files(files.stream()
                        .map(f -> SyncMessage.FileInfo.builder()
                                .path(f.getPath())
                                .hash(f.getHash())
                                .mtime(f.getMtime())
                                .size(f.getSize())
                                .seq(f.getSeq())
                                .build())
                        .toList())
                .tombstones(tombstones.stream()
                        .map(t -> SyncMessage.TombstoneInfo.builder()
                                .path(t.getPath())
                                .deletedAt(t.getDeletedAt())
                                .seq(t.getSeq())
                                .build())
                        .toList())
                .build();
    }

    public SyncMessage.SyncResponse getChangesSince(long lastSeq) {
        // A device whose lastSeq predates a pruned tombstone may have missed that deletion;
        // a sparse delta can't convey "this file is gone" once its tombstone is swept. Promote
        // such a stale device to a full reconcile so absence-based deletion runs.
        if (lastSeq < tombstoneFloorSeq) {
            log.info("lastSeq {} below tombstone floor {} → full reconcile", lastSeq, tombstoneFloorSeq);
            return getFullState();
        }

        List<FileRecord> files = fileRepository.findBySeqGreaterThan(lastSeq);
        List<Tombstone> tombstones = tombstoneRepository.findBySeqGreaterThan(lastSeq);

        return SyncMessage.SyncResponse.builder()
                .currentSeq(currentSeq())
                .fullState(false)
                .files(files.stream()
                        .map(f -> SyncMessage.FileInfo.builder()
                                .path(f.getPath())
                                .hash(f.getHash())
                                .mtime(f.getMtime())
                                .size(f.getSize())
                                .seq(f.getSeq())
                                .build())
                        .toList())
                .tombstones(tombstones.stream()
                        .map(t -> SyncMessage.TombstoneInfo.builder()
                                .path(t.getPath())
                                .deletedAt(t.getDeletedAt())
                                .seq(t.getSeq())
                                .build())
                        .toList())
                .build();
    }

    /** Live tombstone for a path, or null. Used to block stale devices from resurrecting deletes. */
    public Tombstone getTombstone(String path) {
        return tombstoneRepository.findById(path).orElse(null);
    }

    /** Clear a tombstone (a genuine re-creation supersedes the prior deletion). */
    @Transactional
    public void clearTombstone(String path) {
        tombstoneRepository.deleteById(path);
    }

    public void broadcastFileChange(SyncMessage.FileChanged message) {
        messagingTemplate.convertAndSend("/topic/sync", message);
    }

    public void broadcastFileDelete(SyncMessage.FileDeleted message) {
        messagingTemplate.convertAndSend("/topic/sync", message);
    }

    @Scheduled(fixedRate = 3600000)
    @Transactional
    public void cleanupTombstones() {
        long cutoff = System.currentTimeMillis() - (tombstoneTtlDays * 24L * 60L * 60L * 1000L);
        // Capture the highest seq we're about to sweep BEFORE deleting — that becomes the new
        // floor below which a client can no longer be trusted to learn deletions from a delta.
        long prunedMaxSeq = tombstoneRepository.findMaxSeqOlderThan(cutoff);
        int deleted = tombstoneRepository.deleteOlderThan(cutoff);
        if (deleted > 0) {
            log.info("Cleaned up {} old tombstones", deleted);
            if (prunedMaxSeq > tombstoneFloorSeq) {
                tombstoneFloorSeq = prunedMaxSeq;
                syncMetaRepository.save(SyncMeta.builder()
                        .key(META_TOMBSTONE_FLOOR).value(prunedMaxSeq).build());
                log.info("Tombstone floor raised to {}", prunedMaxSeq);
            }
        }
    }

    /**
     * Index a single path against its current on-disk state and broadcast the change.
     * This is the real-time entry point called by {@code VaultWatcherService} after an
     * inotify event settles. If the file is gone, it is treated as a deletion. Hashing is
     * streamed (constant memory) and skipped entirely when size+mtime are unchanged.
     */
    @Transactional
    public void indexPath(String relativePath) {
        if (shouldExcludePath(relativePath)) {
            return;
        }
        Path file = Paths.get(storagePath).resolve(relativePath);
        try {
            if (!Files.isRegularFile(file)) {
                indexDeletionInternal(relativePath, "filesystem");
                return;
            }
            BasicFileAttributes attrs = Files.readAttributes(file, BasicFileAttributes.class);
            upsertFromDisk(relativePath, file, attrs);
        } catch (NoSuchFileException e) {
            indexDeletionInternal(relativePath, "filesystem");
        } catch (IOException e) {
            log.warn("indexPath failed for {}: {}", relativePath, e.getMessage());
        }
    }

    /** Real-time entry point for a deletion detected by the watcher. */
    @Transactional
    public void indexDeletion(String relativePath) {
        if (shouldExcludePath(relativePath)) {
            return;
        }
        indexDeletionInternal(relativePath, "filesystem");
    }

    /**
     * Upsert one file from disk: skip when size+mtime are unchanged; otherwise stream-hash
     * and, only when the hash actually differs, persist a new {@link FileRecord} and
     * broadcast. When the content matches but mtime drifted, refresh mtime quietly (no
     * broadcast, no seq bump) so reconciliation doesn't re-hash it forever.
     */
    private void upsertFromDisk(String relativePath, Path file, BasicFileAttributes attrs) throws IOException {
        long diskMtime = attrs.lastModifiedTime().toMillis();
        long size = attrs.size();
        var existingRecord = fileRepository.findById(relativePath);

        if (existingRecord.isEmpty()) {
            if (tombstoneRepository.existsById(relativePath)) {
                tombstoneRepository.deleteById(relativePath);
                log.info("Removed stale tombstone for re-created file: {}", relativePath);
            }
            String hash = HashUtil.sha256(file);
            saveAndBroadcastChange(relativePath, hash, diskMtime, size);
            log.info("Indexed new file: {}", relativePath);
            return;
        }

        FileRecord existing = existingRecord.get();
        if (existing.getSize() == size && Math.abs(existing.getMtime() - diskMtime) <= 1000) {
            return;
        }
        String hash = HashUtil.sha256(file);
        if (hash.equals(existing.getHash())) {
            existing.setMtime(diskMtime);
            fileRepository.save(existing);
            return;
        }
        saveAndBroadcastChange(relativePath, hash, diskMtime, size);
        log.info("Indexed modified file: {}", relativePath);
    }

    private void saveAndBroadcastChange(String relativePath, String hash, long mtime, long size) {
        long seq = nextSeq();
        // Persist atomically first, broadcast only after the commit — a client reacting
        // to the broadcast must never observe pre-commit state.
        transactionTemplate.executeWithoutResult(tx -> fileRepository.save(FileRecord.builder()
                .path(relativePath)
                .hash(hash)
                .mtime(mtime)
                .size(size)
                .seq(seq)
                .lastModifiedBy("filesystem")
                .build()));
        messagingTemplate.convertAndSend("/topic/sync", SyncMessage.FileChanged.builder()
                .path(relativePath)
                .hash(hash)
                .mtime(mtime)
                .size(size)
                .seq(seq)
                .deviceId("filesystem")
                .build());
    }

    private void indexDeletionInternal(String relativePath, String deletedBy) {
        if (fileRepository.findById(relativePath).isEmpty()) {
            return;
        }
        // VALVE: filesystem deletions arrive from the watcher one by one; an rm -rf /
        // broken mount / wrong storage dir looks like a storm of them. Suppress past the
        // window budget — a wrongly-suppressed genuine deletion re-converges via a later
        // reconcile once the storm is over; a wrongly-applied storm nukes every device.
        if ("filesystem".equals(deletedBy) && !fsDeletionValve.allowOne(System.currentTimeMillis())) {
            if (fsDeletionValve.shouldLogTrip()) {
                log.error("MASS-DELETION VALVE TRIPPED: >{} filesystem deletions in {} ms — suppressing further "
                                + "filesystem deletions this window (first suppressed: {}). Disk view is likely wrong "
                                + "(moved storage dir / mount / rekey). Deletions via devices and MCP are unaffected.",
                        fsDeletionValve.threshold(), fsDeletionValveWindowMs, relativePath);
            }
            return;
        }
        long seq = nextSeq();
        // delete + tombstone must be atomic: a crash in between would leave the file
        // neither live nor tombstoned, and a device could then misread its absence.
        transactionTemplate.executeWithoutResult(tx -> {
            fileRepository.deleteById(relativePath);
            tombstoneRepository.save(Tombstone.builder()
                    .path(relativePath)
                    .deletedAt(System.currentTimeMillis())
                    .deletedBy(deletedBy)
                    .seq(seq)
                    .build());
        });
        messagingTemplate.convertAndSend("/topic/sync", SyncMessage.FileDeleted.builder()
                .path(relativePath)
                .seq(seq)
                .deviceId(deletedBy)
                .build());
        log.info("Indexed deletion: {} (seq={})", relativePath, seq);
    }

    /**
     * Low-frequency reconciliation safety net (default every 5 min). The real-time watcher
     * does the heavy lifting; this catches anything missed while the service was down or on
     * an inotify-queue overflow. Streams hashes, pre-filtered by size+mtime, so it never
     * loads a whole file into the heap.
     */
    // NB: deliberately NOT @Transactional — one transaction spanning a full vault walk
    // (with per-file stream hashing) would pin a DB connection and the persistence
    // context for minutes. The indexing helpers create their own short transactions.
    @Scheduled(fixedRateString = "${vault-sync.reconcile-interval-ms:300000}")
    public void reconcile() {
        Path root = Paths.get(storagePath);
        if (!Files.exists(root)) {
            return;
        }

        // Everything indexed after this point raced the walk — leave it to the next pass.
        final long walkStartSeq = currentSeq();
        java.util.Set<String> diskFiles = new java.util.HashSet<>();

        try {
            Files.walkFileTree(root, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                    try {
                        String relativePath = root.relativize(file).toString().replace("\\", "/");
                        if (shouldExcludePath(relativePath)) {
                            return FileVisitResult.CONTINUE;
                        }
                        diskFiles.add(relativePath);
                        upsertFromDisk(relativePath, file, attrs);
                    } catch (Exception e) {
                        log.error("Error reconciling file: {}", file, e);
                    }
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                    String name = dir.getFileName() != null ? dir.getFileName().toString() : "";
                    if (shouldExcludeDir(name)) {
                        return FileVisitResult.SKIP_SUBTREE;
                    }
                    return FileVisitResult.CONTINUE;
                }
            });

            java.util.List<String> missing = new java.util.ArrayList<>();
            for (FileRecord dbFile : fileRepository.findAll()) {
                if (diskFiles.contains(dbFile.getPath())) {
                    continue;
                }
                // Race guards against tombstoning a file that was uploaded DURING the walk
                // (the walk missed it on disk, but findAll already sees its record — without
                // these checks the reconciler would broadcast a bogus deletion and every
                // device would drop the freshly-uploaded file):
                //  1) skip records newer than the walk start;
                //  2) re-check the disk at decision time.
                if (dbFile.getSeq() > walkStartSeq) {
                    continue;
                }
                if (Files.exists(root.resolve(dbFile.getPath()))) {
                    continue;
                }
                missing.add(dbFile.getPath());
            }
            // VALVE: a batch of vanished files this size is never a real cleanup — it's a
            // moved storage dir, broken mount or mid-flight rekey (incident 2026-07-09:
            // 781 bogus tombstones). Refuse the whole pass and scream; a genuine state
            // converges on a later pass once the disk view is sane again.
            if (!fsDeletionValve.batchAllowed(missing.size())) {
                log.error("MASS-DELETION VALVE TRIPPED in reconcile: {} of {} indexed files missing from disk "
                                + "(threshold {}) — refusing to tombstone. Check storage dir/mount/rekey; "
                                + "if intentional, delete via clients/MCP or raise vault-sync.fs-deletion-valve.threshold.",
                        missing.size(), fileRepository.count(), fsDeletionValve.threshold());
                return;
            }
            for (String path : missing) {
                indexDeletionInternal(path, "filesystem");
            }
        } catch (IOException e) {
            log.error("Error during reconciliation scan", e);
        }
    }
}
