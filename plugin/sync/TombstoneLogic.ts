/**
 * Single source of truth for the tombstone-application decision.
 *
 * A server "tombstone" records that a path was deleted. During a full sync the
 * client must decide, for each tombstoned path that still exists locally,
 * whether to delete it. Getting this wrong loses data in BOTH directions:
 *  - too eager → a freshly re-added file is wiped ("added PDF vanishes"),
 *  - too lax  → a deleted file resurrects and won't stay deleted across devices.
 *
 * This is a PURE function (no Obsidian deps) so every corner case is unit-tested.
 */

export interface TombstoneDecisionInput {
  /** Vault-relative path the tombstone is for. */
  path: string;
  /** True if this device has a recorded synced hash for the path (we synced it before). */
  syncedBefore: boolean;
  /** True if the server's file list ALSO contains a live record for this path. */
  serverHasLive: boolean;
}

/**
 * Whether a tombstone should delete the local file at `path`.
 *
 * Rules (ordered):
 *  1. Server has a live record again → tombstone is stale → DON'T delete.
 *  2. `.obsidian/` config (except `.obsidian/plugins/`) is device-local and
 *     never auto-deleted by tombstones.
 *  3. Never synced here (no recorded hash) and not a plugin file → the user just
 *     (re)created the file at a tombstoned path; it supersedes the old deletion
 *     → DON'T delete (resurrect/upload instead).
 *  4. Otherwise the deletion is genuine → DELETE.
 */
export function tombstoneApplies(input: TombstoneDecisionInput): boolean {
  if (input.serverHasLive) return false;

  const inObsidian = input.path.startsWith('.obsidian/');
  const isPlugin = input.path.startsWith('.obsidian/plugins/');
  if (inObsidian && !isPlugin) return false;

  if (!input.syncedBefore && !isPlugin) return false;

  return true;
}
