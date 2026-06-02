package com.vaultsync.util;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
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
     * Compute SHA-256 hash of file content.
     *
     * @param filePath path to file
     * @return lowercase hex-encoded SHA-256 hash
     * @throws IOException if file cannot be read
     */
    public static String sha256(Path filePath) throws IOException {
        byte[] fileBytes = Files.readAllBytes(filePath);
        return sha256(fileBytes);
    }
}
