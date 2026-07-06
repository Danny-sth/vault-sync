package com.vaultsync.controller;

import com.vaultsync.model.SyncMessage;
import com.vaultsync.service.SyncService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.messaging.simp.SimpMessageHeaderAccessor;
import org.springframework.messaging.simp.annotation.SendToUser;
import org.springframework.stereotype.Controller;

import java.security.Principal;

@Controller
@RequiredArgsConstructor
@Slf4j
public class SyncController {

    private final SyncService syncService;

    // NOTE: the legacy STOMP /app/file.change and /app/file.delete mappings are gone.
    // No client ever sent them (uploads/deletes go through the REST chunked API), and
    // file.change was actively dangerous: it registered a FileRecord from bare metadata
    // (no bytes on disk → the reconciler would tombstone it) and cleared tombstones
    // without the resurrection guard the REST path enforces.

    /**
     * Handle sync request from client.
     * Sends response only to the requesting client via user queue.
     */
    @MessageMapping("/sync.request")
    @SendToUser("/queue/sync")
    public SyncMessage.SyncResponse handleSyncRequest(
            @Payload SyncMessage.SyncRequest request,
            Principal principal,
            SimpMessageHeaderAccessor headerAccessor) {

        log.info("Sync request from {} (lastSeq={}, requestId={})",
                request.getDeviceId(), request.getLastSeq(), request.getRequestId());

        SyncMessage.SyncResponse response;
        if (request.getLastSeq() <= 0) {
            response = syncService.getFullState();
        } else {
            response = syncService.getChangesSince(request.getLastSeq());
        }

        response.setRequestId(request.getRequestId());
        int fileCount = response.getFiles() != null ? response.getFiles().size() : 0;
        int tombCount = response.getTombstones() != null ? response.getTombstones().size() : 0;
        log.info("Sync response to {} → {} files, {} tombstones, currentSeq={}",
                request.getDeviceId(), fileCount, tombCount, response.getCurrentSeq());
        return response;
    }

    /**
     * Handle ping from client - just echo back for heartbeat.
     */
    @MessageMapping("/ping")
    @SendToUser("/queue/pong")
    public String handlePing(Principal principal) {
        return "pong";
    }
}
