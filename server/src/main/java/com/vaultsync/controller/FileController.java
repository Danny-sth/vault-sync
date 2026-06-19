package com.vaultsync.controller;

import com.vaultsync.model.FileRecord;
import com.vaultsync.model.SyncMessage;
import com.vaultsync.service.FileStorageService;
import com.vaultsync.service.SyncService;
import com.vaultsync.util.HashUtil;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import org.springframework.beans.factory.annotation.Value;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;
import java.util.Map;

@RestController
@RequestMapping("/api")
@CrossOrigin(originPatterns = "*", allowedHeaders = "*", exposedHeaders = {"X-File-Hash", "X-File-Mtime", "X-File-Size"})
@RequiredArgsConstructor
@Slf4j
public class FileController {

    private final FileStorageService fileStorageService;
    private final SyncService syncService;

    /** Directory (inside storage, excluded from sync) holding in-progress chunked uploads. */
    private static final String UPLOADS_DIR = ".vault-sync-uploads";

    @Value("${vault-sync.storage-path}")
    private String storagePath;

    /**
     * Streamed chunked upload. The client sends the encrypted blob in ordered binary
     * chunks (octet-stream) so neither side ever holds the whole file as an inflated
     * string — base64-in-JSON OOM-killed Obsidian on mobile and hit the JSON size limit.
     * Each chunk is appended to a temp file keyed by X-Upload-Id; the final chunk
     * (X-Chunk-Index == X-Chunk-Count-1) assembles, runs the same resurrection/concurrency
     * checks (resurrection + optimistic concurrency), commits, and broadcasts. A small file is simply
     * one chunk.
     */
    @PostMapping(value = "/upload-chunk", consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<?> uploadChunk(
            @RequestBody byte[] chunk,
            @RequestHeader("X-Path") String encodedPath,
            @RequestHeader("X-Upload-Id") String uploadId,
            @RequestHeader("X-Chunk-Index") int chunkIndex,
            @RequestHeader("X-Chunk-Count") int chunkCount,
            @RequestHeader("X-Hash") String hash,
            @RequestHeader(value = "X-Mtime", required = false, defaultValue = "0") long mtime,
            @RequestHeader(value = "X-Base-Hash", required = false, defaultValue = "") String baseHash,
            @RequestHeader(value = "X-Base-Seq", required = false, defaultValue = "0") long baseSeq,
            @RequestHeader("X-Device-Id") String deviceId) {

        String path = java.net.URLDecoder.decode(encodedPath, java.nio.charset.StandardCharsets.UTF_8);
        if (!uploadId.matches("[A-Za-z0-9_.-]{1,128}")) {
            return ResponseEntity.badRequest().body(Map.of("error", "invalid uploadId"));
        }
        java.nio.file.Path tmp = Paths.get(storagePath, UPLOADS_DIR, uploadId);
        try {
            Files.createDirectories(tmp.getParent());
            // First chunk truncates any stale partial; subsequent chunks append in order.
            if (chunkIndex == 0) {
                Files.write(tmp, chunk, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
            } else {
                Files.write(tmp, chunk, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            }
            if (chunkIndex < chunkCount - 1) {
                return ResponseEntity.ok(Map.of("status", "chunk-ok", "index", chunkIndex));
            }

            byte[] content = Files.readAllBytes(tmp);
            Files.deleteIfExists(tmp);
            com.vaultsync.model.Tombstone tomb = syncService.getTombstone(path);
            boolean clearTombstoneAfterStore = false;
            if (tomb != null) {
                if (baseSeq != 0 && baseSeq < tomb.getSeq()) {
                    log.warn("Resurrection blocked for {} by {}: baseSeq={} < tombstone seq={} — stale re-push, rejected",
                            path, deviceId, baseSeq, tomb.getSeq());
                    return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of(
                            "error", "deleted", "deletedSeq", tomb.getSeq()));
                }
                clearTombstoneAfterStore = true;
            }

            FileRecord existing = fileStorageService.getFileInfo(path);
            if (existing != null && baseHash != null && !baseHash.isBlank()) {
                String incomingHash = HashUtil.sha256(content);
                if (!existing.getHash().equals(incomingHash) && !existing.getHash().equals(baseHash)) {
                    log.warn("Upload conflict for {} by {}: base={} but server={} — rejected",
                            path, deviceId, baseHash, existing.getHash());
                    return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of(
                            "error", "conflict",
                            "currentHash", existing.getHash(),
                            "currentSeq", existing.getSeq(),
                            "currentMtime", existing.getMtime(),
                            "currentSize", existing.getSize()));
                }
            }

            long seq = syncService.nextSeq();
            FileRecord record = fileStorageService.storeBytes(path, content, hash, deviceId, seq, mtime);

            if (clearTombstoneAfterStore) {
                syncService.clearTombstone(path);
                log.info("Resurrection committed for {} by {} (tombstone cleared after store)", path, deviceId);
            }

            SyncMessage.FileChanged changeMsg = SyncMessage.FileChanged.builder()
                    .path(path).hash(record.getHash()).mtime(record.getMtime())
                    .size(record.getSize()).seq(seq).deviceId(deviceId).build();
            syncService.broadcastFileChange(changeMsg);

            log.info("File uploaded (binary): {} by {} ({} bytes)", path, deviceId, record.getSize());
            return ResponseEntity.ok(Map.of("status", "ok", "hash", record.getHash(), "seq", seq));
        } catch (IOException e) {
            log.error("Failed to upload file (binary): {}", path, e);
            return ResponseEntity.internalServerError().body(Map.of("error", e.getMessage()));
        }
    }

    /**
     * Download a file
     */
    @GetMapping("/download/**")
    public ResponseEntity<?> downloadFile(
            @RequestHeader("X-Device-Id") String deviceId,
            jakarta.servlet.http.HttpServletRequest request) {

        String rawPath = request.getRequestURI().substring("/api/download/".length());
        String path = java.net.URLDecoder.decode(rawPath, java.nio.charset.StandardCharsets.UTF_8);

        try {
            Resource resource = fileStorageService.load(path);
            FileRecord info = fileStorageService.getFileInfo(path);

            HttpHeaders headers = new HttpHeaders();
            if (info != null) {
                headers.add("X-File-Hash", info.getHash());
                headers.add("X-File-Mtime", String.valueOf(info.getMtime()));
                headers.add("X-File-Size", String.valueOf(info.getSize()));
            }

            long size = info != null ? info.getSize() : -1;
            log.info("File downloaded: {} by {} ({} bytes)", path, deviceId, size);
            return ResponseEntity.ok()
                    .headers(headers)
                    .contentType(MediaType.APPLICATION_OCTET_STREAM)
                    .body(resource);

        } catch (NoSuchFileException e) {
            log.warn("File download 404: {} by {}", path, deviceId);
            return ResponseEntity.notFound().build();
        } catch (IOException e) {
            log.error("Failed to download file: {}", path, e);
            return ResponseEntity.internalServerError()
                    .body(Map.of("error", e.getMessage()));
        }
    }

    /**
     * Delete a file
     */
    @DeleteMapping("/delete/**")
    public ResponseEntity<?> deleteFile(
            @RequestHeader("X-Device-Id") String deviceId,
            jakarta.servlet.http.HttpServletRequest request) {

        String rawPath = request.getRequestURI().substring("/api/delete/".length());
        String path = java.net.URLDecoder.decode(rawPath, java.nio.charset.StandardCharsets.UTF_8);

        try {
            SyncMessage.FileDeleted deleteMsg = syncService.processFileDelete(path, deviceId);
            syncService.broadcastFileDelete(deleteMsg);

            log.info("File deleted: {} by {}", path, deviceId);

            return ResponseEntity.ok(Map.of("status", "ok"));
        } catch (Exception e) {
            log.error("Failed to delete file: {}", path, e);
            return ResponseEntity.internalServerError()
                    .body(Map.of("error", e.getMessage()));
        }
    }

    /**
     * Delete a file via JSON (for CORS bypass from Obsidian's requestUrl)
     */
    @PostMapping("/delete-json")
    public ResponseEntity<?> deleteFileJson(
            @RequestBody JsonDeleteRequest request,
            @RequestHeader("X-Device-Id") String deviceId) {

        try {
            SyncMessage.FileDeleted deleteMsg = syncService.processFileDelete(request.path(), deviceId);
            syncService.broadcastFileDelete(deleteMsg);

            log.info("File deleted (JSON): {} by {}", request.path(), deviceId);

            // Return the deletion's seq so the deleting device can remember it
            // (it never receives its own broadcast). A later re-create then proves
            // the device observed the deletion (baseSeq >= tomb.seq) → genuine.
            return ResponseEntity.ok(Map.of("status", "ok", "seq", deleteMsg.getSeq()));
        } catch (Exception e) {
            log.error("Failed to delete file: {}", request.path(), e);
            return ResponseEntity.internalServerError()
                    .body(Map.of("error", e.getMessage()));
        }
    }

    public record JsonDeleteRequest(String path) {}

    /**
     * List all files and tombstones
     */
    @GetMapping("/list")
    public ResponseEntity<?> listFiles(@RequestHeader("X-Device-Id") String deviceId) {
        SyncMessage.SyncResponse response = syncService.getFullState();
        return ResponseEntity.ok(response);
    }

    /**
     * Health check
     */
    @GetMapping("/health")
    public ResponseEntity<?> health() {
        return ResponseEntity.ok(Map.of(
                "status", "ok",
                "currentSeq", syncService.currentSeq()
        ));
    }
}
