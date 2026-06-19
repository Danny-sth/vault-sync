// Pure node:crypto implementation, byte-compatible with plugin/crypto/VaultCrypto.ts.
// Blob layout: MAGIC('VSE') | VERSION(1) | NONCE(12) | CIPHERTEXT+TAG(16).
// Convergent: nonce = HMAC-SHA256(key, VERSION | pathLen(4 LE) | path | plain)[0:12].
// KDF: PBKDF2-HMAC-SHA256, 600000 iterations, 32-byte key. AAD = path.
import { pbkdf2Sync, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';

export const MAGIC = Buffer.from('VSE', 'latin1');
export const VERSION = 1;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + 1;
const PBKDF2_ITER = 600_000;

export function deriveKey(passphrase, salt) {
  return pbkdf2Sync(Buffer.from(passphrase, 'utf8'), Buffer.from(salt), PBKDF2_ITER, 32, 'sha256');
}

function deriveNonce(key, path, plain) {
  const pathBytes = Buffer.from(path, 'utf8');
  const msg = Buffer.alloc(1 + 4 + pathBytes.length + plain.length);
  msg[0] = VERSION;
  msg.writeUInt32LE(pathBytes.length, 1);
  pathBytes.copy(msg, 5);
  Buffer.from(plain).copy(msg, 5 + pathBytes.length);
  return createHmac('sha256', key).update(msg).digest().subarray(0, NONCE_LEN);
}

export function encryptBlob(key, path, plain) {
  const nonce = deriveNonce(key, path, plain);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN });
  cipher.setAAD(Buffer.from(path, 'utf8'));
  const ct = Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), nonce, ct, tag]);
}

export function isBlob(buf) {
  return buf.length >= HEADER_LEN + NONCE_LEN + TAG_LEN
    && buf.subarray(0, 3).equals(MAGIC) && buf[3] === VERSION;
}

export function decryptBlob(key, path, blob) {
  if (!isBlob(blob)) throw new Error('not a VSE blob');
  const nonce = blob.subarray(HEADER_LEN, HEADER_LEN + NONCE_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(HEADER_LEN + NONCE_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN });
  decipher.setAAD(Buffer.from(path, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
