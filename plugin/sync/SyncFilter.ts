import { App } from 'obsidian';

/**
 * Centralized filtering logic for vault-sync.
 * Determines which files should be synced and which should be skipped.
 */
export class SyncFilter {
  /**
   * Files inside .obsidian/ that are unique per device - never sync.
   */
  private static readonly DEVICE_SPECIFIC_FILES = new Set<string>([
    '.obsidian/workspace.json',
    '.obsidian/workspace-mobile.json',
    '.obsidian/plugins/vault-sync/data.json',
  ]);

  /**
   * Path prefixes inside .obsidian/ that contain device-local caches and large assets - never sync.
   */
  private static readonly DEVICE_SPECIFIC_PREFIXES = [
    '.obsidian/icons/',
    '.obsidian/file-recovery/',
    '.obsidian/cache',
    // Never sync this plugin's own code/manifest. Syncing them lets a stale device
    // delete or conflict the running plugin's files (manifest.json went missing →
    // the plugin failed to load). It is deployed out-of-band (per device), not via sync.
    '.obsidian/plugins/vault-sync/',
  ];

  /**
   * Patterns to exclude from sync (matched via includes()).
   */
  private static readonly EXCLUDE_PATTERNS = [
    '.git/',
    '.DS_Store',
    'Thumbs.db',
    '.tmp',
    '.temp',
    '_sync_debug',
    'PLUGIN-DEBUG',
    'SYNC-DEBUG',
    'PLUGIN-LOADED-MARKER',
    '.sync-conflict-',
    '.idea/',
    '.smart-env/',
    'node_modules/',
    // duq/openclaw's internal workspace (skills, memory, state). duq reads/writes these
    // as plaintext on the VPS filesystem; if clients synced them they'd encrypt duq's own
    // brain and break it. User-facing notes duq creates live OUTSIDE cortex/ (Strains/,
    // Daily/, …) and DO sync — duq writes those through the encrypting vault helper.
    'cortex/',
  ];

  /**
   * Check if a path should be synced.
   * Handles both vault-indexed files and .obsidian/* paths.
   */
  static shouldSync(path: string): boolean {
    if (path.startsWith('.obsidian/')) {
      return this.shouldSyncObsidianPath(path);
    }

    return !this.matchesExcludePattern(path);
  }

  /**
   * Check if an .obsidian/* path should be synced.
   */
  private static shouldSyncObsidianPath(path: string): boolean {
    if (this.DEVICE_SPECIFIC_FILES.has(path)) {
      return false;
    }

    for (const prefix of this.DEVICE_SPECIFIC_PREFIXES) {
      if (path.startsWith(prefix)) {
        return false;
      }
    }

    return !this.matchesExcludePattern(path);
  }

  /**
   * Check if path matches any exclude pattern.
   *
   * For extension-like patterns (start with '.' and contain no '/'), we do a
   * word-boundary check: the character immediately after the match must be
   * end-of-string, another '.', or '/'. This prevents false positives like
   * '.temp' inadvertently excluding 'note.template.md' or '.temporary.txt'.
   */
  private static matchesExcludePattern(path: string): boolean {
    for (const pattern of this.EXCLUDE_PATTERNS) {
      if (!path.includes(pattern)) continue;

      // Extension patterns need a tighter check to avoid substring false matches.
      if (pattern.startsWith('.') && !pattern.includes('/')) {
        let idx = path.indexOf(pattern);
        while (idx !== -1) {
          const after = idx + pattern.length;
          const charAfter = after < path.length ? path[after] : '';
          if (!charAfter || charAfter === '.' || charAfter === '/') {
            return true;
          }
          idx = path.indexOf(pattern, idx + 1);
        }
        continue;
      }

      return true;
    }
    return false;
  }

