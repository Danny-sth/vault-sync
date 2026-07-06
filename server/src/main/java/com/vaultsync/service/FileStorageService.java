package com.vaultsync.service;

import com.vaultsync.model.FileRecord;
import com.vaultsync.repository.FileRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.Resource;
import org.springframework.core.io.UrlResource;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.vaultsync.util.HashUtil;

import java.io.IOException;
import java.net.MalformedURLException;
import java.nio.file.*;

@Service
@RequiredArgsConstructor
@Slf4j
public class FileStorageService {

    private final FileRepository fileRepository;

    @Value("${vault-sync.storage-path}")
    private String storagePath;

    /** Directory (inside the vault root, excluded from sync) holding pre-overwrite backups. */
    public static final String VERSIONS_DIR = ".vault-sync-versions";

    /** Directory holding in-progress chunked uploads (see FileController.uploadChunk). */
    public static final String UPLOADS_DIR = ".vault-sync-uploads";

    /** How long version backups are kept before the scheduled cleanup removes them. */
    @Value("${vault-sync.versions-ttl-days:30}")
    private int versionsTtlDays;

    @Transactional
    public FileRecord storeBytes(String path, byte[] content, String expectedHash, String deviceId, long seq, long mtime) throws IOException {
        Path targetPath = getFullPath(path);

        Files.createDirectories(targetPath.getParent());

        backupExisting(targetPath, path);

        Files.write(targetPath, content, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);

        String actualHash = HashUtil.sha256(content);
        if (expectedHash != null && !expectedHash.isEmpty() && !expectedHash.equals(actualHash)) {
            log.warn("Hash mismatch for {}: expected={}, actual={}", path, expectedHash, actualHash);
        }

        long size = content.length;
        long actualMtime = alignDiskMtime(targetPath, mtime);

        FileRecord record = FileRecord.builder()
                .path(path)
                .hash(actualHash)
                .mtime(actualMtime)
                .size(size)
                .seq(seq)
                .lastModifiedBy(deviceId)
                .build();

        return fileRepository.save(record);
    }

    /**
     * Make the on-disk mtime match the client-reported one recorded in the DB. Without
     * this the watcher/reconciler sees a &gt;1s mtime gap on every uploaded file, re-hashes
     * it, and quietly rewrites the record's mtime — churning metadata that devices
     * already received. Falls back to "now" when the client sent no mtime.
     */
    private long alignDiskMtime(Path targetPath, long clientMtime) {
        long mtime = clientMtime > 0 ? clientMtime : System.currentTimeMillis();
        try {
            Files.setLastModifiedTime(targetPath, java.nio.file.attribute.FileTime.fromMillis(mtime));
        } catch (IOException e) {
            log.debug("Could not set mtime for {}: {}", targetPath, e.getMessage());
        }
        return mtime;
    }

