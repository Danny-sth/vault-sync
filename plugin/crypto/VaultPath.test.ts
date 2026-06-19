import { describe, it, expect } from 'vitest';
import { deriveKey, encryptPath, decryptPath, encryptPathComponent } from './VaultCrypto';

const SALT = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

describe('VaultCrypto path encryption', () => {
  it('round-trips a nested path with unicode names', async () => {
    const key = await deriveKey('pw', SALT);
    const p = 'Daily/Прочитанные книги.md';
    const enc = encryptPath(key, p);
    expect(enc).not.toContain('Daily');
    expect(enc).not.toContain('книги');
    expect(decryptPath(key, enc)).toBe(p);
  });

  it('keeps slash structure (depth preserved) and base32-safe names', async () => {
    const key = await deriveKey('pw', SALT);
    const enc = encryptPath(key, 'a/b/c.md');
    expect(enc.split('/').length).toBe(3);
    expect(enc).toMatch(/^[a-z2-7]+\/[a-z2-7]+\/[a-z2-7]+$/);
  });

  it('deterministic: same component → same ciphertext (folder names dedup across tree)', async () => {
    const key = await deriveKey('pw', SALT);
    // "Daily" encrypts to the same name wherever it appears.
    const a = encryptPath(key, 'Daily/x.md').split('/')[0];
    const b = encryptPath(key, 'Daily/y.md').split('/')[0];
    expect(a).toBe(b);
    expect(encryptPathComponent(key, 'Daily')).toBe(a);
  });

  it('different names → different ciphertext', async () => {
    const key = await deriveKey('pw', SALT);
    expect(encryptPathComponent(key, 'Daily')).not.toBe(encryptPathComponent(key, 'Weekly'));
  });

  it('wrong key cannot decrypt the path', async () => {
    const key = await deriveKey('pw', SALT);
    const wrong = await deriveKey('nope', SALT);
    const enc = encryptPath(key, 'secret/folder.md');
    expect(() => decryptPath(wrong, enc)).toThrow();
  });
});
