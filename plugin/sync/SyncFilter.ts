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
  ];

  /**
   * Check if a path should be synced.
   * Handles both vault-indexed files and .obsidian/* paths.
   */
  static shouldSync(path: string): boolean {
    // .obsidian/* paths have special handling
    if (path.startsWith('.obsidian/')) {
      return this.shouldSyncObsidianPath(path);
    }

    // Check exclude patterns (includes .git, .DS_Store, etc.)
    return !this.matchesExcludePattern(path);
  }

  /**
   * Check if an .obsidian/* path should be synced.
   */
  private static shouldSyncObsidianPath(path: string): boolean {
    // Device-specific files - never sync
    if (this.DEVICE_SPECIFIC_FILES.has(path)) {
      return false;
    }

    // Device-specific prefixes - never sync
    for (const prefix of this.DEVICE_SPECIFIC_PREFIXES) {
      if (path.startsWith(prefix)) {
        return false;
      }
    }

    // Check exclude patterns
    return !this.matchesExcludePattern(path);
  }

  /**
   * Check if path matches any exclude pattern.
   */
  private static matchesExcludePattern(path: string): boolean {
    for (const pattern of this.EXCLUDE_PATTERNS) {
      if (path.includes(pattern)) {
        return true;
      }
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
    // .obsidian/* is handled separately via shouldIncludeConfigPath
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
        // Include hidden folders that are not excluded
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
      // Skip .obsidian - handled separately
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
          // Skip files already in vault.getFiles()
          if (vaultFiles.has(file)) continue;
          // Skip .obsidian - handled separately
          if (file.startsWith('.obsidian/')) continue;
          // Check if should sync
          if (this.shouldSync(file)) {
            result.push(file);
          }
        }

        for (const subdir of listing.folders) {
          // Skip excluded directories
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
