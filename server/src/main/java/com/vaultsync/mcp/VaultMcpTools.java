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
    private final CommandExecutionService commandService;

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
            return new ListNotesResult(true, notes, notes.size(), null, null);
        } catch (IOException e) {
            log.error("Failed to list notes", e);
            return new ListNotesResult(false, List.of(), 0, null, "Failed to list notes: " + e.getMessage());
        }
    }

    /**
     * List markdown notes with optional filtering and stats.
     *
     * @param prefix    Optional folder prefix to filter results (e.g., "archive/2024")
     * @param withStats If true, includes file size and last modified time
     * @return JSON-formatted list of notes with optional stats
     */
    @Tool(name = "list_notes_extended", description = "List markdown notes with optional folder filtering and file statistics (size, last modified time).")
    public ListNotesResult listNotesExtended(
            @ToolParam(description = "Optional folder prefix to filter results (e.g., 'archive/2024')") String prefix,
            @ToolParam(description = "If true, includes file size and last modified time") boolean withStats) {
        log.info("MCP tool called: list_notes_extended(prefix={}, withStats={})", prefix, withStats);
        try {
            if (withStats) {
                List<VaultNoteService.NoteInfo> noteInfos = noteService.listNotesWithStats(prefix, true);
                List<NoteInfoItem> items = noteInfos.stream()
                        .map(n -> new NoteInfoItem(n.path(), n.size(), n.lastModified()))
                        .toList();
                return new ListNotesResult(true, null, items.size(), items, null);
            } else {
                List<VaultNoteService.NoteInfo> noteInfos = noteService.listNotesWithStats(prefix, false);
                List<String> paths = noteInfos.stream().map(VaultNoteService.NoteInfo::path).toList();
                return new ListNotesResult(true, paths, paths.size(), null, null);
            }
        } catch (SecurityException e) {
            log.warn("Security violation in list_notes_extended: {}", e.getMessage());
            return new ListNotesResult(false, List.of(), 0, null, "Access denied: " + e.getMessage());
        } catch (IOException e) {
            log.error("Failed to list notes", e);
            return new ListNotesResult(false, List.of(), 0, null, "Failed to list notes: " + e.getMessage());
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
            return new SearchNotesResult(false, List.of(), query, null, 0, "Query is required");
        }

        try {
            List<VaultNoteService.SearchResult> results = noteService.searchNotes(query);
            List<SearchResultItem> items = results.stream()
                    .map(r -> new SearchResultItem(r.path(), r.title(), r.snippet()))
                    .toList();
            return new SearchNotesResult(true, items, query, null, items.size(), null);
        } catch (IOException e) {
            log.error("Failed to search notes", e);
            return new SearchNotesResult(false, List.of(), query, null, 0, "Search failed: " + e.getMessage());
        }
    }

    /**
     * Search for notes in a specific folder.
     *
     * @param query  Search query
     * @param folder Optional folder to limit search (e.g., "archive/2024")
     * @return List of matching notes with snippets
     */
    @Tool(name = "search_notes_in_folder", description = "Search for notes containing a query string within a specific folder. Performs case-insensitive full-text search.")
    public SearchNotesResult searchNotesInFolder(
            @ToolParam(description = "Search query string (case-insensitive)") String query,
            @ToolParam(description = "Folder to limit search (e.g., 'archive/2024')") String folder) {
        log.info("MCP tool called: search_notes_in_folder(query={}, folder={})", query, folder);

        if (query == null || query.isBlank()) {
            return new SearchNotesResult(false, List.of(), query, folder, 0, "Query is required");
        }

        try {
            List<VaultNoteService.SearchResult> results = noteService.searchNotes(query, folder);
            List<SearchResultItem> items = results.stream()
                    .map(r -> new SearchResultItem(r.path(), r.title(), r.snippet()))
                    .toList();
            return new SearchNotesResult(true, items, query, folder, items.size(), null);
        } catch (SecurityException e) {
            log.warn("Security violation in search_notes_in_folder: {}", e.getMessage());
            return new SearchNotesResult(false, List.of(), query, folder, 0, "Access denied: " + e.getMessage());
        } catch (IOException e) {
            log.error("Failed to search notes", e);
            return new SearchNotesResult(false, List.of(), query, folder, 0, "Search failed: " + e.getMessage());
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

    /**
     * Delete a folder from the vault.
     *
     * @param path      Relative path to the folder (e.g., "archive/old")
     * @param recursive If true, deletes folder and all contents
     * @return Result indicating success
     */
    @Tool(name = "delete_folder", description = "Delete a folder from the Obsidian vault. Can delete recursively (folder + contents) or only empty folders.")
    public DeleteFolderResult deleteFolder(
            @ToolParam(description = "Relative path to the folder (e.g., 'archive/old')") String path,
            @ToolParam(description = "If true, deletes folder and all contents; if false, only deletes empty folders") boolean recursive) {
        log.info("MCP tool called: delete_folder(path={}, recursive={})", path, recursive);

        if (path == null || path.isBlank()) {
            return new DeleteFolderResult(false, null, "Path is required");
        }

        try {
            boolean deleted = noteService.deleteFolder(path, recursive);
            if (deleted) {
                return new DeleteFolderResult(true, path, null);
            } else {
                return new DeleteFolderResult(false, path, "Folder not found: " + path);
            }
        } catch (SecurityException e) {
            log.warn("Security violation in delete_folder: {}", e.getMessage());
            return new DeleteFolderResult(false, path, "Access denied: " + e.getMessage());
        } catch (IOException e) {
            log.error("Failed to delete folder {}: {}", path, e.getMessage());
            return new DeleteFolderResult(false, path, "Failed to delete folder: " + e.getMessage());
        } catch (IllegalArgumentException e) {
            return new DeleteFolderResult(false, path, "Invalid path: " + e.getMessage());
        }
    }

    /**
     * Move or rename a note.
     *
     * @param fromPath Source note path
     * @param toPath   Destination path
     * @return Result indicating success
     */
    @Tool(name = "move_note", description = "Move or rename a markdown note in the Obsidian vault. Creates parent directories if needed.")
    public MoveNoteResult moveNote(
            @ToolParam(description = "Relative path to source note (e.g., 'old/note.md')") String fromPath,
            @ToolParam(description = "Relative path to destination (e.g., 'new/note.md')") String toPath) {
        log.info("MCP tool called: move_note(from={}, to={})", fromPath, toPath);

        if (fromPath == null || fromPath.isBlank()) {
            return new MoveNoteResult(false, null, null, "Source path is required");
        }
        if (toPath == null || toPath.isBlank()) {
            return new MoveNoteResult(false, fromPath, null, "Destination path is required");
        }

        try {
            noteService.moveNote(fromPath, toPath);
            return new MoveNoteResult(true, fromPath, toPath, null);
        } catch (SecurityException e) {
            log.warn("Security violation in move_note: {}", e.getMessage());
            return new MoveNoteResult(false, fromPath, toPath, "Access denied: " + e.getMessage());
        } catch (IOException e) {
            log.error("Failed to move note {} -> {}: {}", fromPath, toPath, e.getMessage());
            return new MoveNoteResult(false, fromPath, toPath, "Failed to move note: " + e.getMessage());
        } catch (IllegalArgumentException e) {
            return new MoveNoteResult(false, fromPath, toPath, "Invalid path: " + e.getMessage());
        }
    }

    /**
     * Append content to an existing note.
     *
     * @param path    Relative path to the note
     * @param content Content to append
     * @return Result indicating success
     */
    @Tool(name = "append_note", description = "Append content to an existing markdown note without overwriting. The note must already exist.")
    public AppendNoteResult appendNote(
            @ToolParam(description = "Relative path to the note file (e.g., 'folder/note.md')") String path,
            @ToolParam(description = "Content to append to the note") String content) {
        log.info("MCP tool called: append_note(path={}, contentLength={})", path, content != null ? content.length() : 0);

        if (path == null || path.isBlank()) {
            return new AppendNoteResult(false, null, "Path is required");
        }
        if (content == null) {
            return new AppendNoteResult(false, path, "Content is required");
        }

        try {
            noteService.appendNote(path, content);
            return new AppendNoteResult(true, path, null);
        } catch (SecurityException e) {
            log.warn("Security violation in append_note: {}", e.getMessage());
            return new AppendNoteResult(false, path, "Access denied: " + e.getMessage());
        } catch (IOException e) {
            log.error("Failed to append to note {}: {}", path, e.getMessage());
            return new AppendNoteResult(false, path, "Failed to append: " + e.getMessage());
        } catch (IllegalArgumentException e) {
            return new AppendNoteResult(false, path, "Invalid path: " + e.getMessage());
        }
    }

    /**
     * Edit a note by replacing a unique string.
     *
     * @param path      Relative path to the note
     * @param oldString String to find (must be unique)
     * @param newString Replacement string
     * @return Result indicating success
     */
    @Tool(name = "edit_note", description = "Edit a note by replacing old_string with new_string. The old_string must be unique in the file (only one occurrence allowed).")
    public EditNoteResult editNote(
            @ToolParam(description = "Relative path to the note file (e.g., 'folder/note.md')") String path,
            @ToolParam(description = "String to find in the note (must be unique)") String oldString,
            @ToolParam(description = "Replacement string") String newString) {
        log.info("MCP tool called: edit_note(path={}, oldStringLength={}, newStringLength={})",
                path, oldString != null ? oldString.length() : 0, newString != null ? newString.length() : 0);

        if (path == null || path.isBlank()) {
            return new EditNoteResult(false, null, "Path is required");
        }
        if (oldString == null) {
            return new EditNoteResult(false, path, "old_string is required");
        }
        if (newString == null) {
            return new EditNoteResult(false, path, "new_string is required");
        }

        try {
            noteService.editNote(path, oldString, newString);
            return new EditNoteResult(true, path, null);
        } catch (SecurityException e) {
            log.warn("Security violation in edit_note: {}", e.getMessage());
            return new EditNoteResult(false, path, "Access denied: " + e.getMessage());
        } catch (IOException e) {
            log.error("Failed to edit note {}: {}", path, e.getMessage());
            return new EditNoteResult(false, path, "Failed to edit: " + e.getMessage());
        } catch (IllegalArgumentException e) {
            return new EditNoteResult(false, path, "Edit failed: " + e.getMessage());
        }
    }

    /**
     * Create a folder in the vault.
     *
     * @param path Relative path to the folder
     * @return Result indicating success
     */
    @Tool(name = "create_folder", description = "Create a folder in the Obsidian vault. Creates parent directories if needed. Returns false if folder already exists.")
    public CreateFolderResult createFolder(
            @ToolParam(description = "Relative path to the folder (e.g., 'archive/2024')") String path) {
        log.info("MCP tool called: create_folder(path={})", path);

        if (path == null || path.isBlank()) {
            return new CreateFolderResult(false, null, false, "Path is required");
        }

        try {
            boolean created = noteService.createFolder(path);
            return new CreateFolderResult(true, path, created, null);
        } catch (SecurityException e) {
            log.warn("Security violation in create_folder: {}", e.getMessage());
            return new CreateFolderResult(false, path, false, "Access denied: " + e.getMessage());
        } catch (IOException e) {
            log.error("Failed to create folder {}: {}", path, e.getMessage());
            return new CreateFolderResult(false, path, false, "Failed to create folder: " + e.getMessage());
        } catch (IllegalArgumentException e) {
            return new CreateFolderResult(false, path, false, "Invalid path: " + e.getMessage());
        }
    }

    /**
     * Get metadata for a note or folder.
     *
     * @param path Relative path to the note or folder
     * @return Metadata with path, type, size, and last modified time
     */
    @Tool(name = "get_metadata", description = "Get metadata for a note or folder (size, last modified time, type).")
    public GetMetadataResult getMetadata(
            @ToolParam(description = "Relative path to the note or folder") String path) {
        log.info("MCP tool called: get_metadata(path={})", path);

        if (path == null || path.isBlank()) {
            return new GetMetadataResult(false, null, "Path is required");
        }

        try {
            VaultNoteService.Metadata metadata = noteService.getMetadata(path);
            MetadataInfo info = new MetadataInfo(
                    metadata.path(),
                    metadata.isDirectory(),
                    metadata.size(),
                    metadata.lastModified()
            );
            return new GetMetadataResult(true, info, null);
        } catch (SecurityException e) {
            log.warn("Security violation in get_metadata: {}", e.getMessage());
            return new GetMetadataResult(false, null, "Access denied: " + e.getMessage());
        } catch (IOException e) {
            log.error("Failed to get metadata for {}: {}", path, e.getMessage());
            return new GetMetadataResult(false, null, "Failed to get metadata: " + e.getMessage());
        } catch (IllegalArgumentException e) {
            return new GetMetadataResult(false, null, "Invalid path: " + e.getMessage());
        }
    }

    /**
     * Move or rename a folder.
     *
     * @param fromPath Source folder path
     * @param toPath   Destination path
     * @return Result indicating success
     */
    @Tool(name = "move_folder", description = "Move or rename a folder in the Obsidian vault. Creates parent directories if needed.")
    public MoveFolderResult moveFolder(
            @ToolParam(description = "Relative path to source folder (e.g., 'old/archive')") String fromPath,
            @ToolParam(description = "Relative path to destination (e.g., 'new/archive')") String toPath) {
        log.info("MCP tool called: move_folder(from={}, to={})", fromPath, toPath);

        if (fromPath == null || fromPath.isBlank()) {
            return new MoveFolderResult(false, null, null, "Source path is required");
        }
        if (toPath == null || toPath.isBlank()) {
            return new MoveFolderResult(false, fromPath, null, "Destination path is required");
        }

        try {
            noteService.moveFolder(fromPath, toPath);
            return new MoveFolderResult(true, fromPath, toPath, null);
        } catch (SecurityException e) {
            log.warn("Security violation in move_folder: {}", e.getMessage());
            return new MoveFolderResult(false, fromPath, toPath, "Access denied: " + e.getMessage());
        } catch (IOException e) {
            log.error("Failed to move folder {} -> {}: {}", fromPath, toPath, e.getMessage());
            return new MoveFolderResult(false, fromPath, toPath, "Failed to move folder: " + e.getMessage());
        } catch (IllegalArgumentException e) {
            return new MoveFolderResult(false, fromPath, toPath, "Invalid path: " + e.getMessage());
        }
    }

    /**
     * Execute a pre-approved shell command.
     * Only commands in the whitelist can be executed.
     *
     * @param command Name of the command to execute (e.g., "vpn-russia")
     * @return Execution result with stdout, stderr, and exit code
     */
    @Tool(name = "execute_command", description = "Execute a pre-approved shell command. Only whitelisted commands can be executed. Use this to run system commands like VPN connections, git operations, or other automated tasks.")
    public ExecuteCommandResult executeCommand(
            @ToolParam(description = "Name of the command to execute (must be whitelisted, e.g., 'vpn-russia')") String command) {
        log.info("MCP tool called: execute_command(command={})", command);

        if (command == null || command.isBlank()) {
            return new ExecuteCommandResult(false, null, -1, null, null, "Command name is required");
        }

        try {
            CommandExecutionService.ExecutionResult result = commandService.executeCommand(command);
            return new ExecuteCommandResult(
                    result.success(),
                    result.command(),
                    result.exitCode(),
                    result.stdout(),
                    result.stderr(),
                    null
            );
        } catch (SecurityException e) {
            log.warn("Security violation in execute_command: {}", e.getMessage());
            return new ExecuteCommandResult(false, command, -1, null, null, "Access denied: " + e.getMessage());
        } catch (IOException e) {
            log.error("Failed to execute command {}: {}", command, e.getMessage());
            return new ExecuteCommandResult(false, command, -1, null, null, "Execution failed: " + e.getMessage());
        } catch (Exception e) {
            log.error("Unexpected error executing command {}", command, e);
            return new ExecuteCommandResult(false, command, -1, null, null, "Unexpected error: " + e.getMessage());
        }
    }


    public record ListNotesResult(boolean success, List<String> notes, int count, List<NoteInfoItem> notesWithStats,
                                   String error) {
    }

    public record NoteInfoItem(String path, long size, long lastModified) {
    }

    public record ReadNoteResult(boolean success, String content, String path, String error) {
    }

    public record SearchNotesResult(boolean success, List<SearchResultItem> results, String query, String folder,
                                     int count, String error) {
    }

    public record SearchResultItem(String path, String title, String snippet) {
    }

    public record WriteNoteResult(boolean success, String path, boolean created, String error) {
    }

    public record DeleteNoteResult(boolean success, String path, String error) {
    }

    public record DeleteFolderResult(boolean success, String path, String error) {
    }

    public record MoveNoteResult(boolean success, String fromPath, String toPath, String error) {
    }

    public record AppendNoteResult(boolean success, String path, String error) {
    }

    public record EditNoteResult(boolean success, String path, String error) {
    }

    public record CreateFolderResult(boolean success, String path, boolean created, String error) {
    }

    public record GetMetadataResult(boolean success, MetadataInfo metadata, String error) {
    }

    public record MetadataInfo(String path, boolean isDirectory, long size, long lastModified) {
    }

    public record MoveFolderResult(boolean success, String fromPath, String toPath, String error) {
    }

    public record ExecuteCommandResult(boolean success, String command, int exitCode, String stdout, String stderr, String error) {
    }
}
