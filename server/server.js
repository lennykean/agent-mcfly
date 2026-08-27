#!/usr/bin/env node
// Agent McFly backend: session listing + tailing over HTTP, provider-pluggable.
// Serves ui/dist when it exists (production); in dev, run vite separately.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as claudeCode from './loaders/claude-code.js';
import * as codex from './loaders/codex.js';
import * as cursor from './loaders/cursor.js';
import { alive, attachPty, claudePtySessions, claudeRecordMapping, detectTools, hasEditor, openInEditor, killAllPtys, killPty, listPeers, listPtys, pullPeerInbox, reapOrphans, sendPeerMessage, setPtyRelay, setPtySession, TOKEN } from './pty.js';
import { launchAgent, listAgentProviders } from './agent-launch.js';
import { connectSsh, disconnectAllSsh, disconnectSsh, getSshConnection, listSshConnections } from './ssh.js';
import * as review from './review.js';
import * as matchers from './matchers.js';
import * as git from './git.js';
import * as remoteData from './remote-data.js';

const PROVIDERS = { 'claude-code': claudeCode, codex, cursor };
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
const MCP_TOKEN = crypto.randomBytes(32).toString('hex');
const isPrivateMcpRoute = (pathname) => ['/api/agent-providers', '/api/spawn-agent', '/api/peer-message', '/api/peer-inbox'].includes(pathname);
function hasMcpCredential(req) {
  const supplied = req.headers.authorization;
  const expected = `Bearer ${MCP_TOKEN}`;
  if (typeof supplied !== 'string' || supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

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
function pickScope(project, localOnly = false) {
  const keys = [...wsSnapshots.keys()].filter((scope) => !localOnly || !scope.includes('\0'));
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

// Mapping a terminal to its transcript means listing every session in its cwd,
// which is far more work than a 4-second poll should repeat. Both the hunt and
// the (cosmetic) session label are therefore answered from memory until the
// title changes or the window lapses.
const HUNT_RETRY_MS = 15_000;
const hunted = new Map(); // ptyId -> { title, at, found }
const labels = new Map(); // session id -> { label, at }
const shouldHunt = (p) => {
  const last = hunted.get(p.id);
  return !last || last.title !== p.title || (!last.found && Date.now() - last.at >= HUNT_RETRY_MS);
};

// registry so the (separate) MCP process can find running servers
const SERVERS_FILE = path.join(os.homedir(), '.mcfly', 'servers.json');
function updateServersFile(mutate) {
  try {
    fs.mkdirSync(path.dirname(SERVERS_FILE), { recursive: true });
    let all = [];
    try { all = JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8')); } catch { /* fresh */ }
    all = all.filter((s) => s.pid !== process.pid && alive(s.pid));
    fs.writeFileSync(SERVERS_FILE, JSON.stringify(mutate(all)), { mode: 0o600 });
    fs.chmodSync(SERVERS_FILE, 0o600);
  } catch { /* best effort */ }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // DNS-rebinding defense: a hostile site pointed at 127.0.0.1 becomes
    // same-origin; the Host header is the tell.
    if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) return json(res, 403, { error: 'bad host' });
    if (isPrivateMcpRoute(url.pathname) && req.headers.origin) return json(res, 403, { error: 'cross-origin MCP action is forbidden' });
    if (isPrivateMcpRoute(url.pathname) && !hasMcpCredential(req)) return json(res, 401, { error: 'unauthorized' });
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
      return json(res, 200, {
        tools: [...detectTools(), '_'], token: TOKEN, pwd: process.cwd(),
        platform: process.platform, home: os.homedir(),
        editor: hasEditor(), // a local VS Code to hand folders to
      });
    }
    // open a LOCAL folder in VS Code. Launching `code` here (rather than a
    // vscode:// link) keeps the browser from asking permission every time.
    if (url.pathname === '/api/open-editor' && req.method === 'POST') {
      try {
        const { path: target } = await requestJson(req);
        if (!target || !git.okRoot(target)) return json(res, 404, { error: 'no such folder' });
        if (!hasEditor()) return json(res, 404, { error: 'VS Code (code) is not on PATH' });
        openInEditor(target);
        return json(res, 200, { ok: true });
      } catch (e) { return json(res, 400, { error: String(e.message ?? e) }); }
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
      // ?screens=1 only from the gallery — see listPtys
      const ptys = listPtys(remote?.id, { screens: url.searchParams.get('screens') === '1' });
      // Remote mappings are made by the same post-launch session hunt as
      // local mappings. Avoid rescanning every remote transcript over SFTP
      // on this frequent terminal-registry poll.
      if (remote) return json(res, 200, ptys);
      const claudeRecords = await claudePtySessions();
      for (const p of ptys) {
        const claudeRecord = claudeRecords.get(p.id);
        let exactClaude = false;
        if (claudeRecord) {
          try {
            const mapping = claudeRecordMapping(claudeRecord, claudeCode.listForCwd(claudeRecord.cwd));
            exactClaude = !!mapping;
            if (mapping && (p.session?.provider !== mapping.provider || p.session.id !== mapping.id || p.session.pwd !== mapping.pwd)) {
              p.session = mapping;
              setPtySession(p.id, p.session);
            }
          } catch { /* Claude's PID record is authoritative but best effort */ }
        }
        // the terminal title is the agent's own announcement of its session:
        // exactly one transcript whose name the title contains -> map to it.
        // Titles can duplicate, so several matches (none of them the current
        // mapping) drop the mapping instead of guessing — the follow button
        // then asks the human. Zero matches leaves things alone.
        //
        // The hunt lists every transcript in the cwd, which is far too much
        // work for a 4-second poll to repeat: a title that has already been
        // hunted is only re-hunted after HUNT_RETRY_MS, and a title that
        // resolved is never re-hunted at all. A CHANGED title always is —
        // that is the event the mapping actually depends on.
        if (!exactClaude && p.title && p.cwd && shouldHunt(p)) {
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
            hunted.set(p.id, { title: p.title, at: Date.now(), found: !!p.session });
          } catch { /* title mapping is best effort */ }
        }
        if (!p.session?.pwd) continue;
        const cached = labels.get(p.session.id);
        if (cached && Date.now() - cached.at < HUNT_RETRY_MS) {
          p.session = { ...p.session, label: cached.label };
          continue;
        }
        try {
          const meta = PROVIDERS[p.session.provider]?.listForCwd(p.session.pwd)
            ?.find((s) => s.id === p.session.id);
          if (meta) {
            labels.set(p.session.id, { label: meta.label, at: Date.now() });
            p.session = { ...p.session, label: meta.label };
          }
        } catch { /* label is cosmetic */ }
      }
      return json(res, 200, ptys);
    }
    if (url.pathname === '/api/peers') return json(res, 200, listPeers());
    if (url.pathname === '/api/agent-providers') return json(res, 200, listAgentProviders());
    if (url.pathname === '/api/spawn-agent' && req.method === 'POST') {
      try {
        const input = await requestJson(req);
        const scope = pickScope(input.cwd ?? process.cwd(), true) ?? process.cwd();
        return json(res, 200, await launchAgent(input, { scope }));
      } catch (error) {
        return errorJson(res, error, 400);
      }
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
      return json(res, 404, { error: 'unknown git route' });
    }
    // user settings: one JSON file beside servers.json in ~/.mcfly
    if (url.pathname === '/api/settings') {
      const settingsPath = path.join(os.homedir(), '.mcfly', 'settings.json');
      if (req.method === 'POST') {
        try {
          const s = await requestJson(req);
          fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
          fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
          return json(res, 200, { ok: true });
        } catch (e) {
          return json(res, 400, { error: String(e.message ?? e) });
        }
      }
      try {
        return json(res, 200, JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
      } catch {
        return json(res, 200, {});
      }
    }
    // data-tool matchers: which OTHER tools' results belong in the DATA tab.
    // The UI does the matching; this is just where the rules live.
    if (url.pathname === '/api/data-matchers') {
      if (req.method === 'POST') {
        try {
          return json(res, 200, matchers.replaceMatchers(await requestJson(req)));
        } catch (e) {
          return json(res, e.status ?? 400, { error: String(e.message ?? e) });
        }
      }
      return json(res, 200, matchers.listMatchers());
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
      try {
        const b = await requestJson(req);
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
        return json(res, 200, out);
      } catch { return json(res, 400, { error: 'bad body' }); }
    }
    // workspace state: the UI reports what the user has open/focused/selected;
    // the mcfly MCP queries it so agents can see what the user is pointing at
    if (url.pathname === '/api/workspace-events' && req.method === 'POST') {
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
        return json(res, 403, { error: 'cross-origin workspace state is forbidden' });
      }
      try {
        const { scope = '', snapshot, events } = await requestJson(req);
        if (snapshot && typeof snapshot === 'object') {
          const cur = wsSnapshots.get(scope) ?? {};
          wsSnapshots.set(scope, Object.assign(cur, snapshot, { updated: Date.now() }));
        }
        if (Array.isArray(events)) {
          for (const e of events) wsRing.push({ ...e, scope });
          if (wsRing.length > WS_RING_CAP) wsRing.splice(0, wsRing.length - WS_RING_CAP);
        }
        return json(res, 200, { ok: true });
      } catch { return json(res, 400, { error: 'bad body' }); }
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
      let refused = false;
      req.on('data', (c) => {
        size += c.length;
        // say WHY, then hang up: a bare socket reset reads as a network fault
        if (size > 10 * 1024 * 1024) {
          refused = true;
          json(res, 413, { error: 'image too large' });
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', async () => {
        if (refused) return;
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
    if (url.pathname === '/api/pty-relay' && req.method === 'POST') {
      try {
        const body = await requestJson(req);
        const connection = remoteConnection(url)?.id ?? body.connection;
        if (typeof body.enabled !== 'boolean') return json(res, 400, { error: 'enabled must be a boolean' });
        const ok = setPtyRelay(body.id, body.enabled, connection);
        return json(res, ok ? 200 : 404, ok ? { ok, enabled: body.enabled } : { error: 'terminal not found' });
      } catch (error) {
        return errorJson(res, error, 400);
      }
    }
    if (url.pathname === '/api/peer-message' && req.method === 'POST') {
      try {
        const { id, message, inbox } = await requestJson(req);
        return json(res, 200, await sendPeerMessage(id, message, { inbox: inbox === true }));
      } catch (error) {
        return errorJson(res, error, 400);
      }
    }
    if (url.pathname === '/api/peer-inbox' && req.method === 'POST') {
      try {
        const { id } = await requestJson(req);
        return json(res, 200, pullPeerInbox(id));
      } catch (error) {
        return errorJson(res, error, 400);
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
    if (url.pathname === '/api/fs/mkdir' && req.method === 'POST') {
      try {
        const { root, name } = await requestJson(req);
        if (typeof root !== 'string' || !root || typeof name !== 'string' || !name || name.trim() !== name || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
          return json(res, 400, { error: 'The folder name is not valid.' });
        }
        const remote = remoteConnection(url);
        if (remote) await remoteData.fsMkdir(remote, root, name);
        else {
          if (!git.okRoot(root)) return json(res, 404, { error: 'The parent folder does not exist.' });
          fs.mkdirSync(path.join(path.resolve(root), name));
        }
        return json(res, 200, { ok: true });
      } catch (error) {
        if (error.status) return errorJson(res, error);
        const status = error.code === 'EACCES' || error.code === 'EPERM' ? 403
          : error.code === 'EEXIST' ? 409
            : error.code === 'ENOENT' || error.code === 2 ? 404 : 400;
        return json(res, status, { error: String(error.message ?? error) });
      }
    }
    // file explorer, contained under a caller-supplied root (the session cwd)
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
      const image = remoteData.IMG[ext]; // one table, shared with the remote reader
      if (image) {
        if (st.size > 8 * 1024 * 1024) return json(res, 200, { error: 'image too large' });
        return json(res, 200, { image_src: `data:${image};base64,${fs.readFileSync(target).toString('base64')}` });
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
    // last-activity of specific transcripts (the agent tree asks about the
    // children it still considers alive). A stat each, no parsing, no state:
    // the client freezes an agent once its tip falls behind the playhead and
    // stops asking about it entirely.
    if (url.pathname === '/api/session-tips') {
      const provider = PROVIDERS[url.searchParams.get('provider') ?? 'claude-code'];
      if (!provider?.tip) return json(res, 200, {});
      const out = {};
      for (const id of (url.searchParams.get('ids') ?? '').split(',').filter(Boolean).slice(0, 64)) {
        try { out[id] = provider.tip(id); } catch { /* not written yet, or gone */ }
      }
      return json(res, 200, out);
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
    let stat;
    try { stat = fs.statSync(file); } catch { /* not built, or not a file */ }
    if (file.startsWith(DIST + path.sep) && stat?.isFile()) {
      const ext = path.extname(file);
      // index.html must revalidate every load or browsers heuristically cache
      // it and keep pointing at dead hashed bundles; the hashed assets
      // themselves are immutable by name
      const cache = ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
      res.writeHead(200, {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': cache,
      });
      // streamed, not read whole: the bundle is megabytes and this is the
      // event loop every websocket frame also waits on
      return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
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
  updateServersFile((all) => [...all, {
    pid: process.pid, port: Number(PORT), pwd: process.cwd(), started: Date.now(), mcpToken: MCP_TOKEN,
  }]);
  if (process.env.MCFLY_OPEN === '1') {
    const url = `http://localhost:${PORT}`;
    const [cmd, args] = process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  }
});

reapOrphans(); // children of servers that died without cleanup
// probing PATH for the agent CLIs costs about a second of blocking spawns.
// Spend it here, at boot, rather than inside the first /api/config the page
// waits on.
setImmediate(() => { detectTools(); hasEditor(); });

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
