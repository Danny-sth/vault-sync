package com.vaultsync.repository;

import com.vaultsync.model.Tombstone;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Repository
public interface TombstoneRepository extends JpaRepository<Tombstone, String> {

    List<Tombstone> findBySeqGreaterThan(long seq);

    @Modifying
    @Transactional
    @Query("DELETE FROM Tombstone t WHERE t.deletedAt < :cutoff")
    int deleteOlderThan(@Param("cutoff") long cutoffTimestamp);

    @Query("SELECT COALESCE(MAX(t.seq), 0) FROM Tombstone t")
    long findMaxSeq();
}
