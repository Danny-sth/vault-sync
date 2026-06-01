package com.vaultsync.mcp;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.io.IOException;

/**
 * REST API for executing whitelisted commands.
 * This provides HTTP access to command execution for Obsidian buttons plugin.
 */
@RestController
@RequestMapping("/api/v1/commands")
@RequiredArgsConstructor
@Slf4j
public class CommandController {

    private final CommandExecutionService commandService;

    /**
     * Execute a pre-approved command.
     *
     * @param commandName Name of the command to execute
     * @return Execution result
     */
    @PostMapping("/execute/{commandName}")
    public ResponseEntity<CommandExecutionResponse> executeCommand(
            @PathVariable String commandName) {
        log.info("REST API: execute command: {}", commandName);

        if (commandName == null || commandName.isBlank()) {
            return ResponseEntity.badRequest()
                    .body(new CommandExecutionResponse(
                            false,
                            null,
                            -1,
                            null,
                            null,
                            "Command name is required"
                    ));
        }

        try {
            CommandExecutionService.ExecutionResult result = commandService.executeCommand(commandName);
            return ResponseEntity.ok(new CommandExecutionResponse(
                    result.success(),
                    result.command(),
                    result.exitCode(),
                    result.stdout(),
                    result.stderr(),
                    null
            ));
        } catch (SecurityException e) {
            log.warn("Security violation in execute command: {}", e.getMessage());
            return ResponseEntity.status(403)
                    .body(new CommandExecutionResponse(
                            false,
                            commandName,
                            -1,
                            null,
                            null,
                            "Access denied: " + e.getMessage()
                    ));
        } catch (IOException e) {
            log.error("Failed to execute command {}: {}", commandName, e.getMessage());
            return ResponseEntity.status(500)
                    .body(new CommandExecutionResponse(
                            false,
                            commandName,
                            -1,
                            null,
                            null,
                            "Execution failed: " + e.getMessage()
                    ));
        } catch (Exception e) {
            log.error("Unexpected error executing command {}", commandName, e);
            return ResponseEntity.status(500)
                    .body(new CommandExecutionResponse(
                            false,
                            commandName,
                            -1,
                            null,
                            null,
                            "Unexpected error: " + e.getMessage()
                    ));
        }
    }

    /**
     * Get list of available commands.
     *
     * @return List of whitelisted command names
     */
    @GetMapping("/available")
    public ResponseEntity<AvailableCommandsResponse> getAvailableCommands() {
        log.info("REST API: get available commands");
        return ResponseEntity.ok(new AvailableCommandsResponse(
                commandService.getAvailableCommands()
        ));
    }

    /**
     * Response for command execution.
     */
    public record CommandExecutionResponse(
            boolean success,
            String command,
            int exitCode,
            String stdout,
            String stderr,
            String error
    ) {
    }

    /**
     * Response for available commands list.
     */
    public record AvailableCommandsResponse(
            java.util.List<String> commands
    ) {
    }
}
