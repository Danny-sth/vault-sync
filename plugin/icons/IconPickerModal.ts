import { App, Modal, Setting } from 'obsidian';
import { LUCIDE_ICONS } from './LucideIcons';

/**
 * Modal for picking a Lucide icon.
 */
export class IconPickerModal extends Modal {
  private onSelect: (iconName: string | null) => void;
  private searchInput: HTMLInputElement | null = null;
  private gridContainer: HTMLElement | null = null;
  private currentIcon: string | null;

  constructor(app: App, currentIcon: string | null, onSelect: (iconName: string | null) => void) {
    super(app);
    this.currentIcon = currentIcon;
    this.onSelect = onSelect;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('vault-sync-icon-picker');

    // Title
    contentEl.createEl('h2', { text: 'Choose Icon' });

    // Search
    const searchContainer = contentEl.createDiv({ cls: 'icon-picker-search' });
    this.searchInput = searchContainer.createEl('input', {
      type: 'text',
      placeholder: 'Search icons...',
      cls: 'icon-picker-search-input',
    });
    this.searchInput.addEventListener('input', () => this.renderGrid());

    // Remove icon button
    if (this.currentIcon) {
      new Setting(contentEl)
        .setName('Remove current icon')
        .addButton(btn => btn
          .setButtonText('Remove')
          .setWarning()
          .onClick(() => {
            this.onSelect(null);
            this.close();
          }));
    }

    // Grid container
    this.gridContainer = contentEl.createDiv({ cls: 'icon-picker-grid' });
    this.renderGrid();

    // Styles
    this.injectStyles();

    // Focus search
    this.searchInput.focus();
  }

  private renderGrid(): void {
    if (!this.gridContainer) return;
    this.gridContainer.empty();

    const searchTerm = this.searchInput?.value.toLowerCase() || '';
    const iconNames = Object.keys(LUCIDE_ICONS);

    const filtered = searchTerm
      ? iconNames.filter(name => name.toLowerCase().includes(searchTerm))
      : iconNames;

    for (const iconName of filtered) {
      const iconEl = this.gridContainer.createDiv({ cls: 'icon-picker-item' });

      if (iconName === this.currentIcon) {
        iconEl.addClass('is-selected');
      }

      // SVG
      const svgPath = LUCIDE_ICONS[iconName];
      iconEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none">${svgPath}</svg>`;

      // Tooltip
      iconEl.setAttribute('title', iconName);

      // Click handler
      iconEl.addEventListener('click', () => {
        this.onSelect(iconName);
        this.close();
      });
    }

    // Show count
    if (filtered.length === 0) {
      this.gridContainer.createEl('p', { text: 'No icons found', cls: 'icon-picker-empty' });
    }
  }

  private injectStyles(): void {
    const styleId = 'vault-sync-icon-picker-styles';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .vault-sync-icon-picker {
        padding: 16px;
      }
      .vault-sync-icon-picker h2 {
        margin-top: 0;
        margin-bottom: 16px;
      }
      .icon-picker-search {
        margin-bottom: 16px;
      }
      .icon-picker-search-input {
        width: 100%;
        padding: 8px 12px;
        font-size: 14px;
        border: 1px solid var(--background-modifier-border);
        border-radius: 4px;
        background: var(--background-primary);
        color: var(--text-normal);
      }
      .icon-picker-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(40px, 1fr));
        gap: 4px;
        max-height: 400px;
        overflow-y: auto;
        padding: 4px;
      }
      .icon-picker-item {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        border-radius: 4px;
        cursor: pointer;
        transition: background 0.15s;
      }
      .icon-picker-item:hover {
        background: var(--background-modifier-hover);
      }
      .icon-picker-item.is-selected {
        background: var(--interactive-accent);
        color: var(--text-on-accent);
      }
      .icon-picker-item svg {
        width: 20px;
        height: 20px;
      }
      .icon-picker-empty {
        grid-column: 1 / -1;
        text-align: center;
        color: var(--text-muted);
        padding: 20px;
      }
    `;
    document.head.appendChild(style);
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
