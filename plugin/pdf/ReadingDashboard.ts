import { App, Plugin, TFile, TFolder } from 'obsidian';
import { PROGRESS_DIR, parse, percent, type ProgressEntry } from './PdfProgressStore';

/**
 * "📚 Сейчас читаю" dashboard. Reads every per-book progress file under
 * `_pdf-progress/` and renders a compact list (book, %, page, when last read)
 * into any note that contains the template markers:
 *
 *     %% reading %%
 *     %% /reading %%
 *
 * Put those two lines in your daily-note template; whenever such a note is
 * opened the block between them is refreshed. Notes without the markers are
 * never touched, so it's opt-in and safe.
 */

const MARK_START = '%% reading %%';
const MARK_END = '%% /reading %%';
const BLOCK_RE = /%%\s*reading\s*%%[\s\S]*?%%\s*\/reading\s*%%/;

export class ReadingDashboard {
  private app: App;
  private plugin: Plugin;
  /** Daily-notes folder (from config); daily notes auto-get the block. */
  private dailyFolder = 'Daily';

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  start(): void {
    void this.loadDailyFolder();
    this.plugin.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file instanceof TFile && file.extension === 'md') void this.updateNote(file);
      }),
    );
    this.plugin.addCommand({
      id: 'vault-sync-reading-dashboard',
      name: 'Insert/refresh "Сейчас читаю" here',
      editorCallback: (editor) => {
        void this.renderMarkdown().then((md) => editor.replaceSelection(`${MARK_START}\n${md}\n${MARK_END}`));
      },
    });
  }

  /** Read the daily-notes folder from config (defaults to 'Daily'). */
  private async loadDailyFolder(): Promise<void> {
    try {
      const cfg = JSON.parse(await this.app.vault.adapter.read('.obsidian/daily-notes.json'));
      if (typeof cfg.folder === 'string' && cfg.folder) this.dailyFolder = cfg.folder;
    } catch {
      /* keep default */
    }
  }

  private isDailyNote(file: TFile): boolean {
    const root = this.dailyFolder.replace(/\/+$/, '');
    return file.path.startsWith(`${root}/`) && !file.path.startsWith(`${root}/Templates/`);
  }

  /**
   * Update the reading block in a note. If the markers exist, refresh between
   * them. If not but the note is a daily note, APPEND the section to the end —
   * never overwriting the user's existing content above.
   */
  private async updateNote(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(file);
      const block = `${MARK_START}\n${await this.renderMarkdown()}\n${MARK_END}`;

      let next: string;
      if (BLOCK_RE.test(content)) {
        next = content.replace(BLOCK_RE, block);
      } else if (this.isDailyNote(file)) {
        next = `${content.replace(/\s*$/, '')}\n\n## 📚 Сейчас читаю\n\n${block}\n`;
      } else {
        return;
      }
      if (next !== content) await this.app.vault.modify(file, next);
    } catch (e) {
      console.error('[VaultSync][reading] failed to update note:', e);
    }
  }

  /** Build the markdown list of books currently being read (most recent first). */
  async renderMarkdown(): Promise<string> {
    const entries = await this.readAll();
    if (entries.length === 0) return '_Пока ничего не читаешь — открой PDF и полистай._';
    entries.sort((a, b) => b.mtime - a.mtime);
    const now = Date.now();
    const lines = entries.map((e) => {
      const name = baseName(e.path);
      const pct = percent(e.page, e.total);
      const pages = e.total > 0 ? `${e.page}/${e.total}` : `стр. ${e.page}`;
      const pctStr = e.total > 0 ? `${pct}% · ` : '';
      const when = relTime(now - e.mtime);
      // Wikilink to the PDF so it opens on click.
      return `- 📖 [[${e.path}|${name}]] — ${pctStr}${pages} · ${when}`;
    });
    return lines.join('\n');
  }

  private async readAll(): Promise<ProgressEntry[]> {
    const folder = this.app.vault.getAbstractFileByPath(PROGRESS_DIR);
    if (!(folder instanceof TFolder)) return [];
    const out: ProgressEntry[] = [];
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === 'json') {
        try {
          const entry = parse(await this.app.vault.read(child));
          if (entry) out.push(entry);
        } catch {
          /* skip unreadable progress file */
        }
      }
    }
    return out;
  }
}

/** File name without folders or extension. */
function baseName(path: string): string {
  const file = path.split('/').pop() ?? path;
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
}

/** Human-friendly "сколько назад" from a millisecond delta. */
function relTime(deltaMs: number): string {
  const min = Math.floor(deltaMs / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'вчера';
  return `${days} дн назад`;
}
