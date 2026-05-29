package com.vaultsync.mcp;

import jakarta.annotation.PostConstruct;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * MCP endpoint filter - AUTHLESS mode.
 *
 * Security is provided by:
 * 1. HTTPS termination at duq-gateway (Let's Encrypt)
 * 2. Rate limiting at gateway level
 * 3. Read-only operations (no write/delete exposed)
 *
 * claude.ai does NOT support static Bearer tokens for remote MCP connectors.
 * See: https://claude.com/docs/connectors/building/authentication
 */
@Component
@Order(0)
@Slf4j
public class McpAuthFilter extends OncePerRequestFilter {

    @PostConstruct
    public void init() {
        log.info("MCP filter initialized (authless mode - security via HTTPS gateway)");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String path = request.getRequestURI();

        // MCP endpoints - pass through without auth (authless mode)
        if (path.startsWith("/mcp") || path.equals("/sse")) {
            log.debug("MCP request: {} {} from {}", request.getMethod(), path, request.getRemoteAddr());
            filterChain.doFilter(request, response);
            return;
        }

        // All other paths - pass to next filter (sync endpoints have their own auth)
        filterChain.doFilter(request, response);
    }
}
