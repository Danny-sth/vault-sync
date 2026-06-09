import { Notice } from 'obsidian';

/**
 * A single, in-place-updating status toast for the whole sync lifecycle.
 *
 * Instead of firing a dozen separate `Notice` popups on startup
 * (Syncing… / Server has N / Downloading N / Download i/N / …), we keep ONE
 * persistent notice and rewrite its text via {@link Notice.setMessage}. The
 * popup appears once, updates in place while syncing, then turns into a final
 * ✅/⚠️ line that fades out on its own.
 */
export class SyncStatusNotice {
  private notice: Notice | null = null;

  /** Open (or reuse) the persistent status toast. */
  begin(message: string): void {
    this.set('🔄', message, 0);
  }

  /** Update the text in place — never spawns a new popup. */
  update(message: string): void {
    if (!this.notice) {
      this.begin(message);
      return;
    }
    this.notice.setMessage(`🔄 Vault Sync · ${message}`);
  }

  /** Final success line; auto-hides after a moment. */
  done(message: string, hideAfterMs = 4000): void {
    this.set('✅', message, hideAfterMs);
    this.notice = null;
  }

  /** Final error line; stays a little longer. */
  error(message: string, hideAfterMs = 6000): void {
    this.set('⚠️', message, hideAfterMs);
    this.notice = null;
  }

  private set(icon: string, message: string, durationMs: number): void {
    const text = `${icon} Vault Sync · ${message}`;
    if (this.notice) {
      this.notice.setMessage(text);
      if (durationMs > 0) {
        const n = this.notice;
        window.setTimeout(() => n.hide(), durationMs);
      }
    } else {
      this.notice = new Notice(text, durationMs);
    }
  }
}