  /**
   * Check if a file is device-specific (should never sync).
   */
  static isDeviceSpecific(path: string): boolean {
    if (this.DEVICE_SPECIFIC_FILES.has(path)) {
      return true;
    }
    for (const prefix of this.DEVICE_SPECIFIC_PREFIXES) {
      if (path.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Filter for vault-indexed files only (excludes .obsidian/*).
   * Used by FileWatcher for vault file scanning.
   */
  static shouldWatchVaultFile(path: string): boolean {
    if (path.startsWith('.obsidian/')) {
      return false;
    }
    return this.shouldSync(path);
  }

  /**
   * Recursively list every file under .obsidian/ via adapter API.
   */
  static async listObsidianFiles(app: App): Promise<string[]> {
    return this.listFilesInDir(app, '.obsidian');
  }

  /**
   * List all hidden directories that should be synced (e.g., .trash).
   */
  static async listHiddenDirs(app: App): Promise<string[]> {
    const result: string[] = [];
    try {
      const listing = await app.vault.adapter.list('');
      for (const folder of listing.folders) {
        if (folder.startsWith('.') && !this.matchesExcludePattern(folder + '/')) {
          result.push(folder);
        }
      }
    } catch (e) {
      console.error('[SyncFilter] listHiddenDirs failed:', e);
    }
    return result;
  }

  /**
   * List all files in hidden directories (e.g., .trash).
   */
  static async listHiddenFiles(app: App): Promise<string[]> {
    const dirs = await this.listHiddenDirs(app);
    const allFiles: string[] = [];

    for (const dir of dirs) {
      if (dir === '.obsidian') continue;
      const files = await this.listFilesInDir(app, dir);
      allFiles.push(...files);
    }

    return allFiles;
  }

  /**
   * List ALL hidden files in the vault, including those inside regular directories.
   * This catches files that app.vault.getFiles() misses (hidden files like .trashed-*, temp files).
   */
  static async listAllHiddenFilesInVault(app: App): Promise<string[]> {
    const result: string[] = [];
    const vaultFiles = new Set(app.vault.getFiles().map(f => f.path));
    const stack: string[] = [''];

    while (stack.length > 0) {
      const dir = stack.pop()!;
      try {
        const listing = await app.vault.adapter.list(dir);

        for (const file of listing.files) {
          if (vaultFiles.has(file)) continue;
          if (file.startsWith('.obsidian/')) continue;
          if (this.shouldSync(file)) {
            result.push(file);
          }
        }

        for (const subdir of listing.folders) {
          if (this.matchesExcludePattern(subdir + '/')) continue;
          stack.push(subdir);
        }
      } catch (e) {
        console.error(`[SyncFilter] listAllHiddenFilesInVault failed for ${dir}:`, e);
      }
    }

    return result;
  }

  /**
   * Marker file name for empty folders.
   */
  private static readonly FOLDER_MARKER = '.folder-marker';

  /**
   * Ensure empty folders have marker files and non-empty folders don't.
   * Returns list of created/deleted marker paths for sync.
   * @param tombstonePaths - Set of paths that server has marked as deleted (tombstones).
   *                         We skip creating markers for folders whose markers are in this set.
   */
  static async syncEmptyFolderMarkers(app: App, tombstonePaths?: Set<string>): Promise<{ created: string[]; deleted: string[] }> {
    const created: string[] = [];
    const deleted: string[] = [];
    const stack: string[] = [''];

    while (stack.length > 0) {
      const dir = stack.pop()!;
      try {
        const listing = await app.vault.adapter.list(dir);

        for (const subdir of listing.folders) {
          if (this.matchesExcludePattern(subdir + '/')) continue;
          if (subdir.startsWith('.obsidian')) continue;
          stack.push(subdir);
        }

        const realFiles = listing.files.filter(f => !f.endsWith(this.FOLDER_MARKER));
        const hasSubdirs = listing.folders.length > 0;
        const markerPath = dir ? `${dir}/${this.FOLDER_MARKER}` : this.FOLDER_MARKER;
        const markerExists = listing.files.includes(markerPath);

        if (realFiles.length === 0 && !hasSubdirs && dir !== '') {
          if (!markerExists && !tombstonePaths?.has(markerPath)) {
            await app.vault.adapter.write(markerPath, '');
            created.push(markerPath);
          }
        } else if (markerExists) {
          await app.vault.adapter.remove(markerPath);
          deleted.push(markerPath);
        }
      } catch (e) {
        console.error(`[SyncFilter] syncEmptyFolderMarkers failed for ${dir}:`, e);
      }
    }

    return { created, deleted };
  }

  /**
   * Recursively list every file under a directory via adapter API.
   */
  static async listFilesInDir(app: App, rootDir: string): Promise<string[]> {
    const result: string[] = [];
    const stack: string[] = [rootDir];

    while (stack.length > 0) {
      const dir = stack.pop()!;
      try {
        const listing = await app.vault.adapter.list(dir);
        for (const file of listing.files) {
          if (this.shouldSync(file)) {
            result.push(file);
          }
        }
        for (const subdir of listing.folders) {
          stack.push(subdir);
        }
      } catch (e) {
        console.error(`[SyncFilter] list failed for ${dir}:`, e);
      }
    }

    return result;
  }
}
