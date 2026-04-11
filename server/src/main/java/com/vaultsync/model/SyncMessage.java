package com.vaultsync.model;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

public class SyncMessage {

    // Client -> Server messages
    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class FileChange {
        private String path;
        private String hash;
        private long mtime;
        private long size;
        private String deviceId;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class FileDelete {
        private String path;
        private String deviceId;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class SyncRequest {
        private long lastSeq;
        private String deviceId;
    }

    // Server -> Client messages
    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class FileChanged {
        @Builder.Default
        private String type = "file_changed";
        private String path;
        private String hash;
        private long mtime;
        private long size;
        private long seq;
        private String deviceId;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class FileDeleted {
        @Builder.Default
        private String type = "file_deleted";
        private String path;
        private long seq;
        private String deviceId;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class SyncResponse {
        @Builder.Default
        private String type = "sync_response";
        private long currentSeq;
        private List<FileInfo> files;
        private List<TombstoneInfo> tombstones;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class FileInfo {
        private String path;
        private String hash;
        private long mtime;
        private long size;
        private long seq;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class TombstoneInfo {
        private String path;
        private long deletedAt;
        private long seq;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class Error {
        private String type = "error";
        private String message;
    }
}
