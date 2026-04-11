package com.vaultsync.service;

import com.vaultsync.model.FileRecord;
import com.vaultsync.model.SyncMessage;
import com.vaultsync.model.Tombstone;
import com.vaultsync.repository.FileRepository;
import com.vaultsync.repository.TombstoneRepository;
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
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
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

    @jakarta.annotation.PostConstruct
    public void init() {
        // Initialize sequence counter from database
        long maxFileSeq = fileRepository.findMaxSeq();
        long maxTombstoneSeq = tombstoneRepository.findMaxSeq();
        sequenceCounter.set(Math.max(maxFileSeq, maxTombstoneSeq));
        log.info("Initialized sequence counter to {}", sequenceCounter.get());

        // Scan existing files if database is empty
        if (fileRepository.count() == 0) {
            scanExistingFiles();
        }
    }

    private void scanExistingFiles() {
        Path root = Paths.get(storagePath);
        if (!Files.exists(root)) {
            log.warn("Storage path does not exist: {}", storagePath);
            return;
        }

        log.info("Scanning existing files in {}", storagePath);
        int[] count = {0};

        try {
            Files.walkFileTree(root, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                    try {
                        String relativePath = root.relativize(file).toString().replace("\\", "/");

                        // Skip hidden files
                        if (relativePath.startsWith(".") || relativePath.contains("/.")) {
                            return FileVisitResult.CONTINUE;
                        }

                        // Compute hash
                        byte[] content = Files.readAllBytes(file);
                        String hash = computeHash(content);
                        long mtime = attrs.lastModifiedTime().toMillis();
                        long size = attrs.size();

                        // Save to database
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
                        count[0]++;

                        if (count[0] % 100 == 0) {
                            log.info("Scanned {} files...", count[0]);
                        }
                    } catch (Exception e) {
                        log.error("Error scanning file: {}", file, e);
                    }
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                    String name = dir.getFileName() != null ? dir.getFileName().toString() : "";
                    if (name.startsWith(".")) {
                        return FileVisitResult.SKIP_SUBTREE;
                    }
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException e) {
            log.error("Error scanning storage directory", e);
        }

        log.info("Scan complete: indexed {} files", count[0]);
    }

    private String computeHash(byte[] content) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hashBytes = digest.digest(content);
            return HexFormat.of().formatHex(hashBytes);
        } catch (Exception e) {
            throw new RuntimeException("SHA-256 not available", e);
        }
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

        // Remove from tombstones if exists
        tombstoneRepository.deleteById(path);

        // Update or create file record
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

        // Create broadcast message
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

        // Remove file record
        fileRepository.deleteById(path);

        // Create tombstone
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

    public void broadcastFileChange(SyncMessage.FileChanged message) {
        messagingTemplate.convertAndSend("/topic/sync", message);
    }

    public void broadcastFileDelete(SyncMessage.FileDeleted message) {
        messagingTemplate.convertAndSend("/topic/sync", message);
    }

    // Clean up old tombstones every hour
    @Scheduled(fixedRate = 3600000)
    @Transactional
    public void cleanupTombstones() {
        long cutoff = System.currentTimeMillis() - (tombstoneTtlDays * 24L * 60L * 60L * 1000L);
        int deleted = tombstoneRepository.deleteOlderThan(cutoff);
        if (deleted > 0) {
            log.info("Cleaned up {} old tombstones", deleted);
        }
    }

    // Periodic filesystem scan - detects files added/modified/deleted directly on disk
    @Scheduled(fixedRate = 30000) // Every 30 seconds
    @Transactional
    public void periodicFilesystemScan() {
        Path root = Paths.get(storagePath);
        if (!Files.exists(root)) {
            return;
        }

        int[] added = {0};
        int[] modified = {0};
        int[] deleted = {0};

        // Track files found on disk
        java.util.Set<String> diskFiles = new java.util.HashSet<>();

        try {
            Files.walkFileTree(root, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                    try {
                        String relativePath = root.relativize(file).toString().replace("\\", "/");

                        // Skip hidden files
                        if (relativePath.startsWith(".") || relativePath.contains("/.")) {
                            return FileVisitResult.CONTINUE;
                        }

                        diskFiles.add(relativePath);

                        // Check if file exists in database
                        var existingRecord = fileRepository.findById(relativePath);
                        long diskMtime = attrs.lastModifiedTime().toMillis();

                        if (existingRecord.isEmpty()) {
                            // New file on disk - add to database and broadcast
                            byte[] content = Files.readAllBytes(file);
                            String hash = computeHash(content);
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

                            // Broadcast to connected clients
                            SyncMessage.FileChanged changeMsg = SyncMessage.FileChanged.builder()
                                    .path(relativePath)
                                    .hash(hash)
                                    .mtime(diskMtime)
                                    .size(size)
                                    .seq(seq)
                                    .deviceId("filesystem")
                                    .build();
                            messagingTemplate.convertAndSend("/topic/sync", changeMsg);

                            added[0]++;
                            log.info("Filesystem scan: new file detected: {}", relativePath);

                        } else {
                            // File exists - check if modified (mtime changed)
                            FileRecord existing = existingRecord.get();
                            if (Math.abs(existing.getMtime() - diskMtime) > 1000) { // 1 second tolerance
                                // File modified on disk
                                byte[] content = Files.readAllBytes(file);
                                String hash = computeHash(content);

                                // Only update if hash actually changed
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

                                    // Broadcast to connected clients
                                    SyncMessage.FileChanged changeMsg = SyncMessage.FileChanged.builder()
                                            .path(relativePath)
                                            .hash(hash)
                                            .mtime(diskMtime)
                                            .size(size)
                                            .seq(seq)
                                            .deviceId("filesystem")
                                            .build();
                                    messagingTemplate.convertAndSend("/topic/sync", changeMsg);

                                    modified[0]++;
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
                    if (name.startsWith(".")) {
                        return FileVisitResult.SKIP_SUBTREE;
                    }
                    return FileVisitResult.CONTINUE;
                }
            });

            // Check for files in database that no longer exist on disk
            List<FileRecord> dbFiles = fileRepository.findAll();
            for (FileRecord dbFile : dbFiles) {
                if (!diskFiles.contains(dbFile.getPath())) {
                    // File deleted from disk - remove from DB and broadcast tombstone
                    long seq = nextSeq();
                    fileRepository.deleteById(dbFile.getPath());

                    Tombstone tombstone = Tombstone.builder()
                            .path(dbFile.getPath())
                            .deletedAt(System.currentTimeMillis())
                            .deletedBy("filesystem")
                            .seq(seq)
                            .build();
                    tombstoneRepository.save(tombstone);

                    // Broadcast deletion
                    SyncMessage.FileDeleted deleteMsg = SyncMessage.FileDeleted.builder()
                            .path(dbFile.getPath())
                            .seq(seq)
                            .deviceId("filesystem")
                            .build();
                    messagingTemplate.convertAndSend("/topic/sync", deleteMsg);

                    deleted[0]++;
                    log.info("Filesystem scan: file deleted: {}", dbFile.getPath());
                }
            }

        } catch (IOException e) {
            log.error("Error during periodic filesystem scan", e);
        }

        if (added[0] > 0 || modified[0] > 0 || deleted[0] > 0) {
            log.info("Filesystem scan complete: {} added, {} modified, {} deleted", added[0], modified[0], deleted[0]);
        }
    }
}
