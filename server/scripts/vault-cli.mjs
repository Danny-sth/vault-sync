#!/usr/bin/env node
// Encrypted Obsidian-vault CLI for duq (openclaw). Works THROUGH the vault MCP server
// (get_blob/put_blob/list_blobs/delete_blob) — duq treats this as the Obsidian vault.
// Content and paths are encrypted client-side with the vault key, so the zero-knowledge
// server only ever sees ciphertext, and anything duq writes syncs to Denis's devices.
//
//   node vault-cli.mjs read   "Strains/Blue Dream.md"
//   node vault-cli.mjs write  "Strains/Blue Dream.md"   < content-on-stdin
//   node vault-cli.mjs append "Daily/20.06.2026.md"     < content-on-stdin
//   node vault-cli.mjs list   ["Strains/"]
//   node vault-cli.mjs search "query" ["folder/"]
//   node vault-cli.mjs delete "Strains/Blue Dream.md"
//
// Config (env or defaults): VAULT_MCP_URL (http://localhost:8444/mcp),
// VAULT_MCP_TOKEN (else read from /opt/vault-sync/application.yml mcp-token),
// vault key from VAULT_PASSPHRASE/VAULT_SALT_B64 or /root/vault-sync-key.txt.
import { readFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import { deriveKey, encryptBlob, decryptBlob, encryptPath, decryptPath } from './vault-crypto.mjs';

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
  if (!pass || !salt) { console.error('vault-cli: no vault key'); process.exit(2); }
  return deriveKey(pass, Buffer.from(salt, 'base64'));
}
function loadMcpToken() {
  if (process.env.VAULT_MCP_TOKEN) return process.env.VAULT_MCP_TOKEN;
  const yml = '/opt/vault-sync/application.yml';
  if (existsSync(yml)) {
    const m = /mcp-token:\s*(\S+)/.exec(readFileSync(yml, 'utf8'));
    if (m) return m[1].replace(/["']/g, '');
  }
  console.error('vault-cli: no MCP token'); process.exit(2);
}

// --- minimal MCP streamable-HTTP client ---
const TOKEN = loadMcpToken();
let sessionId = null;
function parseSse(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) if (line.startsWith('data:')) { try { out.push(JSON.parse(line.slice(5).trim())); } catch {} }
  if (!out.length) { try { out.push(JSON.parse(text)); } catch {} }
  return out;
}
function rpc(method, params, id) {
  // node:http (not fetch): the MCP streamable-HTTP response is an SSE stream the server
  // may hold open; undici's fetch throws "terminated" on close even after the data arrived.
  // We accumulate and resolve as soon as the matching JSON-RPC response is present.
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
      res.on('data', (c) => {
        data += c;
        if (id != null && parseSse(data).some((m) => m.id === id)) { res.destroy(); finish(); }
      });
      res.on('end', finish);
      res.on('close', finish);
    });
    req.on('error', (e) => { if (id == null) resolve(null); else reject(e); });
    req.write(body); req.end();
  });
}
async function callTool(name, args, id) {
  const r = await rpc('tools/call', { name, arguments: args }, id);
  const text = r?.result?.content?.[0]?.text;
  if (text == null) throw new Error('MCP ' + name + ': empty result');
  return JSON.parse(text);
}
async function mcpInit() {
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'vault-cli', version: '1' } }, 1);
  await rpc('notifications/initialized', {});
}

const key = loadKey();
const [cmd, arg1, arg2] = process.argv.slice(2);
function safe(p) { p = (p || '').replace(/\\/g, '/'); if (!p || p.includes('..') || p.startsWith('/')) { console.error('vault-cli: invalid path'); process.exit(2); } return p; }

await mcpInit();
let nextId = 10;

if (cmd === 'read') {
  const real = safe(arg1);
  const r = await callTool('get_blob', { path: encryptPath(key, real) }, nextId++);
  if (!r.success) { console.error('not found: ' + real); process.exit(1); }
  process.stdout.write(decryptBlob(key, real, Buffer.from(r.blobBase64, 'base64')));
} else if (cmd === 'write' || cmd === 'append') {
  const real = safe(arg1);
  let content = (() => { try { return readFileSync(0); } catch { return Buffer.alloc(0); } })();
  if (cmd === 'append') {
    const cur = await callTool('get_blob', { path: encryptPath(key, real) }, nextId++);
    if (cur.success) content = Buffer.concat([decryptBlob(key, real, Buffer.from(cur.blobBase64, 'base64')), content]);
  }
  const blob = encryptBlob(key, real, content);
  const r = await callTool('put_blob', { path: encryptPath(key, real), blobBase64: blob.toString('base64') }, nextId++);
  console.log(r.success ? `ok: ${real} (${content.length} bytes, encrypted, via MCP)` : `FAIL: ${r.error}`);
} else if (cmd === 'delete') {
  const real = safe(arg1);
  const r = await callTool('delete_blob', { path: encryptPath(key, real) }, nextId++);
  console.log(r.success ? 'deleted: ' + real : 'FAIL: ' + r.error);
} else if (cmd === 'list') {
  const prefix = arg1 || '';
  const r = await callTool('list_blobs', {}, nextId++);
  for (const b of r.blobs || []) {
    let real; try { real = decryptPath(key, b.path); } catch { continue; }
    if (real.startsWith(prefix)) console.log(real);
  }
} else if (cmd === 'search') {
  const query = (arg1 || '').toLowerCase(); const prefix = arg2 || '';
  const r = await callTool('list_blobs', {}, nextId++);
  for (const b of r.blobs || []) {
    let real; try { real = decryptPath(key, b.path); } catch { continue; }
    if (!real.startsWith(prefix)) continue;
    try {
      const g = await callTool('get_blob', { path: b.path }, nextId++);
      if (!g.success) continue;
      const txt = decryptBlob(key, real, Buffer.from(g.blobBase64, 'base64')).toString('utf8');
      if (txt.toLowerCase().includes(query)) console.log(real);
    } catch {}
  }
} else {
  console.error('usage: vault-cli.mjs read|write|append|list|search|delete <path> [content on stdin]');
  process.exit(2);
}
process.exit(0);
