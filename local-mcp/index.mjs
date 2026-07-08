#!/usr/bin/env node
// Local stdio MCP server for the E2EE vault — runs on Danny's machine, decrypts locally.
// Bridges Claude Code (stdio) to the remote vault-sync MCP endpoint (streamable HTTP,
// static bearer): blobs travel encrypted, key never leaves this machine / the VPS.
//
// Tools: vault_read / vault_write / vault_append / vault_delete / vault_list / vault_search.
// Credentials: ~/.config/vault-sync/key.txt (VAULT_PASSPHRASE/VAULT_SALT_B64 lines, same
// format as /root/vault-sync-key.txt) and ~/.config/vault-sync/mcp-token.
// Env overrides: VAULT_MCP_URL, VAULT_MCP_TOKEN, VAULT_PASSPHRASE, VAULT_SALT_B64.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { deriveKey, encryptBlob, decryptBlob, encryptPath, decryptPath } from '../server/scripts/vault-crypto.mjs';

const CONFIG_DIR = join(homedir(), '.config', 'vault-sync');
const UPSTREAM_URL = process.env.VAULT_MCP_URL || 'https://on-za-menya.online/vault-mcp';

function loadKey() {
  let pass = process.env.VAULT_PASSPHRASE, salt = process.env.VAULT_SALT_B64;
  const file = join(CONFIG_DIR, 'key.txt');
  if ((!pass || !salt) && existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^(\w+)=(.*)$/.exec(line.trim());
      if (m && m[1] === 'VAULT_PASSPHRASE') pass = m[2];
      if (m && m[1] === 'VAULT_SALT_B64') salt = m[2];
    }
  }
  if (!pass || !salt) throw new Error('no vault key (~/.config/vault-sync/key.txt or VAULT_PASSPHRASE/VAULT_SALT_B64)');
  return deriveKey(pass, Buffer.from(salt, 'base64'));
}

function loadToken() {
  if (process.env.VAULT_MCP_TOKEN) return process.env.VAULT_MCP_TOKEN;
  const file = join(CONFIG_DIR, 'mcp-token');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  throw new Error('no MCP token (~/.config/vault-sync/mcp-token or VAULT_MCP_TOKEN)');
}

// Perimeter token checked by duq-nginx (X-Auth-Token, same one the Obsidian plugin sends);
// the Bearer above is vault-sync's own MCP auth behind it.
function loadEdgeToken() {
  if (process.env.VAULT_EDGE_TOKEN) return process.env.VAULT_EDGE_TOKEN;
  const file = join(CONFIG_DIR, 'edge-token');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  throw new Error('no edge token (~/.config/vault-sync/edge-token or VAULT_EDGE_TOKEN)');
}

const key = loadKey();
const token = loadToken();
const edgeToken = loadEdgeToken();

// Lazy upstream connection: don't fail server startup if the VPS is unreachable.
let upstream = null;
async function getUpstream() {
  if (upstream) return upstream;
  const client = new Client({ name: 'vault-local-mcp', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(UPSTREAM_URL), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, 'X-Auth-Token': edgeToken } },
  }));
  upstream = client;
  return upstream;
}

async function call(name, args) {
  const client = await getUpstream();
  const res = await client.callTool({ name, arguments: args });
  const text = res?.content?.[0]?.text;
  if (text == null) throw new Error(`upstream ${name}: empty result`);
  return JSON.parse(text);
}

function checkPath(p) {
  p = (p || '').replace(/\\/g, '/');
  if (!p || p.includes('..') || p.startsWith('/')) throw new Error('invalid vault path: ' + p);
  return p;
}

async function listPaths(prefix) {
  const r = await call('list_blobs', {});
  const out = [];
  for (const b of r.blobs || []) {
    let real; try { real = decryptPath(key, b.path); } catch { continue; }
    if (!prefix || real.startsWith(prefix)) out.push(real);
  }
  return out.sort();
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });

const server = new McpServer({ name: 'vault', version: '1.0.0' });

