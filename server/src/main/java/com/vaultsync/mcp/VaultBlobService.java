package com.vaultsync.mcp;

import com.vaultsync.model.SyncMessage;
import com.vaultsync.service.FileStorageService;
import com.vaultsync.service.SyncService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.Base64;
import java.util.List;

/**
 * Zero-knowledge blob access for the MCP layer.
 *
 * The vault is end-to-end encrypted: clients store opaque ciphertext blobs and the server
 * never holds the key. These methods let a key-holding MCP client list and fetch the raw
 * blobs (as base64) and decrypt them locally — the server performs no decryption, no
 * content read, and no plaintext search. This is the read side; writes still go through the
 * existing sync upload path.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class VaultBlobService {

    private final FileStorageService fileStorageService;
    private final SyncService syncService;

    /**
     * Fetch the raw ciphertext blob for a path, base64-encoded.
     *
     * @param path relative vault path
     * @return base64 of the on-disk bytes (opaque to the server)
     * @throws java.nio.file.NoSuchFileException if the path does not exist
     * @throws IOException                       if the file cannot be read
     */
    public String getBlobBase64(String path) throws IOException {
        byte[] bytes = fileStorageService.loadBytes(path);
        log.debug("MCP blob fetched: {} ({} bytes)", path, bytes.length);
        return Base64.getEncoder().encodeToString(bytes);
    }

    /**
     * Store an encrypted blob (base64) at a path and broadcast the change, exactly like a
     * device upload. The server stays zero-knowledge — it never decrypts; the caller (e.g.
     * duq) must encrypt with the vault key before sending. Returns the assigned seq.
     */
    public long putBlobBase64(String path, String base64, String deviceId) throws IOException {
        byte[] bytes = Base64.getDecoder().decode(base64);
        long seq = syncService.nextSeq();
        var record = fileStorageService.storeBytes(path, bytes, null, deviceId, seq, System.currentTimeMillis());
        syncService.clearTombstone(path);
        syncService.broadcastFileChange(SyncMessage.FileChanged.builder()
                .path(path).hash(record.getHash()).mtime(record.getMtime())
                .size(record.getSize()).seq(seq).deviceId(deviceId).build());
        log.info("MCP blob stored: {} ({} bytes, seq={})", path, bytes.length, seq);
        return seq;
    }

    /** Delete a blob and broadcast the deletion (tombstone), like a device delete. */
    public long deleteBlob(String path, String deviceId) {
        SyncMessage.FileDeleted msg = syncService.processFileDelete(path, deviceId);
        syncService.broadcastFileDelete(msg);
        log.info("MCP blob deleted: {} (seq={})", path, msg.getSeq());
        return msg.getSeq();
    }

    /**
     * List every blob with its sync metadata (path, blob hash, size, mtime, seq). Returns
     * metadata only — no content is read or decrypted.
     */
    public List<BlobInfo> listBlobs() {
        SyncMessage.SyncResponse state = syncService.getFullState();
        return state.getFiles().stream()
                .map(f -> new BlobInfo(f.getPath(), f.getHash(), f.getSize(), f.getMtime(), f.getSeq()))
                .toList();
    }

    /**
     * Blob metadata. {@code hash} is SHA-256 of the on-disk (ciphertext) bytes — the same
     * value the sync protocol uses for optimistic concurrency.
     */
    public record BlobInfo(String path, String hash, long size, long mtime, long seq) {
    }
}
