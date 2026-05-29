package com.vaultsync.mcp;

import lombok.extern.slf4j.Slf4j;
import org.springframework.ai.tool.ToolCallback;
import org.springframework.ai.tool.method.MethodToolCallbackProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.List;

/**
 * MCP Server configuration.
 * Registers tools and configures the MCP server.
 */
@Configuration
@Slf4j
public class McpConfig {

    /**
     * Register MCP tools with the MethodToolCallbackProvider.
     * This exposes @Tool annotated methods to the MCP server.
     */
    @Bean
    public MethodToolCallbackProvider toolCallbackProvider(VaultMcpTools vaultMcpTools) {
        log.info("Registering MCP tools from VaultMcpTools");
        return MethodToolCallbackProvider.builder()
                .toolObjects(vaultMcpTools)
                .build();
    }

    /**
     * Expose tool callbacks as a list for MCP server auto-configuration.
     */
    @Bean
    public List<ToolCallback> mcpToolCallbacks(MethodToolCallbackProvider provider) {
        ToolCallback[] callbacks = provider.getToolCallbacks();
        log.info("Registered {} MCP tool callbacks", callbacks.length);
        for (ToolCallback callback : callbacks) {
            log.info("  - Tool: {}", callback.getToolDefinition().name());
        }
        return List.of(callbacks);
    }
}
