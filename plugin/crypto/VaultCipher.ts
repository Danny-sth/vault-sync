import { deriveKey, encryptBlob, decryptBlob, encryptPath, decryptPath } from './VaultCrypto';

/**
 * Sync-engine-facing wrapper around {@link VaultCrypto}.
 *
 * Bridges encryption into the existing hash-based sync protocol. The server stores and
 * hashes whatever bytes it receives, so once content is encrypted the protocol's hash
 * space MUST become SHA-256 of the *blob*, not of the plaintext — otherwise the plugin's
 * plaintext-hash would never match the server's ciphertext-hash and every file would look
 * perpetually conflicted. Because encryption is convergent (deterministic blob per
 * path+content), {@link blobHashHex} is stable and safe to use exactly where the engine
 * previously hashed plaintext for server comparison.
 *
 * The vault key is derived once (PBKDF2 is async and non-blocking) and held for the session.
 */
export class VaultCipher {
  private constructor(private readonly key: Uint8Array) {}

  /** Derive the session cipher from passphrase + per-vault salt (async — see deriveKey). */
  static async fromPassphrase(passphrase: string, salt: Uint8Array): Promise<VaultCipher> {
    return new VaultCipher(await deriveKey(passphrase, salt));
  }

  /** Plaintext → opaque blob for upload. */
  encrypt(path: string, plain: ArrayBuffer): Uint8Array {
    return encryptBlob(this.key, path, new Uint8Array(plain));
  }

  /** Blob from download → plaintext written to the vault. */
  decrypt(path: string, blob: ArrayBuffer): Uint8Array {
    return decryptBlob(this.key, path, new Uint8Array(blob));
  }

  /** Like {@link encrypt} but returns a plain ArrayBuffer for the transport layer. */
  encryptToArrayBuffer(path: string, plain: ArrayBuffer): ArrayBuffer {
    return toArrayBuffer(this.encrypt(path, plain));
  }

  /** Like {@link decrypt} but returns a plain ArrayBuffer for vault writes. */
  decryptToArrayBuffer(path: string, blob: ArrayBuffer): ArrayBuffer {
    return toArrayBuffer(this.decrypt(path, blob));
  }

  /** Real vault path → encrypted path used on the server (opaque to the server). */
  encryptPath(path: string): string {
    return encryptPath(this.key, path);
  }

  /** Encrypted server path → real vault path. */
  decryptPath(path: string): string {
    return decryptPath(this.key, path);
  }

  /**
   * Hex SHA-256 of the blob that {@link encrypt} would produce for this (path, content).
   * This is the value the server records, so the engine compares against it for dedup and
   * conflict detection. Matches the server's Java HashUtil.sha256 (lowercase hex).
   */
  async blobHashHex(path: string, plain: ArrayBuffer): Promise<string> {
    const blob = this.encrypt(path, plain);
    return sha256Hex(blob);
  }
}

/** Lowercase hex SHA-256, byte-identical to the server's HashUtil.sha256 output. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Copy a Uint8Array into a fresh, exactly-sized ArrayBuffer (never SharedArrayBuffer). */
export function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}
