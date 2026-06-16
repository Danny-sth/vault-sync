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
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.file.NoSuchFileException;
import java.util.Map;

@RestController
@RequestMapping("/api")
@CrossOrigin(originPatterns = "*", allowedHeaders = "*", exposedHeaders = {"X-File-Hash", "X-File-Mtime", "X-File-Size"})
@RequiredArgsConstructor
@Slf4j
public class FileController {

    private final FileStorageService fileStorageService;
    private final SyncService syncService;

    /**
     * Upload a single file
     */
    @PostMapping("/upload")
    public ResponseEntity<?> uploadFile(
            @RequestParam("file") MultipartFile file,
            @RequestParam("path") String path,
            @RequestParam("hash") String hash,
            @RequestParam(value = "mtime", required = false, defaultValue = "0") long mtime,
            @RequestHeader("X-Device-Id") String deviceId) {

        try {
            long seq = syncService.nextSeq();
            FileRecord record = fileStorageService.store(path, file, hash, deviceId, seq);

            SyncMessage.FileChanged changeMsg = SyncMessage.FileChanged.builder()
                    .path(path)
                    .hash(record.getHash())
                    .mtime(record.getMtime())
                    .size(record.getSize())
                    .seq(seq)
                    .deviceId(deviceId)
                    .build();
            syncService.broadcastFileChange(changeMsg);

            log.info("File uploaded: {} by {} ({} bytes)", path, deviceId, record.getSize());

            return ResponseEntity.ok(Map.of(
                    "status", "ok",
                    "hash", record.getHash(),
                    "seq", seq
            ));
        } catch (IOException e) {
            log.error("Failed to upload file: {}", path, e);
            return ResponseEntity.internalServerError()
                    .body(Map.of("error", e.getMessage()));
        }
    }

    /**
     * Upload a file via JSON (base64 encoded content)
     * Used for CORS bypass from Obsidian's requestUrl
     */
    @PostMapping("/upload-json")
    public ResponseEntity<?> uploadFileJson(
            @RequestBody JsonUploadRequest request,
            @RequestHeader("X-Device-Id") String deviceId) {

        try {
            byte[] content = java.util.Base64.getDecoder().decode(request.content());
            String baseHash = request.baseHash();

            // Deletion-resurrection guard — industry-standard VERSION check (not a
            // hash heuristic). A live tombstone means this path was deleted at
            // tombstone.seq. The client sends baseSeq = the highest seq it has seen
            // for the path (including that deletion). Decide:
            //   baseSeq == 0            → device never knew this path → genuine NEW file → accept
            //   baseSeq >= tombstone.seq → device observed the deletion and still
            //                              (re)creates → genuine recreation → accept
            //   0 < baseSeq < tomb.seq  → device holds a PRE-deletion copy → stale
            //                              re-push → reject (deletion wins; prevents the
            //                              "deleted files keep coming back" loop)
            // The old code rejected by "baseHash present", which wrongly deleted a
            // genuinely re-added file whose device merely remembered the old hash.
            com.vaultsync.model.Tombstone tomb = syncService.getTombstone(request.path());
            boolean clearTombstoneAfterStore = false;
            if (tomb != null) {
                long baseSeq = request.baseSeq();
                if (baseSeq != 0 && baseSeq < tomb.getSeq()) {
                    log.warn("Resurrection blocked for {} by {}: baseSeq={} < tombstone seq={} — stale re-push, rejected",
                            request.path(), deviceId, baseSeq, tomb.getSeq());
                    return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of(
                            "error", "deleted",
                            "deletedSeq", tomb.getSeq()
                    ));
                }
                // Genuine recreation. Clear the tombstone ONLY AFTER the file is
                // actually stored — otherwise a storeBytes failure would leave
                // neither file nor tombstone, desyncing every device.
                clearTombstoneAfterStore = true;
            }

            // Optimistic concurrency (compare-and-swap): a client sends baseHash = the
            // server hash it last saw. If the server has since moved to a different
            // version, the client was editing a stale base — reject so it can reconcile
            // instead of silently clobbering newer content (the empty-note data-loss bug).
            FileRecord existing = fileStorageService.getFileInfo(request.path());
            if (existing != null && baseHash != null && !baseHash.isBlank()) {
                String incomingHash = HashUtil.sha256(content);
                if (!existing.getHash().equals(incomingHash)
                        && !existing.getHash().equals(baseHash)) {
                    log.warn("Upload conflict for {} by {}: base={} but server={} ({} bytes) — rejected",
                            request.path(), deviceId, baseHash, existing.getHash(), existing.getSize());
                    return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of(
                            "error", "conflict",
                            "currentHash", existing.getHash(),
                            "currentSeq", existing.getSeq(),
                            "currentMtime", existing.getMtime(),
                            "currentSize", existing.getSize()
                    ));
                }
            }

            long seq = syncService.nextSeq();
            FileRecord record = fileStorageService.storeBytes(
                    request.path(), content, request.hash(), deviceId, seq, request.mtime()
            );

            // File is safely stored — now it's safe to drop the tombstone.
            if (clearTombstoneAfterStore) {
                syncService.clearTombstone(request.path());
                log.info("Resurrection committed for {} by {} (tombstone cleared after store)",
                        request.path(), deviceId);
            }

            SyncMessage.FileChanged changeMsg = SyncMessage.FileChanged.builder()
                    .path(request.path())
                    .hash(record.getHash())
                    .mtime(record.getMtime())
                    .size(record.getSize())
                    .seq(seq)
                    .deviceId(deviceId)
                    .build();
            syncService.broadcastFileChange(changeMsg);

            log.info("File uploaded (JSON): {} by {} ({} bytes)", request.path(), deviceId, record.getSize());

            return ResponseEntity.ok(Map.of(
                    "status", "ok",
                    "hash", record.getHash(),
                    "seq", seq
            ));
        } catch (IOException e) {
            log.error("Failed to upload file: {}", request.path(), e);
            return ResponseEntity.internalServerError()
                    .body(Map.of("error", e.getMessage()));
        } catch (IllegalArgumentException e) {
            log.error("Invalid base64 content for: {}", request.path(), e);
            return ResponseEntity.badRequest()
                    .body(Map.of("error", "Invalid base64 content"));
        }
    }

    public record JsonUploadRequest(String path, String content, String hash, long mtime, String baseHash, long baseSeq) {}

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
