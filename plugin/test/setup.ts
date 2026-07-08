// SyncStatusNotice uses window.setTimeout; node has no window — alias it to globalThis.
(globalThis as any).window = globalThis;
