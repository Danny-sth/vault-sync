package com.vaultsync.mcp;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Unit tests for VaultNoteService - all new methods added in Wave 10.
 */
class VaultNoteServiceTest {

    @TempDir
    Path tempDir;

    private VaultNoteService service;

    @BeforeEach
    void setUp() {
        service = new VaultNoteService(tempDir.toString());
    }

    // ===== DELETE FOLDER TESTS =====

    @Test
    void testDeleteFolder_EmptyFolder() throws IOException {
        // Arrange
        Path folder = tempDir.resolve("test-folder");
        Files.createDirectory(folder);

        // Act
        boolean result = service.deleteFolder("test-folder", false);

        // Assert
        assertTrue(result);
        assertFalse(Files.exists(folder));
    }

    @Test
    void testDeleteFolder_NonEmptyFolderWithoutRecursive_ThrowsException() throws IOException {
        // Arrange
        Path folder = tempDir.resolve("test-folder");
        Files.createDirectory(folder);
        Files.writeString(folder.resolve("note.md"), "content");

        // Act & Assert
        IOException exception = assertThrows(IOException.class, () ->
                service.deleteFolder("test-folder", false)
        );
        assertTrue(exception.getMessage().contains("not empty"));
    }

    @Test
    void testDeleteFolder_NonEmptyFolderWithRecursive() throws IOException {
        // Arrange
        Path folder = tempDir.resolve("test-folder");
        Files.createDirectory(folder);
        Files.writeString(folder.resolve("note.md"), "content");
        Path subfolder = folder.resolve("subfolder");
        Files.createDirectory(subfolder);
        Files.writeString(subfolder.resolve("note2.md"), "content2");

        // Act
        boolean result = service.deleteFolder("test-folder", true);

        // Assert
        assertTrue(result);
        assertFalse(Files.exists(folder));
    }

    @Test
    void testDeleteFolder_NonExistentFolder_ReturnsFalse() throws IOException {
        // Act
        boolean result = service.deleteFolder("nonexistent", false);

        // Assert
        assertFalse(result);
    }

    @Test
    void testDeleteFolder_PathTraversal_ThrowsSecurityException() {
        // Act & Assert
        assertThrows(SecurityException.class, () ->
                service.deleteFolder("../outside", false)
        );
    }

    // ===== MOVE NOTE TESTS =====

    @Test
    void testMoveNote_Success() throws IOException {
        // Arrange
        Files.writeString(tempDir.resolve("old.md"), "test content");

        // Act
        boolean result = service.moveNote("old.md", "new.md");

        // Assert
        assertTrue(result);
        assertFalse(Files.exists(tempDir.resolve("old.md")));
        assertTrue(Files.exists(tempDir.resolve("new.md")));
        assertEquals("test content", Files.readString(tempDir.resolve("new.md")));
    }

    @Test
    void testMoveNote_CreatesParentDirectories() throws IOException {
        // Arrange
        Files.writeString(tempDir.resolve("note.md"), "content");

        // Act
        boolean result = service.moveNote("note.md", "folder/subfolder/note.md");

        // Assert
        assertTrue(result);
        assertTrue(Files.exists(tempDir.resolve("folder/subfolder/note.md")));
        assertEquals("content", Files.readString(tempDir.resolve("folder/subfolder/note.md")));
    }

    @Test
    void testMoveNote_SourceNotFound_ThrowsException() {
        // Act & Assert
        IOException exception = assertThrows(IOException.class, () ->
                service.moveNote("nonexistent.md", "new.md")
        );
        assertTrue(exception.getMessage().contains("not found"));
    }

    @Test
    void testMoveNote_DestinationExists_ThrowsException() throws IOException {
        // Arrange
        Files.writeString(tempDir.resolve("old.md"), "old");
        Files.writeString(tempDir.resolve("new.md"), "new");

        // Act & Assert
        IOException exception = assertThrows(IOException.class, () ->
                service.moveNote("old.md", "new.md")
        );
        assertTrue(exception.getMessage().contains("already exists"));
    }

    // ===== APPEND NOTE TESTS =====

    @Test
    void testAppendNote_Success() throws IOException {
        // Arrange
        Files.writeString(tempDir.resolve("note.md"), "Original content\n");

        // Act
        boolean result = service.appendNote("note.md", "Appended content");

        // Assert
        assertTrue(result);
        String content = Files.readString(tempDir.resolve("note.md"));
        assertEquals("Original content\nAppended content", content);
    }

