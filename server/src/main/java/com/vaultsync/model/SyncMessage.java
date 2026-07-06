package com.vaultsync.model;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

public class SyncMessage {

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class SyncRequest {
        private String requestId;
        private long lastSeq;
        private String deviceId;
    }

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
        private String requestId;
        private long currentSeq;
        private List<FileInfo> files;
        private List<TombstoneInfo> tombstones;
        /**
         * True when this carries the COMPLETE server state (every live file + tombstone), so
         * the client must reconcile by absence (delete locals the server no longer has). False
         * when it is a sparse delta (only entries with seq &gt; the requested lastSeq), which
         * the client applies additively without inferring deletions from absence. The server
         * sets this — the client never guesses — so a stale device gets promoted to a full
         * reconcile automatically when its lastSeq predates pruned tombstones.
         */
        @Builder.Default
        private boolean fullState = false;
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
