import { App, TFile, moment, Notice } from 'obsidian';

interface DailyNotesSettings {
  folder: string;
  format: string;
  template: string;
}

const DEFAULT_SETTINGS: DailyNotesSettings = {
  folder: 'Daily',
  format: 'DD.MM.YYYY',
  template: '',
};

/**
 * Daily Notes module for vault-sync plugin.
 * Creates daily notes on startup using Obsidian's daily-notes settings.
 */
export class DailyNotes {
  private app: App;
  private settings: DailyNotesSettings = DEFAULT_SETTINGS;

  constructor(app: App) {
    this.app = app;
  }

  /**
   * Initialize and create today's daily note if needed.
   * Call this after workspace is ready.
   */
  async init(): Promise<void> {
    await this.loadSettings();

    if (!this.settings.folder) {
      console.debug('[VaultSync:DailyNotes] No daily notes folder configured');
      return;
    }

    await this.createTodayNote();
  }

  /**
   * Load settings from .obsidian/daily-notes.json
   */
  private async loadSettings(): Promise<void> {
    try {
      const configPath = `${this.app.vault.configDir}/daily-notes.json`;

      if (await this.app.vault.adapter.exists(configPath)) {
        const content = await this.app.vault.adapter.read(configPath);
        const parsed = JSON.parse(content);
        this.settings = { ...DEFAULT_SETTINGS, ...parsed };
        console.debug('[VaultSync:DailyNotes] Settings:', this.settings);
      }
    } catch (e) {
      console.error('[VaultSync:DailyNotes] Failed to load settings:', e);
    }
  }

  /**
   * Create today's daily note if it doesn't exist.
   */
  async createTodayNote(): Promise<TFile | null> {
    const today = moment();
    const filename = today.format(this.settings.format) + '.md';
    const filePath = `${this.settings.folder}/${filename}`;

    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
      console.debug('[VaultSync:DailyNotes] Already exists:', filePath);
      return existing;
    }

    await this.ensureFolder(this.settings.folder);

    let content = await this.getTemplateContent();
    content = this.replacePlaceholders(content, today);

    try {
      const file = await this.app.vault.create(filePath, content);
      console.debug('[VaultSync:DailyNotes] Created:', filePath);
      new Notice(`📅 Daily note: ${filename}`);
      return file;
    } catch (e) {
      console.error('[VaultSync:DailyNotes] Failed to create:', e);
      return null;
    }
  }

  /**
   * Ensure folder exists.
   */
  private async ensureFolder(path: string): Promise<void> {
    const parts = path.split('/');
    let current = '';

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        try {
          await this.app.vault.createFolder(current);
        } catch {
        }
      }
    }
  }

  /**
   * Get template content.
   */
  private async getTemplateContent(): Promise<string> {
    if (!this.settings.template) return '';

    let path = this.settings.template;
    if (!path.endsWith('.md')) path += '.md';

    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      try {
        return await this.app.vault.read(file);
      } catch (e) {
        console.error('[VaultSync:DailyNotes] Template read error:', e);
      }
    }
    return '';
  }

  /**
   * Replace {{date:FORMAT}}, {{time:FORMAT}} placeholders.
   */
  private replacePlaceholders(content: string, date: moment.Moment): string {
    content = content.replace(/\{\{date:([^}]+)\}\}/g, (_, fmt) => date.format(fmt));

    content = content.replace(/\{\{date\}\}/g, date.format(this.settings.format));

    content = content.replace(/\{\{time:([^}]+)\}\}/g, (_, fmt) => date.format(fmt));

    content = content.replace(/\{\{time\}\}/g, date.format('HH:mm'));

    return content;
  }
}
