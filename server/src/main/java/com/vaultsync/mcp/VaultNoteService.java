package com.vaultsync.mcp;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

/**
 * Read-only service for accessing vault notes.
 * Used exclusively by MCP tools.
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
     * List all markdown notes in the vault.
     *
     * @return List of relative paths to all .md files
     */
    public List<String> listNotes() throws IOException {
        List<String> notes = new ArrayList<>();

        if (!Files.exists(storagePath)) {
            log.warn("Storage path does not exist: {}", storagePath);
            return notes;
        }

        try (Stream<Path> walk = Files.walk(storagePath)) {
            walk.filter(Files::isRegularFile)
                    .filter(p -> p.toString().endsWith(".md"))
                    .forEach(p -> {
                        String relativePath = storagePath.relativize(p).toString().replace("\\", "/");
                        notes.add(relativePath);
                    });
        }

        log.debug("Listed {} notes", notes.size());
        return notes;
    }

    /**
     * Read the content of a specific note.
     *
     * @param relativePath Relative path to the note (e.g., "folder/note.md")
     * @return Content of the note
     * @throws SecurityException     if path traversal is detected
     * @throws IOException           if file cannot be read
     * @throws IllegalArgumentException if path is invalid
     */
    public String readNote(String relativePath) throws IOException {
        Path resolvedPath = resolveSafePath(relativePath);

        if (!Files.exists(resolvedPath)) {
            throw new IOException("Note not found: " + relativePath);
        }

        if (!Files.isRegularFile(resolvedPath)) {
            throw new IOException("Path is not a file: " + relativePath);
        }

        String content = Files.readString(resolvedPath, StandardCharsets.UTF_8);
        log.debug("Read note: {} ({} chars)", relativePath, content.length());
        return content;
    }

    /**
     * Search for notes containing a query string.
     *
     * @param query Search query (case-insensitive)
     * @return List of search results with path, title, and snippet
     */
    public List<SearchResult> searchNotes(String query) throws IOException {
        List<SearchResult> results = new ArrayList<>();

        if (query == null || query.isBlank()) {
            return results;
        }

        String lowerQuery = query.toLowerCase();

        if (!Files.exists(storagePath)) {
            return results;
        }

        try (Stream<Path> walk = Files.walk(storagePath)) {
            walk.filter(Files::isRegularFile)
                    .filter(p -> p.toString().endsWith(".md"))
                    .forEach(p -> {
                        try {
                            String content = Files.readString(p, StandardCharsets.UTF_8);
                            String lowerContent = content.toLowerCase();

                            if (lowerContent.contains(lowerQuery)) {
                                String relativePath = storagePath.relativize(p).toString().replace("\\", "/");
                                String title = extractTitle(content, relativePath);
                                String snippet = extractSnippet(content, lowerQuery);
                                results.add(new SearchResult(relativePath, title, snippet));
                            }
                        } catch (IOException e) {
                            log.warn("Could not read file during search: {}", p, e);
                        }
                    });
        }

        log.debug("Search for '{}' returned {} results", query, results.size());
        return results;
    }

    /**
     * Resolve a relative path safely, preventing path traversal attacks.
     *
     * @param relativePath User-provided relative path
     * @return Safe resolved absolute path
     * @throws SecurityException if path traversal is detected
     */
    private Path resolveSafePath(String relativePath) {
        if (relativePath == null || relativePath.isBlank()) {
            throw new IllegalArgumentException("Path cannot be null or empty");
        }

        // Normalize separators
        String normalized = relativePath.replace("\\", "/");

        // Check for obvious traversal attempts before resolving
        if (normalized.contains("..") || normalized.startsWith("/") || normalized.contains(":")) {
            throw new SecurityException("Invalid path: path traversal detected in '" + relativePath + "'");
        }

        // Resolve and normalize
        Path resolved = storagePath.resolve(normalized).normalize();

        // Critical security check: resolved path MUST start with storage path
        if (!resolved.startsWith(storagePath)) {
            throw new SecurityException("Invalid path: attempted to access '" + relativePath + "' outside storage directory");
        }

        return resolved;
    }

    /**
     * Extract title from note content (first heading or filename).
     */
    private String extractTitle(String content, String path) {
        // Try to find first H1 heading
        String[] lines = content.split("\n", 10);
        for (String line : lines) {
            if (line.startsWith("# ")) {
                return line.substring(2).trim();
            }
        }

        // Fall back to filename without extension
        String filename = path;
        int lastSlash = path.lastIndexOf('/');
        if (lastSlash >= 0) {
            filename = path.substring(lastSlash + 1);
        }
        if (filename.endsWith(".md")) {
            filename = filename.substring(0, filename.length() - 3);
        }
        return filename;
    }

    /**
     * Extract a snippet around the first occurrence of the query.
     */
    private String extractSnippet(String content, String lowerQuery) {
        String lowerContent = content.toLowerCase();
        int idx = lowerContent.indexOf(lowerQuery);
        if (idx < 0) {
            return "";
        }

        int start = Math.max(0, idx - 50);
        int end = Math.min(content.length(), idx + lowerQuery.length() + 100);

        StringBuilder snippet = new StringBuilder();
        if (start > 0) {
            snippet.append("...");
        }
        snippet.append(content, start, end);
        if (end < content.length()) {
            snippet.append("...");
        }

        // Clean up newlines for readability
        return snippet.toString().replace("\n", " ").replace("\r", "");
    }

    /**
     * Search result record.
     */
    public record SearchResult(String path, String title, String snippet) {
    }
}
