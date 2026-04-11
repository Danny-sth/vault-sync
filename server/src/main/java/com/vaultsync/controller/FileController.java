package com.vaultsync.controller;

import com.vaultsync.model.FileRecord;
import com.vaultsync.model.SyncMessage;
import com.vaultsync.service.FileStorageService;
import com.vaultsync.service.SyncService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
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

            // Broadcast change to WebSocket clients
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
            long seq = syncService.nextSeq();
            FileRecord record = fileStorageService.storeBytes(
                    request.path(), content, request.hash(), deviceId, seq, request.mtime()
            );

            // Broadcast change to WebSocket clients
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

    public record JsonUploadRequest(String path, String content, String hash, long mtime) {}

    /**
     * Download a file
     */
    @GetMapping("/download/**")
    public ResponseEntity<?> downloadFile(
            @RequestHeader("X-Device-Id") String deviceId,
            jakarta.servlet.http.HttpServletRequest request) {

        // Extract path from URL and decode URL-encoded characters (e.g., Cyrillic)
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

            return ResponseEntity.ok()
                    .headers(headers)
                    .contentType(MediaType.APPLICATION_OCTET_STREAM)
                    .body(resource);

        } catch (NoSuchFileException e) {
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
            fileStorageService.delete(path);

            // Broadcast deletion
            SyncMessage.FileDeleted deleteMsg = syncService.processFileDelete(path, deviceId);
            syncService.broadcastFileDelete(deleteMsg);

            log.info("File deleted: {} by {}", path, deviceId);

            return ResponseEntity.ok(Map.of("status", "ok"));
        } catch (IOException e) {
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
            fileStorageService.delete(request.path());

            // Broadcast deletion
            SyncMessage.FileDeleted deleteMsg = syncService.processFileDelete(request.path(), deviceId);
            syncService.broadcastFileDelete(deleteMsg);

            log.info("File deleted (JSON): {} by {}", request.path(), deviceId);

            return ResponseEntity.ok(Map.of("status", "ok"));
        } catch (IOException e) {
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
