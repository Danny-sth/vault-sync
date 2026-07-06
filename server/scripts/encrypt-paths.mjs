#!/usr/bin/env node
// One-time path migration: rename every vault file from its real path to the encrypted
// path (component-wise, base32). Content blobs are NOT touched (their AAD is the real path,
// which clients still know). Idempotent: a path that already decrypts is skipped. Excludes
// service dirs.
//
//   VAULT_PASSPHRASE=.. VAULT_SALT_B64=.. node encrypt-paths.mjs <vaultDir> [--dry-run]
import { readdirSync, statSync, renameSync, mkdirSync, rmdirSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { deriveKey, encryptPath, decryptPath } from './vault-crypto.mjs';

const EXCLUDED_DIRS = new Set(['.git', '.idea', '.smart-env', 'node_modules', '.vault-sync-versions', '.vault-sync-uploads', '.trash']);
const EXCLUDED_NAMES = new Set(['.DS_Store', 'Thumbs.db', '.folder-marker']);

const vaultDir = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
const passphrase = process.env.VAULT_PASSPHRASE;
const saltB64 = process.env.VAULT_SALT_B64;
if (!vaultDir || !passphrase || !saltB64) {
  console.error('usage: VAULT_PASSPHRASE=.. VAULT_SALT_B64=.. node encrypt-paths.mjs <vaultDir> [--dry-run]');
  process.exit(2);
}
const key = deriveKey(passphrase, Buffer.from(saltB64, 'base64'));

function* walkFiles(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDED_DIRS.has(name)) continue;
      yield* walkFiles(full);
    } else if (st.isFile()) {
      if (EXCLUDED_NAMES.has(name)) continue;
      yield full;
    }
  }
}

function alreadyEncrypted(relPath) {
  try { decryptPath(key, relPath); return true; } catch { return false; }
}

let renamed = 0, skipped = 0, failed = 0;
const samples = [];
const dirsToCheck = new Set();

for (const full of walkFiles(vaultDir)) {
  const relPath = relative(vaultDir, full).split(sep).join('/');
  try {
    if (alreadyEncrypted(relPath)) { skipped++; continue; }
    const encRel = encryptPath(key, relPath);
    if (encRel === relPath) { skipped++; continue; }
    const dest = join(vaultDir, encRel.split('/').join(sep));
    if (!dryRun) {
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(full, dest);
      dirsToCheck.add(dirname(full));
    }
    renamed++;
    if (samples.length < 3) samples.push(`${relPath} -> ${encRel.slice(0, 40)}...`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${relPath}: ${e.message}`);
  }
}

// Recursively remove every now-empty directory left behind by the renames (deepest
// first), so no real folder name lingers on the server. Excluded/service dirs are kept.
function pruneEmptyDirs(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory() && !EXCLUDED_DIRS.has(name)) pruneEmptyDirs(full);
  }
  if (dir !== vaultDir) {
    try { if (readdirSync(dir).length === 0) rmdirSync(dir); } catch { /* not empty */ }
  }
}
if (!dryRun) pruneEmptyDirs(vaultDir);

console.log(`${dryRun ? '[DRY-RUN] ' : ''}renamed=${renamed} skipped(already-enc)=${skipped} failed=${failed}`);
samples.forEach((s) => console.log('  ', s));
process.exit(failed > 0 ? 1 : 0);
