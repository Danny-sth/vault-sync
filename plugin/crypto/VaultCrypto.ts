import { gcm } from '@noble/ciphers/aes';
import { argon2id } from '@noble/hashes/argon2';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

/**
 * Zero-knowledge vault crypto.
 *
 * The server never holds the key and never sees plaintext: clients encrypt each
 * file into an opaque blob before upload and decrypt after download. Content is
 * sealed with AES-256-GCM; the relative path is bound as additional authenticated
 * data (AAD) so a blob cannot be silently moved to a different path.
 *
 * Convergent encryption: the nonce is derived deterministically from
 * HMAC(key, version‖path‖plaintext) rather than random, so identical content at
 * the same path always yields the identical blob. This keeps the sync protocol's
 * SHA-256(on-disk-bytes) hash stable across devices and re-encryptions — a random
 * nonce would change the blob (and its hash) on every save, triggering false
 * conflicts and reconcile storms in VaultWatcherService. Trade-off: the server can
 * tell when two blobs are byte-identical (i.e. same plaintext) — acceptable for a
 * single-user vault. (key,nonce) reuse is safe here: it only ever recurs for the
 * exact same (key, path, plaintext), i.e. the identical message.
 *
 * Blob layout:  MAGIC(3) | VERSION(1) | NONCE(12) | CIPHERTEXT+TAG
 */

export const BLOB_MAGIC = new Uint8Array([0x56, 0x53, 0x45]); // "VSE" — Vault-Sync Encrypted
export const BLOB_VERSION = 1;
const NONCE_LEN = 12; // AES-GCM standard nonce
const HEADER_LEN = BLOB_MAGIC.length + 1; // magic + version

// Argon2id parameters. Tuned for interactive key derivation on client devices
// (incl. mobile). Salt is stored alongside the vault config, not derived here.
const ARGON2_OPTS = { t: 3, m: 64 * 1024, p: 4, dkLen: 32 } as const;

/**
 * Derive the 256-bit vault key from a passphrase and a per-vault salt.
 * Deterministic: same (passphrase, salt) → same key on every device.
 */
export function deriveKey(passphrase: string, salt: Uint8Array): Uint8Array {
  const pwd = new TextEncoder().encode(passphrase);
  return argon2id(pwd, salt, ARGON2_OPTS);
}

/**
 * Encrypt file content into a self-describing blob.
 *
 * @param key   32-byte vault key from {@link deriveKey}
 * @param path  relative vault path, bound as AAD
 * @param plain raw file bytes
 */
export function encryptBlob(key: Uint8Array, path: string, plain: Uint8Array): Uint8Array {
  assertKey(key);
  const nonce = deriveNonce(key, path, plain);
  const aad = new TextEncoder().encode(path);
  const ct = gcm(key, nonce, aad).encrypt(plain);

  const blob = new Uint8Array(HEADER_LEN + NONCE_LEN + ct.length);
  blob.set(BLOB_MAGIC, 0);
  blob[BLOB_MAGIC.length] = BLOB_VERSION;
  blob.set(nonce, HEADER_LEN);
  blob.set(ct, HEADER_LEN + NONCE_LEN);
  return blob;
}

/**
 * Decrypt a blob back to file content.
 *
 * @throws if the blob is malformed, the path/AAD does not match, the key is
 *   wrong, or the GCM tag fails (tampering).
 */
export function decryptBlob(key: Uint8Array, path: string, blob: Uint8Array): Uint8Array {
  assertKey(key);
  if (blob.length < HEADER_LEN + NONCE_LEN) {
    throw new Error('VaultCrypto: blob too short');
  }
  if (blob[0] !== BLOB_MAGIC[0] || blob[1] !== BLOB_MAGIC[1] || blob[2] !== BLOB_MAGIC[2]) {
    throw new Error('VaultCrypto: bad magic');
  }
  const version = blob[BLOB_MAGIC.length];
  if (version !== BLOB_VERSION) {
    throw new Error(`VaultCrypto: unsupported blob version ${version}`);
  }
  const nonce = blob.subarray(HEADER_LEN, HEADER_LEN + NONCE_LEN);
  const ct = blob.subarray(HEADER_LEN + NONCE_LEN);
  const aad = new TextEncoder().encode(path);
  return gcm(key, nonce, aad).decrypt(ct);
}

/**
 * Derive a deterministic 12-byte nonce from the key, path and plaintext.
 * Same (key, path, plaintext) → same nonce → same blob (convergent encryption).
 * The blob VERSION is folded in so a future format change re-derives nonces.
 */
function deriveNonce(key: Uint8Array, path: string, plain: Uint8Array): Uint8Array {
  const pathBytes = new TextEncoder().encode(path);
  // Unambiguous framing: VERSION(1) | pathLen(4, LE) | path | plain. Without the
  // explicit length, ("ab","c") and ("a","bc") would hash to the same input and
  // reuse a (key, nonce) pair across different messages — fatal for AES-GCM.
  const msg = new Uint8Array(1 + 4 + pathBytes.length + plain.length);
  msg[0] = BLOB_VERSION;
  new DataView(msg.buffer).setUint32(1, pathBytes.length, true);
  msg.set(pathBytes, 5);
  msg.set(plain, 5 + pathBytes.length);
  return hmac(sha256, key, msg).subarray(0, NONCE_LEN);
}

function assertKey(key: Uint8Array): void {
  if (key.length !== 32) {
    throw new Error(`VaultCrypto: key must be 32 bytes, got ${key.length}`);
  }
}
