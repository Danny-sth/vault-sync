package com.vaultsync.config;

import com.vaultsync.util.TokenValidator;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

@Configuration
public class SecurityConfig {

    @Value("${vault-sync.token}")
    private String authToken;

    // NOTE: no CorsConfigurationSource bean here. CORS is configured ONCE, in WebConfig
    // (MVC layer) — a second, unattached bean silently did nothing and just left two
    // places for the configs to drift apart.

    @Bean
    @Order(1)
    public OncePerRequestFilter tokenAuthFilter() {
        return new OncePerRequestFilter() {
            @Override
            protected void doFilterInternal(HttpServletRequest request,
                                            HttpServletResponse response,
                                            FilterChain filterChain) throws ServletException, IOException {
                String path = request.getRequestURI();

                if (path.equals("/health") || path.startsWith("/actuator")) {
                    filterChain.doFilter(request, response);
                    return;
                }

                if (path.startsWith("/ws")) {
                    filterChain.doFilter(request, response);
                    return;
                }

                if (path.startsWith("/mcp") || path.equals("/sse") || path.startsWith("/.well-known")) {
                    filterChain.doFilter(request, response);
                    return;
                }

                if (path.startsWith("/api")) {
                    String token = request.getHeader("X-Auth-Token");
                    if (token == null) {
                        token = request.getParameter("token");
                    }
                    if (token == null) {
                        String authHeader = request.getHeader("Authorization");
                        if (authHeader != null && authHeader.startsWith("Bearer ")) {
                            token = authHeader.substring(7);
                        }
                    }

                    if (!TokenValidator.validate(token, authToken)) {
                        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
                        response.getWriter().write("{\"error\": \"Unauthorized\"}");
                        return;
                    }
                }

                filterChain.doFilter(request, response);
            }
        };
    }
}
