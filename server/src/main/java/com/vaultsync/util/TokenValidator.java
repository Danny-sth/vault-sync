package com.vaultsync.util;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * Utility class for constant-time token validation.
 */
public final class TokenValidator {

    private TokenValidator() {
        // Utility class
    }

    /**
     * Validate token in constant time to prevent timing attacks.
     *
     * @param provided the token provided by the client
     * @param expected the expected token
     * @return true if tokens match, false otherwise
     */
    public static boolean validate(String provided, String expected) {
        if (provided == null || expected == null) {
            return false;
        }
        return MessageDigest.isEqual(
                provided.getBytes(StandardCharsets.UTF_8),
                expected.getBytes(StandardCharsets.UTF_8)
        );
    }
}
