package com.vaultsync.util;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/**
 * Utility class for SHA-256 hash computation.
 */
public final class HashUtil {

    private HashUtil() {
    }

    /**
     * Compute SHA-256 hash of byte array content.
     *
     * @param content byte array to hash
     * @return lowercase hex-encoded SHA-256 hash
     */
    public static String sha256(byte[] content) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hashBytes = digest.digest(content);
            return HexFormat.of().formatHex(hashBytes);
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-256 not available", e);
        }
    }

    /**
     * Compute SHA-256 hash of a file by streaming it through a {@link DigestInputStream}.
     * Uses a fixed 8&nbsp;KB buffer, so memory stays constant regardless of file size —
     * a 22&nbsp;MB attachment hashes without ever being held whole in the heap. This is the
     * core defence against the heap exhaustion that {@code Files.readAllBytes} caused on the
     * 128&nbsp;MB server.
     *
     * @param filePath path to file
     * @return lowercase hex-encoded SHA-256 hash
     * @throws IOException if file cannot be read
     */
    public static String sha256(Path filePath) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-256 not available", e);
        }
        byte[] buffer = new byte[8192];
        try (InputStream in = Files.newInputStream(filePath);
             DigestInputStream dis = new DigestInputStream(in, digest)) {
            while (dis.read(buffer) != -1) {
                // reading advances the digest; nothing else to do
            }
        }
        return HexFormat.of().formatHex(digest.digest());
    }
}
