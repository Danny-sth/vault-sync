package com.vaultsync.mcp;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * Metadata access for MCP tools.
 *
 * Historically this was a full plaintext-note CRUD (list/read/write/search/move/…), but the
 * vault is now end-to-end encrypted and the server is zero-knowledge: it cannot read note
 * content or real paths, so every content-touching method was dead code that would have
 * returned ciphertext garbage. Only {@link #getMetadata} survives — it reports size/mtime/type
 * for a (client-encrypted) path without decrypting anything. Blob CRUD lives in
 * {@link VaultBlobService}.
 */
@Service
@Slf4j
public class VaultNoteService {

    private final Path storagePath;

    public VaultNoteService(@Value("${vault-sync.storage-path}") String storagePathStr) {
        if (storagePathStr == null || storagePathStr.isBlank()) {
            throw new IllegalStateException("VAULT_SYNC_STORAGE is not configured. MCP server cannot start without storage path.");
        }
        this.storagePath = Paths.get(storagePathStr).toAbsolutePath().normalize();
        log.info("VaultNoteService initialized with storage path: {}", this.storagePath);
    }

    /**
     * Get metadata for a vault entry (file or folder).
     *
     * @param relativePath relative (encrypted) vault path
     * @return metadata record with path info
     * @throws SecurityException        if path traversal is detected
     * @throws IOException              if the path doesn't exist
     * @throws IllegalArgumentException if the path is invalid
     */
    public Metadata getMetadata(String relativePath) throws IOException {
        Path resolvedPath = resolveSafePath(relativePath);

        if (!Files.exists(resolvedPath)) {
            throw new IOException("Path not found: " + relativePath);
        }

        boolean isDirectory = Files.isDirectory(resolvedPath);
        long size = isDirectory ? 0 : Files.size(resolvedPath);
        long lastModified = Files.getLastModifiedTime(resolvedPath).toMillis();

        log.debug("Got metadata: {} (size={}, isDir={})", relativePath, size, isDirectory);
        return new Metadata(relativePath, isDirectory, size, lastModified);
    }

    private Path resolveSafePath(String relativePath) {
        if (relativePath == null || relativePath.isBlank()) {
            throw new IllegalArgumentException("Path cannot be null or empty");
        }

        String normalized = relativePath.replace("\\", "/");

        if (normalized.contains("..") || normalized.startsWith("/") || normalized.contains(":")) {
            throw new SecurityException("Invalid path: path traversal detected in '" + relativePath + "'");
        }

        Path resolved = storagePath.resolve(normalized).normalize();

        if (!resolved.startsWith(storagePath)) {
            throw new SecurityException("Invalid path: attempted to access '" + relativePath + "' outside storage directory");
        }

        return resolved;
    }

    /**
     * Metadata record for files and folders.
     */
    public record Metadata(String path, boolean isDirectory, long size, long lastModified) {
    }
}
