import { App, TFile, TFolder } from 'obsidian';
import { LUCIDE_ICONS } from './LucideIcons';
import { BRAND_ICONS } from './BrandIcons';
import { DEV_ICONS } from './DevIcons';
import { BRAND_COLORS, DEV_ICON_COLORS } from './IconColors';

const FOLDER_ICONS_PATH = '.obsidian/folder-icons.json';
const FILE_ICONS_PATH = '.obsidian/file-icons.json';

/**
 * FileIcons module for vault-sync plugin.
 * File icons come from the `icon` frontmatter property (per-note override) and, falling back,
 * from file-icons.json (path → icon) — a central map so ANY file type (pdf, png, docx…) can
 * have an icon without polluting note content. Folder icons live in folder-icons.json.
 * Renders Lucide / Brand / Dev icons (or emoji) in the file explorer.
 */
export class FileIcons {
  private app: App;
  private observer: MutationObserver | null = null;
  private styleEl: HTMLStyleElement | null = null;
  private folderIcons: Record<string, string> = {};
  private fileIcons: Record<string, string> = {};

  constructor(app: App) {
    this.app = app;
  }

  /**
   * Initialize file icons module.
   * Call after workspace is ready.
   */
  async init(): Promise<void> {
    await this.loadFolderIcons();
    await this.loadFileIcons();
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
   * Load per-file icons from JSON file (path → icon name). Frontmatter `icon` still wins.
   */
  async loadFileIcons(): Promise<void> {
    try {
      if (await this.app.vault.adapter.exists(FILE_ICONS_PATH)) {
        const content = await this.app.vault.adapter.read(FILE_ICONS_PATH);
        this.fileIcons = JSON.parse(content);
        console.debug('[VaultSync:FileIcons] Loaded file icons:', Object.keys(this.fileIcons).length);
      }
    } catch (e) {
      console.error('[VaultSync:FileIcons] Failed to load file icons:', e);
      this.fileIcons = {};
    }
  }

  /** Resolve a file's icon: per-note frontmatter override first, then the central map. */
  private fileIconFor(file: TFile): string | undefined {
    const cache = this.app.metadataCache.getFileCache(file);
    return (cache?.frontmatter?.icon as string | undefined) || this.fileIcons[file.path];
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
      .vault-sync-file-icon svg.vault-sync-fill-icon {
        stroke: none;
        fill: currentColor;
      }
      .vault-sync-emoji-icon {
        font-size: 14px;
        line-height: 1;
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
        requestAnimationFrame(() => this.applyAllIcons());
      }
    });

    const containers = document.querySelectorAll('.nav-files-container, .tree-item-children');
    containers.forEach(container => {
      this.observer?.observe(container, { childList: true, subtree: true });
    });

    const workspace = document.querySelector('.workspace');
    if (workspace) {
      this.observer.observe(workspace, { childList: true, subtree: true });
    }
  }

  /**
   * Apply icons to all visible files and folders.
   */
  applyAllIcons(): void {
    const fileItems = document.querySelectorAll('.nav-file-title, .tree-item-self');
    fileItems.forEach(item => {
      const el = item as HTMLElement;
      const path = el.getAttribute('data-path');
      if (!path) return;
      if (el.querySelector('.vault-sync-file-icon')) return;

      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return;

      const iconName = this.fileIconFor(file);
      if (!iconName) return;

      this.applyIconToElement(el, iconName);
    });

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
    const iconEl = this.buildIconElement(iconName);
    if (!iconEl) {
      console.debug(`[VaultSync:FileIcons] Unknown icon: ${iconName}`);
      return;
    }

    if (isFolder) {
      const content = el.querySelector('.nav-folder-title-content');
      if (content) {
        content.parentElement?.insertBefore(iconEl, content);
        el.classList.add('has-vault-sync-icon');
      }
    } else {
      const content = el.querySelector('.nav-file-title-content, .tree-item-inner');
      if (content) {
        content.parentElement?.insertBefore(iconEl, content);
        el.classList.add('has-vault-sync-icon');
      }
    }
  }

  /**
   * Build the icon element. Known icon sets (Lucide/Brand/Dev) render as inline SVG
   * from our OWN bundled markup; anything user-supplied (frontmatter `icon`, icon maps)
   * only ever reaches the DOM through textContent.
   *
   * SECURITY: the emoji branch previously did `innerHTML = iconName` behind a
   * `/\p{Emoji}/u` test — which matches plain DIGITS too, so a synced note with
   * `icon: "1<img src=x onerror=…>"` executed script inside Obsidian. textContent
   * makes injection impossible regardless of what the regex lets through.
   */
  private buildIconElement(iconName: string): HTMLElement | null {
    const wrapper = document.createElement('span');
    wrapper.className = 'vault-sync-file-icon';

    const svgMarkup = this.getSvgMarkup(iconName);
    if (svgMarkup) {
      wrapper.innerHTML = svgMarkup; // trusted: our own bundled icon data
      return wrapper;
    }

    if (/\p{Extended_Pictographic}/u.test(iconName)) {
      const span = document.createElement('span');
      span.className = 'vault-sync-emoji-icon';
      span.textContent = iconName; // untrusted: never innerHTML
      wrapper.appendChild(span);
      return wrapper;
    }

    return null;
  }

  /** SVG markup for the bundled icon sets only (trusted content). */
  private getSvgMarkup(iconName: string): string | null {
    if (LUCIDE_ICONS[iconName]) {
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${LUCIDE_ICONS[iconName]}</svg>`;
    }

    if (BRAND_ICONS[iconName]) {
      const color = BRAND_COLORS[iconName];
      const style = color ? ` style="color:${color};fill:${color}"` : '';
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="vault-sync-fill-icon"${style}>${BRAND_ICONS[iconName]}</svg>`;
    }

    if (DEV_ICONS[iconName]) {
      const color = DEV_ICON_COLORS[iconName];
      const style = color ? ` style="color:${color};fill:${color}"` : '';
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="vault-sync-fill-icon"${style}>${DEV_ICONS[iconName]}</svg>`;
    }

    return null;
  }

  /**
   * Re-read the icon maps from disk and re-render. Called by the sync layer after it
   * writes folder-icons.json / file-icons.json, so icons set on ANOTHER device appear
   * without restarting Obsidian.
   */
  async reloadFromDisk(): Promise<void> {
    await this.loadFolderIcons();
    await this.loadFileIcons();
    this.applyAllIcons();
  }

  /**
   * Refresh icons for a specific file.
   */
  refreshFile(filePath: string): void {
    const fileItems = document.querySelectorAll(`[data-path="${filePath}"]`);
    fileItems.forEach(item => {
      const el = item as HTMLElement;

      el.querySelector('.vault-sync-file-icon')?.remove();
      el.classList.remove('has-vault-sync-icon');

      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) return;

      const iconName = this.fileIconFor(file);

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

      el.querySelector('.vault-sync-file-icon')?.remove();
      el.classList.remove('has-vault-sync-icon');

      const iconName = this.folderIcons[folderPath];
      if (iconName) {
        this.applyIconToElement(el, iconName, true);
      }
    });
  }
}
