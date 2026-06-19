#!/usr/bin/env node
// Encrypted vault CLI for duq (openclaw), running on the same VPS as the vault.
// Reads/writes the Obsidian vault as ENCRYPTED VSE blobs at ENCRYPTED paths, so anything
// duq creates (notes for Denis) syncs to his devices like a normal client edit. The
// filesystem watcher picks up writes and broadcasts them. The key is read from
// /root/vault-sync-key.txt (or VAULT_PASSPHRASE/VAULT_SALT_B64 env).
//
//   node vault-cli.mjs read   "Strains/Blue Dream.md"
//   node vault-cli.mjs write  "Strains/Blue Dream.md"   < content-on-stdin
//   node vault-cli.mjs append "Strains/Blue Dream.md"   < content-on-stdin
//   node vault-cli.mjs list   ["Strains/"]
//   node vault-cli.mjs search "query" ["folder/"]
//   node vault-cli.mjs delete "Strains/Blue Dream.md"
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, rmSync, readFileSync as rf, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { deriveKey, encryptBlob, decryptBlob, encryptPath, decryptPath, isBlob } from './vault-crypto.mjs';

const VAULT = process.env.VAULT_DIR || '/opt/obsidian-vault';

function loadKey() {
  let pass = process.env.VAULT_PASSPHRASE, salt = process.env.VAULT_SALT_B64;
  if (!pass || !salt) {
    const f = '/root/vault-sync-key.txt';
    if (existsSync(f)) {
      for (const line of rf(f, 'utf8').split('\n')) {
        const m = /^(\w+)=(.*)$/.exec(line.trim());
        if (m && m[1] === 'VAULT_PASSPHRASE') pass = m[2];
        if (m && m[1] === 'VAULT_SALT_B64') salt = m[2];
      }
    }
  }
  if (!pass || !salt) { console.error('vault-cli: no vault key (VAULT_PASSPHRASE/VAULT_SALT_B64 or /root/vault-sync-key.txt)'); process.exit(2); }
  return deriveKey(pass, Buffer.from(salt, 'base64'));
}

function safe(realPath) {
  const p = realPath.replace(/\\/g, '/');
  if (p.includes('..') || p.startsWith('/')) { console.error('vault-cli: invalid path'); process.exit(2); }
  return p;
}

function diskPath(key, realPath) {
  return join(VAULT, encryptPath(key, realPath).split('/').join('/'));
}

function readStdin() {
  try { return readFileSync(0); } catch { return Buffer.alloc(0); }
}

function* walk(dir) {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    let s; try { s = statSync(f); } catch { continue; }
    if (s.isDirectory()) yield* walk(f);
    else if (s.isFile()) yield f;
  }
}

const key = loadKey();
const [cmd, arg1, arg2] = process.argv.slice(2);

if (cmd === 'read') {
  const realPath = safe(arg1);
  const f = diskPath(key, realPath);
  if (!existsSync(f)) { console.error('not found: ' + realPath); process.exit(1); }
  process.stdout.write(decryptBlob(key, realPath, readFileSync(f)));
} else if (cmd === 'write' || cmd === 'append') {
  const realPath = safe(arg1);
  const f = diskPath(key, realPath);
  let content = readStdin();
  if (cmd === 'append' && existsSync(f)) {
    content = Buffer.concat([decryptBlob(key, realPath, readFileSync(f)), content]);
  }
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, encryptBlob(key, realPath, content));
  console.log(`ok: ${realPath} (${content.length} bytes, encrypted)`);
} else if (cmd === 'delete') {
  const realPath = safe(arg1);
  const f = diskPath(key, realPath);
  if (existsSync(f)) { rmSync(f); console.log('deleted: ' + realPath); } else console.log('absent: ' + realPath);
} else if (cmd === 'list') {
  const prefix = arg1 || '';
  for (const f of walk(VAULT)) {
    const encRel = relative(VAULT, f).split('/').join('/');
    if (encRel.startsWith('.vault-sync')) continue;
    let real;
    try { real = decryptPath(key, encRel); } catch { continue; } // plaintext/cortex → skip
    if (real.startsWith(prefix)) console.log(real);
  }
} else if (cmd === 'search') {
  const query = (arg1 || '').toLowerCase();
  const prefix = arg2 || '';
  for (const f of walk(VAULT)) {
    const encRel = relative(VAULT, f).split('/').join('/');
    if (encRel.startsWith('.vault-sync')) continue;
    let real, data;
    try { real = decryptPath(key, encRel); } catch { continue; }
    if (!real.startsWith(prefix)) continue;
    try { data = decryptBlob(key, real, readFileSync(f)); } catch { continue; }
    if (data.toString('utf8').toLowerCase().includes(query)) console.log(real);
  }
} else {
  console.error('usage: vault-cli.mjs read|write|append|list|search|delete <path> [content on stdin]');
  process.exit(2);
}
