import { SyncFilter } from './SyncFilter';

export type SyncAction = 'upload' | 'download' | 'noop';

export interface LocalFileInfo {
  hash: string;
  mtime: number;
}

export interface ServerFileInfo {
  hash: string;
  mtime: number;
}

/**
 * Conflict resolution logic for vault-sync.
 *
 * Conflict resolution is hash-based, not mtime-based. We compare three hashes:
 *   - localCurrentHash: hash of the file currently on disk
 *   - lastKnownHash:    hash recorded in localState after the previous sync
 *   - serverHash:       hash from the latest sync response
 *
 * Cases:
 *   localCurrent == server                          → 'noop' (already in agreement)
 *   localCurrent == lastKnown, server != lastKnown  → 'download' (only the server changed)
 *   server == lastKnown, localCurrent != lastKnown  → 'upload'   (only we changed)
 *   both differ from lastKnown (or lastKnown unset) → real conflict; policy:
 *       .obsidian/plugins/* paths → mtime tiebreaker (newest wins)
 *       .obsidian/* paths         → 'upload' (local wins; mtime on configs is unreliable
 *                                    across devices and gets reset by recovery actions)
 *       vault-indexed paths       → mtime tiebreaker (fallback)
 */
export class ConflictResolver {
  /**
   * Decide whether to upload, download or do nothing for a path that exists both locally and on server.
   *
   * @param path - File path (used for .obsidian/* special handling)
   * @param local - Local file info (hash and mtime), or null if local file doesn't exist
   * @param server - Server file info (hash and mtime)
   * @param lastKnownHash - Hash from last sync, or undefined if never synced
   * @returns 'upload', 'download', or 'noop'
   */
  static resolve(
    path: string,
    local: LocalFileInfo | null,
    server: ServerFileInfo,
    lastKnownHash: string | undefined
  ): SyncAction {
    if (!local) {
      return 'download';
    }

    if (local.hash === server.hash) {
      return 'noop';
    }

    // File was never synced from server on this device → server is source of truth.
    // Don't use mtime tiebreaker: local mtime is always "newer" for files created by
    // Obsidian plugins (daily notes, templates) after the server already has content.
    if (lastKnownHash === undefined) {
      return 'download';
    }

    if (local.hash === lastKnownHash) {
      return 'download'; // only server changed
    }
    if (server.hash === lastKnownHash) {
      return 'upload'; // only we changed
    }

    return this.resolveConflict(path, local, server);
  }

  /**
   * Resolve a real conflict where both local and server have changed.
   * Policy depends on path type.
   */
  private static resolveConflict(
    path: string,
    local: LocalFileInfo,
    server: ServerFileInfo
  ): SyncAction {
    if (path.startsWith('.obsidian/plugins/') && !SyncFilter.isDeviceSpecific(path)) {
      return server.mtime > local.mtime ? 'download' : 'upload';
    }

    if (path.startsWith('.obsidian/')) {
      return 'upload';
    }

    return server.mtime > local.mtime ? 'download' : 'upload';
  }
}
