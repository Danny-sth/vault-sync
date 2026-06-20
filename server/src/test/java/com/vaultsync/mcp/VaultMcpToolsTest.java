package com.vaultsync.mcp;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.Mockito;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Tests for VaultMcpTools. Under E2EE only blob/metadata/command tools survive;
 * the legacy plaintext note/folder tools were removed, so only get_metadata is
 * exercised here (get_blob/put_blob/list_blobs/delete_blob delegate to a mocked
 * VaultBlobService and are covered at the service/integration layer).
 */
class VaultMcpToolsTest {

    @TempDir
    Path tempDir;

    private VaultMcpTools tools;

    @BeforeEach
    void setUp() {
        VaultNoteService service = new VaultNoteService(tempDir.toString());
        CommandExecutionService commandService = Mockito.mock(CommandExecutionService.class);
        VaultBlobService blobService = Mockito.mock(VaultBlobService.class);
        tools = new VaultMcpTools(service, commandService, blobService);
    }

    @Test
    void testGetMetadata_File() throws IOException {
        Files.writeString(tempDir.resolve("note.md"), "test");

        VaultMcpTools.GetMetadataResult result = tools.getMetadata("note.md");

        assertTrue(result.success());
        assertNotNull(result.metadata());
        assertEquals("note.md", result.metadata().path());
        assertFalse(result.metadata().isDirectory());
        assertEquals(4, result.metadata().size());
        assertNull(result.error());
    }

    @Test
    void testGetMetadata_Directory() throws IOException {
        Files.createDirectory(tempDir.resolve("folder"));

        VaultMcpTools.GetMetadataResult result = tools.getMetadata("folder");

        assertTrue(result.success());
        assertTrue(result.metadata().isDirectory());
        assertEquals(0, result.metadata().size());
    }

    @Test
    void testGetMetadata_NotFound() {
        VaultMcpTools.GetMetadataResult result = tools.getMetadata("nonexistent");

        assertFalse(result.success());
        assertNotNull(result.error());
    }

    @Test
    void testGetMetadata_EmptyPath() {
        VaultMcpTools.GetMetadataResult result = tools.getMetadata("");

        assertFalse(result.success());
        assertTrue(result.error().contains("required"));
    }
}
