#!/usr/bin/env node
// Configurable E2EE folder-sync for vault-sync.
//
// Mirrors an arbitrary LOCAL directory (e.g. openclaw's /root/.openclaw/workspace) two-way
// with a PREFIX folder inside the encrypted vault (e.g. cortex/). The local side is plaintext
// (what the program actually reads/writes); the vault side is end-to-end encrypted by the
// SAME mechanism every other vault file uses (VSE blobs + base32 path encryption), so the
// zero-knowledge server only ever sees ciphertext, and the mirrored files show up — decrypted
// — in Obsidian on every device, where they can be viewed and hand-edited. Edits made in the
// vault flow back to the local directory on the next run.
//
// This replaces the ad-hoc /opt/duq-next-generation bridge with a first-class, path-config
// component of vault-sync. The server cannot do this itself (it has no key); only a
// key-holding client can encrypt, which is exactly what this is.
//
// Config: a JSON file (default /opt/vault-sync/folder-sync.json) with an array of mappings:
//   [{ "localPath": "/root/.openclaw/workspace", "vaultPrefix": "cortex/",
//      "stateFile": "/opt/vault-sync/.folder-sync-cortex.json",
//      "skip": ["^memory/", "^\\.openclaw/", "^\\.git/", "\\.jsonl$", "\\.sqlite", "\\.db$", "/\\.trash/", "\\.CONFLICT-"] }]
// Override the config path with FOLDER_SYNC_CONFIG. Key/MCP creds resolved like vault-cli.
import { readFileSync, existsSync } from 'node:fs';
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { encryptBlob, decryptBlob, encryptPath, decryptPath } from './vault-crypto.mjs';
import { loadKey, createMcpClient } from './vault-mcp-client.mjs';

const key = loadKey();
const mcp = createMcpClient();
const callTool = mcp.callTool;

// ---- vault ops (real plaintext paths in/out; encryption happens here) ----
async function listVault(prefix) {
  const r = await callTool('list_blobs', {});
  const out = new Map(); // real path -> { mtime }
  for (const b of r.blobs || []) {
    let real; try { real = decryptPath(key, b.path); } catch { continue; }
    if (real.startsWith(prefix)) out.set(real.slice(prefix.length), { mtime: b.mtime || 0 });
  }
  return out;
}
async function readVault(realPath) {
  const r = await callTool('get_blob', { path: encryptPath(key, realPath) });
  if (!r.success) throw new Error('get_blob failed: ' + realPath);
  return decryptBlob(key, realPath, Buffer.from(r.blobBase64, 'base64')).toString('utf8');
}
async function writeVault(realPath, content) {
  const blob = encryptBlob(key, realPath, Buffer.from(content, 'utf8'));
  const r = await callTool('put_blob', { path: encryptPath(key, realPath), blobBase64: blob.toString('base64') });
  if (!r.success) throw new Error('put_blob failed: ' + realPath + ' ' + (r.error || ''));
}

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

