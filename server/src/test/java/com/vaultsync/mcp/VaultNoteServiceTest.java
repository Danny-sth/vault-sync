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


    @Test
    void testDeleteFolder_EmptyFolder() throws IOException {
        Path folder = tempDir.resolve("test-folder");
        Files.createDirectory(folder);

        boolean result = service.deleteFolder("test-folder", false);

        assertTrue(result);
        assertFalse(Files.exists(folder));
    }

    @Test
    void testDeleteFolder_NonEmptyFolderWithoutRecursive_ThrowsException() throws IOException {
        Path folder = tempDir.resolve("test-folder");
        Files.createDirectory(folder);
        Files.writeString(folder.resolve("note.md"), "content");

        IOException exception = assertThrows(IOException.class, () ->
                service.deleteFolder("test-folder", false)
        );
        assertTrue(exception.getMessage().contains("not empty"));
    }

    @Test
    void testDeleteFolder_NonEmptyFolderWithRecursive() throws IOException {
        Path folder = tempDir.resolve("test-folder");
        Files.createDirectory(folder);
        Files.writeString(folder.resolve("note.md"), "content");
        Path subfolder = folder.resolve("subfolder");
        Files.createDirectory(subfolder);
        Files.writeString(subfolder.resolve("note2.md"), "content2");

        boolean result = service.deleteFolder("test-folder", true);

        assertTrue(result);
        assertFalse(Files.exists(folder));
    }

    @Test
    void testDeleteFolder_NonExistentFolder_ReturnsFalse() throws IOException {
        boolean result = service.deleteFolder("nonexistent", false);

        assertFalse(result);
    }

    @Test
    void testDeleteFolder_PathTraversal_ThrowsSecurityException() {
        assertThrows(SecurityException.class, () ->
                service.deleteFolder("../outside", false)
        );
    }


    @Test
    void testMoveNote_Success() throws IOException {
        Files.writeString(tempDir.resolve("old.md"), "test content");

        boolean result = service.moveNote("old.md", "new.md");

        assertTrue(result);
        assertFalse(Files.exists(tempDir.resolve("old.md")));
        assertTrue(Files.exists(tempDir.resolve("new.md")));
        assertEquals("test content", Files.readString(tempDir.resolve("new.md")));
    }

    @Test
    void testMoveNote_CreatesParentDirectories() throws IOException {
        Files.writeString(tempDir.resolve("note.md"), "content");

        boolean result = service.moveNote("note.md", "folder/subfolder/note.md");

        assertTrue(result);
        assertTrue(Files.exists(tempDir.resolve("folder/subfolder/note.md")));
        assertEquals("content", Files.readString(tempDir.resolve("folder/subfolder/note.md")));
    }

    @Test
    void testMoveNote_SourceNotFound_ThrowsException() {
        IOException exception = assertThrows(IOException.class, () ->
                service.moveNote("nonexistent.md", "new.md")
        );
        assertTrue(exception.getMessage().contains("not found"));
    }

    @Test
    void testMoveNote_DestinationExists_ThrowsException() throws IOException {
        Files.writeString(tempDir.resolve("old.md"), "old");
        Files.writeString(tempDir.resolve("new.md"), "new");

        IOException exception = assertThrows(IOException.class, () ->
                service.moveNote("old.md", "new.md")
        );
        assertTrue(exception.getMessage().contains("already exists"));
    }


    @Test
    void testAppendNote_Success() throws IOException {
        Files.writeString(tempDir.resolve("note.md"), "Original content\n");

        boolean result = service.appendNote("note.md", "Appended content");

        assertTrue(result);
        String content = Files.readString(tempDir.resolve("note.md"));
        assertEquals("Original content\nAppended content", content);
    }

    @Test
    void testAppendNote_AddsExtension() throws IOException {
        Files.writeString(tempDir.resolve("note.md"), "Original");

        boolean result = service.appendNote("note", "\nAppended");

        assertTrue(result);
        assertTrue(Files.exists(tempDir.resolve("note.md")));
    }

    @Test
    void testAppendNote_NoteNotFound_ThrowsException() {
        IOException exception = assertThrows(IOException.class, () ->
                service.appendNote("nonexistent.md", "content")
        );
        assertTrue(exception.getMessage().contains("not found"));
    }


    @Test
    void testEditNote_Success() throws IOException {
        Files.writeString(tempDir.resolve("note.md"), "Hello world");

        boolean result = service.editNote("note.md", "world", "universe");

        assertTrue(result);
        assertEquals("Hello universe", Files.readString(tempDir.resolve("note.md")));
    }

    @Test
    void testEditNote_StringNotFound_ThrowsException() throws IOException {
        Files.writeString(tempDir.resolve("note.md"), "Hello world");

        IllegalArgumentException exception = assertThrows(IllegalArgumentException.class, () ->
                service.editNote("note.md", "nonexistent", "replacement")
        );
        assertTrue(exception.getMessage().contains("not found"));
    }

    @Test
    void testEditNote_MultipleOccurrences_ThrowsException() throws IOException {
        Files.writeString(tempDir.resolve("note.md"), "test test test");

        IllegalArgumentException exception = assertThrows(IllegalArgumentException.class, () ->
                service.editNote("note.md", "test", "replacement")
        );
        assertTrue(exception.getMessage().contains("not unique"));
    }


    @Test
    void testCreateFolder_Success() throws IOException {
        boolean result = service.createFolder("new-folder");

        assertTrue(result);
        assertTrue(Files.isDirectory(tempDir.resolve("new-folder")));
    }

    @Test
    void testCreateFolder_CreatesParentDirectories() throws IOException {
        boolean result = service.createFolder("parent/child/grandchild");

        assertTrue(result);
        assertTrue(Files.isDirectory(tempDir.resolve("parent/child/grandchild")));
    }

    @Test
    void testCreateFolder_AlreadyExists_ReturnsFalse() throws IOException {
        Files.createDirectory(tempDir.resolve("existing"));

        boolean result = service.createFolder("existing");

        assertFalse(result);
    }

    @Test
    void testCreateFolder_PathIsFile_ThrowsException() throws IOException {
        Files.writeString(tempDir.resolve("file.md"), "content");

        IOException exception = assertThrows(IOException.class, () ->
                service.createFolder("file.md")
        );
        assertTrue(exception.getMessage().contains("not a directory"));
    }


    @Test
    void testGetMetadata_File() throws IOException {
        String content = "Test content";
        Files.writeString(tempDir.resolve("note.md"), content);

        VaultNoteService.Metadata metadata = service.getMetadata("note.md");

        assertNotNull(metadata);
        assertEquals("note.md", metadata.path());
        assertFalse(metadata.isDirectory());
        assertEquals(content.length(), metadata.size());
        assertTrue(metadata.lastModified() > 0);
    }

    @Test
    void testGetMetadata_Directory() throws IOException {
        Files.createDirectory(tempDir.resolve("folder"));

        VaultNoteService.Metadata metadata = service.getMetadata("folder");

        assertNotNull(metadata);
        assertEquals("folder", metadata.path());
        assertTrue(metadata.isDirectory());
        assertEquals(0, metadata.size());
        assertTrue(metadata.lastModified() > 0);
    }

    @Test
    void testGetMetadata_NotFound_ThrowsException() {
        IOException exception = assertThrows(IOException.class, () ->
                service.getMetadata("nonexistent")
        );
        assertTrue(exception.getMessage().contains("not found"));
    }


    @Test
    void testMoveFolder_Success() throws IOException {
        Path folder = tempDir.resolve("old-folder");
        Files.createDirectory(folder);
        Files.writeString(folder.resolve("note.md"), "content");

        boolean result = service.moveFolder("old-folder", "new-folder");

        assertTrue(result);
        assertFalse(Files.exists(tempDir.resolve("old-folder")));
        assertTrue(Files.isDirectory(tempDir.resolve("new-folder")));
        assertTrue(Files.exists(tempDir.resolve("new-folder/note.md")));
    }

    @Test
    void testMoveFolder_CreatesParentDirectories() throws IOException {
        Files.createDirectory(tempDir.resolve("folder"));

        boolean result = service.moveFolder("folder", "parent/child/folder");

        assertTrue(result);
        assertTrue(Files.exists(tempDir.resolve("parent/child/folder")));
    }

    @Test
    void testMoveFolder_SourceNotFound_ThrowsException() {
        IOException exception = assertThrows(IOException.class, () ->
                service.moveFolder("nonexistent", "new")
        );
        assertTrue(exception.getMessage().contains("not found"));
    }


    @Test
    void testListNotesWithStats_Simple() throws IOException {
        Files.writeString(tempDir.resolve("note1.md"), "content1");
        Files.writeString(tempDir.resolve("note2.md"), "content2");

        List<VaultNoteService.NoteInfo> notes = service.listNotesWithStats(null, false);

        assertEquals(2, notes.size());
        assertTrue(notes.stream().anyMatch(n -> n.path().equals("note1.md")));
        assertTrue(notes.stream().anyMatch(n -> n.path().equals("note2.md")));
    }

    @Test
    void testListNotesWithStats_WithStats() throws IOException {
        Files.writeString(tempDir.resolve("note.md"), "test");

        List<VaultNoteService.NoteInfo> notes = service.listNotesWithStats(null, true);

        assertEquals(1, notes.size());
        VaultNoteService.NoteInfo info = notes.get(0);
        assertEquals("note.md", info.path());
        assertEquals(4, info.size());
        assertTrue(info.lastModified() > 0);
    }

    @Test
    void testListNotesWithStats_WithPrefix() throws IOException {
        Path folder = tempDir.resolve("archive");
        Files.createDirectory(folder);
        Files.writeString(folder.resolve("old.md"), "old content");
        Files.writeString(tempDir.resolve("new.md"), "new content");

        List<VaultNoteService.NoteInfo> notes = service.listNotesWithStats("archive", false);

        assertEquals(1, notes.size());
        assertEquals("archive/old.md", notes.get(0).path().replace("\\", "/"));
    }


    @Test
    void testSearchNotes_WithFolder() throws IOException {
        Path folder = tempDir.resolve("archive");
        Files.createDirectory(folder);
        Files.writeString(folder.resolve("old.md"), "# Old Note\narchived content");
        Files.writeString(tempDir.resolve("new.md"), "# New Note\nactive content");

        List<VaultNoteService.SearchResult> results = service.searchNotes("content", "archive");

        assertEquals(1, results.size());
        assertTrue(results.get(0).path().contains("archive"));
    }

    @Test
    void testSearchNotes_FolderNotFound_ReturnsEmpty() throws IOException {
        List<VaultNoteService.SearchResult> results = service.searchNotes("query", "nonexistent");

        assertTrue(results.isEmpty());
    }


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
