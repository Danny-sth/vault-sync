package com.vaultsync.mcp;

import com.vaultsync.util.TokenValidator;
import jakarta.annotation.PostConstruct;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * Authentication filter for MCP endpoints.
 * Uses a SEPARATE token from the sync token (VAULT_SYNC_MCP_TOKEN).
 * Implements constant-time comparison to prevent timing attacks.
 */
@Component
@Order(0) // Run before the general security filter
@Slf4j
public class McpAuthFilter extends OncePerRequestFilter {

    @Value("${vault-sync.mcp-token:}")
    private String mcpToken;

    @PostConstruct
    public void init() {
        if (mcpToken == null || mcpToken.isBlank()) {
            throw new IllegalStateException(
                    "VAULT_SYNC_MCP_TOKEN is not configured. " +
                            "MCP server cannot start without authentication token. " +
                            "Set VAULT_SYNC_MCP_TOKEN environment variable."
            );
        }
        log.info("MCP authentication filter initialized");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String path = request.getRequestURI();

        // Only handle MCP endpoints
        if (!path.startsWith("/mcp")) {
            filterChain.doFilter(request, response);
            return;
        }

        // Extract Bearer token from Authorization header
        String authHeader = request.getHeader("Authorization");
        String token = null;

        if (authHeader != null && authHeader.startsWith("Bearer ")) {
            token = authHeader.substring(7);
        }

        // Constant-time token validation
        if (!TokenValidator.validate(token, mcpToken)) {
            log.warn("MCP auth failed for {} from {}", path, request.getRemoteAddr());
            response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            response.setContentType("application/json");
            response.getWriter().write("{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32001,\"message\":\"Unauthorized\"},\"id\":null}");
            return;
        }

        log.debug("MCP auth successful for {} from {}", path, request.getRemoteAddr());
        filterChain.doFilter(request, response);
    }
}
