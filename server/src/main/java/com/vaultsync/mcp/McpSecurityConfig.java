package com.vaultsync.mcp;

import com.vaultsync.util.TokenValidator;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * Static-token security for MCP endpoints.
 *
 * MCP endpoints (`/mcp/**`, `/sse`) require a static bearer token
 * (`vault-sync.mcp-token`) — same model as the sync REST API. The token does not
 * expire, so there is no refresh-flow that can hang the openclaw agent startup.
 */
@Configuration
@EnableWebSecurity
@Slf4j
public class McpSecurityConfig {

    @Value("${vault-sync.mcp-token}")
    private String mcpToken;

    /**
     * MCP endpoints — static bearer token only.
     */
    @Bean
    @Order(1)
    public SecurityFilterChain mcpSecurityFilterChain(HttpSecurity http) throws Exception {
        http
            .securityMatcher("/mcp/**", "/sse")
            .csrf(csrf -> csrf.disable())
            .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            // Only authorize the initial REQUEST, not ASYNC/ERROR re-dispatches: spring-ai's
            // streamable MCP processes responses on an async dispatch that has no
            // SecurityContext, so re-checking it there throws Access Denied + "Missing result
            // context". The original request was already authenticated.
            .authorizeHttpRequests(auth -> auth
                .shouldFilterAllDispatcherTypes(false)
                .anyRequest().authenticated())
            .addFilterBefore(mcpTokenFilter(), UsernamePasswordAuthenticationFilter.class)
            .exceptionHandling(ex -> ex.authenticationEntryPoint((request, response, authException) -> {
                log.warn("MCP auth failed (static token) from {}", request.getRemoteAddr());
                response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
                response.setContentType("application/json");
                response.getWriter().write(
                    "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32001,\"message\":\"Unauthorized: MCP token required\"},\"id\":null}"
                );
            }));

        log.info("MCP security configured: static bearer token");
        return http.build();
    }

    /** Validates `Authorization: Bearer <mcp-token>` in constant time; sets auth on match. */
    private OncePerRequestFilter mcpTokenFilter() {
        return new OncePerRequestFilter() {
            @Override
            protected void doFilterInternal(HttpServletRequest request,
                                            HttpServletResponse response,
                                            FilterChain filterChain) throws ServletException, IOException {
                String token = null;
                String authHeader = request.getHeader("Authorization");
                if (authHeader != null && authHeader.startsWith("Bearer ")) {
                    token = authHeader.substring(7);
                }
                if (token == null) {
                    token = request.getHeader("X-Auth-Token");
                }

                if (TokenValidator.validate(token, mcpToken)) {
                    var auth = new UsernamePasswordAuthenticationToken(
                        "mcp-client", null, AuthorityUtils.createAuthorityList("ROLE_MCP"));
                    SecurityContextHolder.getContext().setAuthentication(auth);
                }
                filterChain.doFilter(request, response);
            }
        };
    }
}
