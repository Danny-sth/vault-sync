package com.vaultsync.controller;

import com.vaultsync.model.SyncMessage;
import com.vaultsync.service.SyncService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.messaging.handler.annotation.SendTo;
import org.springframework.messaging.simp.SimpMessageHeaderAccessor;
import org.springframework.messaging.simp.annotation.SendToUser;
import org.springframework.stereotype.Controller;

import java.security.Principal;

@Controller
@RequiredArgsConstructor
@Slf4j
public class SyncController {

    private final SyncService syncService;

    /**
     * Handle file change notification from client.
     * Broadcasts to all other clients via /topic/sync
     */
    @MessageMapping("/file.change")
    @SendTo("/topic/sync")
    public SyncMessage.FileChanged handleFileChange(
            @Payload SyncMessage.FileChange message,
            Principal principal) {

        log.debug("File change from {}: {}", message.getDeviceId(), message.getPath());

        return syncService.processFileChange(
                message.getPath(),
                message.getHash(),
                message.getMtime(),
                message.getSize(),
                message.getDeviceId()
        );
    }

    /**
     * Handle file delete notification from client.
     * Broadcasts to all other clients via /topic/sync
     */
    @MessageMapping("/file.delete")
    @SendTo("/topic/sync")
    public SyncMessage.FileDeleted handleFileDelete(
            @Payload SyncMessage.FileDelete message,
            Principal principal) {

        log.debug("File delete from {}: {}", message.getDeviceId(), message.getPath());

        return syncService.processFileDelete(
                message.getPath(),
                message.getDeviceId()
        );
    }

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

        log.info("Sync request from {} (lastSeq={})", request.getDeviceId(), request.getLastSeq());

        if (request.getLastSeq() <= 0) {
            // Full sync
            return syncService.getFullState();
        } else {
            // Delta sync
            return syncService.getChangesSince(request.getLastSeq());
        }
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
