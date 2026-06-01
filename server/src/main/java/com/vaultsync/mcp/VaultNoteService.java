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
 * Service for accessing and managing vault notes.
 * Used exclusively by MCP tools.
 * Supports full CRUD operations: list, read, create, update, delete.
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
        return listNotes(null, false);
    }

    /**
     * List markdown notes in the vault with optional filtering and stats.
     *
     * @param prefix    Optional folder prefix to filter results (e.g., "archive/2024")
     * @param withStats If true, returns NoteInfo with size and modified time; if false, returns simple paths
     * @return List of note paths or NoteInfo objects
     */
    public List<NoteInfo> listNotesWithStats(String prefix, boolean withStats) throws IOException {
        List<NoteInfo> notes = new ArrayList<>();

        if (!Files.exists(storagePath)) {
            log.warn("Storage path does not exist: {}", storagePath);
            return notes;
        }

        Path prefixPath = null;
        if (prefix != null && !prefix.isBlank()) {
            prefixPath = resolveSafePath(prefix);
            if (!Files.exists(prefixPath) || !Files.isDirectory(prefixPath)) {
                log.warn("Prefix path does not exist or is not a directory: {}", prefix);
                return notes;
            }
        }

        final Path searchRoot = prefixPath != null ? prefixPath : storagePath;

        try (Stream<Path> walk = Files.walk(searchRoot)) {
            walk.filter(Files::isRegularFile)
                    .filter(p -> p.toString().endsWith(".md"))
                    .forEach(p -> {
                        try {
                            String relativePath = storagePath.relativize(p).toString().replace("\\", "/");
                            if (withStats) {
                                long size = Files.size(p);
                                long lastModified = Files.getLastModifiedTime(p).toMillis();
                                notes.add(new NoteInfo(relativePath, size, lastModified));
                            } else {
                                notes.add(new NoteInfo(relativePath, 0, 0));
                            }
                        } catch (IOException e) {
                            log.warn("Could not get stats for file: {}", p, e);
                        }
                    });
        }

        log.debug("Listed {} notes (prefix={}, withStats={})", notes.size(), prefix, withStats);
        return notes;
    }

    /**
     * List markdown notes in the vault (simple version without stats).
     *
     * @param prefix Optional folder prefix to filter results (e.g., "archive/2024")
     * @param withStats Ignored (for backward compatibility)
     * @return List of relative paths to .md files
     */
    private List<String> listNotes(String prefix, boolean withStats) throws IOException {
        return listNotesWithStats(prefix, false).stream()
                .map(NoteInfo::path)
                .toList();
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
        return searchNotes(query, null);
    }

    /**
     * Search for notes containing a query string, optionally limited to a specific folder.
     *
     * @param query  Search query (case-insensitive)
     * @param folder Optional folder to limit search (e.g., "archive/2024")
     * @return List of search results with path, title, and snippet
     */
    public List<SearchResult> searchNotes(String query, String folder) throws IOException {
        List<SearchResult> results = new ArrayList<>();

        if (query == null || query.isBlank()) {
            return results;
        }

        String lowerQuery = query.toLowerCase();

        if (!Files.exists(storagePath)) {
            return results;
        }

        Path searchRoot = storagePath;
        if (folder != null && !folder.isBlank()) {
            Path folderPath = resolveSafePath(folder);
            if (!Files.exists(folderPath) || !Files.isDirectory(folderPath)) {
                log.warn("Folder path does not exist or is not a directory: {}", folder);
                return results;
            }
            searchRoot = folderPath;
        }

        final Path finalSearchRoot = searchRoot;

        try (Stream<Path> walk = Files.walk(finalSearchRoot)) {
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

        log.debug("Search for '{}' in folder '{}' returned {} results", query, folder, results.size());
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

    /**
     * Write content to a note. Creates the file if it doesn't exist, overwrites if it does.
     * Also creates parent directories if needed.
     *
     * @param relativePath Relative path to the note (e.g., "folder/note.md")
     * @param content      Content to write
     * @return true if created new file, false if overwritten existing
     * @throws SecurityException        if path traversal is detected
     * @throws IOException              if file cannot be written
     * @throws IllegalArgumentException if path is invalid
     */
    public boolean writeNote(String relativePath, String content) throws IOException {
        // Ensure .md extension
        String normalizedPath = relativePath;
        if (!normalizedPath.endsWith(".md")) {
            normalizedPath += ".md";
        }

        Path resolvedPath = resolveSafePath(normalizedPath);
        boolean isNew = !Files.exists(resolvedPath);

        // Create parent directories if needed
        Path parent = resolvedPath.getParent();
        if (parent != null && !Files.exists(parent)) {
            Files.createDirectories(parent);
            log.debug("Created directories: {}", parent);
        }

        Files.writeString(resolvedPath, content, StandardCharsets.UTF_8);
        log.info("Wrote note: {} ({} chars, new={})", normalizedPath, content.length(), isNew);
        return isNew;
    }

    /**
     * Delete a note from the vault.
     *
     * @param relativePath Relative path to the note (e.g., "folder/note.md")
     * @return true if deleted, false if file didn't exist
     * @throws SecurityException        if path traversal is detected
     * @throws IOException              if file cannot be deleted
     * @throws IllegalArgumentException if path is invalid
     */
    public boolean deleteNote(String relativePath) throws IOException {
        Path resolvedPath = resolveSafePath(relativePath);

        if (!Files.exists(resolvedPath)) {
            log.warn("Cannot delete non-existent note: {}", relativePath);
            return false;
        }

        if (!Files.isRegularFile(resolvedPath)) {
            throw new IOException("Path is not a file: " + relativePath);
        }

        Files.delete(resolvedPath);
        log.info("Deleted note: {}", relativePath);
        return true;
    }

    /**
     * Delete a folder from the vault.
     *
     * @param relativePath Relative path to the folder (e.g., "archive/old")
     * @param recursive    If true, deletes folder and all contents; if false, only deletes empty folders
     * @return true if deleted, false if folder didn't exist
     * @throws SecurityException        if path traversal is detected
     * @throws IOException              if folder cannot be deleted (e.g., not empty when recursive=false)
     * @throws IllegalArgumentException if path is invalid
     */
    public boolean deleteFolder(String relativePath, boolean recursive) throws IOException {
        Path resolvedPath = resolveSafePath(relativePath);

        if (!Files.exists(resolvedPath)) {
            log.warn("Cannot delete non-existent folder: {}", relativePath);
            return false;
        }

        if (!Files.isDirectory(resolvedPath)) {
            throw new IOException("Path is not a directory: " + relativePath);
        }

        if (recursive) {
            // Delete folder and all contents recursively
            try (Stream<Path> walk = Files.walk(resolvedPath)) {
                walk.sorted((p1, p2) -> p2.compareTo(p1)) // Reverse order to delete files before directories
                        .forEach(p -> {
                            try {
                                Files.delete(p);
                            } catch (IOException e) {
                                throw new RuntimeException("Failed to delete " + p, e);
                            }
                        });
            } catch (RuntimeException e) {
                if (e.getCause() instanceof IOException) {
                    throw (IOException) e.getCause();
                }
                throw e;
            }
            log.info("Deleted folder recursively: {}", relativePath);
        } else {
            // Only delete if empty
            try {
                Files.delete(resolvedPath);
                log.info("Deleted empty folder: {}", relativePath);
            } catch (java.nio.file.DirectoryNotEmptyException e) {
                throw new IOException("Folder is not empty (use recursive=true to force): " + relativePath);
            }
        }

        return true;
    }

    /**
     * Move or rename a note.
     *
     * @param fromPath Relative path to source note (e.g., "old/note.md")
     * @param toPath   Relative path to destination (e.g., "new/note.md")
     * @return true if moved successfully
     * @throws SecurityException        if path traversal is detected in either path
     * @throws IOException              if source doesn't exist or destination already exists
     * @throws IllegalArgumentException if paths are invalid
     */
    public boolean moveNote(String fromPath, String toPath) throws IOException {
        Path resolvedFrom = resolveSafePath(fromPath);
        Path resolvedTo = resolveSafePath(toPath);

        if (!Files.exists(resolvedFrom)) {
            throw new IOException("Source note not found: " + fromPath);
        }

        if (!Files.isRegularFile(resolvedFrom)) {
            throw new IOException("Source path is not a file: " + fromPath);
        }

        if (Files.exists(resolvedTo)) {
            throw new IOException("Destination already exists: " + toPath);
        }

        // Create parent directories for destination if needed
        Path parent = resolvedTo.getParent();
        if (parent != null && !Files.exists(parent)) {
            Files.createDirectories(parent);
            log.debug("Created directories for move: {}", parent);
        }

        Files.move(resolvedFrom, resolvedTo);
        log.info("Moved note: {} -> {}", fromPath, toPath);
        return true;
    }

    /**
     * Append content to an existing note without overwriting.
     *
     * @param relativePath Relative path to the note (e.g., "folder/note.md")
     * @param content      Content to append
     * @return true if appended successfully
     * @throws SecurityException        if path traversal is detected
     * @throws IOException              if file doesn't exist or cannot be written
     * @throws IllegalArgumentException if path is invalid
     */
    public boolean appendNote(String relativePath, String content) throws IOException {
        // Ensure .md extension
        String normalizedPath = relativePath;
        if (!normalizedPath.endsWith(".md")) {
            normalizedPath += ".md";
        }

        Path resolvedPath = resolveSafePath(normalizedPath);

        if (!Files.exists(resolvedPath)) {
            throw new IOException("Note not found (use write_note to create): " + normalizedPath);
        }

        if (!Files.isRegularFile(resolvedPath)) {
            throw new IOException("Path is not a file: " + normalizedPath);
        }

        // Append content to file
        Files.writeString(resolvedPath, content, StandardCharsets.UTF_8,
                java.nio.file.StandardOpenOption.APPEND);
        log.info("Appended to note: {} ({} chars)", normalizedPath, content.length());
        return true;
    }

    /**
     * Edit a note by replacing old_string with new_string.
     * The old_string must be unique in the file.
     *
     * @param relativePath Relative path to the note (e.g., "folder/note.md")
     * @param oldString    String to find (must be unique in file)
     * @param newString    Replacement string
     * @return true if replaced successfully
     * @throws SecurityException        if path traversal is detected
     * @throws IOException              if file doesn't exist or cannot be written
     * @throws IllegalArgumentException if old_string is not found or not unique
     */
    public boolean editNote(String relativePath, String oldString, String newString) throws IOException {
        Path resolvedPath = resolveSafePath(relativePath);

        if (!Files.exists(resolvedPath)) {
            throw new IOException("Note not found: " + relativePath);
        }

        if (!Files.isRegularFile(resolvedPath)) {
            throw new IOException("Path is not a file: " + relativePath);
        }

        String content = Files.readString(resolvedPath, StandardCharsets.UTF_8);

        // Check if old_string exists
        int firstIndex = content.indexOf(oldString);
        if (firstIndex < 0) {
            throw new IllegalArgumentException("String not found in note: '" + oldString + "'");
        }

        // Check if old_string is unique
        int lastIndex = content.lastIndexOf(oldString);
        if (firstIndex != lastIndex) {
            throw new IllegalArgumentException("String is not unique in note (found multiple occurrences): '" + oldString + "'");
        }

        // Perform replacement
        String newContent = content.replace(oldString, newString);
        Files.writeString(resolvedPath, newContent, StandardCharsets.UTF_8);
        log.info("Edited note: {} (replaced '{}' with '{}')", relativePath,
                oldString.substring(0, Math.min(50, oldString.length())),
                newString.substring(0, Math.min(50, newString.length())));
        return true;
    }

    /**
     * Create a folder in the vault.
     *
     * @param relativePath Relative path to the folder (e.g., "archive/2024")
     * @return true if created, false if already exists
     * @throws SecurityException        if path traversal is detected
     * @throws IOException              if folder cannot be created
     * @throws IllegalArgumentException if path is invalid
     */
    public boolean createFolder(String relativePath) throws IOException {
        Path resolvedPath = resolveSafePath(relativePath);

        if (Files.exists(resolvedPath)) {
            if (Files.isDirectory(resolvedPath)) {
                log.debug("Folder already exists: {}", relativePath);
                return false;
            } else {
                throw new IOException("Path exists but is not a directory: " + relativePath);
            }
        }

        Files.createDirectories(resolvedPath);
        log.info("Created folder: {}", relativePath);
        return true;
    }

    /**
     * Get metadata for a note or folder.
     *
     * @param relativePath Relative path to the note or folder
     * @return Metadata record with path info
     * @throws SecurityException        if path traversal is detected
     * @throws IOException              if path doesn't exist
     * @throws IllegalArgumentException if path is invalid
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

    /**
     * Move or rename a folder.
     *
     * @param fromPath Relative path to source folder (e.g., "old/archive")
     * @param toPath   Relative path to destination (e.g., "new/archive")
     * @return true if moved successfully
     * @throws SecurityException        if path traversal is detected in either path
     * @throws IOException              if source doesn't exist or destination already exists
     * @throws IllegalArgumentException if paths are invalid
     */
    public boolean moveFolder(String fromPath, String toPath) throws IOException {
        Path resolvedFrom = resolveSafePath(fromPath);
        Path resolvedTo = resolveSafePath(toPath);

        if (!Files.exists(resolvedFrom)) {
            throw new IOException("Source folder not found: " + fromPath);
        }

        if (!Files.isDirectory(resolvedFrom)) {
            throw new IOException("Source path is not a directory: " + fromPath);
        }

        if (Files.exists(resolvedTo)) {
            throw new IOException("Destination already exists: " + toPath);
        }

        // Create parent directories for destination if needed
        Path parent = resolvedTo.getParent();
        if (parent != null && !Files.exists(parent)) {
            Files.createDirectories(parent);
            log.debug("Created directories for move: {}", parent);
        }

        Files.move(resolvedFrom, resolvedTo);
        log.info("Moved folder: {} -> {}", fromPath, toPath);
        return true;
    }

    /**
     * Metadata record for files and folders.
     */
    public record Metadata(String path, boolean isDirectory, long size, long lastModified) {
    }

    /**
     * Note information record with optional stats.
     */
    public record NoteInfo(String path, long size, long lastModified) {
    }
}
