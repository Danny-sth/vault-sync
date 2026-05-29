package com.vaultsync.mcp;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.List;

/**
 * MCP Tools for read-only access to vault notes.
 * These tools are exposed via the MCP protocol to Claude.
 *
 * STRICTLY READ-ONLY: No tools that modify, create, or delete files.
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

    // Result records for structured JSON responses

    public record ListNotesResult(boolean success, List<String> notes, int count, String error) {
    }

    public record ReadNoteResult(boolean success, String content, String path, String error) {
    }

    public record SearchNotesResult(boolean success, List<SearchResultItem> results, String query, int count, String error) {
    }

    public record SearchResultItem(String path, String title, String snippet) {
    }
}
