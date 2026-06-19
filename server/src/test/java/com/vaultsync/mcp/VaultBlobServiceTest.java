package com.vaultsync.mcp;

import com.vaultsync.model.SyncMessage;
import com.vaultsync.service.FileStorageService;
import com.vaultsync.service.SyncService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.NoSuchFileException;
import java.util.Base64;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class VaultBlobServiceTest {

    @Mock
    FileStorageService fileStorageService;

    @Mock
    SyncService syncService;

    @InjectMocks
    VaultBlobService blobService;

    @Test
    void getBlobBase64_returnsBase64OfRawBytes() throws IOException {
        byte[] ciphertext = "VSE-encrypted-bytes".getBytes(StandardCharsets.UTF_8);
        when(fileStorageService.loadBytes("note.md")).thenReturn(ciphertext);

        String result = blobService.getBlobBase64("note.md");

        assertThat(result).isEqualTo(Base64.getEncoder().encodeToString(ciphertext));
        // Round-trips back to the exact stored bytes — server never alters the blob.
        assertThat(Base64.getDecoder().decode(result)).isEqualTo(ciphertext);
    }

    @Test
    void getBlobBase64_propagatesMissingFile() throws IOException {
        when(fileStorageService.loadBytes("missing.md")).thenThrow(new NoSuchFileException("missing.md"));

        assertThatThrownBy(() -> blobService.getBlobBase64("missing.md"))
                .isInstanceOf(NoSuchFileException.class);
    }

    @Test
    void listBlobs_mapsSyncStateToBlobInfoMetadataOnly() {
        SyncMessage.SyncResponse state = SyncMessage.SyncResponse.builder()
                .currentSeq(42)
                .files(List.of(
                        SyncMessage.FileInfo.builder()
                                .path("a.md").hash("h1").size(10).mtime(1000).seq(5).build(),
                        SyncMessage.FileInfo.builder()
                                .path("dir/b.md").hash("h2").size(20).mtime(2000).seq(7).build()
                ))
                .tombstones(List.of())
                .build();
        when(syncService.getFullState()).thenReturn(state);

        List<VaultBlobService.BlobInfo> blobs = blobService.listBlobs();

        assertThat(blobs).containsExactly(
                new VaultBlobService.BlobInfo("a.md", "h1", 10, 1000, 5),
                new VaultBlobService.BlobInfo("dir/b.md", "h2", 20, 2000, 7)
        );
    }
}
