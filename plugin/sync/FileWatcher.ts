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
    // Baseline entries whose path vanished from a listing but is still on disk —
    // an index-lag/race artifact, not a deletion. Re-bucketed after the loops.
    const refuted: Array<{ path: string; mtime: number; size: number }> = [];

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
      for (const [path, last] of this.lastScanFiles) {
        if (currentFiles.has(path)) continue;
        if (await this.reallyGone(path)) changes.push({ type: 'delete', path });
        else refuted.push({ path, ...last });
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
      for (const [path, last] of this.lastScanConfigFiles) {
        if (currentConfigs.has(path)) continue;
        if (await this.reallyGone(path)) changes.push({ type: 'delete', path });
        else refuted.push({ path, ...last });
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
      for (const [path, last] of this.lastScanHiddenFiles) {
        if (currentHidden.has(path)) continue;
        if (await this.reallyGone(path)) changes.push({ type: 'delete', path });
        else refuted.push({ path, ...last });
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
      for (const [path, last] of this.lastScanAllHiddenFiles) {
        if (currentAllHidden.has(path)) continue;
        if (await this.reallyGone(path)) changes.push({ type: 'delete', path });
        else refuted.push({ path, ...last });
      }
      this.lastScanAllHiddenFiles.clear();
      for (const [path, stat] of currentAllHidden) {
        this.lastScanAllHiddenFiles.set(path, stat);
      }

      // A refuted delete usually means the file moved between listing buckets mid-scan
      // (e.g. Obsidian indexed a freshly-downloaded file after vault.getFiles() ran but
      // before listAllHiddenFilesInVault took its index snapshot — then the path is in
      // NEITHER listing this pass). Re-seed it into the bucket matching its CURRENT
      // index state so the next scan tracks it normally instead of re-flagging forever.
      for (const r of refuted) {
        this.markProcessed(r.path, r.mtime, r.size);
      }

      if (changes.length > 0 && this.onChangesDetected) {
        // Deduplicate: for the same path, create/modify beats delete.
        // This prevents false deletes when a file transitions from being discovered
        // via adapter scan (lastScanAllHiddenFiles) to being indexed by Obsidian's
        // vault (vault.getFiles()) — a transition that generates both a CREATE and a
        // DELETE in the same scan batch (e.g. .asc or other non-standard extensions).
        const dedupMap = new Map<string, FileChange>();
        for (const change of changes) {
          const existing = dedupMap.get(change.path);
          if (!existing || (existing.type === 'delete' && change.type !== 'delete')) {
            dedupMap.set(change.path, change);
          }
        }
        const dedupedChanges = Array.from(dedupMap.values());
        if (dedupedChanges.length !== changes.length) {
          console.debug(`[FileWatcher] Deduped ${changes.length} → ${dedupedChanges.length} changes`);
        }
        this.onChangesDetected(dedupedChanges);
      }
    } catch (e) {
      console.error('[FileWatcher] Scan error:', e);
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Confirm a "missing from listing" path is REALLY gone from disk before treating it
   * as a deletion. The listings this scanner diffs (vault index, adapter walks with an
   * index snapshot) can transiently drop a live file — mobile index lag turned exactly
   * that into a pushed server deletion followed by a resurrection upload (the
   * delete→resurrect flip-flop). The adapter is FS truth and immune to index state.
   * An exists() failure counts as "still there": never infer deletion from an error.
   */
  private async reallyGone(path: string): Promise<boolean> {
    try {
      return !(await this.app.vault.adapter.exists(path));
    } catch {
      return false;
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
    } else {
      // Use vault API to determine the correct baseline bucket.
      // Files with non-standard extensions (e.g. .asc, .gpg) may not be tracked
      // by vault.getFiles() until Obsidian explicitly indexes them. Putting such a
      // file in lastScanFiles (which is checked against vault.getFiles()) would
      // cause a false delete on the next scan. Using lastScanAllHiddenFiles keeps
      // it consistent with how listAllHiddenFilesInVault discovers it.
      const isVaultTracked = this.app.vault.getAbstractFileByPath(path) instanceof TFile;
      if (isVaultTracked) {
        this.lastScanFiles.set(path, { mtime, size });
      } else {
        this.lastScanAllHiddenFiles.set(path, { mtime, size });
      }
    }
  }

  removeFromBaseline(path: string): void {
    if (path.startsWith('.obsidian/')) {
      this.lastScanConfigFiles.delete(path);
    } else if (path.startsWith('.')) {
      this.lastScanHiddenFiles.delete(path);
    } else {
      // Remove from both possible buckets: the file may have been in either one
      // depending on whether Obsidian had indexed it at the time it was added.
      this.lastScanFiles.delete(path);
      this.lastScanAllHiddenFiles.delete(path);
    }
  }

  private isHiddenFileName(path: string): boolean {
    const parts = path.split('/');
    const filename = parts[parts.length - 1];
    return filename.startsWith('.');
  }
}
