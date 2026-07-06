import { App, TFile, TFolder, moment, Notice } from 'obsidian';
import { FileIcons } from '../icons/FileIcons';

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

/** Latin month names for archive folder naming (Cyrillic breaks path sync). */
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
/** Icon for month-archive folders (matches the existing "Archive": "📦"). */
const ARCHIVE_FOLDER_ICON = '📦';

/**
 * Daily Notes module for vault-sync plugin.
 * Creates daily notes on startup using Obsidian's daily-notes settings, and
 * archives past-month notes into Daily/<Month>.<Year>/ folders.
 *
 * Both jobs are CLIENT-side on purpose: under E2EE the server is zero-knowledge
 * (no vault key), so it can neither write an encrypted note nor even see the
 * "Daily/" folder name — the old server-side DailyNoteScheduler is disabled.
 */
export class DailyNotes {
  private app: App;
  private fileIcons: FileIcons | null;
  private settings: DailyNotesSettings = DEFAULT_SETTINGS;

  constructor(app: App, fileIcons: FileIcons | null = null) {
    this.app = app;
    this.fileIcons = fileIcons;
  }

  /**
   * Initialize and create today's daily note if needed.
   * Call this after workspace is ready.
   */
  async init(): Promise<void> {
    await this.loadSettings();
    await this.run();
  }

  /**
   * One maintenance pass: today's note + month archiving. Idempotent; safe to
   * re-run periodically so an always-open Obsidian still rolls over at
   * midnight / new month, not only on app restart.
   */
  async run(): Promise<void> {
    if (!this.settings.folder) {
      console.debug('[VaultSync:DailyNotes] No daily notes folder configured');
      return;
    }
    await this.createTodayNote();
    await this.archivePastMonths();
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
   * Keep only the current month's notes in the daily folder root: every note
   * from a previous month moves into <folder>/<Month>.<Year>/ (e.g. June.2026).
   * Mirrors the retired server-side archiver; renameFile keeps links intact.
   * Idempotent — an already-archived note simply isn't in the root anymore, and
   * a concurrent device doing the same move loses the race harmlessly.
   */
  private async archivePastMonths(): Promise<void> {
    try {
      const root = this.app.vault.getAbstractFileByPath(this.settings.folder);
      if (!(root instanceof TFolder)) return;
      const now = moment();
      let moved = 0;
      for (const child of [...root.children]) {
        if (!(child instanceof TFile) || child.extension !== 'md') continue;
        // Strict parse against the daily-notes format — anything else in the
        // folder root (templates, regular notes) is left alone.
        const d = moment(child.basename, this.settings.format, true);
        if (!d.isValid()) continue;
        if (d.year() === now.year() && d.month() === now.month()) continue;
        const monthDir = `${this.settings.folder}/${MONTH_NAMES[d.month()]}.${d.year()}`;
        await this.ensureFolder(monthDir);
        if (this.fileIcons && this.fileIcons.getFolderIcon(monthDir) !== ARCHIVE_FOLDER_ICON) {
          await this.fileIcons.setFolderIcon(monthDir, ARCHIVE_FOLDER_ICON);
        }
        try {
          // fileManager (not vault.rename) so links to the note are rewritten.
          await this.app.fileManager.renameFile(child, `${monthDir}/${child.name}`);
          moved++;
          console.debug('[VaultSync:DailyNotes] Archived', child.name, '->', monthDir);
        } catch (e) {
          console.error('[VaultSync:DailyNotes] Failed to archive', child.path, e);
        }
      }
      if (moved > 0) new Notice(`📦 Daily: ${moved} заметок прошлых месяцев убрано в архив`);
    } catch (e) {
      console.error('[VaultSync:DailyNotes] Archive pass failed:', e);
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
