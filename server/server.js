#!/usr/bin/env node
// Agent McFly backend: session listing + tailing over HTTP, provider-pluggable.
// Serves ui/dist when it exists (production); in dev, run vite separately.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as claudeCode from './loaders/claude-code.js';
import * as codex from './loaders/codex.js';
import { alive, attachPty, detectTools, killAllPtys, killPty, listPtys, reapOrphans, setPtySession, TOKEN } from './pty.js';

const PROVIDERS = { 'claude-code': claudeCode, codex };
const PORT = process.env.PORT || 7777;
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'dist');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.png': 'image/png', '.map': 'application/json',
};

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

// what the user has open/focused/selected, reported by the UI; agents query
// it through the mcfly MCP's workspace_state tool
const wsSnapshot = {};
const wsRing = [];
const WS_RING_CAP = 500;

// registry so the (separate) MCP process can find running servers
const SERVERS_FILE = path.join(os.homedir(), '.mcfly', 'servers.json');
function updateServersFile(mutate) {
  try {
    fs.mkdirSync(path.dirname(SERVERS_FILE), { recursive: true });
    let all = [];
    try { all = JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8')); } catch { /* fresh */ }
    all = all.filter((s) => s.pid !== process.pid && alive(s.pid));
    fs.writeFileSync(SERVERS_FILE, JSON.stringify(mutate(all)));
  } catch { /* best effort */ }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // DNS-rebinding defense: a hostile site pointed at 127.0.0.1 becomes
    // same-origin; the Host header is the tell.
    if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) return json(res, 403, { error: 'bad host' });
    if (url.pathname === '/api/config') {
      return json(res, 200, { tools: [...detectTools(), '_'], token: TOKEN, pwd: process.cwd(), platform: process.platform });
    }
    // live terminal registry (agent tmux: list-sessions / map to transcript)
    if (url.pathname === '/api/ptys') return json(res, 200, listPtys());
    // workspace state: the UI reports what the user has open/focused/selected;
    // the mcfly MCP queries it so agents can see what the user is pointing at
    if (url.pathname === '/api/workspace-events' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { snapshot, events } = JSON.parse(body);
          if (snapshot && typeof snapshot === 'object') Object.assign(wsSnapshot, snapshot, { updated: Date.now() });
          if (Array.isArray(events)) {
            for (const e of events) wsRing.push(e);
            while (wsRing.length > WS_RING_CAP) wsRing.shift();
          }
          json(res, 200, { ok: true });
        } catch { json(res, 400, { error: 'bad body' }); }
      });
      return;
    }
    if (url.pathname === '/api/workspace-state') {
      const history = Math.min(Number(url.searchParams.get('history')) || 0, WS_RING_CAP);
      const kinds = url.searchParams.get('kinds')?.split(',').filter(Boolean);
      const since = Number(url.searchParams.get('since_seconds')) || 0;
      let events = wsRing;
      if (kinds?.length) events = events.filter((e) => kinds.includes(e.kind));
      if (since) events = events.filter((e) => e.ts >= Date.now() - since * 1000);
      if (history) events = events.slice(-history);
      else if (!kinds?.length && !since) events = [];
      return json(res, 200, { snapshot: wsSnapshot, events });
    }
    // pasted images land here as bytes; the temp file's path gets typed into
    // the terminal (the drag-and-drop flow every agent CLI already speaks)
    if (url.pathname === '/api/paste-image' && req.method === 'POST') {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 10 * 1024 * 1024) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => {
        try {
          const ext = ({
            'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
          })[req.headers['content-type']] ?? '.png';
          const file = path.join(os.tmpdir(), `mcfly-paste-${Date.now()}${ext}`);
          fs.writeFileSync(file, Buffer.concat(chunks));
          json(res, 200, { path: file });
        } catch {
          json(res, 500, { error: 'write failed' });
        }
      });
      return;
    }
    if (url.pathname === '/api/pty-kill' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { json(res, 200, { ok: killPty(JSON.parse(body).id) }); }
        catch { json(res, 400, { error: 'bad body' }); }
      });
      return;
    }
    if (url.pathname === '/api/pty-session' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { ptyId, provider, session, pwd } = JSON.parse(body);
          json(res, 200, { ok: setPtySession(ptyId, { provider, id: session, pwd }) });
        } catch {
          json(res, 400, { error: 'bad body' });
        }
      });
      return;
    }
    // which agents have session history for this project directory
    if (url.pathname === '/api/providers') {
      const pwd = url.searchParams.get('pwd') ?? '';
      return json(res, 200, Object.entries(PROVIDERS).map(([name, p]) => ({
        provider: name,
        count: p.listForCwd(pwd).length,
      })));
    }
    // read-only file explorer, contained under a caller-supplied root (the session cwd)
    if (url.pathname === '/api/fs/list' || url.pathname === '/api/fs/read') {
      const root = path.resolve(url.searchParams.get('root') ?? '');
      const target = path.resolve(root, url.searchParams.get('path') ?? '');
      if (!root || (!target.startsWith(root + path.sep) && target !== root)) {
        return json(res, 403, { error: 'outside root' });
      }
      if (!fs.existsSync(target)) return json(res, 404, { error: 'not found' });
      if (url.pathname === '/api/fs/list') {
        const entries = fs.readdirSync(target, { withFileTypes: true })
          .filter((e) => !['node_modules', '.git'].includes(e.name))
          .map((e) => ({ name: e.name, dir: e.isDirectory() }))
          .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
        return json(res, 200, entries);
      }
      const st = fs.statSync(target);
      const ext = path.extname(target).toLowerCase();
      const IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
      if (IMG[ext]) {
        if (st.size > 8 * 1024 * 1024) return json(res, 200, { error: 'image too large' });
        return json(res, 200, { image_src: `data:${IMG[ext]};base64,${fs.readFileSync(target).toString('base64')}` });
      }
      if (st.size > 2 * 1024 * 1024) return json(res, 200, { error: `file too large (${Math.round(st.size / 1024)} KB)` });
      return json(res, 200, { content: fs.readFileSync(target, 'utf8') });
    }
    if (url.pathname === '/api/sessions') {
      const pwd = url.searchParams.get('pwd');
      const provider = PROVIDERS[url.searchParams.get('provider') ?? ''];
      if (!pwd || !provider) return json(res, 400, { error: 'need pwd and provider' });
      return json(res, 200, provider.listForCwd(pwd));
    }
    if (url.pathname === '/api/session') {
      const provider = PROVIDERS[url.searchParams.get('provider') ?? 'claude-code'];
      if (!provider) return json(res, 400, { error: 'unknown provider' });
      const id = url.searchParams.get('id');
      if (!id) return json(res, 400, { error: 'missing id' });
      const cursor = parseInt(url.searchParams.get('cursor') ?? '0', 10) || 0;
      try {
        return json(res, 200, provider.tail(id, cursor));
      } catch (e) {
        return json(res, e.code === 'ENOENT' ? 404 : 400, { error: String(e.message ?? e) });
      }
    }
    // static (production build)
    const relPath = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(DIST, relPath);
    if (file.startsWith(DIST + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const body = fs.readFileSync(file); // read before writeHead: a throw here must reach the catch
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      return res.end(body);
    }
    res.writeHead(404);
    res.end('not found — in dev, use the vite server');
  } catch (e) {
    json(res, 500, { error: String(e) });
  }
});

attachPty(server, ALLOWED_HOSTS);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent McFly API: http://localhost:${PORT}`);
  updateServersFile((all) => [...all, { pid: process.pid, port: Number(PORT), pwd: process.cwd(), started: Date.now() }]);
  if (process.env.MCFLY_OPEN === '1') {
    const url = `http://localhost:${PORT}`;
    const [cmd, args] = process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  }
});

reapOrphans(); // children of servers that died without cleanup

const shutdown = () => {
  killAllPtys();
  updateServersFile((all) => all);
  server.close();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.once('SIGHUP', shutdown); // terminal closed on the server (POSIX)
process.once('uncaughtException', (e) => { console.error(e); killAllPtys(); process.exit(1); });
process.once('exit', () => killAllPtys()); // sync-only, but killTree is sync
