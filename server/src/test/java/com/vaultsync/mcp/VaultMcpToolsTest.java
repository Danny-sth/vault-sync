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

    // ===== LIST NOTES EXTENDED TESTS =====

    @Test
    void testListNotesExtended_WithoutStats() throws IOException {
        // Arrange
        Files.writeString(tempDir.resolve("note1.md"), "content1");
        Files.writeString(tempDir.resolve("note2.md"), "content2");

        // Act
        VaultMcpTools.ListNotesResult result = tools.listNotesExtended(null, false);

        // Assert
        assertTrue(result.success());
        assertEquals(2, result.count());
        assertNotNull(result.notes());
        assertNull(result.notesWithStats());
    }

    @Test
    void testListNotesExtended_WithStats() throws IOException {
        // Arrange
        Files.writeString(tempDir.resolve("note.md"), "test");

        // Act
        VaultMcpTools.ListNotesResult result = tools.listNotesExtended(null, true);

        // Assert
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
        // Arrange
        Path folder = tempDir.resolve("archive");
        Files.createDirectory(folder);
        Files.writeString(folder.resolve("old.md"), "old");
        Files.writeString(tempDir.resolve("new.md"), "new");

        // Act
        VaultMcpTools.ListNotesResult result = tools.listNotesExtended("archive", false);

        // Assert
        assertTrue(result.success());
        assertEquals(1, result.count());
    }

    // ===== SEARCH NOTES IN FOLDER TESTS =====

    @Test
    void testSearchNotesInFolder_Success() throws IOException {
        // Arrange
        Path folder = tempDir.resolve("archive");
        Files.createDirectory(folder);
        Files.writeString(folder.resolve("old.md"), "# Old\narchived content");
        Files.writeString(tempDir.resolve("new.md"), "# New\nactive content");

        // Act
        VaultMcpTools.SearchNotesResult result = tools.searchNotesInFolder("archived", "archive");

        // Assert
        assertTrue(result.success());
        assertEquals(1, result.count());
        assertEquals("archive", result.folder());
        assertEquals("archived", result.query());
    }

    @Test
    void testSearchNotesInFolder_EmptyQuery() {
        // Act
        VaultMcpTools.SearchNotesResult result = tools.searchNotesInFolder("", "folder");

        // Assert
        assertFalse(result.success());
        assertNotNull(result.error());
    }

    // ===== DELETE FOLDER TESTS =====

    @Test
    void testDeleteFolder_Success() throws IOException {
        // Arrange
        Files.createDirectory(tempDir.resolve("folder"));

        // Act
        VaultMcpTools.DeleteFolderResult result = tools.deleteFolder("folder", false);

        // Assert
        assertTrue(result.success());
        assertEquals("folder", result.path());
        assertNull(result.error());
    }

    @Test
    void testDeleteFolder_Recursive() throws IOException {
        // Arrange
        Path folder = tempDir.resolve("folder");
        Files.createDirectory(folder);
        Files.writeString(folder.resolve("note.md"), "content");

        // Act
        VaultMcpTools.DeleteFolderResult result = tools.deleteFolder("folder", true);

        // Assert
        assertTrue(result.success());
    }

    @Test
    void testDeleteFolder_NotFound() {
        // Act
        VaultMcpTools.DeleteFolderResult result = tools.deleteFolder("nonexistent", false);

        // Assert
        assertFalse(result.success());
        assertNotNull(result.error());
    }

    @Test
    void testDeleteFolder_EmptyPath() {
        // Act
        VaultMcpTools.DeleteFolderResult result = tools.deleteFolder("", false);

        // Assert
        assertFalse(result.success());
        assertTrue(result.error().contains("required"));
    }

    // ===== MOVE NOTE TESTS =====

    @Test
    void testMoveNote_Success() throws IOException {
        // Arrange
        Files.writeString(tempDir.resolve("old.md"), "content");

        // Act
        VaultMcpTools.MoveNoteResult result = tools.moveNote("old.md", "new.md");

        // Assert
        assertTrue(result.success());
        assertEquals("old.md", result.fromPath());
        assertEquals("new.md", result.toPath());
        assertNull(result.error());
    }

    @Test
    void testMoveNote_SourceNotFound() {
        // Act
        VaultMcpTools.MoveNoteResult result = tools.moveNote("nonexistent.md", "new.md");

        // Assert
        assertFalse(result.success());
        assertNotNull(result.error());
    }

    @Test
    void testMoveNote_EmptyPaths() {
        // Act
        VaultMcpTools.MoveNoteResult result = tools.moveNote("", "new.md");

        // Assert
        assertFalse(result.success());
        assertTrue(result.error().contains("required"));
    }

    // ===== APPEND NOTE TESTS =====

    @Test
    void testAppendNote_Success() throws IOException {
        // Arrange
        Files.writeString(tempDir.resolve("note.md"), "Original\n");

        // Act
        VaultMcpTools.AppendNoteResult result = tools.appendNote("note.md", "Appended");

        // Assert
        assertTrue(result.success());
        assertEquals("note.md", result.path());
        assertNull(result.error());
    }

    @Test
    void testAppendNote_NoteNotFound() {
        // Act
        VaultMcpTools.AppendNoteResult result = tools.appendNote("nonexistent.md", "content");

        // Assert
        assertFalse(result.success());
        assertNotNull(result.error());
    }

    @Test
    void testAppendNote_NullContent() {
        // Act
        VaultMcpTools.AppendNoteResult result = tools.appendNote("note.md", null);

        // Assert
        assertFalse(result.success());
        assertTrue(result.error().contains("required"));
    }

    // ===== EDIT NOTE TESTS =====

    @Test
    void testEditNote_Success() throws IOException {
        // Arrange
        Files.writeString(tempDir.resolve("note.md"), "Hello world");

        // Act
        VaultMcpTools.EditNoteResult result = tools.editNote("note.md", "world", "universe");

        // Assert
        assertTrue(result.success());
        assertEquals("note.md", result.path());
        assertNull(result.error());
    }

    @Test
    void testEditNote_StringNotFound() throws IOException {
        // Arrange
        Files.writeString(tempDir.resolve("note.md"), "content");

        // Act
        VaultMcpTools.EditNoteResult result = tools.editNote("note.md", "nonexistent", "new");

        // Assert
        assertFalse(result.success());
        assertNotNull(result.error());
    }

    @Test
    void testEditNote_NotUnique() throws IOException {
        // Arrange
        Files.writeString(tempDir.resolve("note.md"), "test test test");

        // Act
        VaultMcpTools.EditNoteResult result = tools.editNote("note.md", "test", "replacement");

        // Assert
        assertFalse(result.success());
        assertNotNull(result.error());
    }

    @Test
    void testEditNote_NullParameters() {
        // Act
        VaultMcpTools.EditNoteResult result = tools.editNote("note.md", null, "new");

        // Assert
        assertFalse(result.success());
        assertTrue(result.error().contains("required"));
    }

    // ===== CREATE FOLDER TESTS =====

    @Test
    void testCreateFolder_Success() {
        // Act
        VaultMcpTools.CreateFolderResult result = tools.createFolder("new-folder");

        // Assert
        assertTrue(result.success());
        assertEquals("new-folder", result.path());
        assertTrue(result.created());
        assertNull(result.error());
    }

    @Test
    void testCreateFolder_AlreadyExists() throws IOException {
        // Arrange
        Files.createDirectory(tempDir.resolve("existing"));

        // Act
        VaultMcpTools.CreateFolderResult result = tools.createFolder("existing");

        // Assert
        assertTrue(result.success());
        assertFalse(result.created());
    }

    @Test
    void testCreateFolder_EmptyPath() {
        // Act
        VaultMcpTools.CreateFolderResult result = tools.createFolder("");

        // Assert
        assertFalse(result.success());
        assertTrue(result.error().contains("required"));
    }

    // ===== GET METADATA TESTS =====

    @Test
    void testGetMetadata_File() throws IOException {
        // Arrange
        Files.writeString(tempDir.resolve("note.md"), "test");

        // Act
        VaultMcpTools.GetMetadataResult result = tools.getMetadata("note.md");

        // Assert
        assertTrue(result.success());
        assertNotNull(result.metadata());
        assertEquals("note.md", result.metadata().path());
        assertFalse(result.metadata().isDirectory());
        assertEquals(4, result.metadata().size());
        assertNull(result.error());
    }

    @Test
    void testGetMetadata_Directory() throws IOException {
        // Arrange
        Files.createDirectory(tempDir.resolve("folder"));

        // Act
        VaultMcpTools.GetMetadataResult result = tools.getMetadata("folder");

        // Assert
        assertTrue(result.success());
        assertTrue(result.metadata().isDirectory());
        assertEquals(0, result.metadata().size());
    }

    @Test
    void testGetMetadata_NotFound() {
        // Act
        VaultMcpTools.GetMetadataResult result = tools.getMetadata("nonexistent");

        // Assert
        assertFalse(result.success());
        assertNotNull(result.error());
    }

    @Test
    void testGetMetadata_EmptyPath() {
        // Act
        VaultMcpTools.GetMetadataResult result = tools.getMetadata("");

        // Assert
        assertFalse(result.success());
        assertTrue(result.error().contains("required"));
    }

    // ===== MOVE FOLDER TESTS =====

    @Test
    void testMoveFolder_Success() throws IOException {
        // Arrange
        Path folder = tempDir.resolve("old");
        Files.createDirectory(folder);
        Files.writeString(folder.resolve("note.md"), "content");

        // Act
        VaultMcpTools.MoveFolderResult result = tools.moveFolder("old", "new");

        // Assert
        assertTrue(result.success());
        assertEquals("old", result.fromPath());
        assertEquals("new", result.toPath());
        assertNull(result.error());
    }

    @Test
    void testMoveFolder_SourceNotFound() {
        // Act
        VaultMcpTools.MoveFolderResult result = tools.moveFolder("nonexistent", "new");

        // Assert
        assertFalse(result.success());
        assertNotNull(result.error());
    }

    @Test
    void testMoveFolder_EmptyPaths() {
        // Act
        VaultMcpTools.MoveFolderResult result = tools.moveFolder("", "new");

        // Assert
        assertFalse(result.success());
        assertTrue(result.error().contains("required"));
    }
}
