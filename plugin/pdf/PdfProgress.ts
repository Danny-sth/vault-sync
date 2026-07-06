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
/** Idle delay after opening a PDF (or after a tap) before the whole Obsidian UI fades away. */
const HIDE_UI_DELAY_MS = 4000;
/** How long the progress pill stays up after a scroll/page change before it fades out. */
const PILL_VISIBLE_MS = 3000;

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
  /** Floating progress vial pinned to the right edge of the active PDF view. */
  private barEl: HTMLElement | null = null;
  private barFill: HTMLElement | null = null;
  private barLabel: HTMLElement | null = null;
  /** Idle timer that fades the progress vial out after a scroll. */
  private fadeTimer: number | null = null;
  /** Idle timer that hides the whole Obsidian chrome while reading. */
  private hideUiTimer: number | null = null;
  /** True while the Obsidian UI is faded out (immersive reading). */
  private uiHidden = false;
  /** Tap-to-reveal: pointer handlers + the press origin, to tell a tap from a scroll. */
  private onPointerDown: ((e: PointerEvent) => void) | null = null;
  private onPointerMove: ((e: PointerEvent) => void) | null = null;
  private onPointerUp: ((e: PointerEvent) => void) | null = null;
  private onPointerCancel: ((e: PointerEvent) => void) | null = null;
  private tapStart: { x: number; y: number; t: number } | null = null;
  /** Last seen pointer position — pointercancel carries no useful coords. */
  private tapLast: { x: number; y: number } | null = null;
  private tapTarget: HTMLElement | null = null;
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
    // Mobile swipe-back replaces the view INSIDE the same leaf; depending on the
    // path that may surface as 'file-open' rather than 'active-leaf-change'.
    // onLeafChange is idempotent, so listening to both is safe.
    this.plugin.registerEvent(
      this.app.workspace.on('file-open', () => this.onLeafChange(this.app.workspace.activeLeaf ?? null)),
    );
    // The active leaf at load time won't fire the event above.
    this.app.workspace.onLayoutReady(() => this.onLeafChange(this.app.workspace.activeLeaf ?? null));
  }

  /** Flush any pending save when the plugin unloads. */
  destroy(): void {
    this.detach();
    document.getElementById('vs-read-style')?.remove(); // don't leak the stylesheet
  }

  // --- leaf lifecycle -----------------------------------------------------

  private onLeafChange(leaf: WorkspaceLeaf | null): void {
    const path = this.pdfPathOf(leaf);
    // Same leaf still showing the same PDF → nothing to do. The path check is
    // essential: a mobile swipe-back navigates the SAME leaf from the PDF to
    // another view, and a leaf-only comparison would early-return here and
    // leave the chrome hidden (immersive mode) on the new view forever.
    if (this.attached && this.attached.leaf === leaf && this.attached.path === path) return;
    this.detach();

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
    // Cancel any previous poll chain before scheduling a new one, so a fast
    // leaf switch can't leave two chains racing to attach() to stale leaves.
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer);
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
        if (state.restoreDone) return; // already restored in attach() — no double notice
        this.restore(path, child, state); // restore marks restoreDone when the page is set
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
    this.enterImmersive(leaf);

    // If the document is already loaded, 'pagesloaded' won't fire again.
    if ((child.pdfViewer?.pagesCount ?? 0) > 0) {
      this.restore(path, child, state);
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
    this.exitImmersive();
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

    // Translucent water that rises from the BOTTOM. Its HEIGHT is how much is
    // left to read, and its HUE is driven by reading progress: as you read, the
    // colour travels smoothly across the whole spectrum (set in renderStatus).
    // No self-running animation — colour moves only when the percent moves.
    const water = bar.createDiv({ cls: 'vs-water' });
    water.style.cssText =
      'position:absolute;left:0;right:0;bottom:0;height:0%;overflow:visible;' +
      'background:hsla(0,85%,56%,0.66);filter:hue-rotate(0deg);' +
      'transition:height 0.6s cubic-bezier(0.22,1,0.36,1),filter 0.6s linear';

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
    this.barFill.style.height = `${remaining}%`;
    // Colour follows reading progress: 0% read → red, sweeping through the full
    // spectrum to 100% read. Tied to the percent — it never moves on its own.
    const hue = Math.round(pct * 3.6); // 0..100 % → 0..360°
    this.barFill.style.filter = `hue-rotate(${hue}deg)`;
    this.barLabel.setText(`${remaining}%`);
    this.showBar();
  }

  /** Inject the keyframes for the water ripple and rising bubbles (once). */
  private injectStyle(): void {
    if (document.getElementById('vs-read-style')) return;
    const s = document.createElement('style');
    s.id = 'vs-read-style';
    // Chrome elements we fade for immersive reading — desktop + mobile names,
    // plus the in-view PDF toolbar (page nav / zoom / search). NOTE: the
    // workspace drawers are deliberately NOT in this list — they only appear
    // when the user explicitly swipes them in, and hiding them here made that
    // swipe open an invisible, untappable drawer while immersive.
    const chrome =
      '.titlebar,.workspace-ribbon,.status-bar,.mobile-navbar,' +
      '.workspace-tab-header-container,.view-header,.pdf-toolbar';
    s.textContent =
      '@keyframes vsWave{to{transform:translateX(-50%)}}' +
      '.vs-wave-a{animation:vsWave 2.6s linear infinite}' +
      '.vs-wave-b{animation:vsWave 1.8s linear infinite}' +
      '@keyframes vsBubble{0%{transform:translateY(0);opacity:0}' +
      '15%{opacity:0.7}90%{opacity:0.25}100%{transform:translateY(-150px);opacity:0}}' +
      // While a PDF is open, give the chrome a smooth fade+collapse so hide/reveal glides.
      `body.vs-read-active :is(${chrome}){transition:opacity 0.45s ease,max-height 0.45s ease}` +
      `body.vs-read-active .view-content{transition:margin-top 0.45s ease}` +
      // Immersive: fade the chrome out, collapse the space it ate (PDF goes
      // fullscreen), and stop it taking taps (tap anywhere reveals it again).
      `body.vs-read-immersive :is(${chrome})` +
      '{opacity:0!important;pointer-events:none!important;max-height:0!important;' +
      'min-height:0!important;overflow:hidden!important;border:0!important}' +
      // Mobile pushes .view-content down with margin-top (floating header +
      // safe-area) — collapsing the header isn't enough, drop that margin too
      // so the PDF actually reaches the top edge.
      'body.vs-read-immersive .view-content{margin-top:0!important}';
    document.head.appendChild(s);
  }

  /** Show the vial, then fade it out after a short idle (it's a transient hint). */
  private showBar(): void {
    const bar = this.barEl;
    if (!bar) return;
    bar.style.opacity = '1';
    bar.style.transform = 'translateX(0)';
    // Auto-fade: the pill is a glance, not chrome. Re-armed on every scroll.
    if (this.fadeTimer !== null) window.clearTimeout(this.fadeTimer);
    this.fadeTimer = window.setTimeout(() => {
      this.fadeTimer = null;
      this.fadeBar();
    }, PILL_VISIBLE_MS);
    this.plugin.registerInterval(this.fadeTimer);
  }

  /** Fade the vial out (without removing it — next scroll brings it back instantly). */
  private fadeBar(): void {
    const bar = this.barEl;
    if (!bar) return;
    bar.style.opacity = '0';
    bar.style.transform = 'translateX(14px)';
  }

  // --- immersive reading (hide all Obsidian chrome) ----------------------

  /** Arm the auto-hide and wire a tap-to-reveal handler for this PDF view. */
  private enterImmersive(leaf: WorkspaceLeaf): void {
    this.injectStyle();
    document.body.classList.add('vs-read-active');
    const container: HTMLElement | undefined = (leaf.view as any)?.containerEl;
    if (container) {
      // A *tap* (not a scroll) anywhere on the page brings the chrome back.
      // pdf.js swallows the synthetic 'click' on touch, so we detect the tap
      // ourselves from pointerdown→pointerup with a small movement threshold;
      // a vertical drag (scroll) is reading and stays immersive, while a
      // HORIZONTAL swipe is navigation (drawer / back gesture) — reveal the
      // chrome so the user doesn't land on a UI-less screen. The gesture often
      // ends in 'pointercancel' once Obsidian's drawer takes over, so we track
      // the last position ourselves and treat cancel like an up.
      this.tapTarget = container;
      const finish = (x: number, y: number, cancelled: boolean) => {
        const s = this.tapStart;
        this.tapStart = null;
        this.tapLast = null;
        if (!s) return;
        const dx = x - s.x;
        const dy = y - s.y;
        // TAP — only on a real pointerup. A CANCELLED gesture is by definition not a
        // tap: the browser fires pointercancel the moment native scrolling claims the
        // touch, typically after just a few px — treating that as a tap made every
        // reading scroll pop the chrome back in.
        if (!cancelled && Math.hypot(dx, dy) < 12 && Date.now() - s.t < 400) return this.showUi();
        // HORIZONTAL swipe (drawer / navigation) — requires clear horizontal dominance
        // (1.5×) so a slightly diagonal reading flick never counts.
        if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5) this.showUi();
      };
      this.onPointerDown = (e: PointerEvent) => {
        if (!e.isPrimary) return; // ignore pinch-zoom fingers
        this.tapStart = { x: e.clientX, y: e.clientY, t: Date.now() };
        this.tapLast = { x: e.clientX, y: e.clientY };
      };
      this.onPointerMove = (e: PointerEvent) => {
        if (e.isPrimary && this.tapStart) this.tapLast = { x: e.clientX, y: e.clientY };
      };
      this.onPointerUp = (e: PointerEvent) => {
        if (e.isPrimary) finish(e.clientX, e.clientY, false);
      };
      this.onPointerCancel = () => {
        const last = this.tapLast;
        if (last) finish(last.x, last.y, true);
        else this.tapStart = null;
      };
      container.addEventListener('pointerdown', this.onPointerDown, true);
      container.addEventListener('pointermove', this.onPointerMove, true);
      container.addEventListener('pointerup', this.onPointerUp, true);
      container.addEventListener('pointercancel', this.onPointerCancel, true);
    }
    this.scheduleHideUi();
  }

  /** Tear down immersive mode: reveal chrome, drop listeners and timers. */
  private exitImmersive(): void {
    if (this.hideUiTimer !== null) {
      window.clearTimeout(this.hideUiTimer);
      this.hideUiTimer = null;
    }
    if (this.tapTarget) {
      if (this.onPointerDown) this.tapTarget.removeEventListener('pointerdown', this.onPointerDown, true);
      if (this.onPointerMove) this.tapTarget.removeEventListener('pointermove', this.onPointerMove, true);
      if (this.onPointerUp) this.tapTarget.removeEventListener('pointerup', this.onPointerUp, true);
      if (this.onPointerCancel) this.tapTarget.removeEventListener('pointercancel', this.onPointerCancel, true);
    }
    this.tapTarget = null;
    this.onPointerDown = null;
    this.onPointerMove = null;
    this.onPointerUp = null;
    this.onPointerCancel = null;
    this.tapStart = null;
    this.tapLast = null;
    this.uiHidden = false;
    document.body.classList.remove('vs-read-immersive');
    document.body.classList.remove('vs-read-active');
    this.setStatusBar(false); // never leave the device without its system bar
  }

  /** (Re)start the idle countdown to hide the UI. */
  private scheduleHideUi(): void {
    if (this.hideUiTimer !== null) window.clearTimeout(this.hideUiTimer);
    this.hideUiTimer = window.setTimeout(() => {
      this.hideUiTimer = null;
      this.hideUi();
    }, HIDE_UI_DELAY_MS);
    this.plugin.registerInterval(this.hideUiTimer);
  }

  private hideUi(): void {
    if (!this.attached) return; // PDF closed mid-countdown
    this.uiHidden = true;
    document.body.classList.add('vs-read-immersive');
    this.setStatusBar(true); // edge-to-edge: drop the Android system bar too
  }

  /** Hide/show the Android system status bar via Capacitor (no-op on desktop). */
  private setStatusBar(hidden: boolean): void {
    try {
      const SB = (window as any).Capacitor?.Plugins?.StatusBar;
      if (!SB) return;
      if (hidden) {
        void SB.setOverlaysWebView({ overlay: true });
        void SB.hide();
      } else {
        void SB.show();
        void SB.setOverlaysWebView({ overlay: false });
      }
    } catch {
      /* desktop, or the bridge shifted — immersion just keeps the OS bar */
    }
  }

  /** Bring the chrome back (tap), flash the progress pill, and re-arm the auto-hide. */
  private showUi(): void {
    if (this.uiHidden) {
      this.uiHidden = false;
      document.body.classList.remove('vs-read-immersive');
    }
    this.setStatusBar(false); // restore the Android system bar with the chrome
    // A tap also brings the pill back (then it fades on its own after 3s).
    this.showBar();
    this.scheduleHideUi();
  }

  private removeBar(): void {
    if (this.fadeTimer !== null) {
      window.clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
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

  private restore(path: string, child: PdfChild, state: Attached): void {
    void this.readSaved(path).then((entry) => {
      try {
        if (!entry) return;
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
      } finally {
        // Mark restore complete only AFTER the page is set: the assignment above
        // fires its own 'pagechanging' synchronously, and with restoreDone still
        // false that event is ignored instead of re-saving the restored page.
        state.restoreDone = true;
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
    try {
      await this.ensureDir();
      const filePath = progressFilePath(path);
      const content = serialize(buildEntry(path, page, total, Date.now()));
      const existing = this.app.vault.getAbstractFileByPath(filePath);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
      } else {
        await this.app.vault.create(filePath, content);
      }
      // Only mark saved (and show the notice) AFTER the write succeeded — the old
      // pre-write marking meant a failed write showed «Закладка» and then silently
      // refused to retry that page forever.
      this.lastSaved.set(path, page);
      this.notifySaved(page, total);
    } catch (e) {
      console.error('[VaultSync][pdf] failed to save progress:', e);
    }
  }

  private async readSaved(path: string) {
    try {
      const filePath = progressFilePath(path);
      const f = this.app.vault.getAbstractFileByPath(filePath);
      if (!(f instanceof TFile)) return null;
      const entry = parse(await this.app.vault.read(f));
      // Guard against an FNV-32 hash collision: the file name is hash(path), so a
      // collision would hand us another book's progress. Trust the stored path.
      if (entry && entry.path !== path) return null;
      return entry;
    } catch (e) {
      console.error('[VaultSync][pdf] failed to read progress:', e);
      return null;
    }
  }

  private async ensureDir(): Promise<void> {
    // Check every time (cheap in-memory lookup): the folder can disappear after
    // its last progress file is archived/deleted, so a cached "ensured" flag
    // would wrongly skip re-creating it and make the next save throw
    // "Parent folder doesn't exist".
    if (this.app.vault.getAbstractFileByPath(PROGRESS_DIR)) return;
    try {
      await this.app.vault.createFolder(PROGRESS_DIR);
    } catch {
      /* already exists / created concurrently */
    }
  }
}
