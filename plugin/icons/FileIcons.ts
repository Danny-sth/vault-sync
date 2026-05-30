import { App, TFile, TFolder } from 'obsidian';
import { LUCIDE_ICONS } from './LucideIcons';

const FOLDER_ICONS_PATH = '.obsidian/folder-icons.json';

/**
 * FileIcons module for vault-sync plugin.
 * Reads `icon` frontmatter property for files and folder-icons.json for folders.
 * Displays Lucide icons in file explorer.
 */
export class FileIcons {
  private app: App;
  private observer: MutationObserver | null = null;
  private styleEl: HTMLStyleElement | null = null;
  private folderIcons: Record<string, string> = {};

  constructor(app: App) {
    this.app = app;
  }

  /**
   * Initialize file icons module.
   * Call after workspace is ready.
   */
  async init(): Promise<void> {
    await this.loadFolderIcons();
    this.injectStyles();
    this.setupObserver();
    this.applyAllIcons();
    console.debug('[VaultSync:FileIcons] Initialized');
  }

  /**
   * Cleanup resources.
   */
  destroy(): void {
    this.observer?.disconnect();
    this.styleEl?.remove();
    console.debug('[VaultSync:FileIcons] Destroyed');
  }

  /**
   * Load folder icons from JSON file.
   */
  async loadFolderIcons(): Promise<void> {
    try {
      if (await this.app.vault.adapter.exists(FOLDER_ICONS_PATH)) {
        const content = await this.app.vault.adapter.read(FOLDER_ICONS_PATH);
        this.folderIcons = JSON.parse(content);
        console.debug('[VaultSync:FileIcons] Loaded folder icons:', Object.keys(this.folderIcons).length);
      }
    } catch (e) {
      console.error('[VaultSync:FileIcons] Failed to load folder icons:', e);
      this.folderIcons = {};
    }
  }

  /**
   * Save folder icons to JSON file.
   */
  async saveFolderIcons(): Promise<void> {
    try {
      await this.app.vault.adapter.write(
        FOLDER_ICONS_PATH,
        JSON.stringify(this.folderIcons, null, 2)
      );
    } catch (e) {
      console.error('[VaultSync:FileIcons] Failed to save folder icons:', e);
    }
  }

  /**
   * Set icon for a folder.
   */
  async setFolderIcon(folderPath: string, iconName: string | null): Promise<void> {
    if (iconName) {
      this.folderIcons[folderPath] = iconName;
    } else {
      delete this.folderIcons[folderPath];
    }
    await this.saveFolderIcons();
    this.refreshFolder(folderPath);
  }

  /**
   * Get icon for a folder.
   */
  getFolderIcon(folderPath: string): string | null {
    return this.folderIcons[folderPath] || null;
  }

  /**
   * Inject CSS styles for icons.
   */
  private injectStyles(): void {
    this.styleEl = document.createElement('style');
    this.styleEl.id = 'vault-sync-file-icons';
    this.styleEl.textContent = `
      .vault-sync-file-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        margin-right: 4px;
        flex-shrink: 0;
      }
      .vault-sync-file-icon svg {
        width: 14px;
        height: 14px;
        stroke: currentColor;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
        fill: none;
      }
      /* Hide default file icon when custom icon is present */
      .nav-file-title.has-vault-sync-icon .nav-file-title-content::before {
        display: none !important;
      }
      .tree-item-self.has-vault-sync-icon .tree-item-icon {
        display: none !important;
      }
      /* Hide default folder icon when custom icon is present */
      .nav-folder-title.has-vault-sync-icon .nav-folder-collapse-indicator {
        display: none !important;
      }
      .nav-folder-title.has-vault-sync-icon > .nav-folder-title-content::before {
        display: none !important;
      }
    `;
    document.head.appendChild(this.styleEl);
  }

