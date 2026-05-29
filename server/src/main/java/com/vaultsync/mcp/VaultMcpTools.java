package com.vaultsync.mcp;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.List;

/**
 * MCP Tools for full CRUD access to vault notes.
 * These tools are exposed via the MCP protocol to Claude.
 *
 * Supported operations:
 * - list_notes: List all markdown notes
 * - read_note: Read a specific note
 * - search_notes: Full-text search
 * - write_note: Create or update a note
 * - delete_note: Delete a note
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class VaultMcpTools {

    private final VaultNoteService noteService;

    /**
     * List all markdown notes in the vault.
     * Returns relative paths to all .md files.
     *
     * @return JSON-formatted list of note paths
     */
    @Tool(name = "list_notes", description = "List all markdown notes in the Obsidian vault. Returns relative paths to all .md files.")
    public ListNotesResult listNotes() {
        log.info("MCP tool called: list_notes");
        try {
            List<String> notes = noteService.listNotes();
            return new ListNotesResult(true, notes, notes.size(), null);
        } catch (IOException e) {
            log.error("Failed to list notes", e);
            return new ListNotesResult(false, List.of(), 0, "Failed to list notes: " + e.getMessage());
        }
    }

    /**
     * Read the content of a specific note.
     *
     * @param path Relative path to the note (e.g., "folder/note.md")
     * @return Note content or error message
     */
    @Tool(name = "read_note", description = "Read the content of a specific markdown note from the Obsidian vault. Provide the relative path to the note (e.g., 'folder/note.md').")
    public ReadNoteResult readNote(
            @ToolParam(description = "Relative path to the note file (e.g., 'folder/note.md')") String path) {
        log.info("MCP tool called: read_note(path={})", path);

        if (path == null || path.isBlank()) {
            return new ReadNoteResult(false, null, path, "Path is required");
        }

        try {
            String content = noteService.readNote(path);
            return new ReadNoteResult(true, content, path, null);
        } catch (SecurityException e) {
            log.warn("Security violation in read_note: {}", e.getMessage());
            return new ReadNoteResult(false, null, path, "Access denied: " + e.getMessage());
        } catch (IOException e) {
            log.warn("Failed to read note {}: {}", path, e.getMessage());
            return new ReadNoteResult(false, null, path, "Failed to read note: " + e.getMessage());
        } catch (IllegalArgumentException e) {
            return new ReadNoteResult(false, null, path, "Invalid path: " + e.getMessage());
        }
    }

    /**
     * Search for notes containing a query string.
     * Performs case-insensitive full-text search.
     *
     * @param query Search query
     * @return List of matching notes with snippets
     */
    @Tool(name = "search_notes", description = "Search for notes containing a query string. Performs case-insensitive full-text search across all markdown files in the vault.")
    public SearchNotesResult searchNotes(
            @ToolParam(description = "Search query string (case-insensitive)") String query) {
        log.info("MCP tool called: search_notes(query={})", query);

        if (query == null || query.isBlank()) {
            return new SearchNotesResult(false, List.of(), query, 0, "Query is required");
        }

        try {
            List<VaultNoteService.SearchResult> results = noteService.searchNotes(query);
            List<SearchResultItem> items = results.stream()
                    .map(r -> new SearchResultItem(r.path(), r.title(), r.snippet()))
                    .toList();
            return new SearchNotesResult(true, items, query, items.size(), null);
        } catch (IOException e) {
            log.error("Failed to search notes", e);
            return new SearchNotesResult(false, List.of(), query, 0, "Search failed: " + e.getMessage());
        }
    }

    /**
     * Write or create a note in the vault.
     *
     * @param path    Relative path to the note (e.g., "folder/note.md")
     * @param content Content to write
     * @return Result indicating success and whether file was created or updated
     */
    @Tool(name = "write_note", description = "Create or update a markdown note in the Obsidian vault. Provide the relative path and content. Creates parent directories if needed. Adds .md extension if missing.")
    public WriteNoteResult writeNote(
            @ToolParam(description = "Relative path to the note file (e.g., 'folder/note.md')") String path,
            @ToolParam(description = "Content to write to the note") String content) {
        log.info("MCP tool called: write_note(path={}, contentLength={})", path, content != null ? content.length() : 0);

        if (path == null || path.isBlank()) {
            return new WriteNoteResult(false, null, false, "Path is required");
        }
        if (content == null) {
            return new WriteNoteResult(false, path, false, "Content is required");
        }

        try {
            boolean created = noteService.writeNote(path, content);
            String normalizedPath = path.endsWith(".md") ? path : path + ".md";
            return new WriteNoteResult(true, normalizedPath, created, null);
        } catch (SecurityException e) {
            log.warn("Security violation in write_note: {}", e.getMessage());
            return new WriteNoteResult(false, path, false, "Access denied: " + e.getMessage());
        } catch (IOException e) {
            log.error("Failed to write note {}: {}", path, e.getMessage());
            return new WriteNoteResult(false, path, false, "Failed to write note: " + e.getMessage());
        } catch (IllegalArgumentException e) {
            return new WriteNoteResult(false, path, false, "Invalid path: " + e.getMessage());
        }
    }

    /**
     * Delete a note from the vault.
     *
     * @param path Relative path to the note (e.g., "folder/note.md")
     * @return Result indicating success
     */
    @Tool(name = "delete_note", description = "Delete a markdown note from the Obsidian vault. Provide the relative path to the note to delete.")
    public DeleteNoteResult deleteNote(
            @ToolParam(description = "Relative path to the note file to delete (e.g., 'folder/note.md')") String path) {
        log.info("MCP tool called: delete_note(path={})", path);

        if (path == null || path.isBlank()) {
            return new DeleteNoteResult(false, null, "Path is required");
        }

        try {
            boolean deleted = noteService.deleteNote(path);
            if (deleted) {
                return new DeleteNoteResult(true, path, null);
            } else {
                return new DeleteNoteResult(false, path, "Note not found: " + path);
            }
        } catch (SecurityException e) {
            log.warn("Security violation in delete_note: {}", e.getMessage());
            return new DeleteNoteResult(false, path, "Access denied: " + e.getMessage());
        } catch (IOException e) {
            log.error("Failed to delete note {}: {}", path, e.getMessage());
            return new DeleteNoteResult(false, path, "Failed to delete note: " + e.getMessage());
        } catch (IllegalArgumentException e) {
            return new DeleteNoteResult(false, path, "Invalid path: " + e.getMessage());
        }
    }

    // Result records for structured JSON responses

    public record ListNotesResult(boolean success, List<String> notes, int count, String error) {
    }

    public record ReadNoteResult(boolean success, String content, String path, String error) {
    }

    public record SearchNotesResult(boolean success, List<SearchResultItem> results, String query, int count, String error) {
    }

    public record SearchResultItem(String path, String title, String snippet) {
    }

    public record WriteNoteResult(boolean success, String path, boolean created, String error) {
    }

    public record DeleteNoteResult(boolean success, String path, String error) {
    }
}
