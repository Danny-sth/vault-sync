import { App, FileSystemAdapter, Notice, Platform } from 'obsidian';
import { VaultSyncSettings } from '../types';

/**
 * Run shell scripts that live INSIDE the vault, locally on this device.
 *
 * The vault is just storage: any `*.sh` script synced into it becomes a
 * runnable command. Pressing a button runs that script right here (e.g.
 * `vpn-russia` runs `vpn-russia.sh` and brings the tunnel up locally).
 *
 * No whitelist, no server — every script in the vault is allowed.
 */
export class CommandExecutor {
  /** command name (script basename without .sh) -> absolute path on disk */
  private scripts: Map<string, string> = new Map();

  constructor(private app: App, private settings: VaultSyncSettings) {}

  /** Absolute filesystem path of the vault root (desktop only). */
  private get vaultPath(): string | null {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    return null;
  }

  /**
   * Discover available commands: every `*.sh` script in the vault.
   * Command name is the script's basename without the `.sh` suffix.
   */
  async getAvailableCommands(): Promise<string[]> {
    this.scripts.clear();

    if (!Platform.isDesktopApp) {
      return [];
    }

    let fs: typeof import('fs');
    let path: typeof import('path');
    try {
      fs = require('fs');
      path = require('path');
    } catch {
      return [];
    }

    const root = this.vaultPath;
    if (!root) {
      return [];
    }

    const walk = (dir: string): void => {
      let entries: import('fs').Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) {
          continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.sh')) {
          const name = entry.name.slice(0, -3);
          if (!this.scripts.has(name)) {
            this.scripts.set(name, full);
          }
        }
      }
    };

    walk(root);

    const commands = Array.from(this.scripts.keys());
    console.log(`[VaultSync] Vault scripts found:`, commands);
    return commands;
  }

  /**
   * Open the vault script in a terminal and run it INTERACTIVELY.
   * Detached so Obsidian is not blocked; the user interacts in the terminal.
   */
  async executeCommand(commandName: string): Promise<CommandResult> {
    if (!Platform.isDesktopApp) {
      new Notice(`✗ ${commandName}: scripts run on desktop only`);
      return { success: false, stdout: '', stderr: '', exitCode: -1, error: 'desktop only' };
    }

    let childProcess: typeof import('child_process');
    try {
      childProcess = require('child_process');
    } catch (e) {
      new Notice(`✗ ${commandName}: cannot run scripts here`);
      return { success: false, stdout: '', stderr: '', exitCode: -1, error: String(e) };
    }

    let scriptPath = this.scripts.get(commandName);
    if (!scriptPath) {
      await this.getAvailableCommands();
      scriptPath = this.scripts.get(commandName);
    }
    if (!scriptPath) {
      console.error(`[VaultSync] No vault script found for command: ${commandName}`);
      new Notice(`✗ ${commandName}: script not found in vault`);
      return { success: false, stdout: '', stderr: '', exitCode: -1, error: 'script not found' };
    }

    const terminal = this.findTerminal();
    if (!terminal) {
      new Notice(`✗ ${commandName}: no terminal emulator found`);
      return { success: false, stdout: '', stderr: '', exitCode: -1, error: 'no terminal' };
    }

    console.log(`[VaultSync] Opening ${scriptPath} in terminal: ${terminal.bin}`);
    new Notice(`Открываю ${commandName} в терминале...`);

    try {
      const child = childProcess.spawn(terminal.bin, terminal.args(scriptPath), {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return { success: true, stdout: '', stderr: '', exitCode: 0, error: null };
    } catch (e) {
      console.error(`[VaultSync] Failed to open terminal for ${commandName}:`, e);
      new Notice(`✗ ${commandName}: не удалось открыть терминал`);
      return { success: false, stdout: '', stderr: '', exitCode: -1, error: String(e) };
    }
  }

  /**
   * Pick an available terminal emulator and build its launch arguments.
   * Keeps the terminal open after the script exits (`exec bash`).
   */
  private findTerminal(): { bin: string; args: (script: string) => string[] } | null {
    let childProcess: typeof import('child_process');
    try {
      childProcess = require('child_process');
    } catch {
      return null;
    }

    const exists = (bin: string): boolean => {
      try {
        childProcess.execFileSync('which', [bin], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    };

    const inner = (script: string): string =>
      `bash ${JSON.stringify(script)}; echo; echo '[нажми Enter чтобы закрыть]'; read`;

    const candidates: Array<{ bin: string; args: (script: string) => string[] }> = [
      { bin: 'gnome-terminal', args: (s) => ['--', 'bash', '-lc', inner(s)] },
      { bin: 'konsole', args: (s) => ['-e', 'bash', '-lc', inner(s)] },
      { bin: 'xfce4-terminal', args: (s) => ['-e', `bash -lc ${JSON.stringify(inner(s))}`] },
      { bin: 'x-terminal-emulator', args: (s) => ['-e', 'bash', '-lc', inner(s)] },
      { bin: 'xterm', args: (s) => ['-e', 'bash', '-lc', inner(s)] },
    ];

    for (const c of candidates) {
      if (exists(c.bin)) {
        return c;
      }
    }
    return null;
  }
}

export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string | null;
}
