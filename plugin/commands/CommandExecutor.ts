import { Notice, requestUrl } from 'obsidian';
import { VaultSyncSettings } from '../types';

/**
 * Execute whitelisted commands on the server.
 */
export class CommandExecutor {
  constructor(private settings: VaultSyncSettings) {}

  /**
   * Execute a command on the server.
   */
  async executeCommand(commandName: string): Promise<CommandResult> {
    const url = `${this.settings.serverUrl}/api/v1/commands/execute/${commandName}`;

    try {
      console.log(`[VaultSync] Executing command: ${commandName}`);
      new Notice(`Executing: ${commandName}...`);

      const response = await requestUrl({
        url,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.settings.token}`,
          'Content-Type': 'application/json',
        },
      });

      const result = response.json as CommandExecutionResponse;

      if (result.success) {
        console.log(`[VaultSync] Command completed: ${commandName}`, result);
        new Notice(`✓ ${commandName} completed`);

        // Show output if any
        if (result.stdout) {
          console.log(`[VaultSync] Command output:\n${result.stdout}`);
        }
        if (result.stderr) {
          console.warn(`[VaultSync] Command stderr:\n${result.stderr}`);
        }
      } else {
        console.error(`[VaultSync] Command failed: ${commandName}`, result.error);
        new Notice(`✗ ${commandName} failed: ${result.error || 'Unknown error'}`);
      }

      return {
        success: result.success,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.exitCode,
        error: result.error,
      };
    } catch (error) {
      console.error(`[VaultSync] Command execution error:`, error);
      new Notice(`✗ Failed to execute ${commandName}`);

      return {
        success: false,
        stdout: '',
        stderr: '',
        exitCode: -1,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get list of available commands from server.
   */
  async getAvailableCommands(): Promise<string[]> {
    const url = `${this.settings.serverUrl}/api/v1/commands/available`;

    try {
      const response = await requestUrl({
        url,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.settings.token}`,
        },
      });

      const result = response.json as AvailableCommandsResponse;
      return result.commands;
    } catch (error) {
      console.error(`[VaultSync] Failed to get available commands:`, error);
      return [];
    }
  }
}

interface CommandExecutionResponse {
  success: boolean;
  command: string | null;
  exitCode: number;
  stdout: string | null;
  stderr: string | null;
  error: string | null;
}

interface AvailableCommandsResponse {
  commands: string[];
}

export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string | null;
}
