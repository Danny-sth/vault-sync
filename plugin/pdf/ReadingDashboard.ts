import { App, Notice, Plugin, TFile, TFolder } from 'obsidian';
import { PROGRESS_DIR, progressFilePath, parse, percent, type ProgressEntry } from './PdfProgressStore';

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
/** Note that accumulates finished books (100%) for history. */
const ARCHIVE_PATH = 'Прочитанные книги.md';

export class ReadingDashboard {
  private app: App;
  private plugin: Plugin;
  /** Daily-notes folder (from config); daily notes auto-get the block. */
  private dailyFolder = 'Daily';
  /** Paths currently being updated — guards against concurrent file-open
   *  handlers appending the block twice. */
  private updating = new Set<string>();

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  start(): void {
    void this.loadDailyFolder();
    void this.ensureArchive();
    this.plugin.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file instanceof TFile && file.extension === 'md') void this.updateNote(file);
      }),
    );
    // Dynamic refresh: when a progress file changes (you flip a page), refresh
    // any daily notes currently open in the workspace so the block stays live.
    this.plugin.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile && file.path.startsWith(`${PROGRESS_DIR}/`)) {
          this.refreshOpenDailyNotes();
        }
      }),
    );
    this.plugin.addCommand({
      id: 'vault-sync-reading-dashboard',
      name: 'Insert/refresh "Сейчас читаю" here',
      editorCallback: (editor) => {
        void this.renderMarkdown().then((md) => editor.replaceSelection(`${MARK_START}\n${md}\n${MARK_END}`));
      },
    });
    this.plugin.addCommand({
      id: 'vault-sync-archive-finished',
      name: 'Архивировать прочитанные книги (100%)',
      callback: () => void this.archiveFinished(),
    });
  }

  private refreshTimer: number | null = null;

  /** Debounced refresh of every daily note currently open in the workspace. */
  private refreshOpenDailyNotes(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      const seen = new Set<string>();
      this.app.workspace.iterateAllLeaves((leaf) => {
        const f = (leaf.view as { file?: TFile }).file;
        if (f instanceof TFile && f.extension === 'md' && !seen.has(f.path)) {
          seen.add(f.path);
          void this.updateNote(f);
        }
      });
    }, 800);
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
    if (this.updating.has(file.path)) return; // another handler is already on it
    this.updating.add(file.path);
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
    } finally {
      this.updating.delete(file.path);
    }
  }

  /** Build the markdown list of books being read (most recent first). Finished
   *  books stay here with a ✅ until you archive them via the command. */
  async renderMarkdown(): Promise<string> {
    const entries = await this.readAll();
    if (entries.length === 0) return '_Пока ничего не читаешь — открой PDF и полистай._';
    entries.sort((a, b) => b.mtime - a.mtime);
    const now = Date.now();
    const lines = entries.map((e) => {
      const name = baseName(e.path);
      const pct = percent(e.page, e.total);
      const done = pct >= 100 ? ' ✅' : '';
      const pages = e.total > 0 ? `${e.page} / ${e.total}` : `стр. ${e.page}`;
      const when = relTime(now - e.mtime);
      // Bold title (wikilink opens the PDF) + a native HTML progress bar.
      const bar = `<progress value="${pct}" max="100"></progress>`;
      return `**[[${e.path}|📖 ${name}]]**${done}\n${bar} **${pct}%** · ${pages} · _${when}_`;
    });
    return lines.join('\n\n');
  }

  private archiveSyncing = false;

  /** Create the archive note (empty) if it doesn't exist yet, so it's visible. */
  private async ensureArchive(): Promise<void> {
    try {
      if (!this.app.vault.getAbstractFileByPath(ARCHIVE_PATH)) {
        await this.app.vault.create(
          ARCHIVE_PATH,
          '# 📚 Прочитанные книги\n\n_Книги, дочитанные до конца._\n',
        );
      }
    } catch {
      /* already exists / race */
    }
  }

  /**
   * Move every finished (100%) book into the archive note (on demand, from the
   * command) and remove its progress file so it leaves the active dashboard.
   */
  async archiveFinished(): Promise<void> {
    if (this.archiveSyncing) return;
    this.archiveSyncing = true;
    try {
      const done = (await this.readAll()).filter((e) => e.total > 0 && percent(e.page, e.total) >= 100);
      if (done.length === 0) {
        new Notice('📚 Нет дочитанных книг (100%) для архива');
        return;
      }
      const existing = this.app.vault.getAbstractFileByPath(ARCHIVE_PATH);
      let content =
        existing instanceof TFile
          ? await this.app.vault.read(existing)
          : '# 📚 Прочитанные книги\n\n_Книги, дочитанные до конца._\n';
      let moved = 0;
      for (const e of done) {
        if (!content.includes(`[[${e.path}|`)) {
          const line = `- ✅ **[[${e.path}|${baseName(e.path)}]]** · ${e.total} стр · дочитано ${fmtDate(e.mtime)}`;
          content = `${content.replace(/\s*$/, '')}\n${line}\n`;
        }
        moved++;
      }
      // Persist the archive FIRST. Only once the books are safely written do we
      // remove their progress files — otherwise a failed modify would delete the
      // progress while losing the archive entry (silent data loss).
      if (existing instanceof TFile) await this.app.vault.modify(existing, content);
      else await this.app.vault.create(ARCHIVE_PATH, content);
      for (const e of done) {
        const pf = this.app.vault.getAbstractFileByPath(progressFilePath(e.path));
        if (pf instanceof TFile) await this.app.vault.delete(pf);
      }
      new Notice(`📚 В архив перенесено: ${moved}`);
      this.refreshOpenDailyNotes();
    } catch (e) {
      console.error('[VaultSync][reading] archive failed:', e);
    } finally {
      this.archiveSyncing = false;
    }
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

/** DD.MM.YYYY for the archive's "finished on" date. */
function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
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
