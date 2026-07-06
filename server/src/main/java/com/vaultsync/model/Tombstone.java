package com.vaultsync.model;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Entity
@Table(name = "tombstones")
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class Tombstone {

    @Id
    @Column(length = 4096) // encrypted per-component paths are long; 1024 overflowed on deep trees
    private String path;

    private long deletedAt;

    @Column(length = 64)
    private String deletedBy;

    private long seq;
}
