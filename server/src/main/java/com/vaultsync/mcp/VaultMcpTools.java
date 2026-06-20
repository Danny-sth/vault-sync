package com.vaultsync.mcp;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.List;

/**
 * MCP Tools for the END-TO-END-ENCRYPTED vault.
 *
 * The vault is zero-knowledge: the server stores ciphertext only and never sees
 * plaintext content or real paths (paths are encrypted client-side too). Therefore
 * the legacy plaintext note tools (list_notes, read_note, write_note, search_notes,
 * edit_note, append_note, move/delete_note, *_folder) have been REMOVED — under E2EE
 * they either return ciphertext, corrupt blobs, or always come back empty.
 *
 * Surviving tools, all E2EE-safe:
 * - list_blobs / get_blob / put_blob / delete_blob — blob CRUD over encrypted paths
 * - get_metadata — size/mtime/type only (no content decryption)
 * - execute_command — whitelisted shell (unrelated to vault content)
 *
 * Clients (e.g. the DUQ duq-vault-mcp plugin) encrypt paths + content locally,
 * list via list_blobs and decrypt paths, and full-text search by pulling blobs and
 * grepping after local decryption.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class VaultMcpTools {

    private final VaultNoteService noteService;
    private final CommandExecutionService commandService;
    private final VaultBlobService blobService;

    /**
     * Get metadata for a vault entry (size, last modified time, type). Operates on the
     * encrypted path the client supplies — no content is decrypted, so this is E2EE-safe
     * and handy as an existence/changed check.
     */
    @Tool(name = "get_metadata", description = "Get metadata for a note or folder (size, last modified time, type). Operates on the encrypted path; no content is decrypted.")
    public GetMetadataResult getMetadata(
            @ToolParam(description = "Encrypted vault path to the note or folder") String path) {
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
     * Execute a pre-approved shell command. Only commands in the whitelist can be executed.
     * Unrelated to vault content (e.g. VPN connections, git operations).
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

    /**
     * Fetch the raw encrypted blob for a path (base64). The server never decrypts — the
     * caller decrypts locally with the vault key. Use for zero-knowledge reads.
     */
    @Tool(name = "get_blob", description = "Fetch the raw end-to-end-encrypted blob for a vault path, base64-encoded. The server stores and returns ciphertext only; decrypt it locally with the vault key.")
    public GetBlobResult getBlob(
            @ToolParam(description = "Encrypted vault path to the file") String path) {
        log.info("MCP tool called: get_blob(path={})", path);

        if (path == null || path.isBlank()) {
            return new GetBlobResult(false, null, null, "Path is required");
        }

        try {
            String blobBase64 = blobService.getBlobBase64(path);
            return new GetBlobResult(true, path, blobBase64, null);
        } catch (java.nio.file.NoSuchFileException e) {
            return new GetBlobResult(false, path, null, "Blob not found: " + path);
        } catch (IOException e) {
            log.warn("Failed to read blob {}: {}", path, e.getMessage());
            return new GetBlobResult(false, path, null, "Failed to read blob: " + e.getMessage());
        }
    }

    /**
     * List every encrypted blob with its sync metadata (path, blob hash, size, mtime, seq).
     * Metadata only — no content is read or decrypted server-side.
     */
    @Tool(name = "list_blobs", description = "List every encrypted blob in the vault with sync metadata (path, blob hash, size, mtime, seq). Returns metadata only; no content is decrypted server-side.")
    public ListBlobsResult listBlobs() {
        log.info("MCP tool called: list_blobs");
        try {
            List<VaultBlobService.BlobInfo> blobs = blobService.listBlobs();
            return new ListBlobsResult(true, blobs, blobs.size(), null);
        } catch (Exception e) {
            log.error("Failed to list blobs", e);
            return new ListBlobsResult(false, List.of(), 0, "Failed to list blobs: " + e.getMessage());
        }
    }

    /**
     * Store an encrypted blob (base64) at a path. The vault is end-to-end encrypted, so
     * the caller MUST encrypt the content with the vault key before calling — the server
     * never decrypts.
     */
    @Tool(name = "put_blob", description = "Store an end-to-end-encrypted blob (base64) at a vault path. You MUST encrypt the content with the vault key first; the server stores ciphertext only.")
    public PutBlobResult putBlob(
            @ToolParam(description = "Encrypted vault path to the file") String path,
            @ToolParam(description = "Base64 of the encrypted VSE blob") String blobBase64) {
        log.info("MCP tool called: put_blob(path={})", path);
        if (path == null || path.isBlank()) return new PutBlobResult(false, null, 0, "Path is required");
        if (blobBase64 == null || blobBase64.isBlank()) return new PutBlobResult(false, path, 0, "blobBase64 is required");
        try {
            long seq = blobService.putBlobBase64(path, blobBase64, "mcp");
            return new PutBlobResult(true, path, seq, null);
        } catch (IllegalArgumentException e) {
            return new PutBlobResult(false, path, 0, "Invalid base64");
        } catch (IOException e) {
            log.error("Failed to put blob {}: {}", path, e.getMessage());
            return new PutBlobResult(false, path, 0, "Failed to store blob: " + e.getMessage());
        }
    }

    /** Delete a blob (and its file) at a path, broadcasting the deletion to all devices. */
    @Tool(name = "delete_blob", description = "Delete a file (blob) from the encrypted vault and broadcast the deletion to all devices.")
    public DeleteBlobResult deleteBlob(
            @ToolParam(description = "Encrypted vault path to the file to delete") String path) {
        log.info("MCP tool called: delete_blob(path={})", path);
        if (path == null || path.isBlank()) return new DeleteBlobResult(false, null, "Path is required");
        try {
            blobService.deleteBlob(path, "mcp");
            return new DeleteBlobResult(true, path, null);
        } catch (Exception e) {
            log.error("Failed to delete blob {}: {}", path, e.getMessage());
            return new DeleteBlobResult(false, path, "Failed to delete: " + e.getMessage());
        }
    }

    public record GetBlobResult(boolean success, String path, String blobBase64, String error) {
    }

    public record PutBlobResult(boolean success, String path, long seq, String error) {
    }

    public record ListBlobsResult(boolean success, List<VaultBlobService.BlobInfo> blobs, int count, String error) {
    }

    public record DeleteBlobResult(boolean success, String path, String error) {
    }

    public record GetMetadataResult(boolean success, MetadataInfo metadata, String error) {
    }

    public record MetadataInfo(String path, boolean isDirectory, long size, long lastModified) {
    }

    public record ExecuteCommandResult(boolean success, String command, int exitCode, String stdout, String stderr, String error) {
    }
}
