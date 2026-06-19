import { describe, it, expect } from 'vitest';
import { VaultCipher, sha256Hex } from './VaultCipher';

const SALT = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

function buf(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer;
}

describe('VaultCipher', () => {
  it('round-trips through encrypt/decrypt for the same path', () => {
    const cipher = VaultCipher.fromPassphrase('pass', SALT);
    const plain = '# note\nтело 🔐';
    const blob = cipher.encrypt('a/b.md', buf(plain));
    const out = cipher.decrypt('a/b.md', blob.buffer);
    expect(new TextDecoder().decode(out)).toBe(plain);
  });

  it('blobHashHex is stable for the same (path, content) — usable as the sync hash', async () => {
    const cipher = VaultCipher.fromPassphrase('pass', SALT);
    const h1 = await cipher.blobHashHex('a.md', buf('hello'));
    const h2 = await cipher.blobHashHex('a.md', buf('hello'));
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('blobHashHex equals sha256 of the actual encrypted blob (matches what the server stores)', async () => {
    const cipher = VaultCipher.fromPassphrase('pass', SALT);
    const blob = cipher.encrypt('a.md', buf('hello'));
    expect(await cipher.blobHashHex('a.md', buf('hello'))).toBe(await sha256Hex(blob));
  });

  it('blobHashHex differs when content changes', async () => {
    const cipher = VaultCipher.fromPassphrase('pass', SALT);
    const h1 = await cipher.blobHashHex('a.md', buf('one'));
    const h2 = await cipher.blobHashHex('a.md', buf('two'));
    expect(h1).not.toBe(h2);
  });

  it('two ciphers from the same passphrase+salt are interchangeable (cross-device)', () => {
    const a = VaultCipher.fromPassphrase('shared', SALT);
    const b = VaultCipher.fromPassphrase('shared', SALT);
    const blob = a.encrypt('x.md', buf('cross-device'));
    expect(new TextDecoder().decode(b.decrypt('x.md', blob.buffer))).toBe('cross-device');
  });
});
