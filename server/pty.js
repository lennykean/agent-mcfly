// Live terminal hosting: websocket <-> node-pty. The UI opens /ws/pty with a
// per-boot token and an optional tool to launch inside the shell.
//
// PTYs survive their websocket: on disconnect (page reload, HMR full reload)
// the shell stays alive for a grace window buffering output, and the page
// re-attaches with ?attach=<ptyId>. Control frames to the client are a \x00
// prefix + JSON; everything else is raw terminal data.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import pty from '@lydell/node-pty';
import headless from '@xterm/headless';

// server-side VT interpreter: each PTY keeps a "shadow screen" so previews
// show true terminal state (TUIs included), with no client attached
const ShadowTerminal = headless.Terminal ?? headless.default?.Terminal;

export const TOKEN = crypto.randomBytes(16).toString('hex');

const WIN = process.platform === 'win32';
const CANDIDATE_TOOLS = ['claude', 'codex', 'agy', 'pi', 'opencode', 'aider', 'gemini', 'goose'];
const BUFFER_CAP = 256 * 1024;

function which(name) {
  try {
    execFileSync(WIN ? 'where.exe' : 'which', [name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const SHELL = WIN ? (which('pwsh') ? 'pwsh.exe' : 'powershell.exe') : process.env.SHELL || 'bash';

let tools; // detected once, first request
export function detectTools() {
  tools ??= CANDIDATE_TOOLS.filter(which);
  return tools;
}

// The server may itself have been launched from inside an agent session; the
// hosted terminal must look like a fresh user shell. Drop harness runtime vars
// (a nested claude that sees CLAUDECODE disables transcript saving) and
// NO_COLOR, and advertise full color support for node-based CLIs.
// CLAUDE_CONFIG_DIR and other user-set vars are kept.
function sanitizedEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDECODE' || k === 'NO_COLOR' || k.startsWith('CLAUDE_CODE_')) continue;
    env[k] = v;
  }
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '3' };
}

// ptyId -> { p, buffer: string[], size, ws, tool, cwd, created, session }
const sessions = new Map();
// SSH PTYs are channels owned by this local McFly process. They need the
// connection in their identity because two hosts can produce the same id.
const remoteSessions = new Map();

const remoteKey = (connection, id) => `${connection}\0${id}`;
const sessionOf = (id, connection) => connection
  ? remoteSessions.get(remoteKey(connection, id))
  : sessions.get(id);

const ctl = (obj) => '\x00' + JSON.stringify(obj);

// "screenshot": the shadow's full viewport — actual rendered terminal state,
// with dimensions so the client can scale it into a thumbnail.
// Rendering a viewport drains the shadow's pending writes, which costs real
// CPU on a busy agent — so it is CACHED: gallery thumbnails at ~1fps are
// plenty, and the event loop stays free for the PTY sockets (keystrokes).
const SCREEN_TTL_MS = 1000;
function screenOf(s) {
  const now = Date.now();
  if (s.screenCache && now - s.screenCache.at < SCREEN_TTL_MS) return s.screenCache.value;
  let value = null;
  try {
    const b = s.shadow.buffer.active;
    const rows = s.shadow.rows;
    const lines = [];
    for (let y = Math.max(0, b.length - rows); y < b.length; y++) {
      lines.push(b.getLine(y)?.translateToString(true) ?? '');
    }
    value = { text: lines.join('\n'), cols: s.shadow.cols, rows };
  } catch {
    value = null;
  }
  s.screenCache = { at: now, value };
  return value;
}

// registry view for the live-terminal picker (agent tmux: list-sessions).
// screens are OPT-IN: tab badges only need identity, and rendering every
// terminal's viewport on every poll is what starves the sockets
export function listPtys(connection, { screens = false } = {}) {
  const values = connection
    ? [...remoteSessions.values()].filter((s) => s.connection === connection)
    : [...sessions.values()];
  return values.map((s) => ({
    id: s.id,
    tool: s.tool,
    cwd: s.cwd,
    created: s.created,
    attached: !!s.ws,
    session: s.session ?? null, // { provider, id, pwd } once the hunter maps it
    title: s.title || null, // live terminal title (OSC), the agent's own words
    screen: screens ? screenOf(s) : null,
    ...(s.connection ? { connection: s.connection } : {}),
  }));
}

export function setPtySession(ptyId, mapping, connection) {
  const s = sessionOf(ptyId, connection);
  if (!s) return false;
  s.session = mapping;
  return true;
}

// tmux semantics: detached sessions persist until the process exits or an
// explicit kill — no grace reaper
function detach(s) {
  s.ws = null;
  s.detachedAt = Date.now();
}

// ---- orphan prevention: PTYs die with the server, even when the server
// dies badly. Killing only the shell leaves the agent running inside it
// alive (job control puts it in its own process group), so kills are
// tree-wide; and a liveness file lets the NEXT server boot reap children
// of servers that never got to run their handlers (force-kill, crash). ----

const LIVE_FILE = path.join(os.homedir(), '.mcfly', 'live-ptys.json');

function saveLive() {
  try {
    fs.mkdirSync(path.dirname(LIVE_FILE), { recursive: true });
    let all = {};
    try { all = JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8')); } catch { /* fresh file */ }
    all[process.pid] = [...sessions.values()].map((s) => ({ pid: s.p.pid, shell: path.basename(SHELL) }));
    fs.writeFileSync(LIVE_FILE, JSON.stringify(all));
  } catch { /* best effort */ }
}

export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function processName(pid) {
  try {
    if (WIN) {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      return out.split('","')[0]?.replace(/^"/, '').trim() ?? '';
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim();
  } catch { return ''; }
}

export function killTree(pid) {
  try {
    if (WIN) {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'pipe', windowsHide: true });
    } else {
      let kids = [];
      try { kids = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { /* no children */ }
      for (const kid of kids) killTree(Number(kid));
      process.kill(pid, 'SIGKILL');
    }
  } catch { /* already gone */ }
}

// on boot: children recorded by servers that no longer exist are orphans.
// PID-reuse guard: only kill a pid that still looks like the shell we spawned.
export function reapOrphans() {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8')); } catch { return; }
  const next = {};
  for (const [serverPid, ptys] of Object.entries(all)) {
    if (Number(serverPid) === process.pid || alive(Number(serverPid))) { next[serverPid] = ptys; continue; }
    for (const entry of Array.isArray(ptys) ? ptys : []) {
      const want = String(entry.shell ?? '').replace(/\.exe$/i, '').toLowerCase();
      if (entry.pid && alive(entry.pid) && want && processName(entry.pid).toLowerCase().includes(want)) {
        killTree(entry.pid);
      }
    }
  }
  try { fs.writeFileSync(LIVE_FILE, JSON.stringify(next)); } catch { /* best effort */ }
}

export function killPty(id, connection) {
  const s = sessionOf(id, connection);
  if (!s) return false;
  if (s.connection) {
    try { s.p.signal('KILL'); } catch { /* server may not support signals */ }
    try { s.p.close(); } catch { /* close event cleans up */ }
    return true;
  }
  killTree(s.p.pid); // the whole tree: the shell AND the agent inside it
  try { s.p.kill(); } catch { /* onExit cleans up */ }
  return true;
}

export function killAllPtys() {
  for (const id of sessions.keys()) killPty(id);
  for (const s of remoteSessions.values()) killPty(s.id, s.connection);
  saveLive();
}

function wire(s, ws) {
  s.detachedAt = null;
  s.ws = ws;
  ws.on('message', (m) => {
    try {
      const j = JSON.parse(m.toString());
      if (j.t === 'i') s.p.write(j.d);
      else if (j.t === 'r' && j.cols > 0 && j.rows > 0) {
        if (s.connection) s.p.setWindow(j.rows, j.cols, 0, 0);
        else s.p.resize(j.cols, j.rows);
        try { s.shadow?.resize(j.cols, j.rows); } catch { /* preview only */ }
      }
    } catch { /* ignore malformed frames */ }
  });
  ws.on('close', () => {
    if (s.ws === ws) detach(s);
  });
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const powershellQuote = (s) => String(s).replace(/'/g, "''");

function remoteShell(record, cwd, cb) {
  const ps = `try { Set-Location -LiteralPath '${powershellQuote(cwd)}' -ErrorAction Stop } catch { Write-Error $_; exit 1 }`;
  const command = record.platform === 'win32'
    ? `powershell.exe -NoLogo -NoExit -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`
    : `cd -- ${shQuote(cwd)} && exec "\${SHELL:-/bin/sh}" -il`;
  try {
    record.client.exec(command, {
      pty: { term: 'xterm-256color', cols: 100, rows: 30, width: 0, height: 0 },
    }, cb);
  } catch (error) {
    cb(error);
  }
}

export function attachPty(server, allowedHosts, getRemote = () => undefined) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (
      url.pathname !== '/ws/pty' ||
      !allowedHosts.has(req.headers.host ?? '') ||
      url.searchParams.get('token') !== TOKEN
    ) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const connection = url.searchParams.get('connection') || undefined;
      const remote = connection ? getRemote(connection) : undefined;
      if (connection && !remote) {
        ws.send(ctl({ gone: true, error: 'SSH connection unavailable' }));
        ws.close();
        return;
      }
      // ---- (re-)attach to a surviving pty; steal=1 takes it from a live holder ----
      const attach = url.searchParams.get('attach');
      if (attach) {
        const s = sessionOf(attach, connection);
        if (!s) {
          ws.send(ctl({ gone: true }));
          ws.close();
          return;
        }
        if (s.ws) {
          if (url.searchParams.get('steal') !== '1') {
            ws.send(ctl({ busy: true }));
            ws.close();
            return;
          }
          // the previous holder keeps its replay view; only the terminal moves
          const old = s.ws;
          s.ws = null;
          try { old.send(ctl({ taken: true })); old.close(); } catch { /* already gone */ }
        }
        ws.send(ctl({ ptyId: s.id, attached: true }));
        for (const chunk of s.buffer) ws.send(chunk);
        wire(s, ws);
        return;
      }

      // ---- fresh session ----
      const tool = url.searchParams.get('tool') ?? '_';
      const cwdParam = url.searchParams.get('cwd');
      if (remote) {
        const cwd = cwdParam || remote.home || '.';
        remoteShell(remote, cwd, (err, p) => {
          if (err || !p) {
            if (ws.readyState === 1) {
              ws.send(`\r\nfailed to start remote shell: ${err?.message ?? 'unknown error'}\r\n`);
              ws.close();
            }
            return;
          }
          if (ws.readyState !== 1) {
            try { p.close(); } catch { /* client left before SSH opened */ }
            return;
          }
          p.setEncoding?.('utf8');
          p.stderr?.setEncoding?.('utf8');
          const s = {
            id: crypto.randomBytes(8).toString('hex'), p, buffer: [], size: 0, ws: null,
            connection, tool, cwd, created: Date.now(), session: null, title: '',
            shadow: new ShadowTerminal({ cols: 100, rows: 30, scrollback: 20, allowProposedApi: true }),
          };
          try { s.shadow.onTitleChange((t) => { s.title = t; }); } catch { /* preview only */ }
          remoteSessions.set(remoteKey(connection, s.id), s);
          if (tool !== '_' && /^[\w.-]+$/.test(tool)) setTimeout(() => { try { p.write(tool + '\r'); } catch { /* ended */ } }, 600);
          const onData = (d) => {
            s.buffer.push(d);
            s.size += typeof d === 'string' ? Buffer.byteLength(d) : d.length;
            while (s.size > BUFFER_CAP && s.buffer.length > 1) {
              const old = s.buffer.shift();
              s.size -= typeof old === 'string' ? Buffer.byteLength(old) : old.length;
            }
            try { s.shadow.write(d); } catch { /* preview only */ }
            if (s.ws?.readyState === 1) s.ws.send(d);
          };
          let ended = false;
          const end = (error) => {
            if (ended) return;
            ended = true;
            if (s.ws?.readyState === 1) {
              if (error) s.ws.send(`\r\nSSH terminal error: ${error.message ?? error}\r\n`);
              s.ws.send(ctl({ exit: true }));
              s.ws.close();
            }
            try { s.shadow?.dispose(); } catch { /* already gone */ }
            remoteSessions.delete(remoteKey(connection, s.id));
          };
          p.on('data', onData);
          p.stderr?.on('data', onData);
          p.once('error', end);
          p.once('close', () => end());
          if (ws.readyState === 1) {
            ws.send(ctl({ ptyId: s.id }));
            wire(s, ws);
          } else {
            remoteSessions.delete(remoteKey(connection, s.id));
            try { s.shadow?.dispose(); } catch { /* already gone */ }
            try { p.close(); } catch { /* client left during setup */ }
          }
        });
        return;
      }
      let cwd = os.homedir();
      try {
        if (cwdParam && fs.statSync(cwdParam).isDirectory()) cwd = cwdParam;
      } catch { /* stale/bad path from an old transcript; home is fine */ }
      let p;
      try {
        p = pty.spawn(SHELL, [], {
          name: 'xterm-256color',
          cols: 100,
          rows: 30,
          cwd,
          env: sanitizedEnv(),
          // modern conpty (ships in the prebuilds), not the in-box conhost:
          // the old one eats TUI scrollback and mouse passthrough, so wheel
          // scrolling in claude/codex sessions is dead without this
          ...(WIN ? { useConptyDll: true } : {}),
        });
      } catch (e) {
        ws.send(`\r\nfailed to start ${SHELL}: ${e.message}\r\n`);
        ws.close();
        return;
      }
      const s = {
        id: crypto.randomBytes(8).toString('hex'), p, buffer: [], size: 0, ws: null,
        tool, cwd, created: Date.now(), session: null, title: '',
        shadow: new ShadowTerminal({ cols: 100, rows: 30, scrollback: 20, allowProposedApi: true }),
      };
      // agents announce themselves in the terminal title (OSC); the shadow
      // parses it anyway, and the title is how a pty maps to its session
      try { s.shadow.onTitleChange((t) => { s.title = t; }); } catch { /* preview only */ }
      sessions.set(s.id, s);
      saveLive();
      ws.send(ctl({ ptyId: s.id }));

      // launch the picked tool inside the shell so PATH/shims resolve the
      // same way they do for the user; '_' stays a bare shell
      if (tool !== '_' && /^[\w.-]+$/.test(tool)) {
        setTimeout(() => p.write(tool + '\r'), 600);
      }
      p.onData((d) => {
        s.buffer.push(d);
        s.size += d.length;
        while (s.size > BUFFER_CAP && s.buffer.length > 1) s.size -= s.buffer.shift().length;
        try { s.shadow.write(d); } catch { /* preview only */ }
        if (s.ws?.readyState === 1) s.ws.send(d);
      });
      p.onExit(() => {
        if (s.ws?.readyState === 1) {
          s.ws.send(ctl({ exit: true }));
          s.ws.close();
        }
        try { s.shadow?.dispose(); } catch { /* already gone */ }
        sessions.delete(s.id);
        saveLive();
      });
      wire(s, ws);
    });
  });
}