  /**
   * Setup MutationObserver to watch for file explorer changes.
   */
  private setupObserver(): void {
    this.observer = new MutationObserver((mutations) => {
      let shouldUpdate = false;
      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          shouldUpdate = true;
          break;
        }
      }
      if (shouldUpdate) {
        // Debounce updates
        requestAnimationFrame(() => this.applyAllIcons());
      }
    });

    // Observe file explorer containers
    const containers = document.querySelectorAll('.nav-files-container, .tree-item-children');
    containers.forEach(container => {
      this.observer?.observe(container, { childList: true, subtree: true });
    });

    // Also observe workspace for view changes
    const workspace = document.querySelector('.workspace');
    if (workspace) {
      this.observer.observe(workspace, { childList: true, subtree: true });
    }
  }

  /**
   * Apply icons to all visible files and folders.
   */
  applyAllIcons(): void {
    // Find all file items in file explorer
    const fileItems = document.querySelectorAll('.nav-file-title, .tree-item-self');
    fileItems.forEach(item => {
      const el = item as HTMLElement;
      const path = el.getAttribute('data-path');
      if (!path) return;
      if (el.querySelector('.vault-sync-file-icon')) return;

      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return;

      const cache = this.app.metadataCache.getFileCache(file);
      const iconName = cache?.frontmatter?.icon as string | undefined;
      if (!iconName) return;

      this.applyIconToElement(el, iconName);
    });

    // Find all folder items in file explorer
    const folderItems = document.querySelectorAll('.nav-folder-title');
    folderItems.forEach(item => {
      const el = item as HTMLElement;
      const path = el.getAttribute('data-path');
      if (!path) return;
      if (el.querySelector('.vault-sync-file-icon')) return;

      const iconName = this.folderIcons[path];
      if (!iconName) return;

      this.applyIconToElement(el, iconName, true);
    });
  }

  /**
   * Apply icon to a specific element.
   */
  private applyIconToElement(el: HTMLElement, iconName: string, isFolder = false): void {
    const iconSvg = this.getIconSvg(iconName);
    if (!iconSvg) {
      console.debug(`[VaultSync:FileIcons] Unknown icon: ${iconName}`);
      return;
    }

    // Create icon element
    const iconEl = document.createElement('span');
    iconEl.className = 'vault-sync-file-icon';
    iconEl.innerHTML = iconSvg;

    if (isFolder) {
      // For folders, insert before the title content
      const content = el.querySelector('.nav-folder-title-content');
      if (content) {
        content.parentElement?.insertBefore(iconEl, content);
        el.classList.add('has-vault-sync-icon');
      }
    } else {
      // For files
      const content = el.querySelector('.nav-file-title-content, .tree-item-inner');
      if (content) {
        content.parentElement?.insertBefore(iconEl, content);
        el.classList.add('has-vault-sync-icon');
      }
    }
  }

  /**
   * Get SVG for a Lucide icon.
   */
  private getIconSvg(iconName: string): string | null {
    const path = LUCIDE_ICONS[iconName];
    if (!path) return null;

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${path}</svg>`;
  }

  /**
   * Refresh icons for a specific file.
   */
  refreshFile(filePath: string): void {
    const fileItems = document.querySelectorAll(`[data-path="${filePath}"]`);
    fileItems.forEach(item => {
      const el = item as HTMLElement;

      // Remove existing icon
      el.querySelector('.vault-sync-file-icon')?.remove();
      el.classList.remove('has-vault-sync-icon');

      // Get new icon
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) return;

      const cache = this.app.metadataCache.getFileCache(file);
      const iconName = cache?.frontmatter?.icon as string | undefined;

      if (iconName) {
        this.applyIconToElement(el, iconName);
      }
    });
  }

  /**
   * Refresh icon for a specific folder.
   */
  refreshFolder(folderPath: string): void {
    const folderItems = document.querySelectorAll(`[data-path="${folderPath}"]`);
    folderItems.forEach(item => {
      const el = item as HTMLElement;

      // Remove existing icon
      el.querySelector('.vault-sync-file-icon')?.remove();
      el.classList.remove('has-vault-sync-icon');

      // Get new icon
      const iconName = this.folderIcons[folderPath];
      if (iconName) {
        this.applyIconToElement(el, iconName, true);
      }
    });
  }
}
