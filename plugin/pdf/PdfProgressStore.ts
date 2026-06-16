/**
 * Pure, Obsidian-independent core for PDF reading-progress.
 *
 * Storage model: one small JSON file per book under a visible vault folder.
 * Per-book files mean sync conflicts are scoped to a single book, where
 * "last read page wins" is exactly the correct resolution — unlike a single
 * shared file, which would let one device's write clobber another book's
 * progress (the last-write-wins data-loss we already hit once).
 *
 * This module has NO `obsidian` import on purpose, so it is unit-testable in
 * plain Node/vitest.
 */

/** Directory (vault-relative) holding per-book progress files. */
export const PROGRESS_DIR = '_pdf-progress';

/** One book's reading progress. */
export interface ProgressEntry {
  /** Vault-relative path of the PDF this progress belongs to. */
  path: string;
  /** 1-based page number the reader stopped on. */
  page: number;
  /** Total pages in the book (0 if unknown). Lets the dashboard show a percent. */
  total: number;
  /** Epoch ms of when this entry was written (informational / tie-break). */
  mtime: number;
}

/**
 * Deterministic 32-bit FNV-1a hash of a string, as zero-padded hex.
 * Used to derive a stable, filesystem-safe file name from a book path
 * without having to escape slashes/spaces/unicode in the path itself.
 */
export function hashPath(path: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    // 32-bit FNV prime multiply.
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Vault-relative path of the progress file for a given book. */
export function progressFilePath(bookPath: string): string {
  return `${PROGRESS_DIR}/${hashPath(bookPath)}.json`;
}

/** Reading progress as a whole percent (0–100), clamped and safe for total <= 0. */
export function percent(page: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const pct = Math.round((page / total) * 100);
  return Math.max(0, Math.min(100, pct));
}

/** Build a progress entry. `now` is injected for deterministic testing. */
export function buildEntry(bookPath: string, page: number, total: number, now: number): ProgressEntry {
  return { path: bookPath, page, total, mtime: now };
}

/** Serialize an entry to the JSON string stored on disk. */
export function serialize(entry: ProgressEntry): string {
  return JSON.stringify(entry, null, 2);
}

/**
 * Parse a progress file's contents.
 * Returns null for anything malformed or out of range so a corrupt/foreign
 * file can never throw or yield a nonsensical page (page must be an integer >= 1).
 */
export function parse(json: string): ProgressEntry | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const obj = data as Record<string, unknown>;
  const { path, page, total, mtime } = obj;
  if (typeof path !== 'string' || path.length === 0) return null;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) return null;
  const safeTotal = typeof total === 'number' && Number.isInteger(total) && total > 0 ? total : 0;
  const safeMtime = typeof mtime === 'number' && Number.isFinite(mtime) ? mtime : 0;
  return { path, page, total: safeTotal, mtime: safeMtime };
}
