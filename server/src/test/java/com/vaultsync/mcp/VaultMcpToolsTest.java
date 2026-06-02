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
 * Integration tests for VaultMcpTools - all new MCP @Tool methods.
 */
class VaultMcpToolsTest {

    @TempDir
    Path tempDir;

    private VaultMcpTools tools;

    @BeforeEach
    void setUp() {
        VaultNoteService service = new VaultNoteService(tempDir.toString());
        CommandExecutionService commandService = Mockito.mock(CommandExecutionService.class);
        tools = new VaultMcpTools(service, commandService);
    }


    @Test
    void testListNotesExtended_WithoutStats() throws IOException {
        Files.writeString(tempDir.resolve("note1.md"), "content1");
        Files.writeString(tempDir.resolve("note2.md"), "content2");

        VaultMcpTools.ListNotesResult result = tools.listNotesExtended(null, false);

        assertTrue(result.success());
        assertEquals(2, result.count());
        assertNotNull(result.notes());
        assertNull(result.notesWithStats());
    }

    @Test
    void testListNotesExtended_WithStats() throws IOException {
        Files.writeString(tempDir.resolve("note.md"), "test");

        VaultMcpTools.ListNotesResult result = tools.listNotesExtended(null, true);

        assertTrue(result.success());
        assertEquals(1, result.count());
        assertNull(result.notes());
        assertNotNull(result.notesWithStats());
        assertEquals(1, result.notesWithStats().size());
        assertEquals("note.md", result.notesWithStats().get(0).path());
        assertEquals(4, result.notesWithStats().get(0).size());
    }

    @Test
    void testListNotesExtended_WithPrefix() throws IOException {
        Path folder = tempDir.resolve("archive");
        Files.createDirectory(folder);
        Files.writeString(folder.resolve("old.md"), "old");
        Files.writeString(tempDir.resolve("new.md"), "new");

        VaultMcpTools.ListNotesResult result = tools.listNotesExtended("archive", false);

        assertTrue(result.success());
        assertEquals(1, result.count());
    }


    @Test
    void testSearchNotesInFolder_Success() throws IOException {
        Path folder = tempDir.resolve("archive");
        Files.createDirectory(folder);
        Files.writeString(folder.resolve("old.md"), "# Old\narchived content");
        Files.writeString(tempDir.resolve("new.md"), "# New\nactive content");

        VaultMcpTools.SearchNotesResult result = tools.searchNotesInFolder("archived", "archive");

        assertTrue(result.success());
        assertEquals(1, result.count());
        assertEquals("archive", result.folder());
        assertEquals("archived", result.query());
    }

    @Test
    void testSearchNotesInFolder_EmptyQuery() {
        VaultMcpTools.SearchNotesResult result = tools.searchNotesInFolder("", "folder");

        assertFalse(result.success());
        assertNotNull(result.error());
    }


    @Test
    void testDeleteFolder_Success() throws IOException {
        Files.createDirectory(tempDir.resolve("folder"));

        VaultMcpTools.DeleteFolderResult result = tools.deleteFolder("folder", false);

        assertTrue(result.success());
        assertEquals("folder", result.path());
        assertNull(result.error());
    }

    @Test
    void testDeleteFolder_Recursive() throws IOException {
        Path folder = tempDir.resolve("folder");
        Files.createDirectory(folder);
        Files.writeString(folder.resolve("note.md"), "content");

        VaultMcpTools.DeleteFolderResult result = tools.deleteFolder("folder", true);

        assertTrue(result.success());
    }

    @Test
    void testDeleteFolder_NotFound() {
        VaultMcpTools.DeleteFolderResult result = tools.deleteFolder("nonexistent", false);

        assertFalse(result.success());
        assertNotNull(result.error());
    }

    @Test
    void testDeleteFolder_EmptyPath() {
        VaultMcpTools.DeleteFolderResult result = tools.deleteFolder("", false);

        assertFalse(result.success());
        assertTrue(result.error().contains("required"));
    }


    @Test
    void testMoveNote_Success() throws IOException {
        Files.writeString(tempDir.resolve("old.md"), "content");

        VaultMcpTools.MoveNoteResult result = tools.moveNote("old.md", "new.md");

        assertTrue(result.success());
        assertEquals("old.md", result.fromPath());
        assertEquals("new.md", result.toPath());
        assertNull(result.error());
    }

