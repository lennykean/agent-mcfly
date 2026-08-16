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
import { connectSsh, disconnectAllSsh, disconnectSsh, getSshConnection, listSshConnections } from './ssh.js';
import * as review from './review.js';
import * as git from './git.js';
import * as remoteData from './remote-data.js';

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

function errorJson(res, error, fallback = 500) {
  const body = { error: String(error.message ?? error) };
  if (typeof error.code === 'string') body.code = error.code;
  return json(res, error.status ?? fallback, body);
}

function remoteConnection(url) {
  const id = url.searchParams.get('connection');
  if (!id) return null;
  const connection = getSshConnection(id);
  if (connection) return connection;
  const error = new Error('SSH connection not found');
  error.status = 404;
  error.code = 'SSH_CONNECTION_NOT_FOUND';
  throw error;
}

const reviewOrigin = (connection, pwd) => connection
  ? JSON.stringify([connection.host.toLowerCase(), connection.port, connection.username, pwd])
  : undefined;

async function requestJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

// what the user has open/focused/selected, reported by the UI; agents query
// it through the mcfly MCP's workspace_state tool. Multi-root: one snapshot
// per workspace scope (its project pwd; '' from pre-scope UIs), so an agent
// in project A reads A's state even while the user works in project B.
const wsSnapshots = new Map(); // scope -> { ...snapshot, updated }
const wsRing = [];
const WS_RING_CAP = 500;
const normScope = (p) => {
  const source = String(p ?? '').split('\0').at(-1).replace(/\\/g, '/');
  const normalized = source === '/' ? source : source.replace(/\/+$/, '');
  return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
};
// the scope covering a project dir: the longest scope the project sits under.
// An explicit project never falls through
// to another workspace; bare requests keep the newest-snapshot behavior.
function pickScope(project) {
  const keys = [...wsSnapshots.keys()];
  if (!keys.length) return null;
  const want = normScope(project);
  if (want) {
    const hits = keys.filter((k) => {
      const n = normScope(k);
      return n && (want === n || want.startsWith(n.endsWith('/') ? n : `${n}/`));
    }).sort((a, b) => normScope(b).length - normScope(a).length);
    return hits[0] ?? null;
  }
  return keys.sort((a, b) => (wsSnapshots.get(b).updated ?? 0) - (wsSnapshots.get(a).updated ?? 0))[0];
}

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // DNS-rebinding defense: a hostile site pointed at 127.0.0.1 becomes
    // same-origin; the Host header is the tell.
    if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) return json(res, 403, { error: 'bad host' });
    if (url.pathname === '/api/ssh/connections' && req.method === 'GET') {
      return json(res, 200, listSshConnections());
    }
    if (url.pathname === '/api/ssh/connect' && req.method === 'POST') {
      try {
        return json(res, 200, await connectSsh(await requestJson(req)));
      } catch (e) {
        const out = { error: String(e.message ?? e), code: e.code };
        for (const key of ['host', 'port', 'fingerprint', 'expectedFingerprint']) {
          if (e[key] != null) out[key] = e[key];
        }
        return json(res, e.status ?? 400, out);
      }
    }
    if (url.pathname === '/api/ssh/disconnect' && req.method === 'POST') {
      try {
        const { id } = await requestJson(req);
        return json(res, 200, { ok: disconnectSsh(id) });
      } catch (e) {
        return json(res, 400, { error: String(e.message ?? e) });
      }
    }
    if (url.pathname === '/api/config') {
      const remote = remoteConnection(url);
      if (remote) {
        return json(res, 200, {
          tools: [...remote.tools, '_'], token: TOKEN, pwd: remote.home,
          platform: remote.platform, home: remote.home,
        });
      }
      return json(res, 200, { tools: [...detectTools(), '_'], token: TOKEN, pwd: process.cwd(), platform: process.platform, home: os.homedir() });
    }
    if (url.pathname === '/api/workspace/validate') {
      const pwd = url.searchParams.get('pwd');
      const remote = remoteConnection(url);
      if (pwd && (remote ? await remoteData.isDirectory(remote, pwd) : git.okRoot(pwd))) {
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'Workspace directory not found', code: 'WORKSPACE_NOT_FOUND' });
    }
    // live terminal registry (agent tmux: list-sessions / map to transcript);
    // mapped sessions carry their transcript title so the picker reads human
    if (url.pathname === '/api/ptys') {
      const remote = remoteConnection(url);
      const ptys = listPtys(remote?.id);
      // Remote mappings are made by the same post-launch session hunt as
      // local mappings. Avoid rescanning every remote transcript over SFTP
      // on this frequent terminal-registry poll.
      if (remote) return json(res, 200, ptys);
      // ponytail: re-scans session heads every poll; cache if dirs grow large
      for (const p of ptys) {
        // the terminal title is the agent's own announcement of its session:
        // exactly one transcript whose name the title contains -> map to it.
        // Titles can duplicate, so several matches (none of them the current
        // mapping) drop the mapping instead of guessing — the follow button
        // then asks the human. Zero matches leaves things alone.
        if (p.title && p.cwd) {
          try {
            const matches = [];
            for (const [prov, loader] of Object.entries(PROVIDERS)) {
              for (const s of loader.listForCwd(p.cwd)) {
                if (s.label && s.label.length >= 8 && p.title.includes(s.label)) matches.push({ prov, s });
              }
            }
            if (matches.length === 1 && p.session?.id !== matches[0].s.id) {
              p.session = { provider: matches[0].prov, id: matches[0].s.id, pwd: p.cwd };
              setPtySession(p.id, p.session);
            } else if (matches.length > 1 && p.session && !matches.some((m) => m.s.id === p.session.id)) {
              p.session = null;
              setPtySession(p.id, null);
            }
          } catch { /* title mapping is best effort */ }
        }
        if (!p.session?.pwd) continue;
        try {
          const meta = PROVIDERS[p.session.provider]?.listForCwd(p.session.pwd)
            ?.find((s) => s.id === p.session.id);
          if (meta) p.session = { ...p.session, label: meta.label };
        } catch { /* label is cosmetic */ }
      }
      return json(res, 200, ptys);
    }
    // read-only git inspection for the GIT pane; root follows the explorer
    if (url.pathname.startsWith('/api/git/')) {
      const root = url.searchParams.get('root') ?? process.cwd();
      const remote = remoteConnection(url);
      if (remote ? !await remoteData.isDirectory(remote, root) : !git.okRoot(root)) return json(res, 400, { error: 'bad root' });
      try {
        const io = remote ? remoteData.gitIo(remote) : undefined;
        if (url.pathname === '/api/git/status') return json(res, 200, await git.status(root, io));
        if (url.pathname === '/api/git/log') {
          return json(res, 200, await git.log(root, Number(url.searchParams.get('limit') ?? 150), Number(url.searchParams.get('skip') ?? 0), io));
        }
        if (url.pathname === '/api/git/worktrees') return json(res, 200, await git.worktrees(root, io));
        if (url.pathname === '/api/git/diff') {
          const file = url.searchParams.get('path') ?? '';
          const staged = url.searchParams.get('staged') === '1';
          return json(res, 200, { hunks: await git.diff(root, file, staged, io) });
        }
        // review checklist: files differing from a base ref, and their diffs
        if (url.pathname === '/api/git/reffiles') {
          const ref = url.searchParams.get('ref') ?? '';
          return json(res, 200, { ref: await git.resolveRef(root, ref, io), files: await git.diffFiles(root, ref, io) });
        }
        if (url.pathname === '/api/git/refdiff') {
          const ref = url.searchParams.get('ref') ?? '';
          const file = url.searchParams.get('path') ?? '';
          return json(res, 200, { hunks: await git.diffAgainstRef(root, ref, file, io) });
        }
      } catch (e) {
        if (git.isNotRepositoryError(e)) {
          if (url.pathname === '/api/git/status') return json(res, 200, { repo: false, staged: [], changed: [] });
          if (url.pathname === '/api/git/log' || url.pathname === '/api/git/worktrees') return json(res, 200, []);
        }
        return json(res, 200, { error: String(e.message ?? e).split('\n')[0] });
      }
    }
    // user settings: one JSON file beside servers.json in ~/.mcfly
    if (url.pathname === '/api/settings') {
      const settingsPath = path.join(os.homedir(), '.mcfly', 'settings.json');
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try {
            const s = JSON.parse(body);
            fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
            fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
            json(res, 200, { ok: true });
          } catch (e) {
            json(res, 400, { error: String(e.message ?? e) });
          }
        });
        return;
      }
      try {
        return json(res, 200, JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
      } catch {
        return json(res, 200, {});
      }
    }
    // quick pickers: grep the repo, find a file by name (tracked files).
    // Failures surface as {error} — a silent [] reads as "no matches"
    if (url.pathname === '/api/grep' || url.pathname === '/api/files') {
      // the root is echoed back so the picker can SHOW what it searched —
      // a silent empty result with an invisible root is undiagnosable
      const root = url.searchParams.get('root') || process.cwd();
      const q = url.searchParams.get('q') ?? '';
      const remote = remoteConnection(url);
      if (remote ? !await remoteData.isDirectory(remote, root) : !git.okRoot(root)) return json(res, 200, { root, error: `not a directory: ${root}` });
      if (!q.trim()) return json(res, 200, { root, items: [] });
      try {
        const io = remote ? remoteData.gitIo(remote) : undefined;
        return json(res, 200, {
          root,
          items: url.pathname === '/api/grep' ? await git.grep(root, q, io) : await git.listFiles(root, q, io),
        });
      } catch (e) {
        return json(res, 200, { root, error: String(e.message ?? e) });
      }
    }
    // human review: session-scoped threaded comments; the human writes from
    // the UI, agents read and reply through the MCP
    if (url.pathname === '/api/reviews') {
      const pwd = url.searchParams.get('pwd') ?? process.cwd();
      return json(res, 200, review.listReviews(pwd, reviewOrigin(remoteConnection(url), pwd)));
    }
    if (url.pathname.startsWith('/api/review-') && req.method === 'POST') {
      const connection = remoteConnection(url);
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const b = JSON.parse(body);
          const pwd = b.pwd ?? process.cwd();
          const origin = reviewOrigin(connection, pwd);
          const out =
            url.pathname === '/api/review-create' ? review.createReview(pwd, b.session, origin)
            : url.pathname === '/api/review-close' ? review.closeReview(pwd, b.id, origin)
            : url.pathname === '/api/review-comment' ? review.addComment(pwd, b.id, b.comment, origin)
            : url.pathname === '/api/review-reply' ? review.addReply(pwd, b.commentId, b.body, b.author ?? 'human', b.addressed, origin)
            : url.pathname === '/api/review-thread-state' ? review.setThreadState(pwd, b.id, b.commentId, b.state, origin)
            : url.pathname === '/api/review-checklist' ? review.setChecklist(pwd, b.id, b.patch ?? {}, origin)
            : undefined;
          if (out === undefined) return json(res, 404, { error: 'unknown review action' });
          if (out === null) return json(res, 404, { error: 'not found' });
          json(res, 200, out);
        } catch { json(res, 400, { error: 'bad body' }); }
      });
      return;
    }
    // workspace state: the UI reports what the user has open/focused/selected;
    // the mcfly MCP queries it so agents can see what the user is pointing at
    if (url.pathname === '/api/workspace-events' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { scope = '', snapshot, events } = JSON.parse(body);
          if (snapshot && typeof snapshot === 'object') {
            const cur = wsSnapshots.get(scope) ?? {};
            wsSnapshots.set(scope, Object.assign(cur, snapshot, { updated: Date.now() }));
          }
          if (Array.isArray(events)) {
            for (const e of events) wsRing.push({ ...e, scope });
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
      const scope = pickScope(url.searchParams.get('project'));
      let events = scope === null ? [] : wsRing.filter((e) => (e.scope ?? '') === scope);
      if (kinds?.length) events = events.filter((e) => kinds.includes(e.kind));
      if (since) events = events.filter((e) => e.ts >= Date.now() - since * 1000);
      if (history) events = events.slice(-history);
      else if (!kinds?.length && !since) events = [];
      return json(res, 200, { snapshot: scope === null ? {} : wsSnapshots.get(scope), scope, events });
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
      req.on('end', async () => {
        try {
          const ext = ({
            'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
          })[req.headers['content-type']] ?? '.png';
          const remote = remoteConnection(url);
          const file = remote
            ? await remoteData.pasteImage(remote, Buffer.concat(chunks), ext)
            : path.join(os.tmpdir(), `mcfly-paste-${Date.now()}${ext}`);
          if (!remote) fs.writeFileSync(file, Buffer.concat(chunks));
          json(res, 200, { path: file });
        } catch (error) {
          if (error.status) errorJson(res, error);
          else json(res, 500, { error: 'write failed' });
        }
      });
      return;
    }
    if (url.pathname === '/api/pty-kill' && req.method === 'POST') {
      try {
        const body = await requestJson(req);
        const connection = remoteConnection(url)?.id ?? body.connection;
        const { id } = body;
        return json(res, 200, { ok: killPty(id, connection) });
      } catch (error) {
        return error.status ? errorJson(res, error) : json(res, 400, { error: 'bad body' });
      }
    }
    if (url.pathname === '/api/pty-session' && req.method === 'POST') {
      try {
        const body = await requestJson(req);
        const connection = remoteConnection(url)?.id ?? body.connection;
        const { ptyId, provider, session, pwd } = body;
        return json(res, 200, { ok: setPtySession(ptyId, { provider, id: session, pwd }, connection) });
      } catch (error) {
        return error.status ? errorJson(res, error) : json(res, 400, { error: 'bad body' });
      }
    }
    // which agents have session history for this project directory
    if (url.pathname === '/api/providers') {
      const pwd = url.searchParams.get('pwd') ?? '';
      const remote = remoteConnection(url);
      if (remote) return json(res, 200, await remoteData.listProviders(remote, pwd));
      return json(res, 200, Object.entries(PROVIDERS).map(([name, p]) => ({
        provider: name,
        count: p.listForCwd(pwd).length,
      })));
    }
    // read-only file explorer, contained under a caller-supplied root (the session cwd)
    if (url.pathname === '/api/fs/list' || url.pathname === '/api/fs/read') {
      const remote = remoteConnection(url);
      if (remote) {
        const root = url.searchParams.get('root') ?? '';
        const relative = url.searchParams.get('path') ?? '';
        try {
          return json(res, 200, url.pathname === '/api/fs/list'
            ? await remoteData.fsList(remote, root, relative)
            : await remoteData.fsRead(remote, root, relative));
        } catch (error) {
          const status = error.code === 'EACCES' ? 403 : (error.code === 2 || error.code === 'ENOENT') ? 404 : 400;
          return json(res, status, { error: String(error.message ?? error) });
        }
      }
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
      const providerName = url.searchParams.get('provider') ?? '';
      const provider = PROVIDERS[providerName];
      if (!pwd || !provider) return json(res, 400, { error: 'need pwd and provider' });
      const remote = remoteConnection(url);
      if (remote) return json(res, 200, await remoteData.listSessions(remote, providerName, pwd));
      return json(res, 200, provider.listForCwd(pwd));
    }
    if (url.pathname === '/api/session') {
      const providerName = url.searchParams.get('provider') ?? 'claude-code';
      const provider = PROVIDERS[providerName];
      if (!provider) return json(res, 400, { error: 'unknown provider' });
      const id = url.searchParams.get('id');
      if (!id) return json(res, 400, { error: 'missing id' });
      const cursor = parseInt(url.searchParams.get('cursor') ?? '0', 10) || 0;
      try {
        const remote = remoteConnection(url);
        if (remote) return json(res, 200, await remoteData.tailSession(remote, providerName, id, cursor));
        return json(res, 200, provider.tail(id, cursor));
      } catch (e) {
        if (e.status) return errorJson(res, e);
        return json(res, e.code === 'ENOENT' || e.code === 2 ? 404 : 400, { error: String(e.message ?? e) });
      }
    }
    // static (production build)
    const relPath = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(DIST, relPath);
    if (file.startsWith(DIST + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const body = fs.readFileSync(file); // read before writeHead: a throw here must reach the catch
      const ext = path.extname(file);
      // index.html must revalidate every load or browsers heuristically cache
      // it and keep pointing at dead hashed bundles; the hashed assets
      // themselves are immutable by name
      const cache = ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': cache });
      return res.end(body);
    }
    res.writeHead(404);
    res.end('not found — in dev, use the vite server');
  } catch (e) {
    errorJson(res, e);
  }
});

attachPty(server, ALLOWED_HOSTS, getSshConnection);
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
  disconnectAllSsh();
  updateServersFile((all) => all);
  server.close();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.once('SIGHUP', shutdown); // terminal closed on the server (POSIX)
process.once('uncaughtException', (e) => { console.error(e); killAllPtys(); process.exit(1); });
process.once('exit', () => killAllPtys()); // sync-only, but killTree is sync
