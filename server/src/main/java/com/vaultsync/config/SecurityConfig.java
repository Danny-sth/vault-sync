package com.vaultsync.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.security.MessageDigest;
import java.util.List;

@Configuration
public class SecurityConfig {

    @Value("${vault-sync.token}")
    private String authToken;

    @Bean
    public CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration configuration = new CorsConfiguration();
        configuration.setAllowedOriginPatterns(List.of("*"));
        configuration.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE", "OPTIONS"));
        configuration.setAllowedHeaders(List.of("*"));
        configuration.setExposedHeaders(List.of("X-File-Hash", "X-File-Mtime", "X-File-Size"));
        configuration.setAllowCredentials(true);

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", configuration);
        return source;
    }

    @Bean
    @Order(1)
    public OncePerRequestFilter tokenAuthFilter() {
        return new OncePerRequestFilter() {
            @Override
            protected void doFilterInternal(HttpServletRequest request,
                                            HttpServletResponse response,
                                            FilterChain filterChain) throws ServletException, IOException {
                String path = request.getRequestURI();

                // Skip auth for health check and actuator
                if (path.equals("/health") || path.startsWith("/actuator")) {
                    filterChain.doFilter(request, response);
                    return;
                }

                // Skip auth for WebSocket (handled by WebSocketConfig)
                if (path.startsWith("/ws")) {
                    filterChain.doFilter(request, response);
                    return;
                }

                // Check token for API endpoints
                if (path.startsWith("/api")) {
                    String token = request.getHeader("X-Auth-Token");
                    if (token == null) {
                        token = request.getParameter("token");
                    }

                    if (token == null || !constantTimeEquals(token, authToken)) {
                        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
                        response.getWriter().write("{\"error\": \"Unauthorized\"}");
                        return;
                    }
                }

                filterChain.doFilter(request, response);
            }

            private boolean constantTimeEquals(String a, String b) {
                if (a == null || b == null) return false;
                return MessageDigest.isEqual(a.getBytes(), b.getBytes());
            }
        };
    }
}
