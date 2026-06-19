#!/usr/bin/env node
// One-time vault migration: encrypt every content file in place into VSE blobs that
// the plugin (same passphrase+salt) can decrypt. Idempotent (skips already-encrypted
// files) and self-verifying (decrypts each blob back before overwriting).
//
//   VAULT_PASSPHRASE=... VAULT_SALT_B64=... node encrypt-vault.mjs <vaultDir> [--dry-run]
//
// Skips sync-excluded dirs and structural marker files so it touches only real content.
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { deriveKey, encryptBlob, decryptBlob, isBlob } from './vault-crypto.mjs';

// cortex/ is duq/openclaw's live plaintext workspace — it reads/writes those files
// directly, so encrypting them would break duq. Left as plaintext; device clients skip
// what they can't decrypt (see SyncManager.undecryptable).
const EXCLUDED_DIRS = new Set(['.git', '.idea', '.smart-env', 'node_modules', '.vault-sync-versions', '.trash', 'cortex']);
const EXCLUDED_NAMES = new Set(['.DS_Store', 'Thumbs.db', '.folder-marker']);

const vaultDir = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
const passphrase = process.env.VAULT_PASSPHRASE;
const saltB64 = process.env.VAULT_SALT_B64;

if (!vaultDir || !passphrase || !saltB64) {
  console.error('usage: VAULT_PASSPHRASE=.. VAULT_SALT_B64=.. node encrypt-vault.mjs <vaultDir> [--dry-run]');
  process.exit(2);
}

const salt = Buffer.from(saltB64, 'base64');
const key = deriveKey(passphrase, salt);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDED_DIRS.has(name)) continue;
      yield* walk(full);
    } else if (st.isFile()) {
      if (EXCLUDED_NAMES.has(name)) continue;
      yield full;
    }
  }
}

let encrypted = 0, skipped = 0, failed = 0;
const samples = [];

for (const full of walk(vaultDir)) {
  const relPath = relative(vaultDir, full).split(sep).join('/');
  try {
    const data = readFileSync(full);
    if (isBlob(data)) { skipped++; continue; }            // already encrypted → idempotent

    const blob = encryptBlob(key, relPath, data);
    // Verify the blob decrypts back to the exact original BEFORE overwriting.
    const back = decryptBlob(key, relPath, blob);
    if (!back.equals(data)) throw new Error('round-trip mismatch');

    if (!dryRun) writeFileSync(full, blob);
    encrypted++;
    if (samples.length < 3) samples.push(relPath);
  } catch (e) {
    failed++;
    console.error(`FAIL ${relPath}: ${e.message}`);
  }
}

console.log(`${dryRun ? '[DRY-RUN] ' : ''}encrypted=${encrypted} skipped(already)=${skipped} failed=${failed}`);
if (samples.length) console.log('samples:', samples.join(', '));
process.exit(failed > 0 ? 1 : 0);
