package com.vaultsync.service;

import jakarta.annotation.PreDestroy;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static java.nio.file.StandardWatchEventKinds.*;

/**
 * Event-driven file-change detection backed by the OS (inotify via {@link WatchService}).
 *
 * <p>Replaces the old 30-second full-tree poll. A single daemon thread drains watch events;
 * each event schedules a per-path "settle" task ~1.5&nbsp;s out, and repeated events for the
 * same path reset that timer. When it fires we read the file's <em>current</em> state once and
 * delegate to {@link SyncService#indexPath(String)} (or it resolves to a deletion if the file
 * is gone). This debounce collapses a rapid create+delete or a burst of editor saves into a
 * single net update — which is what removes the Android 404 download race.
 *
 * <p>The low-frequency {@link SyncService#reconcile()} sweep remains the convergence backstop
 * for anything this watcher misses (downtime, inotify queue overflow).
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class VaultWatcherService {

    private final SyncService syncService;

    @Value("${vault-sync.storage-path}")
    private String storagePath;

    @Value("${vault-sync.watch-debounce-ms:1500}")
    private long debounceMs;

    private WatchService watchService;
    private Path root;
    private Thread watchThread;
    private volatile boolean running;

    private final Map<WatchKey, Path> keyToDir = new ConcurrentHashMap<>();
    private final Map<String, ScheduledFuture<?>> pending = new ConcurrentHashMap<>();
    private ScheduledExecutorService debouncePool;

    @EventListener(ApplicationReadyEvent.class)
    public void start() {
        root = Paths.get(storagePath);
        if (!Files.isDirectory(root)) {
            log.warn("VaultWatcher: storage path is not a directory, watcher disabled: {}", storagePath);
            return;
        }
        try {
            watchService = root.getFileSystem().newWatchService();
        } catch (IOException e) {
            log.error("VaultWatcher: could not create WatchService, watcher disabled", e);
            return;
        }

        ThreadFactory daemon = r -> {
            Thread t = new Thread(r, "vault-watch-debounce");
            t.setDaemon(true);
            return t;
        };
        debouncePool = new ScheduledThreadPoolExecutor(2, daemon);

        int dirs = registerAll(root);
        running = true;
        watchThread = new Thread(this::watchLoop, "vault-watcher");
        watchThread.setDaemon(true);
        watchThread.start();
        log.info("VaultWatcher started: watching {} directories under {}", dirs, storagePath);
    }

    /** Recursively register {@code dir} and its non-excluded subdirectories. Returns count registered. */
    private int registerAll(Path dir) {
        AtomicInteger count = new AtomicInteger(0);
        try {
            Files.walkFileTree(dir, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult preVisitDirectory(Path d, BasicFileAttributes attrs) {
                    String name = d.getFileName() != null ? d.getFileName().toString() : "";
                    if (!d.equals(root) && syncService.shouldExcludeDir(name)) {
                        return FileVisitResult.SKIP_SUBTREE;
                    }
                    try {
                        WatchKey key = d.register(watchService, ENTRY_CREATE, ENTRY_MODIFY, ENTRY_DELETE);
                        keyToDir.put(key, d);
                        count.incrementAndGet();
                    } catch (IOException e) {
                        log.warn("VaultWatcher: could not register {}: {}", d, e.getMessage());
                    }
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException e) {
            log.warn("VaultWatcher: registerAll failed for {}: {}", dir, e.getMessage());
        }
        return count.get();
    }

    private void watchLoop() {
        while (running) {
            WatchKey key;
            try {
                key = watchService.take();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            } catch (ClosedWatchServiceException e) {
                break;
            }

            Path dir = keyToDir.get(key);
            if (dir == null) {
                key.reset();
                continue;
            }

            for (WatchEvent<?> event : key.pollEvents()) {
                WatchEvent.Kind<?> kind = event.kind();
                if (kind == OVERFLOW) {
                    log.warn("VaultWatcher: inotify OVERFLOW — triggering reconciliation");
                    safeReconcile();
                    continue;
                }
                @SuppressWarnings("unchecked")
                WatchEvent<Path> ev = (WatchEvent<Path>) event;
                Path child = dir.resolve(ev.context());

                // A newly created directory needs its own watch, plus indexing of any files
                // that landed inside it before we could register (race between mkdir and register).
                if (kind == ENTRY_CREATE && Files.isDirectory(child)) {
                    String dirName = child.getFileName().toString();
                    if (!syncService.shouldExcludeDir(dirName)) {
                        registerAll(child);
                        indexExistingFilesUnder(child);
                    }
                    continue;
                }

                scheduleIndex(child);
            }

            boolean valid = key.reset();
            if (!valid) {
                keyToDir.remove(key);
            }
        }
        log.info("VaultWatcher loop stopped");
    }

    /** Debounce: (re)schedule indexing of {@code child}; coalesces bursts into one net update. */
    private void scheduleIndex(Path child) {
        String relativePath = root.relativize(child).toString().replace("\\", "/");
        if (syncService.shouldExcludePath(relativePath)) {
            return;
        }
        ScheduledFuture<?> previous = pending.remove(relativePath);
        if (previous != null) {
            previous.cancel(false);
        }
        ScheduledFuture<?> future = debouncePool.schedule(() -> {
            pending.remove(relativePath);
            try {
                syncService.indexPath(relativePath);
            } catch (Exception e) {
                log.warn("VaultWatcher: indexPath failed for {}: {}", relativePath, e.getMessage());
            }
        }, debounceMs, TimeUnit.MILLISECONDS);
        pending.put(relativePath, future);
    }

    private void indexExistingFilesUnder(Path dir) {
        try {
            Files.walkFileTree(dir, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                    scheduleIndex(file);
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult preVisitDirectory(Path d, BasicFileAttributes attrs) {
                    String name = d.getFileName() != null ? d.getFileName().toString() : "";
                    return syncService.shouldExcludeDir(name) ? FileVisitResult.SKIP_SUBTREE : FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException e) {
            log.warn("VaultWatcher: failed to index new dir {}: {}", dir, e.getMessage());
        }
    }

    private void safeReconcile() {
        try {
            syncService.reconcile();
        } catch (Exception e) {
            log.warn("VaultWatcher: reconcile after overflow failed: {}", e.getMessage());
        }
    }

    @PreDestroy
    public void stop() {
        running = false;
        if (watchThread != null) {
            watchThread.interrupt();
        }
        if (debouncePool != null) {
            debouncePool.shutdownNow();
        }
        if (watchService != null) {
            try {
                watchService.close();
            } catch (IOException e) {
                log.debug("VaultWatcher: error closing WatchService: {}", e.getMessage());
            }
        }
        log.info("VaultWatcher stopped");
    }
}
