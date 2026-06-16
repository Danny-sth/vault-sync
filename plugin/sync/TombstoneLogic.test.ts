import { describe, it, expect } from 'vitest';
import { tombstoneApplies } from './TombstoneLogic';

describe('tombstoneApplies — every corner case', () => {
  // 1. Genuine deletion of a previously-synced file → DELETE.
  it('deletes a previously-synced file whose server record is gone', () => {
    expect(
      tombstoneApplies({ path: 'Travel/notice.pdf', syncedBefore: true, serverHasLive: false }),
    ).toBe(true);
  });

  // 2. THE BUG: user just added a file at a tombstoned path → KEEP (resurrect).
  it('does NOT delete a freshly-added file (never synced here) at a tombstoned path', () => {
    expect(
      tombstoneApplies({ path: 'Travel/notice.pdf', syncedBefore: false, serverHasLive: false }),
    ).toBe(false);
  });

  // 3. Stale tombstone: server already has a live record again → KEEP.
  it('ignores a tombstone when the server has a live record for the path', () => {
    expect(
      tombstoneApplies({ path: 'Travel/notice.pdf', syncedBefore: true, serverHasLive: true }),
    ).toBe(false);
    expect(
      tombstoneApplies({ path: 'Travel/notice.pdf', syncedBefore: false, serverHasLive: true }),
    ).toBe(false);
  });

  // 4. Device-local .obsidian config is never auto-deleted by a tombstone.
  it('never deletes .obsidian config (non-plugin), even if synced before', () => {
    expect(
      tombstoneApplies({ path: '.obsidian/app.json', syncedBefore: true, serverHasLive: false }),
    ).toBe(false);
    expect(
      tombstoneApplies({ path: '.obsidian/workspace.json', syncedBefore: false, serverHasLive: false }),
    ).toBe(false);
  });

  // 5. Plugin files DO follow tombstones (they are synced), even if not "synced before".
  it('deletes a tombstoned plugin file regardless of local sync history', () => {
    expect(
      tombstoneApplies({ path: '.obsidian/plugins/foo/main.js', syncedBefore: false, serverHasLive: false }),
    ).toBe(true);
    expect(
      tombstoneApplies({ path: '.obsidian/plugins/foo/main.js', syncedBefore: true, serverHasLive: false }),
    ).toBe(true);
  });

  // 5b. ...but a live server record still wins over the tombstone for plugins.
  it('keeps a tombstoned plugin file if the server has a live record', () => {
    expect(
      tombstoneApplies({ path: '.obsidian/plugins/foo/main.js', syncedBefore: true, serverHasLive: true }),
    ).toBe(false);
  });

  // 6. Ordinary previously-synced vault file with a tombstone → DELETE.
  it('deletes an ordinary previously-synced vault file', () => {
    expect(
      tombstoneApplies({ path: 'notes/old.md', syncedBefore: true, serverHasLive: false }),
    ).toBe(true);
  });

  // 7. Folder markers behave like ordinary files (synced before → delete).
  it('deletes a tombstoned folder marker that was synced before', () => {
    expect(
      tombstoneApplies({ path: 'empty/.folder-marker', syncedBefore: true, serverHasLive: false }),
    ).toBe(true);
  });

  // 8. A path that merely contains ".obsidian" deeper down is NOT treated as config.
  it('treats only a leading .obsidian/ as config, not nested occurrences', () => {
    expect(
      tombstoneApplies({ path: 'notes/.obsidian/x.md', syncedBefore: false, serverHasLive: false }),
    ).toBe(false); // not synced before, not a plugin → resurrect, still false but for rule 3
    expect(
      tombstoneApplies({ path: 'notes/.obsidian/x.md', syncedBefore: true, serverHasLive: false }),
    ).toBe(true); // synced before, leading path is "notes/" not ".obsidian/" → genuine delete
  });
});