    @Test
    void testMoveNote_SourceNotFound() {
        VaultMcpTools.MoveNoteResult result = tools.moveNote("nonexistent.md", "new.md");

        assertFalse(result.success());
        assertNotNull(result.error());
    }

    @Test
    void testMoveNote_EmptyPaths() {
        VaultMcpTools.MoveNoteResult result = tools.moveNote("", "new.md");

        assertFalse(result.success());
        assertTrue(result.error().contains("required"));
    }


    @Test
    void testAppendNote_Success() throws IOException {
        Files.writeString(tempDir.resolve("note.md"), "Original\n");

        VaultMcpTools.AppendNoteResult result = tools.appendNote("note.md", "Appended");

        assertTrue(result.success());
        assertEquals("note.md", result.path());
        assertNull(result.error());
    }

    @Test
    void testAppendNote_NoteNotFound() {
        VaultMcpTools.AppendNoteResult result = tools.appendNote("nonexistent.md", "content");

        assertFalse(result.success());
        assertNotNull(result.error());
    }

    @Test
    void testAppendNote_NullContent() {
        VaultMcpTools.AppendNoteResult result = tools.appendNote("note.md", null);

        assertFalse(result.success());
        assertTrue(result.error().contains("required"));
    }


    @Test
    void testEditNote_Success() throws IOException {
        Files.writeString(tempDir.resolve("note.md"), "Hello world");

        VaultMcpTools.EditNoteResult result = tools.editNote("note.md", "world", "universe");

        assertTrue(result.success());
        assertEquals("note.md", result.path());
        assertNull(result.error());
    }

    @Test
    void testEditNote_StringNotFound() throws IOException {
        Files.writeString(tempDir.resolve("note.md"), "content");

        VaultMcpTools.EditNoteResult result = tools.editNote("note.md", "nonexistent", "new");

        assertFalse(result.success());
        assertNotNull(result.error());
    }

    @Test
    void testEditNote_NotUnique() throws IOException {
        Files.writeString(tempDir.resolve("note.md"), "test test test");

        VaultMcpTools.EditNoteResult result = tools.editNote("note.md", "test", "replacement");

        assertFalse(result.success());
        assertNotNull(result.error());
    }

    @Test
    void testEditNote_NullParameters() {
        VaultMcpTools.EditNoteResult result = tools.editNote("note.md", null, "new");

        assertFalse(result.success());
        assertTrue(result.error().contains("required"));
    }


    @Test
    void testCreateFolder_Success() {
        VaultMcpTools.CreateFolderResult result = tools.createFolder("new-folder");

        assertTrue(result.success());
        assertEquals("new-folder", result.path());
        assertTrue(result.created());
        assertNull(result.error());
    }

    @Test
    void testCreateFolder_AlreadyExists() throws IOException {
        Files.createDirectory(tempDir.resolve("existing"));

        VaultMcpTools.CreateFolderResult result = tools.createFolder("existing");

        assertTrue(result.success());
        assertFalse(result.created());
    }

    @Test
    void testCreateFolder_EmptyPath() {
        VaultMcpTools.CreateFolderResult result = tools.createFolder("");

        assertFalse(result.success());
        assertTrue(result.error().contains("required"));
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


    @Test
    void testMoveFolder_Success() throws IOException {
        Path folder = tempDir.resolve("old");
        Files.createDirectory(folder);
        Files.writeString(folder.resolve("note.md"), "content");

        VaultMcpTools.MoveFolderResult result = tools.moveFolder("old", "new");

        assertTrue(result.success());
        assertEquals("old", result.fromPath());
        assertEquals("new", result.toPath());
        assertNull(result.error());
    }

    @Test
    void testMoveFolder_SourceNotFound() {
        VaultMcpTools.MoveFolderResult result = tools.moveFolder("nonexistent", "new");

        assertFalse(result.success());
        assertNotNull(result.error());
    }

    @Test
    void testMoveFolder_EmptyPaths() {
        VaultMcpTools.MoveFolderResult result = tools.moveFolder("", "new");

        assertFalse(result.success());
        assertTrue(result.error().contains("required"));
    }
}
