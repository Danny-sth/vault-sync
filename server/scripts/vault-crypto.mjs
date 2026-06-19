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

// --- Path (filename/folder) encryption — byte-compatible with plugin VaultCrypto ---
const PATH_AAD = Buffer.from('vault-path', 'utf8');
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32encode(bytes) {
  let bits = 0, val = 0, out = '';
  for (const b of bytes) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function base32decode(s) {
  let bits = 0, val = 0; const out = [];
  for (const ch of s) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    val = (val << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function componentNonce(key, component) {
  const msg = Buffer.concat([Buffer.from([0xfe]), component]);
  return createHmac('sha256', key).update(msg).digest().subarray(0, NONCE_LEN);
}
export function encryptPathComponent(key, component) {
  const bytes = Buffer.from(component, 'utf8');
  const nonce = componentNonce(key, bytes);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN });
  cipher.setAAD(PATH_AAD);
  const ct = Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
  return base32encode(Buffer.concat([nonce, ct]));
}
export function decryptPathComponent(key, enc) {
  const data = base32decode(enc);
  const nonce = data.subarray(0, NONCE_LEN);
  const tag = data.subarray(data.length - TAG_LEN);
  const ct = data.subarray(NONCE_LEN, data.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN });
  decipher.setAAD(PATH_AAD);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
export function encryptPath(key, path) {
  return path.split('/').map((c) => (c === '' ? '' : encryptPathComponent(key, c))).join('/');
}
export function decryptPath(key, encPath) {
  return encPath.split('/').map((c) => (c === '' ? '' : decryptPathComponent(key, c))).join('/');
}
