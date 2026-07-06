package com.vaultsync.repository;

import com.vaultsync.model.FileRecord;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface FileRepository extends JpaRepository<FileRecord, String> {

    List<FileRecord> findBySeqGreaterThan(long seq);

    @Query("SELECT COALESCE(MAX(f.seq), 0) FROM FileRecord f")
    long findMaxSeq();
}
