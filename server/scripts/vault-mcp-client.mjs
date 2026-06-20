// Shared E2EE-vault MCP client for the server-side Node tools (vault-cli, folder-sync).
// One place for: credential resolution + the minimal MCP streamable-HTTP transport.
// Crypto (encrypt/decrypt path & blob) stays in vault-crypto.mjs; callers import that directly.
import { readFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import { deriveKey } from './vault-crypto.mjs';

/** Derive the vault key from env (VAULT_PASSPHRASE/VAULT_SALT_B64) or /root/vault-sync-key.txt. */
export function loadKey() {
  let pass = process.env.VAULT_PASSPHRASE, salt = process.env.VAULT_SALT_B64;
  if ((!pass || !salt) && existsSync('/root/vault-sync-key.txt')) {
    for (const line of readFileSync('/root/vault-sync-key.txt', 'utf8').split('\n')) {
      const m = /^(\w+)=(.*)$/.exec(line.trim());
      if (m && m[1] === 'VAULT_PASSPHRASE') pass = m[2];
      if (m && m[1] === 'VAULT_SALT_B64') salt = m[2];
    }
  }
  if (!pass || !salt) { console.error('vault-mcp: no vault key (VAULT_PASSPHRASE/VAULT_SALT_B64)'); process.exit(2); }
  return deriveKey(pass, Buffer.from(salt, 'base64'));
}

/** Resolve the MCP token from env or /opt/vault-sync/application.yml. */
export function loadMcpToken() {
  if (process.env.VAULT_MCP_TOKEN) return process.env.VAULT_MCP_TOKEN;
  const yml = '/opt/vault-sync/application.yml';
  if (existsSync(yml)) {
    const m = /mcp-token:\s*(\S+)/.exec(readFileSync(yml, 'utf8'));
    if (m) return m[1].replace(/["']/g, '');
  }
  console.error('vault-mcp: no MCP token'); process.exit(2);
}

function parseSse(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) if (line.startsWith('data:')) { try { out.push(JSON.parse(line.slice(5).trim())); } catch {} }
  if (!out.length) { try { out.push(JSON.parse(text)); } catch {} }
  return out;
}

/**
 * Minimal MCP streamable-HTTP client. Uses node:http (not fetch): the server may hold the SSE
 * response open and undici's fetch throws "terminated" on close even after the data arrived;
 * we accumulate and resolve as soon as the matching JSON-RPC response is present. Returns an
 * object with init() and callTool(name, args).
 */
export function createMcpClient(url = process.env.VAULT_MCP_URL || 'http://localhost:8444/mcp',
                                token = loadMcpToken()) {
  let sessionId = null;
  let nextId = 10;

  function rpc(method, params, id) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', ...(id != null ? { id } : {}), method, params });
      const u = new URL(url);
      const headers = {
        Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
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

  async function init() {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'vault-mcp', version: '1' } }, 1);
    await rpc('notifications/initialized', {});
  }

  async function callTool(name, args) {
    const r = await rpc('tools/call', { name, arguments: args }, nextId++);
    const text = r?.result?.content?.[0]?.text;
    if (text == null) throw new Error('MCP ' + name + ': empty result');
    return JSON.parse(text);
  }

  return { init, callTool, rpc };
}
