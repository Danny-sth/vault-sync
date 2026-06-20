package com.vaultsync.model;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * A tiny persistent key/value row for sync engine metadata that must survive restarts but
 * doesn't belong to any file or tombstone. Currently holds the "tombstone floor" — the
 * highest seq among tombstones that have been pruned by TTL. A client whose lastSeq is below
 * this floor may have missed a deletion (its tombstone was already swept), so the server
 * promotes it to a full reconcile instead of a sparse delta.
 */
@Entity
@Table(name = "sync_meta")
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SyncMeta {

    // `key`/`value` are reserved words in H2 — map to non-reserved column names.
    @Id
    @Column(name = "meta_key", length = 64)
    private String key;

    @Column(name = "meta_value")
    private long value;
}