server.registerTool('vault_read', {
  description: 'Read a note from the Obsidian vault (decrypted plaintext). Path is the real vault path, e.g. "Coding/duq/Roadmap.md".',
  inputSchema: { path: z.string().describe('Vault path, e.g. "Daily/08.07.2026.md"') },
}, async ({ path }) => {
  const real = checkPath(path);
  const r = await call('get_blob', { path: encryptPath(key, real) });
  if (!r.success) throw new Error('not found: ' + real);
  return text(decryptBlob(key, real, Buffer.from(r.blobBase64, 'base64')).toString('utf8'));
});

server.registerTool('vault_write', {
  description: 'Write (create or overwrite) a note in the Obsidian vault. Content is encrypted locally before upload and syncs to all devices.',
  inputSchema: { path: z.string(), content: z.string() },
}, async ({ path, content }) => {
  const real = checkPath(path);
  const blob = encryptBlob(key, real, Buffer.from(content, 'utf8'));
  const r = await call('put_blob', { path: encryptPath(key, real), blobBase64: blob.toString('base64') });
  if (!r.success) throw new Error('write failed: ' + (r.error || 'unknown'));
  return text(`ok: ${real} (${Buffer.byteLength(content)} bytes)`);
});

server.registerTool('vault_append', {
  description: 'Append text to an existing vault note (creates it if missing).',
  inputSchema: { path: z.string(), content: z.string() },
}, async ({ path, content }) => {
  const real = checkPath(path);
  let full = Buffer.from(content, 'utf8');
  const cur = await call('get_blob', { path: encryptPath(key, real) });
  if (cur.success) full = Buffer.concat([decryptBlob(key, real, Buffer.from(cur.blobBase64, 'base64')), full]);
  const blob = encryptBlob(key, real, full);
  const r = await call('put_blob', { path: encryptPath(key, real), blobBase64: blob.toString('base64') });
  if (!r.success) throw new Error('append failed: ' + (r.error || 'unknown'));
  return text(`ok: ${real} (now ${full.length} bytes)`);
});

server.registerTool('vault_delete', {
  description: 'Delete a note from the Obsidian vault.',
  inputSchema: { path: z.string() },
}, async ({ path }) => {
  const real = checkPath(path);
  const r = await call('delete_blob', { path: encryptPath(key, real) });
  if (!r.success) throw new Error('delete failed: ' + (r.error || 'unknown'));
  return text('deleted: ' + real);
});

server.registerTool('vault_list', {
  description: 'List vault note paths, optionally filtered by a path prefix like "Coding/" or "Daily/".',
  inputSchema: { prefix: z.string().optional() },
}, async ({ prefix }) => {
  const paths = await listPaths(prefix || '');
  return text(paths.length ? paths.join('\n') : '(empty)');
});

server.registerTool('vault_search', {
  description: 'Full-text search over vault notes (case-insensitive substring). Optionally limit to a path prefix. Downloads and decrypts each candidate note, so prefer narrow prefixes.',
  inputSchema: { query: z.string(), prefix: z.string().optional() },
}, async ({ query, prefix }) => {
  const q = query.toLowerCase();
  const paths = (await listPaths(prefix || '')).filter((p) => p.endsWith('.md'));
  const hits = [];
  for (const real of paths) {
    if (real.toLowerCase().includes(q)) { hits.push(`${real} (path match)`); continue; }
    const r = await call('get_blob', { path: encryptPath(key, real) });
    if (!r.success) continue;
    let plain; try { plain = decryptBlob(key, real, Buffer.from(r.blobBase64, 'base64')).toString('utf8'); } catch { continue; }
    const idx = plain.toLowerCase().indexOf(q);
    if (idx >= 0) {
      const line = plain.slice(plain.lastIndexOf('\n', idx) + 1, (plain.indexOf('\n', idx) + 1 || plain.length + 1) - 1);
      hits.push(`${real}: ${line.trim().slice(0, 200)}`);
    }
    if (hits.length >= 50) break;
  }
  return text(hits.length ? hits.join('\n') : 'no matches');
});

await server.connect(new StdioServerTransport());
