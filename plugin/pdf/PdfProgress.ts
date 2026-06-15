import { App, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { PROGRESS_DIR, progressFilePath, buildEntry, serialize, parse, percent } from './PdfProgressStore';

/**
 * Remembers the last page you were on in any PDF and restores it next time the
 * same PDF is opened — including on other devices, because the progress files
 * live in the vault and ride the existing vault-sync channel.
 *
 * A "book" is simply any `.pdf` file in the vault; its vault-relative path is
 * the identity. Progress is stored one-file-per-PDF under `_pdf-progress/`
 * (see PdfProgressStore for why per-file beats a single shared file).
 *
 * The current page is read from / written to Obsidian's built-in PDF viewer
 * via its internal (undocumented) pdf.js structures. Obsidian's core is closed
 * source, so this surface can shift between releases — every access is wrapped
 * in try/catch, and a break disables only this feature, never the whole plugin.
 */

/** Idle time after the last page change before progress is persisted. */
const SAVE_DEBOUNCE_MS = 1500;
/** Viewer-readiness polling. */
const POLL_INTERVAL_MS = 200;
const POLL_MAX_TRIES = 30; // ~6s
/** Minimum gap between "bookmark saved" notices, to avoid spam while flipping pages. */
const SAVE_NOTICE_THROTTLE_MS = 6000;

interface MinimalEventBus {
  on(name: string, cb: (data: any) => void): void;
  off(name: string, cb: (data: any) => void): void;
}

/** The slice of Obsidian's internal PDF viewer we actually touch. */
interface PdfChild {
  pdfViewer?: {
    eventBus?: MinimalEventBus;
    pagesCount?: number;
    pdfViewer?: { currentPageNumber?: number } | null;
  };
}

interface Attached {
  leaf: WorkspaceLeaf;
  path: string;
  eventBus: MinimalEventBus;
  onPageChanging: (data: any) => void;
  onPagesLoaded: (data: any) => void;
  restoreDone: boolean;
}

export class PdfProgress {
  private app: App;
  private plugin: Plugin;
  private attached: Attached | null = null;
  private pollTimer: number | null = null;
  private saveTimer: number | null = null;
  /** Last page persisted per book, to skip redundant writes. */
  private lastSaved = new Map<string, number>();
  private dirEnsured = false;
  /** Floating progress bar pinned to the bottom edge of the active PDF view. */
  private barEl: HTMLElement | null = null;
  private barFill: HTMLElement | null = null;
  private barLabel: HTMLElement | null = null;
  private fadeTimer: number | null = null;
  private drainTimer: number | null = null;
  /** Water level (% remaining). */
  private level = 0;
  /** Epoch ms of the last "bookmark saved" notice, for throttling. */
  private lastNoticeAt = 0;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  /** Begin watching the workspace for PDF views. */
  start(): void {
    this.plugin.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => this.onLeafChange(leaf)),
    );
    // The active leaf at load time won't fire the event above.
    this.app.workspace.onLayoutReady(() => this.onLeafChange(this.app.workspace.activeLeaf ?? null));

  }

  /** Flush any pending save when the plugin unloads. */
  destroy(): void {
    this.detach();
  }

  // --- leaf lifecycle -----------------------------------------------------

  private onLeafChange(leaf: WorkspaceLeaf | null): void {
    if (this.attached && this.attached.leaf === leaf) return;
    this.detach();

    const path = this.pdfPathOf(leaf);
    if (!leaf || !path) return;

    this.waitForViewer(leaf, path, 0);
  }

  /** Returns the vault path if the leaf shows a `.pdf`, else null. */
  private pdfPathOf(leaf: WorkspaceLeaf | null): string | null {
    try {
      const view: any = leaf?.view;
      if (!view || view.getViewType?.() !== 'pdf') return null;
      const file: TFile | undefined = view.file;
      if (!file || file.extension?.toLowerCase() !== 'pdf') return null;
      return file.path;
    } catch {
      return null;
    }
  }

  private getChild(leaf: WorkspaceLeaf): PdfChild | null {
    try {
      return ((leaf.view as any)?.viewer?.child as PdfChild) ?? null;
    } catch {
      return null;
    }
  }

  /** Poll until the viewer's eventBus exists, then attach handlers. */
  private waitForViewer(leaf: WorkspaceLeaf, path: string, tries: number): void {
    const child = this.getChild(leaf);
    const eventBus = child?.pdfViewer?.eventBus;
    if (eventBus) {
      this.attach(leaf, path, child!, eventBus);
      return;
    }
    if (tries >= POLL_MAX_TRIES) return; // viewer never became ready; give up quietly
    this.pollTimer = window.setTimeout(
      () => this.waitForViewer(leaf, path, tries + 1),
      POLL_INTERVAL_MS,
    );
    this.plugin.registerInterval(this.pollTimer); // ensure cleanup on unload
  }

  private attach(leaf: WorkspaceLeaf, path: string, child: PdfChild, eventBus: MinimalEventBus): void {
    const state: Attached = {
      leaf,
      path,
      eventBus,
      restoreDone: false,
      onPageChanging: (data: any) => {
        const page = typeof data?.pageNumber === 'number' ? data.pageNumber : undefined;
        const total = child.pdfViewer?.pagesCount ?? 0;
        // Keep the progress bar live even before restore completes.
        if (page && page >= 1) this.renderStatus(page, total);
        // Ignore the viewer's initial auto-scroll before we've restored.
        if (!state.restoreDone) return;
        if (page && page >= 1) this.scheduleSave(path, page, total);
      },
      onPagesLoaded: () => {
        this.restore(path, child);
        state.restoreDone = true;
      },
    };

    try {
      eventBus.on('pagechanging', state.onPageChanging);
      eventBus.on('pagesloaded', state.onPagesLoaded);
    } catch (e) {
      console.error('[VaultSync][pdf] failed to subscribe to viewer events:', e);
      return;
    }
    this.attached = state;
    this.ensureBar(leaf);

    // If the document is already loaded, 'pagesloaded' won't fire again.
    if ((child.pdfViewer?.pagesCount ?? 0) > 0) {
      this.restore(path, child);
      state.restoreDone = true;
    }
  }

  private detach(): void {
    if (this.pollTimer !== null) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    // Persist a pending page immediately so a fast tab switch doesn't lose it.
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      if (this.pendingSave) {
        const { path, page, total } = this.pendingSave;
        this.pendingSave = null;
        void this.save(path, page, total);
      }
    }
    const a = this.attached;
    if (a) {
      try {
        a.eventBus.off('pagechanging', a.onPageChanging);
        a.eventBus.off('pagesloaded', a.onPagesLoaded);
      } catch {
        /* viewer already torn down */
      }
      this.attached = null;
    }
    this.clearStatus();
  }

  // --- progress bar + notices --------------------------------------------

  /** Create the floating progress bar inside the PDF view (status bar is hidden on mobile). */
  private ensureBar(leaf: WorkspaceLeaf): void {
    this.removeBar();
    const container: HTMLElement | undefined = (leaf.view as any)?.containerEl;
    if (!container) return;
    // An elegant rounded "pill" near the RIGHT edge, inset top/bottom so it
    // clears the PDF toolbar above and the floating mobile toolbar below.
    // Fills top→bottom as you read; theme accent colour so it blends in.
    this.injectStyle();
    const bar = container.createDiv({ cls: 'vs-read-pill-v20' });
    // Glassy translucent vial.
    bar.style.cssText =
      'position:absolute;right:14px;top:50%;height:360px;margin-top:-180px;width:26px;z-index:50;' +
      'border-radius:15px;overflow:hidden;pointer-events:none;opacity:0;transform:translateX(14px);' +
      'background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.30);' +
      'box-shadow:0 4px 16px rgba(0,0,0,0.4),inset 0 1px 6px rgba(255,255,255,0.28),' +
      'inset 0 -7px 14px rgba(0,0,0,0.18);' +
      'transition:opacity 0.6s cubic-bezier(0.22,1,0.36,1),transform 0.6s cubic-bezier(0.22,1,0.36,1);' +
      'backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)';

    // Translucent water that rises from the BOTTOM; height = reading %, and its
    // hue shifts with progress. Drains away on fade.
    // Water body rising from the bottom; height = level, colour by progress.
    const water = bar.createDiv({ cls: 'vs-water' });
    // The water continuously cycles through every hue via an animated
    // hue-rotate, so it shimmers smoothly across the whole spectrum.
    water.style.cssText =
      'position:absolute;left:0;right:0;bottom:0;height:0%;overflow:visible;' +
      'background:hsla(0,85%,56%,0.66);filter:hue-rotate(0deg);' +
      'animation:vsHue 11s linear infinite;' +
      'transition:height 0.6s cubic-bezier(0.22,1,0.36,1)';

    // Two offset sine waves scrolling across the surface — the standard
    // liquid-fill wave pattern (what wavify draws), animated purely in CSS.
    const wave = (cls: string, opacity: number, fillCol: string) =>
      `<svg class="${cls}" viewBox="0 0 120 20" preserveAspectRatio="none" ` +
      `style="position:absolute;left:0;top:-8px;width:200%;height:14px;opacity:${opacity}">` +
      `<path d="M0 12 Q15 4 30 12 T60 12 T90 12 T120 12 V20 H0 Z" fill="${fillCol}"/></svg>`;
    const surface = water.createDiv({ cls: 'vs-surface' });
    surface.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:0';
    surface.innerHTML = wave('vs-wave-a', 0.5, 'rgba(255,255,255,0.55)') +
      wave('vs-wave-b', 0.8, 'rgba(255,255,255,0.75)');

    // A few rising bubbles for detail.
    for (let i = 0; i < 3; i++) {
      const b = water.createSpan({ cls: 'vs-bubble' });
      const size = 3 + i;
      const left = 5 + i * 7;
      b.style.cssText =
        `position:absolute;bottom:6px;left:${left}px;width:${size}px;height:${size}px;` +
        'border-radius:50%;background:rgba(255,255,255,0.5);' +
        `animation:vsBubble ${2.6 + i * 0.8}s ease-in ${i * 0.9}s infinite`;
    }

    // Glass reflection: a soft vertical gloss down the upper-left of the vial.
    const gloss = bar.createDiv();
    gloss.style.cssText =
      'position:absolute;left:4px;top:7px;width:6px;height:55%;border-radius:4px;z-index:3;pointer-events:none;' +
      'background:linear-gradient(180deg,rgba(255,255,255,0.55),rgba(255,255,255,0))';

    // Percent label, centred, readable over the water.
    const label = bar.createSpan({ cls: 'vs-read-pct' });
    label.style.cssText =
      'position:absolute;top:50%;left:0;right:0;transform:translateY(-50%);text-align:center;z-index:4;' +
      'font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;color:#fff;' +
      'text-shadow:0 0 3px rgba(0,0,0,0.7),0 1px 2px rgba(0,0,0,0.5);pointer-events:none';
    const fill = water;
    this.barEl = bar;
    this.barFill = fill;
    this.barLabel = label;
  }

  /** Update the floating bar's fill width and label. */
  private renderStatus(page: number, total: number): void {
    if (!this.barFill || !this.barLabel) return;
    const pct = percent(page, total);
    // Water shows how much is LEFT: full at the start, draining to empty as you
    // read. The label is the remaining percent (100 → 0).
    const remaining = 100 - pct;
    this.level = remaining;
    this.barFill.style.height = `${remaining}%`;
    // Colour is driven by the continuous hue-rotate animation, not the page.
    this.barLabel.setText(`${remaining}%`);
    this.showBar();
  }

  /** Inject the keyframes for the water ripple and rising bubbles (once). */
  private injectStyle(): void {
    if (document.getElementById('vs-read-style')) return;
    const s = document.createElement('style');
    s.id = 'vs-read-style';
    s.textContent =
      '@keyframes vsWave{to{transform:translateX(-50%)}}' +
      '.vs-wave-a{animation:vsWave 2.6s linear infinite}' +
      '.vs-wave-b{animation:vsWave 1.8s linear infinite}' +
      '@keyframes vsBubble{0%{transform:translateY(0);opacity:0}' +
      '15%{opacity:0.7}90%{opacity:0.25}100%{transform:translateY(-150px);opacity:0}}' +
      '@keyframes vsRainbow{0%{background-position:0% 0%}100%{background-position:0% 100%}}' +
      '@keyframes vsHue{to{filter:hue-rotate(360deg)}}';
    document.head.appendChild(s);
  }

  /** Ensure the vial is visible (it stays on screen while a PDF is open). */
  private showBar(): void {
    const bar = this.barEl;
    if (!bar) return;
    // The vial stays visible while a PDF is open — just ensure it's shown.
    bar.style.opacity = '1';
    bar.style.transform = 'translateX(0)';
  }

  private removeBar(): void {
    if (this.fadeTimer !== null) {
      window.clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
    if (this.drainTimer !== null) {
      window.clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.barEl?.remove();
    this.barLabel?.remove();
    this.barEl = null;
    this.barFill = null;
    this.barLabel = null;
  }

  private clearStatus(): void {
    this.removeBar();
  }

  /** A subtle "bookmark saved" notice, throttled so flipping pages doesn't spam. */
  private notifySaved(page: number, total: number): void {
    const now = Date.now();
    if (now - this.lastNoticeAt < SAVE_NOTICE_THROTTLE_MS) return;
    this.lastNoticeAt = now;
    const tail = total > 0 ? ` · ${percent(page, total)}%` : '';
    new Notice(`🔖 Закладка · стр. ${page}${total ? '/' + total : ''}${tail}`, 2000);
  }

  // --- restore / save -----------------------------------------------------

  private restore(path: string, child: PdfChild): void {
    void this.readSaved(path).then((entry) => {
      if (!entry) return;
      try {
        const viewer = child.pdfViewer?.pdfViewer;
        const total = child.pdfViewer?.pagesCount ?? 0;
        if (!viewer) return;
        const target = total > 0 ? Math.min(entry.page, total) : entry.page;
        // Pre-seed lastSaved so the restore's own pagechanging isn't re-written.
        this.lastSaved.set(path, target);
        viewer.currentPageNumber = target;
        this.renderStatus(target, total);
        // Only announce a real resume (not page 1).
        if (target > 1) {
          new Notice(`🔖 Продолжаем со стр. ${target} из ${total || '?'} · ${percent(target, total)}%`, 4000);
        }
      } catch (e) {
        console.error('[VaultSync][pdf] failed to restore page:', e);
      }
    });
  }

  private pendingSave: { path: string; page: number; total: number } | null = null;

  private scheduleSave(path: string, page: number, total: number): void {
    this.pendingSave = { path, page, total };
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      const pending = this.pendingSave;
      this.pendingSave = null;
      if (pending) void this.save(pending.path, pending.page, pending.total);
    }, SAVE_DEBOUNCE_MS);
    this.plugin.registerInterval(this.saveTimer);
  }

  private async save(path: string, page: number, total = 0): Promise<void> {
    if (this.lastSaved.get(path) === page) return;
    this.lastSaved.set(path, page);
    this.notifySaved(page, total);
    try {
      await this.ensureDir();
      const filePath = progressFilePath(path);
      const content = serialize(buildEntry(path, page, Date.now()));
      const existing = this.app.vault.getAbstractFileByPath(filePath);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
      } else {
        await this.app.vault.create(filePath, content);
      }
    } catch (e) {
      console.error('[VaultSync][pdf] failed to save progress:', e);
    }
  }

  private async readSaved(path: string) {
    try {
      const filePath = progressFilePath(path);
      const f = this.app.vault.getAbstractFileByPath(filePath);
      if (!(f instanceof TFile)) return null;
      return parse(await this.app.vault.read(f));
    } catch (e) {
      console.error('[VaultSync][pdf] failed to read progress:', e);
      return null;
    }
  }

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    if (!this.app.vault.getAbstractFileByPath(PROGRESS_DIR)) {
      try {
        await this.app.vault.createFolder(PROGRESS_DIR);
      } catch {
        /* already exists / created concurrently */
      }
    }
    this.dirEnsured = true;
  }
}
