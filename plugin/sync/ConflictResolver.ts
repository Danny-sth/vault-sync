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
    // Local file doesn't exist — trust server
    if (!local) {
      return 'download';
    }

    // Hashes match — already in sync
    if (local.hash === server.hash) {
      return 'noop';
    }

    // If we have baseline hash, use three-way merge logic
    if (lastKnownHash !== undefined) {
      // Only server changed
      if (local.hash === lastKnownHash) {
        return 'download';
      }
      // Only local changed
      if (server.hash === lastKnownHash) {
        return 'upload';
      }
    }

    // Real conflict: both sides changed from baseline (or no baseline)
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
    // Plugin configs: newest wins (mtime-based)
    // This allows plugin settings to sync properly across devices
    if (path.startsWith('.obsidian/plugins/') && !SyncFilter.isDeviceSpecific(path)) {
      return server.mtime > local.mtime ? 'download' : 'upload';
    }

    // Other .obsidian/* paths (workspace, core settings, etc.): local wins
    // mtime on these configs is unreliable across devices
    if (path.startsWith('.obsidian/')) {
      return 'upload';
    }

    // Vault-indexed files: mtime tiebreaker
    return server.mtime > local.mtime ? 'download' : 'upload';
  }
}
