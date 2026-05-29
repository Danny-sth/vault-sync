package com.vaultsync.mcp;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * OAuth 2.0 Metadata endpoints for MCP authorization.
 *
 * RFC 9728: Protected Resource Metadata - tells clients where to find AS
 * RFC 8414: Authorization Server Metadata - tells clients how to authorize
 *
 * IMPORTANT: We serve our OWN AS metadata (without registration_endpoint)
 * to force claude.ai to use pre-registered client_id instead of DCR.
 *
 * @see <a href="https://datatracker.ietf.org/doc/html/rfc9728">RFC 9728</a>
 * @see <a href="https://datatracker.ietf.org/doc/html/rfc8414">RFC 8414</a>
 */
@RestController
@Slf4j
public class ProtectedResourceMetadataController {

    @Value("${vault-sync.oauth.resource-url:https://on-za-menya.online/vault-mcp}")
    private String resourceUrl;

    @Value("${vault-sync.oauth.issuer-uri:https://on-za-menya.online/realms/duq}")
    private String keycloakIssuer;

    /**
     * Returns Protected Resource Metadata per RFC 9728.
     *
     * Points authorization_servers to OUR domain (not Keycloak directly)
     * so that claude.ai fetches our AS metadata without registration_endpoint.
     */
    @GetMapping(
        value = "/.well-known/oauth-protected-resource",
        produces = MediaType.APPLICATION_JSON_VALUE
    )
    public ResponseEntity<Map<String, Object>> getProtectedResourceMetadata() {
        log.info("Protected Resource Metadata requested");

        // Point to our own AS metadata endpoint (same domain as resource)
        // This makes claude.ai fetch /.well-known/oauth-authorization-server from us
        String authorizationServer = resourceUrl.replace("/vault-mcp", "");

        Map<String, Object> metadata = Map.of(
            "resource", resourceUrl,
            "authorization_servers", List.of(authorizationServer),
            "scopes_supported", List.of("openid", "profile"),
            "bearer_methods_supported", List.of("header"),
            "resource_documentation", "https://github.com/Danny-sth/vault-sync"
        );

        log.info("Protected Resource Metadata: resource={}, authorization_servers={}",
            resourceUrl, authorizationServer);

        return ResponseEntity.ok(metadata);
    }

    /**
     * Returns Authorization Server Metadata per RFC 8414.
     *
     * CRITICAL: Does NOT include registration_endpoint to prevent DCR.
     * claude.ai will use pre-registered client_id (vault-mcp-claude) instead.
     *
     * All actual endpoints point to Keycloak.
     */
    @GetMapping(
        value = "/.well-known/oauth-authorization-server",
        produces = MediaType.APPLICATION_JSON_VALUE
    )
    public ResponseEntity<Map<String, Object>> getAuthorizationServerMetadata() {
        log.info("Authorization Server Metadata requested (NO registration_endpoint)");

        String baseUrl = resourceUrl.replace("/vault-mcp", "");

        // Build metadata with explicit ordering (issuer first per RFC 8414)
        Map<String, Object> metadata = new LinkedHashMap<>();

        // Required fields (RFC 8414)
        metadata.put("issuer", baseUrl);
        metadata.put("authorization_endpoint", keycloakIssuer + "/protocol/openid-connect/auth");
        metadata.put("token_endpoint", keycloakIssuer + "/protocol/openid-connect/token");
        metadata.put("jwks_uri", keycloakIssuer + "/protocol/openid-connect/certs");

        // Supported features
        metadata.put("response_types_supported", List.of("code"));
        metadata.put("grant_types_supported", List.of("authorization_code", "refresh_token"));
        metadata.put("token_endpoint_auth_methods_supported", List.of("none", "client_secret_basic", "client_secret_post"));
        metadata.put("code_challenge_methods_supported", List.of("S256"));
        metadata.put("scopes_supported", List.of("openid", "profile", "email", "offline_access"));

        // NO registration_endpoint - forces pre-registered client usage

        log.info("AS Metadata: issuer={}, auth={}, token={} (NO registration_endpoint)",
            baseUrl, metadata.get("authorization_endpoint"), metadata.get("token_endpoint"));

        return ResponseEntity.ok(metadata);
    }
}
