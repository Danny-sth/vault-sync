package com.vaultsync.mcp;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

/**
 * Service for executing pre-approved shell commands.
 * Only commands in the whitelist can be executed.
 * Commands must exist as executable scripts in the commands directory.
 */
@Service
@Slf4j
public class CommandExecutionService {

    private final Path commandsPath;
    private final Set<String> allowedCommands;
    private final long timeoutSeconds;

    public CommandExecutionService(
            @Value("${vault-sync.commands-path:/opt/vault-sync/commands}") String commandsPathStr,
            @Value("#{'${vault-sync.allowed-commands:}'.split(',')}") List<String> allowedCommandsList,
            @Value("${vault-sync.command-timeout-seconds:30}") long timeoutSeconds) {

        this.commandsPath = Paths.get(commandsPathStr).toAbsolutePath().normalize();
        this.allowedCommands = Set.copyOf(allowedCommandsList);
        this.timeoutSeconds = timeoutSeconds;

        log.info("CommandExecutionService initialized:");
        log.info("  Commands path: {}", this.commandsPath);
        log.info("  Allowed commands: {}", this.allowedCommands);
        log.info("  Timeout: {}s", this.timeoutSeconds);

        if (this.allowedCommands.isEmpty()) {
            log.warn("No commands are whitelisted. execute_command tool will reject all requests.");
        }
    }

    /**
     * Execute a pre-approved shell command.
     *
     * @param commandName Name of the command to execute (must be in whitelist)
     * @return Execution result with stdout, stderr, and exit code
     * @throws SecurityException if command is not whitelisted
     * @throws IOException if command cannot be executed
     */
    public ExecutionResult executeCommand(String commandName) throws IOException {
        log.info("Executing command: {}", commandName);

        // Whitelist check
        if (!allowedCommands.contains(commandName)) {
            throw new SecurityException("Command not whitelisted: " + commandName);
        }

        // Resolve command path
        Path scriptPath = resolveCommandPath(commandName);

        if (!Files.exists(scriptPath)) {
            throw new IOException("Command script not found: " + scriptPath);
        }

        if (!Files.isExecutable(scriptPath)) {
            throw new IOException("Command script is not executable: " + scriptPath);
        }

        // Execute command
        ProcessBuilder pb = new ProcessBuilder(scriptPath.toString());
        pb.redirectErrorStream(false);

        Process process = pb.start();

        // Read stdout and stderr
        StringBuilder stdout = new StringBuilder();
        StringBuilder stderr = new StringBuilder();

        try (BufferedReader outReader = new BufferedReader(new InputStreamReader(process.getInputStream()));
             BufferedReader errReader = new BufferedReader(new InputStreamReader(process.getErrorStream()))) {

            // Wait for completion with timeout
            boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);

            if (!finished) {
                process.destroyForcibly();
                throw new IOException("Command timed out after " + timeoutSeconds + " seconds");
            }

            // Read all output
            outReader.lines().forEach(line -> stdout.append(line).append("\n"));
            errReader.lines().forEach(line -> stderr.append(line).append("\n"));

            int exitCode = process.exitValue();

            log.info("Command '{}' completed with exit code {}", commandName, exitCode);

            return new ExecutionResult(
                    exitCode == 0,
                    commandName,
                    exitCode,
                    stdout.toString(),
                    stderr.toString()
            );

        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            process.destroyForcibly();
            throw new IOException("Command execution interrupted", e);
        }
    }

    /**
     * Resolve command name to script path with security validation.
     *
     * @param commandName Command name (e.g., "vpn-russia")
     * @return Safe resolved path to the script
     * @throws SecurityException if path traversal is detected
     */
    private Path resolveCommandPath(String commandName) {
        if (commandName == null || commandName.isBlank()) {
            throw new IllegalArgumentException("Command name cannot be null or empty");
        }

        // Security: prevent path traversal
        if (commandName.contains("/") || commandName.contains("\\") ||
                commandName.contains("..") || commandName.contains(":")) {
            throw new SecurityException("Invalid command name: path traversal detected in '" + commandName + "'");
        }

        // Resolve script path (try .sh extension first, then without)
        Path scriptPath = commandsPath.resolve(commandName + ".sh").normalize();

        // Critical security check: resolved path MUST start with commands path
        if (!scriptPath.startsWith(commandsPath)) {
            throw new SecurityException("Invalid command: attempted to access '" + commandName + "' outside commands directory");
        }

        // If .sh doesn't exist, try without extension
        if (!Files.exists(scriptPath)) {
            scriptPath = commandsPath.resolve(commandName).normalize();
            if (!scriptPath.startsWith(commandsPath)) {
                throw new SecurityException("Invalid command: attempted to access '" + commandName + "' outside commands directory");
            }
        }

        return scriptPath;
    }

    /**
     * Get list of available (whitelisted) commands.
     *
     * @return List of command names that can be executed
     */
    public List<String> getAvailableCommands() {
        return new ArrayList<>(allowedCommands);
    }

    /**
     * Execution result record.
     */
    public record ExecutionResult(
            boolean success,
            String command,
            int exitCode,
            String stdout,
            String stderr
    ) {
    }
}
