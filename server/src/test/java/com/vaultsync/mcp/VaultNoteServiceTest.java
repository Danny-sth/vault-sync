package com.vaultsync.mcp;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Tests for the surviving (E2EE-safe) surface of VaultNoteService: metadata lookups and
 * their path-traversal guards. The plaintext note CRUD was removed with the E2EE cutover.
 */
class VaultNoteServiceTest {

    @TempDir
    Path tempDir;

    private VaultNoteService service;

    @BeforeEach
    void setUp() {
        service = new VaultNoteService(tempDir.toString());
    }

    @Test
    void getMetadataForFile() throws IOException {
        Path note = tempDir.resolve("note.md");
        Files.writeString(note, "hello");

        VaultNoteService.Metadata meta = service.getMetadata("note.md");

        assertFalse(meta.isDirectory());
        assertEquals(5, meta.size());
        assertEquals("note.md", meta.path());
        assertTrue(meta.lastModified() > 0);
    }

    @Test
    void getMetadataForFolder() throws IOException {
        Files.createDirectories(tempDir.resolve("folder"));

        VaultNoteService.Metadata meta = service.getMetadata("folder");

        assertTrue(meta.isDirectory());
        assertEquals(0, meta.size());
    }

    @Test
    void getMetadataForMissingPathThrows() {
        assertThrows(IOException.class, () -> service.getMetadata("nope.md"));
    }

    @Test
    void getMetadataRejectsTraversal() {
        assertThrows(SecurityException.class, () -> service.getMetadata("../outside.md"));
        assertThrows(SecurityException.class, () -> service.getMetadata("/etc/passwd"));
        assertThrows(SecurityException.class, () -> service.getMetadata("a/../../b.md"));
    }

    @Test
    void getMetadataRejectsBlankPath() {
        assertThrows(IllegalArgumentException.class, () -> service.getMetadata(""));
        assertThrows(IllegalArgumentException.class, () -> service.getMetadata(null));
    }
}
