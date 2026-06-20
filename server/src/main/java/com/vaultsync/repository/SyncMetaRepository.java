package com.vaultsync.repository;

import com.vaultsync.model.SyncMeta;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface SyncMetaRepository extends JpaRepository<SyncMeta, String> {
}
