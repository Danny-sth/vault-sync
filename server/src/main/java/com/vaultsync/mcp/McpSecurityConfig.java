package com.vaultsync.mcp;

import jakarta.servlet.http.HttpServletResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

/**
 * OAuth 2.1 Resource Server security for MCP endpoints.
 *
 * Implements RFC 9728 (Protected Resource Metadata) for claude.ai compatibility.
 * All MCP endpoints require valid Keycloak JWT - NO authless fallback.
 */
@Configuration
@EnableWebSecurity
@Slf4j
public class McpSecurityConfig {

    @Value("${vault-sync.oauth.resource-url:https://on-za-menya.online/vault-mcp}")
    private String resourceUrl;

    @Value("${vault-sync.oauth.issuer-uri:https://on-za-menya.online/realms/duq}")
    private String issuerUri;

    /**
     * MCP endpoints security - OAuth2 JWT required.
     * Higher priority (Order 1) than sync endpoints.
     */
    @Bean
    @Order(1)
    public SecurityFilterChain mcpSecurityFilterChain(HttpSecurity http) throws Exception {
        http
            .securityMatcher("/mcp/**", "/sse", "/.well-known/oauth-protected-resource")
            .csrf(csrf -> csrf.disable())
            .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(auth -> auth
                // RFC 9728: Protected Resource Metadata must be public
                .requestMatchers(HttpMethod.GET, "/.well-known/oauth-protected-resource").permitAll()
                // All MCP endpoints require OAuth2 JWT
                .requestMatchers("/mcp/**", "/sse").authenticated()
                .anyRequest().authenticated()
            )
            .oauth2ResourceServer(oauth2 -> oauth2
                .jwt(jwt -> {})
                // Custom 401 response with WWW-Authenticate header (RFC 9728)
                .authenticationEntryPoint((request, response, authException) -> {
                    log.warn("MCP auth failed: {} from {}", authException.getMessage(), request.getRemoteAddr());
                    response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
                    response.setContentType("application/json");
                    // RFC 9728: Include resource_metadata URL in WWW-Authenticate
                    response.setHeader("WWW-Authenticate",
                        "Bearer resource_metadata=\"" + resourceUrl + "/.well-known/oauth-protected-resource\"");
                    response.getWriter().write(
                        "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32001,\"message\":\"Unauthorized: OAuth2 token required\"},\"id\":null}"
                    );
                })
            );

        log.info("MCP OAuth2 Resource Server configured: issuer={}", issuerUri);
        return http.build();
    }
}
