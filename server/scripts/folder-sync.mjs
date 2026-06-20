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
import http from 'node:http';
import { deriveKey, encryptBlob, decryptBlob, encryptPath, decryptPath } from './vault-crypto.mjs';

// ---- creds (same resolution as vault-cli.mjs) ----
const MCP_URL = process.env.VAULT_MCP_URL || 'http://localhost:8444/mcp';
function loadKey() {
  let pass = process.env.VAULT_PASSPHRASE, salt = process.env.VAULT_SALT_B64;
  if ((!pass || !salt) && existsSync('/root/vault-sync-key.txt')) {
    for (const line of readFileSync('/root/vault-sync-key.txt', 'utf8').split('\n')) {
      const m = /^(\w+)=(.*)$/.exec(line.trim());
      if (m && m[1] === 'VAULT_PASSPHRASE') pass = m[2];
      if (m && m[1] === 'VAULT_SALT_B64') salt = m[2];
    }
  }
  if (!pass || !salt) { console.error('folder-sync: no vault key'); process.exit(2); }
  return deriveKey(pass, Buffer.from(salt, 'base64'));
}
function loadMcpToken() {
  if (process.env.VAULT_MCP_TOKEN) return process.env.VAULT_MCP_TOKEN;
  const yml = '/opt/vault-sync/application.yml';
  if (existsSync(yml)) { const m = /mcp-token:\s*(\S+)/.exec(readFileSync(yml, 'utf8')); if (m) return m[1].replace(/["']/g, ''); }
  console.error('folder-sync: no MCP token'); process.exit(2);
}

// ---- minimal MCP streamable-HTTP client (node:http, same as vault-cli) ----
const TOKEN = loadMcpToken();
let sessionId = null;
function parseSse(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) if (line.startsWith('data:')) { try { out.push(JSON.parse(line.slice(5).trim())); } catch {} }
  if (!out.length) { try { out.push(JSON.parse(text)); } catch {} }
  return out;
}
function rpc(method, params, id) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', ...(id != null ? { id } : {}), method, params });
    const u = new URL(MCP_URL);
    const headers = {
      Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(body),
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'POST', headers }, (res) => {
      const sid = res.headers['mcp-session-id']; if (sid) sessionId = sid;
      let data = ''; let done = false;
      const finish = () => { if (done) return; done = true; if (id == null) return resolve(null); resolve(parseSse(data).find((m) => m.id === id) || null); };
      res.on('data', (c) => { data += c; });
      res.on('end', finish); res.on('close', finish);
    });
    req.on('error', (e) => { if (id == null) resolve(null); else reject(e); });
    req.setTimeout(30000, () => { req.destroy(new Error('MCP request timeout')); });
    req.write(body); req.end();
  });
}
let nextId = 10;
async function callTool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args }, nextId++);
  const text = r?.result?.content?.[0]?.text;
  if (text == null) throw new Error('MCP ' + name + ': empty result');
  return JSON.parse(text);
}
async function mcpInit() {
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'folder-sync', version: '1' } }, 1);
  await rpc('notifications/initialized', {});
}

const key = loadKey();

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
    try {
      if (inL && inV) {
        const lc = await readFile(local.get(rel).abs, 'utf8');
        const vc = await readVault(rel);
        const lh = sha(lc), vh = sha(vc);
        if (lh === vh) { skip++; nextState[rel] = lh; continue; }
        const lChanged = lh !== base, vChanged = vh !== base;
        if (lChanged && !vChanged) { await writeVault(rel, lc); push++; nextState[rel] = lh; }
        else if (vChanged && !lChanged) { await writeLocal(SRC, rel, vc); pull++; nextState[rel] = vh; }
        else { // both changed since last sync — keep both, newest mtime wins
          conflict++;
          const vMtime = vault.get(rel).mtime;
          if (local.get(rel).mtimeMs >= vMtime) {
            await writeLocal(SRC, rel, vc, `${rel}.CONFLICT-vault-${Math.round(vMtime)}`);
            await writeVault(rel, lc); nextState[rel] = lh;
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
        await writeVault(rel, lc); push++; nextState[rel] = sha(lc);
      } else { // inV && !inL — present in vault, absent locally → re-create locally
        const vc = await readVault(rel);
        await writeLocal(SRC, rel, vc); pull++; nextState[rel] = sha(vc);
      }
    } catch (e) { fail++; console.log(`FAIL ${PREFIX}${rel}: ${e.message}`); if (base !== undefined) nextState[rel] = base; }
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

await mcpInit();
for (const m of mappings) {
  try { await syncMapping(m); }
  catch (e) { console.error(`mapping ${m.localPath} -> ${m.vaultPrefix} failed: ${e.message}`); }
}
process.exit(0);
