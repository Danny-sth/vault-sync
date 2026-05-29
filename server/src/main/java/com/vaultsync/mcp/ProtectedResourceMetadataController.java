package com.vaultsync.mcp;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * RFC 9728: OAuth 2.0 Protected Resource Metadata.
 *
 * This endpoint tells claude.ai where to find the authorization server
 * and how to register as an OAuth client.
 *
 * @see <a href="https://datatracker.ietf.org/doc/html/rfc9728">RFC 9728</a>
 */
@RestController
@Slf4j
public class ProtectedResourceMetadataController {

    @Value("${vault-sync.oauth.resource-url:https://on-za-menya.online/vault-mcp}")
    private String resourceUrl;

    @Value("${vault-sync.oauth.issuer-uri:https://on-za-menya.online/realms/duq}")
    private String issuerUri;

    /**
     * Returns Protected Resource Metadata per RFC 9728.
     *
     * claude.ai reads this after receiving 401 to discover:
     * - Where to find the authorization server
     * - What scopes are available
     * - How to register as a client (DCR)
     */
    @GetMapping(
        value = "/.well-known/oauth-protected-resource",
        produces = MediaType.APPLICATION_JSON_VALUE
    )
    public ResponseEntity<Map<String, Object>> getProtectedResourceMetadata() {
        log.debug("Protected Resource Metadata requested");

        // RFC 9728 Protected Resource Metadata
        Map<String, Object> metadata = Map.of(
            // The protected resource identifier (must match what user enters in claude.ai)
            "resource", resourceUrl,

            // Authorization servers that can issue tokens for this resource
            // Primary server first (Keycloak)
            "authorization_servers", List.of(issuerUri),

            // Scopes supported by this resource (MCP read-only)
            "scopes_supported", List.of("openid", "profile"),

            // Bearer token method
            "bearer_methods_supported", List.of("header"),

            // Resource documentation
            "resource_documentation", "https://github.com/Danny-sth/vault-sync"
        );

        log.info("Returning Protected Resource Metadata: resource={}, authorization_servers={}",
            resourceUrl, List.of(issuerUri));

        return ResponseEntity.ok(metadata);
    }
}
