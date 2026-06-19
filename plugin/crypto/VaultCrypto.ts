import { gcm } from '@noble/ciphers/aes';
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

// PBKDF2-HMAC-SHA256 iteration count (OWASP 2023 baseline for this primitive).
const PBKDF2_ITERATIONS = 600_000;

/**
 * Derive the 256-bit vault key from a passphrase and a per-vault salt.
 * Deterministic: same (passphrase, salt) → same key on every device.
 *
 * Uses native WebCrypto PBKDF2 (crypto.subtle.deriveBits) rather than a synchronous
 * JS Argon2: Argon2id at interactive parameters runs ~1–5 s with no yield points and
 * would freeze Obsidian's UI thread (worst on mobile). PBKDF2 here runs off the JS
 * event loop and returns a Promise — no UI jank. Trade-off: PBKDF2 is not memory-hard,
 * so it is weaker than Argon2id against GPU/ASIC passphrase cracking; mitigated by a
 * high iteration count and a strong passphrase. Acceptable for a single-user vault
 * whose primary threat is offline access to stolen ciphertext/backups.
 */
export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  const pwd = new TextEncoder().encode(passphrase);
  // Copy into freshly-allocated ArrayBuffers so the WebCrypto BufferSource types
  // resolve to ArrayBuffer (never SharedArrayBuffer) under strict lib typings.
  const pwdBuf = new ArrayBuffer(pwd.byteLength);
  new Uint8Array(pwdBuf).set(pwd);
  const saltBuf = new ArrayBuffer(salt.byteLength);
  new Uint8Array(saltBuf).set(salt);

  const baseKey = await crypto.subtle.importKey('raw', pwdBuf, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBuf, iterations: PBKDF2_ITERATIONS },
    baseKey,
    256,
  );
  return new Uint8Array(bits);
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

// ---------------------------------------------------------------------------
// Path (filename / folder) encryption — full zero-knowledge: the server never
// sees real names. Each path component is encrypted deterministically, so the same
// name always maps to the same ciphertext (the folder tree is preserved and names
// dedup), and it is reversible (a client decrypts a listing back into real names).
// Output is base32 (a-z 2-7) → safe as a filesystem name. Both the plugin and any
// other key holder (duq) use this identical mapping, so nobody is "broken" by it.
// ---------------------------------------------------------------------------

const PATH_AAD = new TextEncoder().encode('vault-path');
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32encode(bytes: Uint8Array): string {
  let bits = 0, val = 0, out = '';
  for (const b of bytes) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

function base32decode(s: string): Uint8Array {
  let bits = 0, val = 0;
  const out: number[] = [];
  for (const ch of s) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    val = (val << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

/** Deterministic nonce for a path component (domain-separated from the blob nonce). */
function deriveComponentNonce(key: Uint8Array, component: Uint8Array): Uint8Array {
  const msg = new Uint8Array(1 + component.length);
  msg[0] = 0xfe; // path-component domain marker (blob nonce starts with BLOB_VERSION)
  msg.set(component, 1);
  return hmac(sha256, key, msg).subarray(0, NONCE_LEN);
}

/** Encrypt a single path component (no '/') → base32 filesystem-safe name. */
export function encryptPathComponent(key: Uint8Array, component: string): string {
  assertKey(key);
  const bytes = new TextEncoder().encode(component);
  const nonce = deriveComponentNonce(key, bytes);
  const ct = gcm(key, nonce, PATH_AAD).encrypt(bytes);
  const out = new Uint8Array(NONCE_LEN + ct.length);
  out.set(nonce, 0);
  out.set(ct, NONCE_LEN);
  return base32encode(out);
}

/** Inverse of {@link encryptPathComponent}. */
export function decryptPathComponent(key: Uint8Array, enc: string): string {
  assertKey(key);
  const data = base32decode(enc);
  const nonce = data.subarray(0, NONCE_LEN);
  const ct = data.subarray(NONCE_LEN);
  return new TextDecoder().decode(gcm(key, nonce, PATH_AAD).decrypt(ct));
}

/** Encrypt a full relative path component-by-component (slashes preserved). */
export function encryptPath(key: Uint8Array, path: string): string {
  return path.split('/').map((c) => (c === '' ? '' : encryptPathComponent(key, c))).join('/');
}

/** Inverse of {@link encryptPath}. */
export function decryptPath(key: Uint8Array, encPath: string): string {
  return encPath.split('/').map((c) => (c === '' ? '' : decryptPathComponent(key, c))).join('/');
}