    @Test
    void testAppendNote_AddsExtension() throws IOException {
        // Arrange
        Files.writeString(tempDir.resolve("note.md"), "Original");

        // Act
        boolean result = service.appendNote("note", "\nAppended");

        // Assert
        assertTrue(result);
        assertTrue(Files.exists(tempDir.resolve("note.md")));
    }

    @Test
    void testAppendNote_NoteNotFound_ThrowsException() {
        // Act & Assert
        IOException exception = assertThrows(IOException.class, () ->
                service.appendNote("nonexistent.md", "content")
        );
        assertTrue(exception.getMessage().contains("not found"));
    }

    // ===== EDIT NOTE TESTS =====

    @Test
    void testEditNote_Success() throws IOException {
        // Arrange
        Files.writeString(tempDir.resolve("note.md"), "Hello world");

        // Act
        boolean result = service.editNote("note.md", "world", "universe");

        // Assert
        assertTrue(result);
        assertEquals("Hello universe", Files.readString(tempDir.resolve("note.md")));
    }

    @Test
    void testEditNote_StringNotFound_ThrowsException() throws IOException {
        // Arrange
        Files.writeString(tempDir.resolve("note.md"), "Hello world");

        // Act & Assert
        IllegalArgumentException exception = assertThrows(IllegalArgumentException.class, () ->
                service.editNote("note.md", "nonexistent", "replacement")
        );
        assertTrue(exception.getMessage().contains("not found"));
    }

    @Test
    void testEditNote_MultipleOccurrences_ThrowsException() throws IOException {
        // Arrange
        Files.writeString(tempDir.resolve("note.md"), "test test test");

        // Act & Assert
        IllegalArgumentException exception = assertThrows(IllegalArgumentException.class, () ->
                service.editNote("note.md", "test", "replacement")
        );
        assertTrue(exception.getMessage().contains("not unique"));
    }

    // ===== CREATE FOLDER TESTS =====

    @Test
    void testCreateFolder_Success() throws IOException {
        // Act
        boolean result = service.createFolder("new-folder");

        // Assert
        assertTrue(result);
        assertTrue(Files.isDirectory(tempDir.resolve("new-folder")));
    }

    @Test
    void testCreateFolder_CreatesParentDirectories() throws IOException {
        // Act
        boolean result = service.createFolder("parent/child/grandchild");

        // Assert
        assertTrue(result);
        assertTrue(Files.isDirectory(tempDir.resolve("parent/child/grandchild")));
    }

    @Test
    void testCreateFolder_AlreadyExists_ReturnsFalse() throws IOException {
        // Arrange
        Files.createDirectory(tempDir.resolve("existing"));

        // Act
        boolean result = service.createFolder("existing");

        // Assert
        assertFalse(result);
    }

    @Test
    void testCreateFolder_PathIsFile_ThrowsException() throws IOException {
        // Arrange
        Files.writeString(tempDir.resolve("file.md"), "content");

        // Act & Assert
        IOException exception = assertThrows(IOException.class, () ->
                service.createFolder("file.md")
        );
        assertTrue(exception.getMessage().contains("not a directory"));
    }

    // ===== GET METADATA TESTS =====

    @Test
    void testGetMetadata_File() throws IOException {
        // Arrange
        String content = "Test content";
        Files.writeString(tempDir.resolve("note.md"), content);

        // Act
        VaultNoteService.Metadata metadata = service.getMetadata("note.md");

        // Assert
        assertNotNull(metadata);
        assertEquals("note.md", metadata.path());
        assertFalse(metadata.isDirectory());
        assertEquals(content.length(), metadata.size());
        assertTrue(metadata.lastModified() > 0);
    }

    @Test
    void testGetMetadata_Directory() throws IOException {
        // Arrange
        Files.createDirectory(tempDir.resolve("folder"));

        // Act
        VaultNoteService.Metadata metadata = service.getMetadata("folder");

        // Assert
        assertNotNull(metadata);
        assertEquals("folder", metadata.path());
        assertTrue(metadata.isDirectory());
        assertEquals(0, metadata.size());
        assertTrue(metadata.lastModified() > 0);
    }

    @Test
    void testGetMetadata_NotFound_ThrowsException() {
        // Act & Assert
        IOException exception = assertThrows(IOException.class, () ->
                service.getMetadata("nonexistent")
        );
        assertTrue(exception.getMessage().contains("not found"));
    }

    // ===== MOVE FOLDER TESTS =====

