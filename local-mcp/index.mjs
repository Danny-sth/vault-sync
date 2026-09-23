#!/usr/bin/env node
// Local stdio MCP server for the E2EE vault — runs on Danny's machine, decrypts locally.
// Bridges Claude Code (stdio) to the remote vault-sync MCP endpoint (streamable HTTP,
// static bearer): blobs travel encrypted, key never leaves this machine / the VPS.
//
// Tools: vault_read / vault_write / vault_edit / vault_append / vault_delete / vault_list / vault_search.
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
const UPSTREAM_URL = process.env.VAULT_MCP_URL || 'https://vault.on-za-menya.online/vault-mcp';

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

// Сервер перезапустился / сессия протухла (MCP spec: неизвестная сессия → 404, клиент
// обязан начать новую) или обрыв связи → сбросить клиента и повторить вызов один раз.
const RECONNECT_RE = /Session not found|\b404\b|\b502\b|\b503\b|fetch failed|ECONNRESET|socket hang up|terminated/i;

async function resetUpstream() {
  const old = upstream;
  upstream = null;
  try { await old?.close(); } catch { /* сессия уже мертва */ }
}

async function call(name, args) {
  let res;
  try {
    res = await (await getUpstream()).callTool({ name, arguments: args });
  } catch (e) {
    if (!RECONNECT_RE.test(String(e?.message ?? e))) throw e;
    await resetUpstream();
    res = await (await getUpstream()).callTool({ name, arguments: args });
  }
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

server.registerTool('vault_edit', {
  description: 'Edit a note by EXACT string replacement — changes ONLY the matched fragment, the rest of the note stays intact. This is THE tool for точечные правки existing notes (безопаснее vault_write, который перезаписывает всё). old_string must match the current note text verbatim (read it first with vault_read); if it is not unique, extend it or pass replace_all=true.',
  inputSchema: {
    path: z.string().describe('Vault path, e.g. "Coding/duq/Roadmap.md"'),
    old_string: z.string().describe('Exact existing fragment to replace (verbatim match)'),
    new_string: z.string().describe('Replacement text (empty string deletes the fragment)'),
    replace_all: z.boolean().optional().describe('Replace every occurrence (default false — old_string must be unique)'),
  },
}, async ({ path, old_string, new_string, replace_all }) => {
  const real = checkPath(path);
  if (!old_string) throw new Error('old_string required');
  if (old_string === new_string) throw new Error('old_string и new_string совпадают — нечего менять');
  const cur = await call('get_blob', { path: encryptPath(key, real) });
  if (!cur.success) throw new Error('not found: ' + real);
  const content = decryptBlob(key, real, Buffer.from(cur.blobBase64, 'base64')).toString('utf8');
  const count = content.split(old_string).length - 1;
  if (count === 0) throw new Error(`old_string не найдена в ${real}: ${old_string.slice(0, 60)}…`);
  if (count > 1 && !replace_all) throw new Error(`old_string не уникальна (${count} совпадений) — расширь фрагмент или передай replace_all=true`);
  const updated = replace_all ? content.split(old_string).join(new_string) : content.replace(old_string, new_string);
  const blob = encryptBlob(key, real, Buffer.from(updated, 'utf8'));
  const r = await call('put_blob', { path: encryptPath(key, real), blobBase64: blob.toString('base64') });
  if (!r.success) throw new Error('edit failed: ' + (r.error || 'unknown'));
  return text(`ok: ${real} — ${replace_all ? count : 1} замен(а), теперь ${Buffer.byteLength(updated)} bytes. Остальное содержимое не тронуто.`);
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

// Поиск идёт по словам, а не по точной подстроке: вопрос задают фразой («где Денис живёт»),
// а в заметке написано иначе («Сейчас живёт во Флорианополисе»). Совпадением считается заметка,
// где встретились все слова запроса; строки с ними и показываем. Диакритика снимается, чтобы
// «Florianópolis» и «Florianopolis» были одним словом.
const CYR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h',
  ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };

// Одна форма записи для сравнения: без регистра, без диакритики (ё → е, ó → o) и с кириллицей,
// переписанной латиницей, — тогда «Florianopolis» находит «Флорианополис» и наоборот.
const fold = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[\u0430-\u044f]/g, (ch) => (ch in CYR ? CYR[ch] : ch));
const wordsOf = (s) => fold(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);

function matchLines(plain, words) {
  const scored = [];
  for (const line of plain.split('\n')) {
    const folded = fold(line);
    const hits = words.filter((w) => folded.includes(w)).length;
    if (hits) scored.push({ hits, line: line.trim() });
  }
  scored.sort((a, b) => b.hits - a.hits);
  return scored;
}

server.registerTool('vault_search', {
  description: 'Full-text search over vault notes by words (case- and accent-insensitive; a note matches when all query words occur in it, in any order or form of the line). Optionally limit to a path prefix. Downloads and decrypts each candidate note, so prefer narrow prefixes.',
  inputSchema: { query: z.string(), prefix: z.string().optional() },
}, async ({ query, prefix }) => {
  const words = wordsOf(query);
  if (!words.length) return text('no matches');
  const paths = (await listPaths(prefix || '')).filter((p) => p.endsWith('.md'));
  // Спрашивают фразой, а в заметке написано своими словами: совпадение считаем по числу слов
  // запроса, а не требуем их все. Лучшие заметки идут первыми — остальное человек отфильтрует сам.
  const found = [];
  for (const real of paths) {
    const inPath = words.filter((w) => fold(real).includes(w)).length;
    if (inPath === words.length) { found.push({ score: words.length + 1, lines: [`${real} (path match)`] }); continue; }
    const r = await call('get_blob', { path: encryptPath(key, real) });
    if (!r.success) continue;
    let plain; try { plain = decryptBlob(key, real, Buffer.from(r.blobBase64, 'base64')).toString('utf8'); } catch { continue; }
    const folded = fold(plain);
    const score = words.filter((w) => folded.includes(w)).length + inPath;
    if (!score) continue;
    const lines = matchLines(plain, words).slice(0, 3).map(({ line }) => `${real}: ${line.slice(0, 200)}`);
    if (lines.length) found.push({ score, lines });
  }
  found.sort((a, b) => b.score - a.score);
  const hits = found.flatMap((f) => f.lines).slice(0, 40);
  return text(hits.length ? hits.join('\n') : 'no matches');
});

await server.connect(new StdioServerTransport());
