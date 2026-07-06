package com.vaultsync.config;

import com.vaultsync.util.TokenValidator;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.Message;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.simp.config.ChannelRegistration;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.ChannelInterceptor;
import org.springframework.messaging.support.MessageHeaderAccessor;
import org.springframework.web.socket.config.annotation.EnableWebSocketMessageBroker;
import org.springframework.web.socket.config.annotation.StompEndpointRegistry;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketTransportRegistration;

import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

import java.security.Principal;

@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {

    /**
     * STOMP frame ceiling. The full-state sync response is ONE frame listing every file
     * and tombstone; on a large vault (long encrypted paths) it can pass 4MB, and an
     * oversized frame is dropped SILENTLY — the stale device just never syncs. So the
     * limit is config (prod raises it) instead of a hardcoded 4MB.
     */
    @Value("${vault-sync.ws-message-size-bytes:16777216}")
    private int wsMessageSizeBytes;

    @Value("${vault-sync.ws-session-idle-timeout-ms:600000}")
    private long wsSessionIdleTimeoutMs;

    /**
     * Configure native WebSocket container buffer sizes.
     * Required for Tomcat 11+ to handle large STOMP messages.
     */
    @Bean
    public ServletServerContainerFactoryBean createWebSocketContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        container.setMaxTextMessageBufferSize(wsMessageSizeBytes);
        container.setMaxBinaryMessageBufferSize(wsMessageSizeBytes);
        container.setMaxSessionIdleTimeout(wsSessionIdleTimeoutMs);
        return container;
    }

    @Value("${vault-sync.token}")
    private String authToken;

    @Bean
    public TaskScheduler heartbeatScheduler() {
        ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
        scheduler.setPoolSize(1);
        scheduler.setThreadNamePrefix("ws-heartbeat-");
        scheduler.initialize();
        return scheduler;
    }

    @Override
    public void configureMessageBroker(MessageBrokerRegistry config) {
        config.enableSimpleBroker("/topic", "/queue")
              .setHeartbeatValue(new long[] {60000, 60000})
              .setTaskScheduler(heartbeatScheduler());
        config.setApplicationDestinationPrefixes("/app");
        config.setUserDestinationPrefix("/user");
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        registry.addEndpoint("/ws")
                .setAllowedOriginPatterns("*");
        registry.addEndpoint("/ws")
                .setAllowedOriginPatterns("*")
                .withSockJS();
    }

    @Override
    public void configureWebSocketTransport(WebSocketTransportRegistration registration) {
        registration.setSendBufferSizeLimit(wsMessageSizeBytes);
        registration.setMessageSizeLimit(wsMessageSizeBytes);
        registration.setSendTimeLimit(120 * 1000);
    }

    @Override
    public void configureClientInboundChannel(ChannelRegistration registration) {
        registration.interceptors(new ChannelInterceptor() {
            @Override
            public Message<?> preSend(Message<?> message, MessageChannel channel) {
                StompHeaderAccessor accessor = MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);

                if (accessor != null && StompCommand.CONNECT.equals(accessor.getCommand())) {
                    String token = accessor.getFirstNativeHeader("X-Auth-Token");
                    String deviceId = accessor.getFirstNativeHeader("X-Device-Id");

                    if (!TokenValidator.validate(token, authToken)) {
                        throw new SecurityException("Invalid authentication token");
                    }

                    if (deviceId != null && !deviceId.isBlank()) {
                        accessor.setUser(new DevicePrincipal(deviceId));
                    }
                }
                return message;
            }
        });
    }

    private record DevicePrincipal(String deviceId) implements Principal {
        @Override
        public String getName() {
            return deviceId;
        }
    }
}
