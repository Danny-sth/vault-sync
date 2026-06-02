import { App, TFile } from 'obsidian';
import { SyncFilter } from './SyncFilter';

export interface FileChange {
  type: 'create' | 'modify' | 'delete';
  path: string;
  file?: TFile;
}

export class FileWatcher {
  private app: App;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isScanning = false;
  private lastScanFiles: Map<string, { mtime: number; size: number }> = new Map();
  private lastScanConfigFiles: Map<string, { mtime: number; size: number }> = new Map();
  private lastScanHiddenFiles: Map<string, { mtime: number; size: number }> = new Map();
  private lastScanAllHiddenFiles: Map<string, { mtime: number; size: number }> = new Map();

  onChangesDetected?: (changes: FileChange[]) => void;
  shouldIncludeConfigPath?: (path: string) => boolean;

  constructor(app: App) {
    this.app = app;
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
    this.lastScanHiddenFiles.clear();
    this.lastScanAllHiddenFiles.clear();

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

    for (const path of await SyncFilter.listHiddenFiles(this.app)) {
      const stat = await this.app.vault.adapter.stat(path);
      if (stat) this.lastScanHiddenFiles.set(path, { mtime: stat.mtime, size: stat.size });
    }

    for (const path of await SyncFilter.listAllHiddenFilesInVault(this.app)) {
      const stat = await this.app.vault.adapter.stat(path);
      if (stat) this.lastScanAllHiddenFiles.set(path, { mtime: stat.mtime, size: stat.size });
    }

    console.debug(`[FileWatcher] Baseline: ${this.lastScanFiles.size} vault, ${this.lastScanConfigFiles.size} config, ${this.lastScanHiddenFiles.size} hidden, ${this.lastScanAllHiddenFiles.size} allHidden`);
  }

  private async scan(): Promise<void> {
    if (this.isScanning) return;
    this.isScanning = true;
    const changes: FileChange[] = [];

    try {
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

      const currentHidden = new Map<string, { mtime: number; size: number }>();
      for (const path of await SyncFilter.listHiddenFiles(this.app)) {
        const stat = await this.app.vault.adapter.stat(path);
        if (stat) currentHidden.set(path, { mtime: stat.mtime, size: stat.size });
      }
      for (const [path, stat] of currentHidden) {
        const last = this.lastScanHiddenFiles.get(path);
        if (!last) {
          changes.push({ type: 'create', path });
        } else if (stat.mtime !== last.mtime || stat.size !== last.size) {
          changes.push({ type: 'modify', path });
        }
      }
      for (const [path] of this.lastScanHiddenFiles) {
        if (!currentHidden.has(path)) changes.push({ type: 'delete', path });
      }
      this.lastScanHiddenFiles.clear();
      for (const [path, stat] of currentHidden) {
        this.lastScanHiddenFiles.set(path, stat);
      }

      const currentAllHidden = new Map<string, { mtime: number; size: number }>();
      for (const path of await SyncFilter.listAllHiddenFilesInVault(this.app)) {
        const stat = await this.app.vault.adapter.stat(path);
        if (stat) currentAllHidden.set(path, { mtime: stat.mtime, size: stat.size });
      }
      for (const [path, stat] of currentAllHidden) {
        const last = this.lastScanAllHiddenFiles.get(path);
        if (!last) {
          changes.push({ type: 'create', path });
        } else if (stat.mtime !== last.mtime || stat.size !== last.size) {
          changes.push({ type: 'modify', path });
        }
      }
      for (const [path] of this.lastScanAllHiddenFiles) {
        if (!currentAllHidden.has(path)) changes.push({ type: 'delete', path });
      }
      this.lastScanAllHiddenFiles.clear();
      for (const [path, stat] of currentAllHidden) {
        this.lastScanAllHiddenFiles.set(path, stat);
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
    } else if (path.startsWith('.')) {
      this.lastScanHiddenFiles.set(path, { mtime, size });
    } else if (this.isHiddenFileName(path)) {
      this.lastScanAllHiddenFiles.set(path, { mtime, size });
    } else {
      this.lastScanFiles.set(path, { mtime, size });
    }
  }

  removeFromBaseline(path: string): void {
    if (path.startsWith('.obsidian/')) {
      this.lastScanConfigFiles.delete(path);
    } else if (path.startsWith('.')) {
      this.lastScanHiddenFiles.delete(path);
    } else if (this.isHiddenFileName(path)) {
      this.lastScanAllHiddenFiles.delete(path);
    } else {
      this.lastScanFiles.delete(path);
    }
  }

  private isHiddenFileName(path: string): boolean {
    const parts = path.split('/');
    const filename = parts[parts.length - 1];
    return filename.startsWith('.');
  }
}
