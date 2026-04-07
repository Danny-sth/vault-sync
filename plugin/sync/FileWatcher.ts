import { App, TFile, TFolder, Vault } from 'obsidian';
import { LocalState } from '../storage/LocalState';

export interface FileChange {
  type: 'create' | 'modify' | 'delete';
  path: string;
  file?: TFile;
}

export class FileWatcher {
  private app: App;
  private localState: LocalState;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isScanning = false;
  private lastScanFiles: Map<string, { mtime: number; size: number }> = new Map();

  onChangesDetected?: (changes: FileChange[]) => void;

  constructor(app: App, localState: LocalState) {
    this.app = app;
    this.localState = localState;
  }

  /**
   * Start periodic file system scanning
   * @param intervalMs - scan interval in milliseconds (default 10 seconds)
   */
  start(intervalMs: number = 10000): void {
    if (this.intervalId) {
      return; // Already running
    }

    console.log(`[FileWatcher] Starting with ${intervalMs}ms interval`);

    // Initial scan to build baseline
    this.buildBaseline();

    // Start periodic scanning
    this.intervalId = setInterval(() => {
      this.scan();
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[FileWatcher] Stopped');
    }
  }

  /**
   * Build initial baseline of all files
   */
  private buildBaseline(): void {
    this.lastScanFiles.clear();
    const files = this.app.vault.getFiles();

    for (const file of files) {
      if (this.shouldWatch(file.path)) {
        this.lastScanFiles.set(file.path, {
          mtime: file.stat.mtime,
          size: file.stat.size,
        });
      }
    }

    console.log(`[FileWatcher] Baseline built with ${this.lastScanFiles.size} files`);
  }

  /**
   * Scan for changes since last scan
   */
  private async scan(): Promise<void> {
    if (this.isScanning) {
      return; // Skip if previous scan still running
    }

    this.isScanning = true;
    const changes: FileChange[] = [];

    try {
      const currentFiles = new Map<string, TFile>();
      const vaultFiles = this.app.vault.getFiles();

      // Build current state
      for (const file of vaultFiles) {
        if (this.shouldWatch(file.path)) {
          currentFiles.set(file.path, file);
        }
      }

      // Detect new and modified files
      for (const [path, file] of currentFiles) {
        const lastState = this.lastScanFiles.get(path);

        if (!lastState) {
          // New file
          changes.push({ type: 'create', path, file });
          console.log(`[FileWatcher] Detected new file: ${path}`);
        } else if (
          file.stat.mtime !== lastState.mtime ||
          file.stat.size !== lastState.size
        ) {
          // Modified file
          changes.push({ type: 'modify', path, file });
          console.log(`[FileWatcher] Detected modified file: ${path}`);
        }
      }

      // Detect deleted files
      for (const [path] of this.lastScanFiles) {
        if (!currentFiles.has(path)) {
          changes.push({ type: 'delete', path });
          console.log(`[FileWatcher] Detected deleted file: ${path}`);
        }
      }

      // Update baseline
      this.lastScanFiles.clear();
      for (const [path, file] of currentFiles) {
        this.lastScanFiles.set(path, {
          mtime: file.stat.mtime,
          size: file.stat.size,
        });
      }

      // Notify about changes
      if (changes.length > 0 && this.onChangesDetected) {
        console.log(`[FileWatcher] Detected ${changes.length} changes`);
        this.onChangesDetected(changes);
      }
    } catch (e) {
      console.error('[FileWatcher] Scan error:', e);
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Force immediate scan (useful after external operations)
   */
  async forceScan(): Promise<void> {
    console.log('[FileWatcher] Force scan requested');
    await this.scan();
  }

  /**
   * Check if file should be watched
   */
  private shouldWatch(path: string): boolean {
    // Skip hidden files and directories
    if (path.startsWith('.')) return false;
    if (path.includes('/.')) return false;

    // Skip specific patterns
    const excludePatterns = ['.git/', '.DS_Store', 'Thumbs.db', '.tmp', '.temp'];
    for (const pattern of excludePatterns) {
      if (path.includes(pattern)) return false;
    }

    return true;
  }

  /**
   * Mark file as processed (update baseline without triggering change)
   */
  markProcessed(path: string, mtime: number, size: number): void {
    this.lastScanFiles.set(path, { mtime, size });
  }

  /**
   * Remove file from baseline (after delete)
   */
  removeFromBaseline(path: string): void {
    this.lastScanFiles.delete(path);
  }
}
