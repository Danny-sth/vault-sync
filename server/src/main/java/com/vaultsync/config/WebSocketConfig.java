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
     * Configure native WebSocket container buffer sizes.
     * Required for Tomcat 11+ to handle large STOMP messages.
     */
    @Bean
    public ServletServerContainerFactoryBean createWebSocketContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        container.setMaxTextMessageBufferSize(4 * 1024 * 1024);  // 4MB for large sync responses
        container.setMaxBinaryMessageBufferSize(4 * 1024 * 1024); // 4MB
        container.setMaxSessionIdleTimeout(600000L); // 10 minutes
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
        // Enable simple broker for subscriptions with heartbeat
        // Using 60 seconds heartbeat to allow time for large sync responses (5000+ files)
        config.enableSimpleBroker("/topic", "/queue")
              .setHeartbeatValue(new long[] {60000, 60000})  // server-to-client, client-to-server (ms)
              .setTaskScheduler(heartbeatScheduler());
        // Prefix for messages FROM clients
        config.setApplicationDestinationPrefixes("/app");
        // Prefix for user-specific messages
        config.setUserDestinationPrefix("/user");
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        registry.addEndpoint("/ws")
                .setAllowedOriginPatterns("*");
        // SockJS fallback for browsers that don't support WebSocket
        registry.addEndpoint("/ws")
                .setAllowedOriginPatterns("*")
                .withSockJS();
    }

    @Override
    public void configureWebSocketTransport(WebSocketTransportRegistration registration) {
        // Increase buffer sizes for large sync responses (5000+ files = several MB)
        registration.setSendBufferSizeLimit(4 * 1024 * 1024);  // 4MB send buffer
        registration.setMessageSizeLimit(4 * 1024 * 1024);     // 4MB message size
        registration.setSendTimeLimit(120 * 1000);              // 120 seconds send timeout (mobile networks are slow)
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

                    // Set user principal for user-specific messaging
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
