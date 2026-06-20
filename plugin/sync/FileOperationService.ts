import { App, TFile, TFolder } from 'obsidian';

/**
 * Service for file system operations in vault-sync.
 * Handles reading, writing, and cleanup of files and folders.
 * Abstracts differences between vault-indexed files and .obsidian/* paths.
 */
export class FileOperationService {
  constructor(private app: App) {}

  /**
   * Read binary content for any path (vault-indexed or .obsidian/*).
   * @returns Content and mtime, or null if file doesn't exist.
   */
  async readBinary(path: string): Promise<{ content: ArrayBuffer; mtime: number } | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      return { content: await this.app.vault.readBinary(file), mtime: file.stat.mtime };
    }
    try {
      const content = await this.app.vault.adapter.readBinary(path);
      const stat = await this.app.vault.adapter.stat(path);
      return { content, mtime: stat?.mtime ?? Date.now() };
    } catch (e: any) {
      // A missing file is an expected, handled signal here (callers treat null as
      // "not present → download/skip"), not a failure — don't spam the console with
      // ENOENT for every absent path during a reconcile. Only log genuine read errors.
      if (!FileOperationService.isMissing(e)) {
        console.error(`[FileOperationService] readBinary failed for ${path}:`, e);
      }
      return null;
    }
  }

  /** True when an error means "the path isn't there" (ENOENT) — i.e. already absent. */
  static isMissing(e: any): boolean {
    return e?.code === 'ENOENT' || /ENOENT|no such file|does not exist/i.test(String(e?.message ?? e));
  }

  /**
   * Delete a path if present. Idempotent: a file that's already gone — including a phantom
   * still in the vault index but missing on disk (which makes vault.delete throw ENOENT) —
   * counts as success, because the goal (path absent) is already met. This is what stops a
   * stale localState entry from being retried (and error-logged) on every sync forever.
   * Re-throws only genuinely unexpected errors.
   * @returns true if a file was actually removed, false if it was already absent.
   */
  async deleteIfPresent(path: string): Promise<boolean> {
    try {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await this.app.vault.delete(file);
        return true;
      }
      if (await this.app.vault.adapter.exists(path)) {
        await this.app.vault.adapter.remove(path);
        return true;
      }
      return false;
    } catch (e) {
      // Phantom index entry (TFile present, disk gone) → ENOENT. The deletion goal is met.
      if (FileOperationService.isMissing(e)) return false;
      throw e;
    }
  }

  /**
   * Write binary content for any path, overwriting if it already exists.
   * Uses the vault API for indexed files, and the adapter for paths the vault
   * does not index (hidden dot-folders like .obsidian/ or .claude/, or files
   * already on disk that the index hasn't picked up).
   */
  async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, content);
      return;
    }

    // Files inside hidden dot-folders (.obsidian, .claude, …) are invisible to the
    // vault index, so getAbstractFileByPath returns null even when the file exists
    // on disk. Going through createBinary here throws "File already exists" — the
    // bug that made e.g. .claude/settings.local.json fail to sync forever. For any
    // such path (or any path already present on disk) use adapter.writeBinary,
    // which overwrites in place.
    const isHidden = path.split('/').some(seg => seg.startsWith('.'));
    if (isHidden || (await this.app.vault.adapter.exists(path))) {
      const dir = path.substring(0, path.lastIndexOf('/'));
      await this.ensureAdapterDir(dir);
      await this.app.vault.adapter.writeBinary(path, content);
      return;
    }

    const dir = path.substring(0, path.lastIndexOf('/'));
    if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
      await this.createFolderRecursively(dir);
    }
    await this.app.vault.createBinary(path, content);
  }

  /**
   * Ensure a directory exists via the adapter, creating each segment in turn.
   * Tolerates already-existing segments (hidden dirs, races).
   */
  private async ensureAdapterDir(dir: string): Promise<void> {
    if (!dir) return;
    const parts = dir.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        try {
          await this.app.vault.adapter.mkdir(current);
        } catch (e) {
          // already exists / created concurrently — fine
        }
      }
    }
  }

  /**
   * Create folder and all parent folders recursively.
   */
  async createFolderRecursively(path: string): Promise<void> {
    const parts = path.split('/');
    let currentPath = '';
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(currentPath);
      if (!existing) {
        try {
          await this.app.vault.createFolder(currentPath);
        } catch (e: any) {
          const msg = e?.message?.toLowerCase() || '';
          if (!msg.includes('already exists') && !msg.includes('folder exists')) {
            if (!this.app.vault.getAbstractFileByPath(currentPath)) {
              throw e;
            }
          }
        }
      }
    }
  }

  /**
   * Clean up empty parent folders after file deletion.
   */
  async cleanupEmptyParentFolders(filePath: string): Promise<void> {
    const parts = filePath.split('/');
    parts.pop();

    while (parts.length > 0) {
      const folderPath = parts.join('/');

      try {
        const listing = await this.app.vault.adapter.list(folderPath);
        const isEmpty = listing.files.length === 0 && listing.folders.length === 0;

        if (isEmpty) {
          const folder = this.app.vault.getAbstractFileByPath(folderPath);
          if (folder instanceof TFolder) {
            await this.app.vault.delete(folder);
          } else {
            await this.app.vault.adapter.rmdir(folderPath, false);
          }
          console.debug(`[FileOperationService] Deleted empty parent folder: ${folderPath}`);
        } else {
          break;
        }
      } catch (e) {
        break;
      }

      parts.pop();
    }
  }

  /**
   * Clean up all empty folders in the vault recursively (deepest first).
   * Folders with only .folder-marker files are NOT deleted (they're intentionally kept empty).
   * @returns Number of deleted folders.
   */
  async cleanupEmptyFolders(): Promise<number> {
    const deletedFolders: string[] = [];

    const allFolders: TFolder[] = [];
    const collectFolders = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFolder) {
          collectFolders(child);
          allFolders.push(child);
        }
      }
    };
    collectFolders(this.app.vault.getRoot());

    allFolders.sort((a, b) => b.path.length - a.path.length);

    for (const folder of allFolders) {
      if (folder.path.startsWith('.') || folder.path.includes('/.')) continue;

      try {
        const listing = await this.app.vault.adapter.list(folder.path);
        const hasRealFiles = listing.files.some(f => !f.endsWith('.folder-marker'));
        const hasSubfolders = listing.folders.length > 0;

        if (!hasRealFiles && !hasSubfolders && listing.files.length === 0) {
          await this.app.vault.delete(folder);
          deletedFolders.push(folder.path);
          console.debug(`[FileOperationService] Deleted empty folder: ${folder.path}`);
        }
      } catch (e) {
        console.error(`[FileOperationService] Failed to check/delete folder: ${folder.path}`, e);
      }
    }

    if (deletedFolders.length > 0) {
      console.debug(`[FileOperationService] Cleaned up ${deletedFolders.length} empty folders`);
    }

    return deletedFolders.length;
  }

  /**
   * Check if a path exists (vault-indexed or .obsidian/*).
   */
  async exists(path: string): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file) return true;
    return await this.app.vault.adapter.exists(path);
  }

  /**
   * Delete a file by path.
   */
  async deleteFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.vault.delete(file);
    } else if (await this.app.vault.adapter.exists(path)) {
      await this.app.vault.adapter.remove(path);
    }
  }

  /**
   * Get file stats for a path.
   */
  async getStat(path: string): Promise<{ mtime: number; size: number } | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      return { mtime: file.stat.mtime, size: file.stat.size };
    }
    const stat = await this.app.vault.adapter.stat(path);
    return stat ? { mtime: stat.mtime, size: stat.size } : null;
  }
}
