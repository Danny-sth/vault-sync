package com.vaultsync.service;

import com.vaultsync.model.FileRecord;
import com.vaultsync.model.SyncMessage;
import com.vaultsync.model.Tombstone;
import com.vaultsync.repository.FileRepository;
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
    private final SimpMessagingTemplate messagingTemplate;

    @Value("${vault-sync.tombstone-ttl-days:14}")
    private int tombstoneTtlDays;

    @Value("${vault-sync.storage-path}")
    private String storagePath;

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
            if (path.contains(pattern)) {
                return true;
            }
        }
        return false;
    }

    public boolean shouldExcludeDir(String dirName) {
        return EXCLUDED_DIRS.contains(dirName);
    }

    @jakarta.annotation.PostConstruct
    public void init() {
        initializeSequenceCounter();
        if (fileRepository.count() == 0) {
            scanExistingFiles();
        }
    }

    @Transactional(readOnly = true)
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
    public SyncMessage.FileChanged processFileChange(String path, String hash, long mtime, long size, String deviceId) {
        long seq = nextSeq();

        tombstoneRepository.deleteById(path);

        FileRecord record = FileRecord.builder()
                .path(path)
                .hash(hash)
                .mtime(mtime)
                .size(size)
                .seq(seq)
                .lastModifiedBy(deviceId)
                .build();
        fileRepository.save(record);

        log.info("File changed: {} by {} (seq={})", path, deviceId, seq);

        return SyncMessage.FileChanged.builder()
                .path(path)
                .hash(hash)
                .mtime(mtime)
                .size(size)
                .seq(seq)
                .deviceId(deviceId)
                .build();
    }

    @Transactional
    public SyncMessage.FileDeleted processFileDelete(String path, String deviceId) {
        long seq = nextSeq();

        fileRepository.deleteById(path);

        try {
            Path filePath = Paths.get(storagePath).resolve(path);
            if (Files.deleteIfExists(filePath)) {
                log.debug("Physically deleted file: {}", path);
                cleanupEmptyParentDirectories(filePath.getParent());
            }
        } catch (IOException e) {
            log.warn("Could not delete file from disk: {} - {}", path, e.getMessage());
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

    private void cleanupEmptyParentDirectories(Path directory) {
        Path root = Paths.get(storagePath);
        Path current = directory;

        while (current != null && !current.equals(root) && current.startsWith(root)) {
            try {
                if (Files.isDirectory(current) && isDirectoryEmpty(current)) {
                    Files.delete(current);
                    log.debug("Deleted empty directory: {}", current);
                    current = current.getParent();
                } else {
                    break;
                }
            } catch (IOException e) {
                log.debug("Could not delete directory {}: {}", current, e.getMessage());
                break;
            }
        }
    }

    private boolean isDirectoryEmpty(Path directory) throws IOException {
        try (var entries = Files.list(directory)) {
            return entries.findFirst().isEmpty();
        }
    }

    public SyncMessage.SyncResponse getFullState() {
        List<FileRecord> files = fileRepository.findAll();
        List<Tombstone> tombstones = tombstoneRepository.findAll();

        return SyncMessage.SyncResponse.builder()
                .currentSeq(currentSeq())
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
        List<FileRecord> files = fileRepository.findBySeqGreaterThan(lastSeq);
        List<Tombstone> tombstones = tombstoneRepository.findBySeqGreaterThan(lastSeq);

        return SyncMessage.SyncResponse.builder()
                .currentSeq(currentSeq())
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
        int deleted = tombstoneRepository.deleteOlderThan(cutoff);
        if (deleted > 0) {
            log.info("Cleaned up {} old tombstones", deleted);
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
        fileRepository.save(FileRecord.builder()
                .path(relativePath)
                .hash(hash)
                .mtime(mtime)
                .size(size)
                .seq(seq)
                .lastModifiedBy("filesystem")
                .build());
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
        long seq = nextSeq();
        fileRepository.deleteById(relativePath);
        tombstoneRepository.save(Tombstone.builder()
                .path(relativePath)
                .deletedAt(System.currentTimeMillis())
                .deletedBy(deletedBy)
                .seq(seq)
                .build());
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
    @Scheduled(fixedRateString = "${vault-sync.reconcile-interval-ms:300000}")
    @Transactional
    public void reconcile() {
        Path root = Paths.get(storagePath);
        if (!Files.exists(root)) {
            return;
        }

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

            for (FileRecord dbFile : fileRepository.findAll()) {
                if (!diskFiles.contains(dbFile.getPath())) {
                    indexDeletionInternal(dbFile.getPath(), "filesystem");
                }
            }
        } catch (IOException e) {
            log.error("Error during reconciliation scan", e);
        }

        // syncEmptyFolderMarkers() intentionally NOT called under E2EE: it writes
        // real-named ".folder-marker" files, which are incompatible with the encrypted
        // path scheme (clients can't decrypt the path and skip them). Empty-folder sync
        // is handled client-side (the plugin manages its own markers at encrypted paths).
    }

    private static final String FOLDER_MARKER = ".folder-marker";

    /**
     * Ensure empty folders have .folder-marker files and non-empty folders don't.
     */
    private void syncEmptyFolderMarkers() {
        log.debug("syncEmptyFolderMarkers() started");
        Path root = Paths.get(storagePath);
        if (!Files.exists(root)) {
            log.debug("syncEmptyFolderMarkers(): root path doesn't exist");
            return;
        }

        AtomicInteger markersCreated = new AtomicInteger(0);
        AtomicInteger markersDeleted = new AtomicInteger(0);

        try {
            Files.walkFileTree(root, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                    String name = dir.getFileName() != null ? dir.getFileName().toString() : "";
                    if (shouldExcludeDir(name)) {
                        return FileVisitResult.SKIP_SUBTREE;
                    }
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult postVisitDirectory(Path dir, IOException exc) {
                    if (dir.equals(root)) {
                        return FileVisitResult.CONTINUE;
                    }

                    String relativePath = root.relativize(dir).toString().replace("\\", "/");
                    if (shouldExcludePath(relativePath + "/")) {
                        return FileVisitResult.CONTINUE;
                    }

                    try {
                        Path markerPath = dir.resolve(FOLDER_MARKER);
                        String markerRelativePath = root.relativize(markerPath).toString().replace("\\", "/");

                        long realFileCount;
                        long subdirCount;
                        try (var stream = Files.list(dir)) {
                            var entries = stream.toList();
                            realFileCount = entries.stream()
                                .filter(p -> Files.isRegularFile(p) && !p.getFileName().toString().equals(FOLDER_MARKER))
                                .count();
                            subdirCount = entries.stream()
                                .filter(Files::isDirectory)
                                .count();
                        }

                        boolean markerExists = Files.exists(markerPath);

                        if (realFileCount == 0 && subdirCount == 0) {
                            // Do NOT recreate a marker that was deliberately deleted (live tombstone),
                            // otherwise the server resurrects empty folders the user just removed.
                            // Mirrors the client's syncEmptyFolderMarkers tombstone check.
                            if (!markerExists && !tombstoneRepository.existsById(markerRelativePath)) {
                                Files.createFile(markerPath);
                                log.info("Created folder marker: {}", markerRelativePath);

                                long seq = nextSeq();
                                String hash = HashUtil.sha256(new byte[0]);
                                FileRecord record = FileRecord.builder()
                                    .path(markerRelativePath)
                                    .hash(hash)
                                    .mtime(System.currentTimeMillis())
                                    .size(0)
                                    .seq(seq)
                                    .lastModifiedBy("server")
                                    .build();
                                fileRepository.save(record);

                                SyncMessage.FileChanged changeMsg = SyncMessage.FileChanged.builder()
                                    .path(markerRelativePath)
                                    .hash(hash)
                                    .mtime(System.currentTimeMillis())
                                    .size(0)
                                    .seq(seq)
                                    .deviceId("server")
                                    .build();
                                messagingTemplate.convertAndSend("/topic/sync", changeMsg);
                                markersCreated.incrementAndGet();
                            }
                        } else if (markerExists) {
                            Files.delete(markerPath);
                            fileRepository.deleteById(markerRelativePath);

                            long seq = nextSeq();
                            Tombstone tombstone = Tombstone.builder()
                                .path(markerRelativePath)
                                .deletedAt(System.currentTimeMillis())
                                .deletedBy("server")
                                .seq(seq)
                                .build();
                            tombstoneRepository.save(tombstone);

                            SyncMessage.FileDeleted deleteMsg = SyncMessage.FileDeleted.builder()
                                .path(markerRelativePath)
                                .seq(seq)
                                .deviceId("server")
                                .build();
                            messagingTemplate.convertAndSend("/topic/sync", deleteMsg);

                            log.info("Removed folder marker: {}", markerRelativePath);
                            markersDeleted.incrementAndGet();
                        }
                    } catch (IOException e) {
                        log.error("Error syncing folder marker for {}: {}", dir, e.getMessage());
                    }

                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException e) {
            log.error("Error syncing folder markers", e);
        }

        if (markersCreated.get() > 0 || markersDeleted.get() > 0) {
            log.info("Folder markers sync: {} created, {} deleted", markersCreated.get(), markersDeleted.get());
        }
        log.debug("syncEmptyFolderMarkers() finished");
    }
}
