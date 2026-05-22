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

import java.security.Principal;

@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {

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
        config.enableSimpleBroker("/topic", "/queue")
              .setHeartbeatValue(new long[] {10000, 10000})  // server-to-client, client-to-server (ms)
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
        // Increase buffer sizes for large sync responses
        registration.setSendBufferSizeLimit(2 * 1024 * 1024);  // 2MB send buffer
        registration.setMessageSizeLimit(2 * 1024 * 1024);     // 2MB message size
        registration.setSendTimeLimit(30 * 1000);               // 30 seconds send timeout
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
