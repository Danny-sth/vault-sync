import { App, TFile } from 'obsidian';
import { LocalState } from '../storage/LocalState';
import { SyncFilter } from './SyncFilter';

export interface FileChange {
  type: 'create' | 'modify' | 'delete';
  path: string;
  file?: TFile;
}

export class FileWatcher {
  private app: App;
  // localState retained for future use; FileWatcher stores baseline in-memory only.
  // @ts-ignore
  private localState: LocalState;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isScanning = false;
  // Vault-indexed files baseline.
  private lastScanFiles: Map<string, { mtime: number; size: number }> = new Map();
  // .obsidian/* baseline (separate API path — adapter.list, not vault.getFiles).
  private lastScanConfigFiles: Map<string, { mtime: number; size: number }> = new Map();

  onChangesDetected?: (changes: FileChange[]) => void;
  // Filter applied to .obsidian/* paths — set by SyncManager so device-specific files are skipped.
  shouldIncludeConfigPath?: (path: string) => boolean;

  constructor(app: App, localState: LocalState) {
    this.app = app;
    this.localState = localState;
  }

  /**
   * Start periodic file system scanning (vault + .obsidian/*).
   * @param intervalMs - scan interval in milliseconds (default 10 seconds)
   */
  start(intervalMs: number = 10000): void {
    if (this.intervalId) {
      return;
    }

    console.debug(`[FileWatcher] Starting with ${intervalMs}ms interval`);
    void this.buildBaseline();

    this.intervalId = setInterval(() => {
      void this.scan();
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.debug('[FileWatcher] Stopped');
    }
  }

  private async buildBaseline(): Promise<void> {
    this.lastScanFiles.clear();
    this.lastScanConfigFiles.clear();

    for (const file of this.app.vault.getFiles()) {
      if (SyncFilter.shouldWatchVaultFile(file.path)) {
        this.lastScanFiles.set(file.path, { mtime: file.stat.mtime, size: file.stat.size });
      }
    }

    for (const path of await SyncFilter.listObsidianFiles(this.app)) {
      if (!this.shouldIncludeConfigPath || this.shouldIncludeConfigPath(path)) {
        const stat = await this.app.vault.adapter.stat(path);
        if (stat) this.lastScanConfigFiles.set(path, { mtime: stat.mtime, size: stat.size });
      }
    }

    console.debug(`[FileWatcher] Baseline: ${this.lastScanFiles.size} vault files, ${this.lastScanConfigFiles.size} config files`);
  }

  private async scan(): Promise<void> {
    if (this.isScanning) return;
    this.isScanning = true;
    const changes: FileChange[] = [];

    try {
      // --- Vault-indexed files ---
      const currentFiles = new Map<string, TFile>();
      for (const file of this.app.vault.getFiles()) {
        if (SyncFilter.shouldWatchVaultFile(file.path)) currentFiles.set(file.path, file);
      }
      for (const [path, file] of currentFiles) {
        const last = this.lastScanFiles.get(path);
        if (!last) {
          changes.push({ type: 'create', path, file });
        } else if (file.stat.mtime !== last.mtime || file.stat.size !== last.size) {
          changes.push({ type: 'modify', path, file });
        }
      }
      for (const [path] of this.lastScanFiles) {
        if (!currentFiles.has(path)) changes.push({ type: 'delete', path });
      }
      this.lastScanFiles.clear();
      for (const [path, file] of currentFiles) {
        this.lastScanFiles.set(path, { mtime: file.stat.mtime, size: file.stat.size });
      }

      // --- .obsidian/* files via adapter ---
      const currentConfigs = new Map<string, { mtime: number; size: number }>();
      for (const path of await SyncFilter.listObsidianFiles(this.app)) {
        if (this.shouldIncludeConfigPath && !this.shouldIncludeConfigPath(path)) continue;
        const stat = await this.app.vault.adapter.stat(path);
        if (stat) currentConfigs.set(path, { mtime: stat.mtime, size: stat.size });
      }
      for (const [path, stat] of currentConfigs) {
        const last = this.lastScanConfigFiles.get(path);
        if (!last) {
          changes.push({ type: 'create', path });
        } else if (stat.mtime !== last.mtime || stat.size !== last.size) {
          changes.push({ type: 'modify', path });
        }
      }
      for (const [path] of this.lastScanConfigFiles) {
        if (!currentConfigs.has(path)) changes.push({ type: 'delete', path });
      }
      this.lastScanConfigFiles.clear();
      for (const [path, stat] of currentConfigs) {
        this.lastScanConfigFiles.set(path, stat);
      }

      if (changes.length > 0 && this.onChangesDetected) {
        console.debug(`[FileWatcher] Detected ${changes.length} changes`);
        this.onChangesDetected(changes);
      }
    } catch (e) {
      console.error('[FileWatcher] Scan error:', e);
    } finally {
      this.isScanning = false;
    }
  }

  async forceScan(): Promise<void> {
    console.debug('[FileWatcher] Force scan requested');
    await this.scan();
  }

  markProcessed(path: string, mtime: number, size: number): void {
    if (path.startsWith('.obsidian/')) {
      this.lastScanConfigFiles.set(path, { mtime, size });
    } else {
      this.lastScanFiles.set(path, { mtime, size });
    }
  }

  removeFromBaseline(path: string): void {
    if (path.startsWith('.obsidian/')) {
      this.lastScanConfigFiles.delete(path);
    } else {
      this.lastScanFiles.delete(path);
    }
  }
}
