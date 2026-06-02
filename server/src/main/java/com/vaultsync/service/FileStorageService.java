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
import org.springframework.web.multipart.MultipartFile;

import com.vaultsync.util.HashUtil;

import java.io.IOException;
import java.io.InputStream;
import java.net.MalformedURLException;
import java.nio.file.*;

@Service
@RequiredArgsConstructor
@Slf4j
public class FileStorageService {

    private final FileRepository fileRepository;

    @Value("${vault-sync.storage-path}")
    private String storagePath;

    @Transactional
    public FileRecord store(String path, MultipartFile file, String expectedHash, String deviceId, long seq) throws IOException {
        Path targetPath = getFullPath(path);

        Files.createDirectories(targetPath.getParent());

        try (InputStream is = file.getInputStream()) {
            Files.copy(is, targetPath, StandardCopyOption.REPLACE_EXISTING);
        }

        String actualHash = HashUtil.sha256(targetPath);
        if (expectedHash != null && !expectedHash.equals(actualHash)) {
            log.warn("Hash mismatch for {}: expected={}, actual={}", path, expectedHash, actualHash);
        }

        long size = Files.size(targetPath);
        long mtime = Files.getLastModifiedTime(targetPath).toMillis();

        FileRecord record = FileRecord.builder()
                .path(path)
                .hash(actualHash)
                .mtime(mtime)
                .size(size)
                .seq(seq)
                .lastModifiedBy(deviceId)
                .build();

        return fileRepository.save(record);
    }

    @Transactional
    public FileRecord storeBytes(String path, byte[] content, String expectedHash, String deviceId, long seq, long mtime) throws IOException {
        Path targetPath = getFullPath(path);

        Files.createDirectories(targetPath.getParent());

        Files.write(targetPath, content, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);

        String actualHash = HashUtil.sha256(content);
        if (expectedHash != null && !expectedHash.isEmpty() && !expectedHash.equals(actualHash)) {
            log.warn("Hash mismatch for {}: expected={}, actual={}", path, expectedHash, actualHash);
        }

        long size = content.length;
        long actualMtime = mtime > 0 ? mtime : System.currentTimeMillis();

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
        if (normalized.contains("..")) {
            throw new IllegalArgumentException("Invalid path: " + relativePath);
        }
        return Paths.get(storagePath).resolve(normalized);
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
}
