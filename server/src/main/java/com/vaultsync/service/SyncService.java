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
            ".git", ".idea", ".smart-env", ".DS_Store", "node_modules", ".vault-sync-versions"
    );

    private static final Set<String> EXCLUDED_PATTERNS = Set.of(
            ".DS_Store", "Thumbs.db", ".tmp", ".temp"
    );

    private boolean shouldExcludePath(String path) {
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

    private boolean shouldExcludeDir(String dirName) {
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

                        byte[] content = Files.readAllBytes(file);
                        String hash = HashUtil.sha256(content);
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

    @Scheduled(fixedRate = 30000)
    @Transactional
    public void periodicFilesystemScan() {
        Path root = Paths.get(storagePath);
        if (!Files.exists(root)) {
            return;
        }

        AtomicInteger added = new AtomicInteger(0);
        AtomicInteger modified = new AtomicInteger(0);
        AtomicInteger deleted = new AtomicInteger(0);

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

                        var existingRecord = fileRepository.findById(relativePath);
                        long diskMtime = attrs.lastModifiedTime().toMillis();

                        if (existingRecord.isEmpty()) {
                            if (tombstoneRepository.existsById(relativePath)) {
                                tombstoneRepository.deleteById(relativePath);
                                log.info("Removed stale tombstone for re-created file: {}", relativePath);
                            }

                            byte[] content = Files.readAllBytes(file);
                            String hash = HashUtil.sha256(content);
                            long size = attrs.size();
                            long seq = nextSeq();

                            FileRecord record = FileRecord.builder()
                                    .path(relativePath)
                                    .hash(hash)
                                    .mtime(diskMtime)
                                    .size(size)
                                    .seq(seq)
                                    .lastModifiedBy("filesystem")
                                    .build();
                            fileRepository.save(record);

                            SyncMessage.FileChanged changeMsg = SyncMessage.FileChanged.builder()
                                    .path(relativePath)
                                    .hash(hash)
                                    .mtime(diskMtime)
                                    .size(size)
                                    .seq(seq)
                                    .deviceId("filesystem")
                                    .build();
                            messagingTemplate.convertAndSend("/topic/sync", changeMsg);

                            added.incrementAndGet();
                            log.info("Filesystem scan: new file detected: {}", relativePath);

                        } else {
                            FileRecord existing = existingRecord.get();
                            if (Math.abs(existing.getMtime() - diskMtime) > 1000) {
                                byte[] content = Files.readAllBytes(file);
                                String hash = HashUtil.sha256(content);

                                if (!hash.equals(existing.getHash())) {
                                    long size = attrs.size();
                                    long seq = nextSeq();

                                    FileRecord record = FileRecord.builder()
                                            .path(relativePath)
                                            .hash(hash)
                                            .mtime(diskMtime)
                                            .size(size)
                                            .seq(seq)
                                            .lastModifiedBy("filesystem")
                                            .build();
                                    fileRepository.save(record);

                                    SyncMessage.FileChanged changeMsg = SyncMessage.FileChanged.builder()
                                            .path(relativePath)
                                            .hash(hash)
                                            .mtime(diskMtime)
                                            .size(size)
                                            .seq(seq)
                                            .deviceId("filesystem")
                                            .build();
                                    messagingTemplate.convertAndSend("/topic/sync", changeMsg);

                                    modified.incrementAndGet();
                                    log.info("Filesystem scan: file modified: {}", relativePath);
                                }
                            }
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

            List<FileRecord> dbFiles = fileRepository.findAll();
            for (FileRecord dbFile : dbFiles) {
                if (!diskFiles.contains(dbFile.getPath())) {
                    long seq = nextSeq();
                    fileRepository.deleteById(dbFile.getPath());

                    Tombstone tombstone = Tombstone.builder()
                            .path(dbFile.getPath())
                            .deletedAt(System.currentTimeMillis())
                            .deletedBy("filesystem")
                            .seq(seq)
                            .build();
                    tombstoneRepository.save(tombstone);

                    SyncMessage.FileDeleted deleteMsg = SyncMessage.FileDeleted.builder()
                            .path(dbFile.getPath())
                            .seq(seq)
                            .deviceId("filesystem")
                            .build();
                    messagingTemplate.convertAndSend("/topic/sync", deleteMsg);

                    deleted.incrementAndGet();
                    log.info("Filesystem scan: file deleted: {}", dbFile.getPath());
                }
            }

        } catch (IOException e) {
            log.error("Error during periodic filesystem scan", e);
        }

        if (added.get() > 0 || modified.get() > 0 || deleted.get() > 0) {
            log.info("Filesystem scan complete: {} added, {} modified, {} deleted", added.get(), modified.get(), deleted.get());
        }

        syncEmptyFolderMarkers();
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
