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
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.security.oauth2.jwt.JwtDecoders;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
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

    @Value("${vault-sync.oauth.required-audience:vault-mcp}")
    private String requiredAudience;

    /**
     * Public OAuth metadata (RFC 9728/8414). Order 0, БЕЗ oauth2ResourceServer —
     * чтобы встроенный Spring OAuth2ProtectedResourceMetadataFilter НЕ перекрывал
     * наш ProtectedResourceMetadataController (он отдаёт правильные resource +
     * authorization_servers для claude.ai-коннектора).
     */
    @Bean
    @Order(0)
    public SecurityFilterChain wellKnownMetadataChain(HttpSecurity http) throws Exception {
        http
            .securityMatcher("/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server")
            .csrf(csrf -> csrf.disable())
            .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
        return http.build();
    }

    /**
     * MCP endpoints security - OAuth2 JWT required.
     * Higher priority (Order 1) than sync endpoints.
     */
    @Bean
    @Order(1)
    public SecurityFilterChain mcpSecurityFilterChain(HttpSecurity http) throws Exception {
        http
            .securityMatcher("/mcp/**", "/sse")
            .csrf(csrf -> csrf.disable())
            .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(auth -> auth
                // RFC 9728: Protected Resource Metadata must be public
                .requestMatchers(HttpMethod.GET, "/.well-known/oauth-protected-resource").permitAll()
                // RFC 8414: Authorization Server Metadata must be public
                .requestMatchers(HttpMethod.GET, "/.well-known/oauth-authorization-server").permitAll()
                // All MCP endpoints require OAuth2 JWT (/api/v1/commands/** uses simple token auth)
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

        log.info("MCP OAuth2 Resource Server configured: issuer={}, required_audience={}", issuerUri, requiredAudience);
        return http.build();
    }

    /**
     * JWT Decoder with audience validation (RFC 8707).
     * Only tokens with aud=vault-mcp are accepted.
     */
    @Bean
    public JwtDecoder jwtDecoder() {
        // Lazy delegate: the real Nimbus decoder (which fetches OIDC discovery
        // from Keycloak) is built on the FIRST token validation, not at startup.
        // Spring Security's fromIssuerLocation/withIssuerLocation resolve eagerly,
        // which crash-looped the whole sync server whenever Keycloak was down.
        return new JwtDecoder() {
            private volatile JwtDecoder delegate;

            @Override
            public Jwt decode(String token) throws JwtException {
                JwtDecoder d = delegate;
                if (d == null) {
                    synchronized (this) {
                        if (delegate == null) {
                            delegate = buildDecoder();
                        }
                        d = delegate;
                    }
                }
                return d.decode(token);
            }
        };
    }

    /** Builds the real audience-validating decoder (fetches OIDC metadata on first use). */
    private JwtDecoder buildDecoder() {
        NimbusJwtDecoder decoder = JwtDecoders.fromIssuerLocation(issuerUri);

        // Add audience validator
        decoder.setJwtValidator(token -> {
            // First validate standard claims (issuer, expiration, etc.)
            var defaultResult = JwtValidators.createDefaultWithIssuer(issuerUri).validate(token);
            if (defaultResult.hasErrors()) {
                return defaultResult;
            }

            // Then validate audience
            var audience = token.getAudience();
            if (audience == null || !audience.contains(requiredAudience)) {
                log.warn("Token rejected: missing required audience '{}', got: {}", requiredAudience, audience);
                return OAuth2TokenValidatorResult.failure(
                    new org.springframework.security.oauth2.core.OAuth2Error(
                        "invalid_token",
                        "Token not issued for this resource (missing audience: " + requiredAudience + ")",
                        null
                    )
                );
            }

            return OAuth2TokenValidatorResult.success();
        });

        log.info("JwtDecoder configured with audience validation: required_audience={}", requiredAudience);
        return decoder;
    }
}
