package com.vaultsync.util;

/**
 * Mass-deletion safety valve for FILESYSTEM-origin deletions (the watcher/reconcile
 * path). Device- and MCP-initiated deletions are deliberate user actions and are
 * never valved.
 *
 * <p>Why it exists: legitimate filesystem deletions on the server are rare singletons
 * (manual disk surgery). A large burst means the disk view is wrong — a moved/renamed
 * storage dir, a broken mount, a mid-flight re-encryption (incident 2026-07-09: a rekey
 * on the live server made the watcher tombstone 781 files that were never deleted). The
 * valve suppresses the burst instead of letting it fan out to every device as deletions.
 *
 * <p>Two independent guards, same idea as the plugin's offline-deletion valve:
 * <ul>
 *   <li>{@link #batchAllowed}: a reconcile pass refuses its whole missing-files batch
 *       when it exceeds the threshold;</li>
 *   <li>{@link #allowOne}: a sliding window caps event-driven deletions per minute
 *       (an rm -rf storm arrives as individual inotify events, not a batch).</li>
 * </ul>
 *
 * <p>Pure logic, no Spring — unit-tested like TombstoneLogic. Thread-safe.
 */
public class FsDeletionValve {

    private final long windowMs;
    private final int threshold;

    private long windowStart;
    private int windowCount;
    private boolean trippedLogged;

    public FsDeletionValve(long windowMs, int threshold) {
        this.windowMs = windowMs;
        this.threshold = threshold;
    }

    /** Whether a reconcile pass may apply a batch of {@code missingCount} deletions. */
    public boolean batchAllowed(int missingCount) {
        return missingCount <= threshold;
    }

    /**
     * Register one event-driven filesystem deletion; false = suppressed (window budget
     * exhausted). {@code nowMs} is injected so the window is unit-testable.
     */
    public synchronized boolean allowOne(long nowMs) {
        if (nowMs - windowStart > windowMs) {
            windowStart = nowMs;
            windowCount = 0;
            trippedLogged = false;
        }
        if (windowCount >= threshold) {
            return false;
        }
        windowCount++;
        return true;
    }

    /** One loud log line per tripped window: true only on the first suppressed deletion. */
    public synchronized boolean shouldLogTrip() {
        if (trippedLogged) {
            return false;
        }
        trippedLogged = true;
        return true;
    }

    public int threshold() {
        return threshold;
    }
}