async function* walk(dir) {
  let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

// ---- one mapping, two-way with per-file state + mtime conflict tiebreak ----
async function syncMapping(m) {
  const SRC = m.localPath;
  const PREFIX = m.vaultPrefix.endsWith('/') ? m.vaultPrefix : m.vaultPrefix + '/';
  const STATE_FILE = m.stateFile || `/opt/vault-sync/.folder-sync-${PREFIX.replace(/\W+/g, '_')}.json`;
  const skipRes = (m.skip || []).map((s) => new RegExp(s));
  const skipRel = (rel) => skipRes.some((re) => re.test(rel));

  // A corrupt/missing state file just means "no baseline" — recompute from hashes, never crash.
  let state = {};
  if (existsSync(STATE_FILE)) {
    try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
    catch (e) { console.warn(`folder-sync: bad state ${STATE_FILE}, starting fresh: ${e.message}`); }
  }
  const nextState = {};

  const local = new Map();
  for await (const abs of walk(SRC)) {
    const rel = relative(SRC, abs).split('\\').join('/');
    if (skipRel(rel)) continue;
    local.set(rel, { abs, mtimeMs: (await stat(abs)).mtimeMs });
  }
  const vault = await listVault(PREFIX);
  for (const k of [...vault.keys()]) if (skipRel(k)) vault.delete(k);

  const all = new Set([...local.keys(), ...vault.keys()]);
  let push = 0, pull = 0, skip = 0, conflict = 0, fail = 0;

  for (const rel of all) {
    const inL = local.has(rel), inV = vault.has(rel), base = state[rel];
    const vfull = PREFIX + rel; // the file's real path inside the vault (what gets encrypted)
    try {
      if (inL && inV) {
        const lc = await readFile(local.get(rel).abs, 'utf8');
        const vc = await readVault(vfull);
        const lh = sha(lc), vh = sha(vc);
        if (lh === vh) { skip++; nextState[rel] = lh; continue; }
        const lChanged = lh !== base, vChanged = vh !== base;
        if (lChanged && !vChanged) { await writeVault(vfull, lc); push++; nextState[rel] = lh; }
        else if (vChanged && !lChanged) { await writeLocal(SRC, rel, vc); pull++; nextState[rel] = vh; }
        else { // both changed since last sync — keep both, newest mtime wins
          conflict++;
          const vMtime = vault.get(rel).mtime;
          if (local.get(rel).mtimeMs >= vMtime) {
            await writeLocal(SRC, rel, vc, `${rel}.CONFLICT-vault-${Math.round(vMtime)}`);
            await writeVault(vfull, lc); nextState[rel] = lh;
          } else {
            await writeLocal(SRC, rel, lc, `${rel}.CONFLICT-local-${Math.round(local.get(rel).mtimeMs)}`);
            await writeLocal(SRC, rel, vc); nextState[rel] = vh;
          }
        }
      } else if (inL && !inV) {
        // Present locally, absent in vault. We do NOT delete by absence (a transient list
        // miss must never wipe the agent's brain) — re-create it in the vault from the local
        // copy. A genuine vault-side deletion simply doesn't propagate; the file resurrects.
        const lc = await readFile(local.get(rel).abs, 'utf8');
        await writeVault(vfull, lc); push++; nextState[rel] = sha(lc);
      } else { // inV && !inL — present in vault, absent locally → re-create locally
        const vc = await readVault(vfull);
        await writeLocal(SRC, rel, vc); pull++; nextState[rel] = sha(vc);
      }
    } catch (e) { fail++; console.log(`FAIL ${vfull}: ${e.message}`); if (base !== undefined) nextState[rel] = base; }
  }

  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(nextState), 'utf8');
  console.log(`[${SRC} <-> ${PREFIX}] push=${push} pull=${pull} skip=${skip} conflict=${conflict} fail=${fail}`);
}

async function writeLocal(SRC, rel, content, asName) {
  const out = join(SRC, asName || rel);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, content, 'utf8');
}

// ---- config + run ----
const CONFIG_PATH = process.env.FOLDER_SYNC_CONFIG || '/opt/vault-sync/folder-sync.json';
const DEFAULT = [{
  localPath: '/root/.openclaw/workspace',
  vaultPrefix: 'cortex/',
  stateFile: '/opt/vault-sync/.folder-sync-cortex.json',
  skip: ['^memory/', '^\\.openclaw/', '^\\.git/', '\\.jsonl$', '\\.sqlite', '\\.db$', '\\.bin$', '/\\.trash/', '^\\.trash/', '\\.CONFLICT-'],
}];
const mappings = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : DEFAULT;

await mcp.init();
for (const m of mappings) {
  try { await syncMapping(m); }
  catch (e) { console.error(`mapping ${m.localPath} -> ${m.vaultPrefix} failed: ${e.message}`); }
}
process.exit(0);
