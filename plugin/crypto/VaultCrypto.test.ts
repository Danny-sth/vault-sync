import { describe, it, expect } from 'vitest';
import { deriveKey, encryptBlob, decryptBlob, BLOB_MAGIC, BLOB_VERSION } from './VaultCrypto';

const PASSPHRASE = 'correct horse battery staple';
// Fixed 16-byte salt for deterministic key derivation in tests.
const SALT = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

function textBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('VaultCrypto', () => {
  it('derives a stable 32-byte key from passphrase + salt', () => {
    const k1 = deriveKey(PASSPHRASE, SALT);
    const k2 = deriveKey(PASSPHRASE, SALT);
    expect(k1.length).toBe(32);
    expect(Array.from(k1)).toEqual(Array.from(k2));
  });

  it('derives a different key for a different passphrase', () => {
    const k1 = deriveKey(PASSPHRASE, SALT);
    const k2 = deriveKey('wrong passphrase', SALT);
    expect(Array.from(k1)).not.toEqual(Array.from(k2));
  });

  it('round-trips content: decrypt(encrypt(x)) === x', () => {
    const key = deriveKey(PASSPHRASE, SALT);
    const plain = textBytes('# Secret note\n\nhello мир 🔒');
    const blob = encryptBlob(key, 'folder/note.md', plain);
    const out = decryptBlob(key, 'folder/note.md', blob);
    expect(Array.from(out)).toEqual(Array.from(plain));
  });

  it('produces a tagged blob with magic + version header and is not plaintext', () => {
    const key = deriveKey(PASSPHRASE, SALT);
    const plain = textBytes('plaintext-marker-xyz');
    const blob = encryptBlob(key, 'a.md', plain);
    expect(blob[0]).toBe(BLOB_MAGIC[0]);
    expect(blob[1]).toBe(BLOB_MAGIC[1]);
    expect(blob[2]).toBe(BLOB_MAGIC[2]);
    expect(blob[3]).toBe(BLOB_VERSION);
    // The marker must not appear verbatim in the ciphertext.
    const hay = new TextDecoder('latin1').decode(blob);
    expect(hay.includes('plaintext-marker-xyz')).toBe(false);
  });

  it('convergent: same (path, content) encrypts to the identical blob (stable hash)', () => {
    const key = deriveKey(PASSPHRASE, SALT);
    const plain = textBytes('same input');
    const a = encryptBlob(key, 'a.md', plain);
    const b = encryptBlob(key, 'a.md', plain);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('different content at the same path yields a different blob', () => {
    const key = deriveKey(PASSPHRASE, SALT);
    const a = encryptBlob(key, 'a.md', textBytes('content one'));
    const b = encryptBlob(key, 'a.md', textBytes('content two'));
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('same content at different paths yields a different blob', () => {
    const key = deriveKey(PASSPHRASE, SALT);
    const plain = textBytes('same content');
    const a = encryptBlob(key, 'one.md', plain);
    const b = encryptBlob(key, 'two.md', plain);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('no nonce collision for ambiguous (path, content) splits: ("ab","c") vs ("a","bc")', () => {
    const key = deriveKey(PASSPHRASE, SALT);
    // Same concatenated bytes split differently between path and content. Without
    // length-framing in nonce derivation these would share a nonce → GCM break.
    const a = encryptBlob(key, 'ab', textBytes('c'));
    const b = encryptBlob(key, 'a', textBytes('bc'));
    const nonceA = a.subarray(4, 16);
    const nonceB = b.subarray(4, 16);
    expect(Array.from(nonceA)).not.toEqual(Array.from(nonceB));
  });

  it('binds the path via AAD: decrypting under a different path fails', () => {
    const key = deriveKey(PASSPHRASE, SALT);
    const blob = encryptBlob(key, 'real/path.md', textBytes('x'));
    expect(() => decryptBlob(key, 'other/path.md', blob)).toThrow();
  });

  it('rejects a tampered blob (GCM auth)', () => {
    const key = deriveKey(PASSPHRASE, SALT);
    const blob = encryptBlob(key, 'a.md', textBytes('x'));
    blob[blob.length - 1] ^= 0xff; // flip a tag byte
    expect(() => decryptBlob(key, 'a.md', blob)).toThrow();
  });

  it('fails to decrypt with the wrong key', () => {
    const key = deriveKey(PASSPHRASE, SALT);
    const wrong = deriveKey('nope', SALT);
    const blob = encryptBlob(key, 'a.md', textBytes('x'));
    expect(() => decryptBlob(wrong, 'a.md', blob)).toThrow();
  });
});
