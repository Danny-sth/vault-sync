/**
 * Minimal 'obsidian' module mock for the protocol test harness (vitest alias).
 * Only what the sync classes actually touch: TFile/TFolder for instanceof checks,
 * a no-op Notice, and a requestUrl that must never be reached (tests inject a
 * fake SyncApiClient; a call here means a seam was missed).
 */

export class TAbstractFile {
  path = '';
  name = '';
}

export class TFile extends TAbstractFile {
  stat: { mtime: number; size: number; ctime: number } = { mtime: 0, size: 0, ctime: 0 };
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

export class Notice {
  constructor(_message?: string, _timeout?: number) {}
  setMessage(_message: string): void {}
  hide(): void {}
}

// Type-only in the plugin sources; a runtime value is still exported so a stray
// value-position use fails loudly instead of crashing the module load.
export type App = any;
export type Menu = any;

export async function requestUrl(_req: unknown): Promise<never> {
  throw new Error('requestUrl must not be called in tests — inject a FakeApiClient');
}

export function normalizePath(p: string): string {
  return p;
}