    /**
     * Commit an already-on-disk temp file (an assembled chunked upload) as the new content
     * of {@code path}. Never buffers the content: the hash is computed by streaming and the
     * file is MOVED into place (atomic on the same filesystem, with a copy fallback), so a
     * multi-hundred-MB attachment costs O(8KB) heap instead of O(size). The temp file is
     * consumed by this call — on success it no longer exists.
     */
    @Transactional
    public FileRecord storeFromTempFile(String path, Path tempFile, String expectedHash, String deviceId, long seq, long mtime) throws IOException {
        Path targetPath = getFullPath(path);

        Files.createDirectories(targetPath.getParent());

        backupExisting(targetPath, path);

        String actualHash = HashUtil.sha256(tempFile);
        if (expectedHash != null && !expectedHash.isEmpty() && !expectedHash.equals(actualHash)) {
            log.warn("Hash mismatch for {}: expected={}, actual={}", path, expectedHash, actualHash);
        }
        long size = Files.size(tempFile);

        try {
            Files.move(tempFile, targetPath, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException e) {
            // Different filesystem (uploads dir mounted elsewhere) — plain move still avoids buffering.
            Files.move(tempFile, targetPath, StandardCopyOption.REPLACE_EXISTING);
        }

        long actualMtime = alignDiskMtime(targetPath, mtime);

        FileRecord record = FileRecord.builder()
                .path(path)
                .hash(actualHash)
                .mtime(actualMtime)
                .size(size)
                .seq(seq)
                .lastModifiedBy(deviceId)
                .build();

        return fileRepository.save(record);
    }

    /**
     * Read the raw on-disk bytes for a path. For an encrypted vault these bytes are the
     * opaque ciphertext blob — the server never decrypts. Used by the MCP blob tools so a
     * key-holding client can pull and decrypt locally.
     */
    public byte[] loadBytes(String path) throws IOException {
        Path filePath = getFullPath(path);
        if (!Files.exists(filePath)) {
            throw new NoSuchFileException(path);
        }
        if (!Files.isRegularFile(filePath)) {
            throw new IOException("Path is not a file: " + path);
        }
        return Files.readAllBytes(filePath);
    }

    public Resource load(String path) throws IOException {
        Path filePath = getFullPath(path);
        if (!Files.exists(filePath)) {
            throw new NoSuchFileException(path);
        }

        try {
            Resource resource = new UrlResource(filePath.toUri());
            if (resource.exists() && resource.isReadable()) {
                return resource;
            } else {
                throw new IOException("Could not read file: " + path);
            }
        } catch (MalformedURLException e) {
            throw new IOException("Could not read file: " + path, e);
        }
    }

    public void delete(String path) throws IOException {
        Path filePath = getFullPath(path);
        Files.deleteIfExists(filePath);
        fileRepository.deleteById(path);

        cleanupEmptyParentDirectories(filePath.getParent());
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

    public FileRecord getFileInfo(String path) {
        return fileRepository.findById(path).orElse(null);
    }

    private Path getFullPath(String relativePath) {
        String normalized = relativePath.replace("\\", "/");
        // An absolute path would WIN in resolve() (dropping the storage root entirely),
        // so reject it alongside traversal; then double-check the normalized result is
        // still inside the root — defence in depth against any encoding trick.
        if (normalized.contains("..") || normalized.startsWith("/") || normalized.contains(":")) {
            throw new IllegalArgumentException("Invalid path: " + relativePath);
        }
        Path root = Paths.get(storagePath).toAbsolutePath().normalize();
        Path resolved = root.resolve(normalized).normalize();
        if (!resolved.startsWith(root)) {
            throw new IllegalArgumentException("Invalid path: " + relativePath);
        }
        return resolved;
    }

    public boolean exists(String path) {
        return Files.exists(getFullPath(path));
    }

    public long getSize(String path) throws IOException {
        return Files.size(getFullPath(path));
    }

    public long getMtime(String path) throws IOException {
        return Files.getLastModifiedTime(getFullPath(path)).toMillis();
    }

    /**
     * Copy the current on-disk file to {@code .vault-sync-versions/<path>/<epochMillis>.bak}
     * before it is overwritten, so a clobber (e.g. a stale device uploading an empty
     * note) is always recoverable. Skipped when the target is missing or empty, or
     * when the new content is byte-identical to the existing file.
     */
    private void backupExisting(Path targetPath, String relativePath) {
        try {
            if (relativePath.startsWith(VERSIONS_DIR + "/") || relativePath.equals(VERSIONS_DIR)) {
                return;
            }
            if (!Files.exists(targetPath) || Files.size(targetPath) == 0) {
                return;
            }
            Path dest = Paths.get(storagePath, VERSIONS_DIR)
                    .resolve(relativePath)
                    .resolve(System.currentTimeMillis() + ".bak");
            Files.createDirectories(dest.getParent());
            Files.copy(targetPath, dest, StandardCopyOption.REPLACE_EXISTING);
            log.debug("Versioned {} -> {}", relativePath, dest);
        } catch (IOException e) {
            log.warn("Could not version {}: {}", relativePath, e.getMessage());
        }
    }

    /** Purge orphaned chunked-upload temp files (interrupted uploads) older than 1h. Hourly. */
    @org.springframework.scheduling.annotation.Scheduled(fixedRate = 3600000)
    public void cleanupOrphanUploads() {
        Path uploadsRoot = Paths.get(storagePath, UPLOADS_DIR);
        if (!Files.exists(uploadsRoot)) {
            return;
        }
        long cutoff = System.currentTimeMillis() - 3600000L;
        try (var walk = Files.walk(uploadsRoot)) {
            walk.filter(Files::isRegularFile)
                .filter(p -> {
                    try {
                        return Files.getLastModifiedTime(p).toMillis() < cutoff;
                    } catch (IOException e) {
                        return false;
                    }
                })
                .forEach(p -> {
                    try {
                        Files.delete(p);
                        log.debug("Deleted orphan chunked-upload temp: {}", p);
                    } catch (IOException e) {
                        log.debug("Could not delete orphan upload {}: {}", p, e.getMessage());
                    }
                });
        } catch (IOException e) {
            log.warn("Orphan upload cleanup failed: {}", e.getMessage());
        }
    }

    /** Purge version backups older than {@code versions-ttl-days}. Runs hourly. */
    @org.springframework.scheduling.annotation.Scheduled(fixedRate = 3600000)
    public void cleanupVersions() {
        Path versionsRoot = Paths.get(storagePath, VERSIONS_DIR);
        if (!Files.exists(versionsRoot)) {
            return;
        }
        long cutoff = System.currentTimeMillis() - (versionsTtlDays * 24L * 60L * 60L * 1000L);
        try (var walk = Files.walk(versionsRoot)) {
            walk.filter(Files::isRegularFile)
                .filter(p -> {
                    try {
                        return Files.getLastModifiedTime(p).toMillis() < cutoff;
                    } catch (IOException e) {
                        return false;
                    }
                })
                .forEach(p -> {
                    try {
                        Files.delete(p);
                    } catch (IOException e) {
                        log.debug("Could not delete old version {}: {}", p, e.getMessage());
                    }
                });
        } catch (IOException e) {
            log.warn("Version cleanup failed: {}", e.getMessage());
        }
    }
}
