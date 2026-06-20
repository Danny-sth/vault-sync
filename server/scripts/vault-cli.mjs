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
import { readFileSync } from 'node:fs';
import { encryptBlob, decryptBlob, encryptPath, decryptPath } from './vault-crypto.mjs';
import { loadKey, createMcpClient } from './vault-mcp-client.mjs';

const key = loadKey();
const mcp = createMcpClient();
const callTool = mcp.callTool;
const [cmd, arg1, arg2] = process.argv.slice(2);
function safe(p) { p = (p || '').replace(/\\/g, '/'); if (!p || p.includes('..') || p.startsWith('/')) { console.error('vault-cli: invalid path'); process.exit(2); } return p; }

await mcp.init();

if (cmd === 'read') {
  const real = safe(arg1);
  const r = await callTool('get_blob', { path: encryptPath(key, real) });
  if (!r.success) { console.error('not found: ' + real); process.exit(1); }
  process.stdout.write(decryptBlob(key, real, Buffer.from(r.blobBase64, 'base64')));
} else if (cmd === 'write' || cmd === 'append') {
  const real = safe(arg1);
  let content = (() => { try { return readFileSync(0); } catch { return Buffer.alloc(0); } })();
  if (cmd === 'append') {
    const cur = await callTool('get_blob', { path: encryptPath(key, real) });
    if (cur.success) content = Buffer.concat([decryptBlob(key, real, Buffer.from(cur.blobBase64, 'base64')), content]);
  }
  const blob = encryptBlob(key, real, content);
  const r = await callTool('put_blob', { path: encryptPath(key, real), blobBase64: blob.toString('base64') });
  console.log(r.success ? `ok: ${real} (${content.length} bytes, encrypted, via MCP)` : `FAIL: ${r.error}`);
} else if (cmd === 'delete') {
  const real = safe(arg1);
  const r = await callTool('delete_blob', { path: encryptPath(key, real) });
  console.log(r.success ? 'deleted: ' + real : 'FAIL: ' + r.error);
} else if (cmd === 'list') {
  const prefix = arg1 || '';
  const r = await callTool('list_blobs', {});
  for (const b of r.blobs || []) {
    let real; try { real = decryptPath(key, b.path); } catch { continue; }
    if (real.startsWith(prefix)) console.log(real);
  }
} else if (cmd === 'search') {
  const query = (arg1 || '').toLowerCase(); const prefix = arg2 || '';
  const r = await callTool('list_blobs', {});
  for (const b of r.blobs || []) {
    let real; try { real = decryptPath(key, b.path); } catch { continue; }
    if (!real.startsWith(prefix)) continue;
    try {
      const g = await callTool('get_blob', { path: b.path });
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