    @Test
    void testMoveFolder_Success() throws IOException {
        // Arrange
        Path folder = tempDir.resolve("old-folder");
        Files.createDirectory(folder);
        Files.writeString(folder.resolve("note.md"), "content");

        // Act
        boolean result = service.moveFolder("old-folder", "new-folder");

        // Assert
        assertTrue(result);
        assertFalse(Files.exists(tempDir.resolve("old-folder")));
        assertTrue(Files.isDirectory(tempDir.resolve("new-folder")));
        assertTrue(Files.exists(tempDir.resolve("new-folder/note.md")));
    }

    @Test
    void testMoveFolder_CreatesParentDirectories() throws IOException {
        // Arrange
        Files.createDirectory(tempDir.resolve("folder"));

        // Act
        boolean result = service.moveFolder("folder", "parent/child/folder");

        // Assert
        assertTrue(result);
        assertTrue(Files.exists(tempDir.resolve("parent/child/folder")));
    }

    @Test
    void testMoveFolder_SourceNotFound_ThrowsException() {
        // Act & Assert
        IOException exception = assertThrows(IOException.class, () ->
                service.moveFolder("nonexistent", "new")
        );
        assertTrue(exception.getMessage().contains("not found"));
    }

    // ===== LIST NOTES WITH STATS TESTS =====

    @Test
    void testListNotesWithStats_Simple() throws IOException {
        // Arrange
        Files.writeString(tempDir.resolve("note1.md"), "content1");
        Files.writeString(tempDir.resolve("note2.md"), "content2");

        // Act
        List<VaultNoteService.NoteInfo> notes = service.listNotesWithStats(null, false);

        // Assert
        assertEquals(2, notes.size());
        assertTrue(notes.stream().anyMatch(n -> n.path().equals("note1.md")));
        assertTrue(notes.stream().anyMatch(n -> n.path().equals("note2.md")));
    }

    @Test
    void testListNotesWithStats_WithStats() throws IOException {
        // Arrange
        Files.writeString(tempDir.resolve("note.md"), "test");

        // Act
        List<VaultNoteService.NoteInfo> notes = service.listNotesWithStats(null, true);

        // Assert
        assertEquals(1, notes.size());
        VaultNoteService.NoteInfo info = notes.get(0);
        assertEquals("note.md", info.path());
        assertEquals(4, info.size());
        assertTrue(info.lastModified() > 0);
    }

    @Test
    void testListNotesWithStats_WithPrefix() throws IOException {
        // Arrange
        Path folder = tempDir.resolve("archive");
        Files.createDirectory(folder);
        Files.writeString(folder.resolve("old.md"), "old content");
        Files.writeString(tempDir.resolve("new.md"), "new content");

        // Act
        List<VaultNoteService.NoteInfo> notes = service.listNotesWithStats("archive", false);

        // Assert
        assertEquals(1, notes.size());
        assertEquals("archive/old.md", notes.get(0).path().replace("\\", "/"));
    }

    // ===== SEARCH NOTES WITH FOLDER TESTS =====

    @Test
    void testSearchNotes_WithFolder() throws IOException {
        // Arrange
        Path folder = tempDir.resolve("archive");
        Files.createDirectory(folder);
        Files.writeString(folder.resolve("old.md"), "# Old Note\narchived content");
        Files.writeString(tempDir.resolve("new.md"), "# New Note\nactive content");

        // Act
        List<VaultNoteService.SearchResult> results = service.searchNotes("content", "archive");

        // Assert
        assertEquals(1, results.size());
        assertTrue(results.get(0).path().contains("archive"));
    }

    @Test
    void testSearchNotes_FolderNotFound_ReturnsEmpty() throws IOException {
        // Act
        List<VaultNoteService.SearchResult> results = service.searchNotes("query", "nonexistent");

        // Assert
        assertTrue(results.isEmpty());
    }

    // ===== SECURITY TESTS =====

    @Test
    void testPathTraversal_MoveNote() {
        assertThrows(SecurityException.class, () ->
                service.moveNote("note.md", "../outside/note.md")
        );
    }

    @Test
    void testPathTraversal_AppendNote() {
        assertThrows(SecurityException.class, () ->
                service.appendNote("../outside.md", "content")
        );
    }

    @Test
    void testPathTraversal_EditNote() {
        assertThrows(SecurityException.class, () ->
                service.editNote("../outside.md", "old", "new")
        );
    }

    @Test
    void testPathTraversal_CreateFolder() {
        assertThrows(SecurityException.class, () ->
                service.createFolder("../outside")
        );
    }

    @Test
    void testPathTraversal_GetMetadata() {
        assertThrows(SecurityException.class, () ->
                service.getMetadata("../outside")
        );
    }

    @Test
    void testPathTraversal_MoveFolder() {
        assertThrows(SecurityException.class, () ->
                service.moveFolder("folder", "../outside")
        );
    }
}
