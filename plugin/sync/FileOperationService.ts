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
    } catch (e) {
      console.error(`[FileOperationService] readBinary failed for ${path}:`, e);
      return null;
    }
  }

  /**
   * Write binary content for any path.
   * Uses vault API for indexed files, adapter for .obsidian/* paths.
   */
  async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, content);
      return;
    }
    if (path.startsWith('.obsidian/')) {
      const dir = path.substring(0, path.lastIndexOf('/'));
      if (dir && !(await this.app.vault.adapter.exists(dir))) {
        await this.app.vault.adapter.mkdir(dir);
      }
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
          // Ignore "folder already exists" errors (race condition with parallel downloads)
          const msg = e?.message?.toLowerCase() || '';
          if (!msg.includes('already exists') && !msg.includes('folder exists')) {
            // Check again if folder exists now - if yes, it's fine
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
    parts.pop(); // Remove filename

    while (parts.length > 0) {
      const folderPath = parts.join('/');

      try {
        // Use adapter API to check folder contents (works for non-indexed folders)
        const listing = await this.app.vault.adapter.list(folderPath);
        const isEmpty = listing.files.length === 0 && listing.folders.length === 0;

        if (isEmpty) {
          // Try vault API first (for indexed folders)
          const folder = this.app.vault.getAbstractFileByPath(folderPath);
          if (folder instanceof TFolder) {
            await this.app.vault.delete(folder);
          } else {
            // Use adapter for non-indexed folders
            await this.app.vault.adapter.rmdir(folderPath, false);
          }
          console.debug(`[FileOperationService] Deleted empty parent folder: ${folderPath}`);
        } else {
          break; // Folder not empty, stop
        }
      } catch (e) {
        break; // Stop on any error
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

    // Get all folders sorted by depth (deepest first)
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

    // Sort by path length descending (deepest first)
    allFolders.sort((a, b) => b.path.length - a.path.length);

    for (const folder of allFolders) {
      // Skip hidden folders
      if (folder.path.startsWith('.') || folder.path.includes('/.')) continue;

      // Check if folder is empty using adapter (to catch hidden files like .folder-marker)
      try {
        const listing = await this.app.vault.adapter.list(folder.path);
        const hasRealFiles = listing.files.some(f => !f.endsWith('.folder-marker'));
        const hasSubfolders = listing.folders.length > 0;

        // Only delete if truly empty (no real files and no subfolders)
        // Folders with .folder-marker are kept
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
