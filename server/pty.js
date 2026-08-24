// Live terminal hosting: websocket <-> node-pty. The UI opens /ws/pty with a
// per-boot token and an optional tool to launch inside the shell.
//
// PTYs survive their websocket: on disconnect (page reload, HMR full reload)
// the shell stays alive buffering output, and the page re-attaches with
// ?attach=<ptyId>. Control frames to the client are a \x00 prefix + JSON;
// everything else is raw terminal data.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import pty from '@lydell/node-pty';
import headless from '@xterm/headless';

// server-side VT interpreter: each PTY keeps a "shadow screen" so previews
// show true terminal state (TUIs included), with no client attached
const ShadowTerminal = headless.Terminal ?? headless.default?.Terminal;

export const TOKEN = crypto.randomBytes(16).toString('hex');

const WIN = process.platform === 'win32';
// the agent CLIs McFly knows how to launch; ssh.js probes remote hosts for the
// same list, so it lives in one place
export const AGENT_TOOLS = ['claude', 'codex', 'cursor-agent', 'agy', 'pi', 'opencode', 'aider', 'gemini', 'goose'];
const BUFFER_CAP = 256 * 1024;
const INBOX_CAP = 100;
const INBOX_BYTES_CAP = 1024 * 1024;

export const hasTerminalControls = (value) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(String(value));

export function toolPath(name, { platform = process.platform, lookup = execFileSync, exists = fs.existsSync } = {}) {
  const win = platform === 'win32';
  try {
    const found = lookup(win ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).filter(Boolean);
    if (!win) return found[0];
    const first = found.find((file) => /\.(?:com|exe|cmd|bat|ps1)$/i.test(file)) ?? found[0];
    const ps1 = first?.replace(/\.cmd$/i, '.ps1');
    return ps1 !== first && exists(ps1) ? ps1 : first;
  } catch {
    return null;
  }
}

const which = (name) => !!toolPath(name);

const SHELL = WIN ? (which('pwsh') ? 'pwsh.exe' : 'powershell.exe') : process.env.SHELL || 'bash';

let tools; // detected once, first request
// Extra CLI flags per tool, from ~/.mcfly/settings.json ({"flags":{"claude":
// "--model opus"}}). Read at launch so a settings change applies to the next
// terminal without a restart. Control characters are stripped — the launch
// line is TYPED into the shell, so a stray newline would run half a command.
export function toolFlags(tool) {
  try {
    const file = path.join(os.homedir(), '.mcfly', 'settings.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))?.flags?.[tool];
    // eslint-disable-next-line no-control-regex
    const clean = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
    return clean ? ` ${clean}` : '';
  } catch { return ''; }
}

export function detectTools() {
  tools ??= AGENT_TOOLS.filter(which);
  return tools;
}

// VS Code, for handing a project folder over. Detected once, like the agent
// CLIs; the launcher is fire-and-forget so a slow editor never blocks a request.
let editor;
export function hasEditor() {
  editor ??= which('code');
  return editor;
}
export function openInEditor(dir) {
  // .cmd on Windows needs a shell; detached+unref so it outlives this request
  const cmd = WIN ? 'code.cmd' : 'code';
  const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore', shell: WIN, windowsHide: true });
  child.unref();
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

// ptyId -> { p, buffer, ws, tool, cwd, created, session, relayEnabled }
const sessions = new Map();
// SSH PTYs are channels owned by this local McFly process. They need the
// connection in their identity because two hosts can produce the same id.
const remoteSessions = new Map();

const remoteKey = (connection, id) => `${connection}\0${id}`;
const sessionOf = (id, connection) => connection
  ? remoteSessions.get(remoteKey(connection, id))
  : sessions.get(id);

const ctl = (obj) => '\x00' + JSON.stringify(obj);
const peerIdOf = (s) => s.connection ? `${s.connection}:${s.id}` : s.id;

// Terminal output is appended to one string and trimmed from the front, not
// kept as a list of chunks: a fast-scrolling TUI produces thousands of small
// writes, and shifting an array of them is quadratic. It also makes reattach
// a single websocket frame instead of one per chunk.
// Terminal output is appended to one string and trimmed from the front, not
// kept as a list of chunks: a fast-scrolling TUI produces thousands of small
// writes, and shifting an array of them is quadratic. It also makes reattach
// a single websocket frame instead of one per chunk.
// ponytail: the shadow is fed unconditionally because it is also what parses
// the OSC title, and the title is how a pty maps to its session. Gating it on
// "someone is watching" needs the title read off the raw stream first.
function record(s, d) {
  s.buffer += d;
  if (s.buffer.length > BUFFER_CAP) s.buffer = s.buffer.slice(-BUFFER_CAP);
  try { s.shadow.write(d); } catch { /* preview only */ }
  if (s.ws?.readyState === 1) s.ws.send(d);
}

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
    relayEnabled: !!s.relayEnabled,
    screen: screens ? screenOf(s) : null,
    ...(s.connection ? { connection: s.connection } : {}),
  }));
}

const sessionAvailable = (s) => [s.session?.provider, s.session?.id, s.session?.pwd]
  .every((value) => typeof value === 'string' && value.trim());

const peerView = (s) => {
  const relayEnabled = !!s.relayEnabled;
  const available = sessionAvailable(s);
  return {
    id: peerIdOf(s),
    terminal_id: s.id,
    tool: s.tool,
    cwd: s.cwd,
    workspace: s.session?.pwd ?? null,
    title: s.title || null,
    session_id: s.session?.id ?? null,
    provider: s.session?.provider ?? null,
    relay_enabled: relayEnabled,
    session_available: available,
    messageable: relayEnabled && available,
    interactive: !relayEnabled,
    ...(s.connection ? { connection: s.connection } : {}),
  };
};

// MCP-facing registry. Unmessageable terminals stay visible so an agent can
// distinguish user-interactive peers from relays still waiting for discovery.
export function listPeers() {
  return [...sessions.values(), ...remoteSessions.values()].map(peerView);
}

export function setPtySession(ptyId, mapping, connection) {
  const s = sessionOf(ptyId, connection);
  if (!s) return false;
  s.session = mapping;
  return true;
}

export function setPtyRelay(ptyId, enabled, connection) {
  const s = sessionOf(ptyId, connection);
  if (!s || typeof enabled !== 'boolean') return false;
  s.relayEnabled = enabled;
  if (s.ws?.readyState === 1) s.ws.send(ctl({ relayEnabled: enabled }));
  return true;
}

function relayError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

const requireMessageable = (s) => {
  if (!s.relayEnabled) throw relayError('peer is interactive; ask the user to enable relay mode first', 409, 'PEER_INTERACTIVE');
  if (!sessionAvailable(s)) {
    throw relayError('peer relay is enabled, but its agent session is not available yet; wait for McFly to discover it', 409, 'PEER_SESSION_UNAVAILABLE');
  }
};

const peerOf = (id) => sessions.get(id)
  ?? [...remoteSessions.values()].find((s) => peerIdOf(s) === id);

const writeInput = (s, data, source) => {
  if (source === 'human' && s.relayEnabled) return false;
  s.p.write(data);
  return true;
};

export function sendPeerMessage(id, message, { inbox = false } = {}) {
  const s = peerOf(id);
  if (!s) return Promise.reject(relayError('peer not found', 404, 'PEER_NOT_FOUND'));
  if (typeof message !== 'string' || !message.trim()) return Promise.reject(relayError('message is required', 400, 'INVALID_MESSAGE'));
  if (Buffer.byteLength(message) > 128 * 1024) return Promise.reject(relayError('message is too large', 413, 'MESSAGE_TOO_LARGE'));
  if (hasTerminalControls(message)) {
    return Promise.reject(relayError('message contains terminal control characters', 400, 'INVALID_MESSAGE'));
  }
  if (inbox) {
    const queued = s.inbox ??= [];
    const bytes = queued.reduce((total, item) => total + Buffer.byteLength(item.message), 0);
    if (queued.length >= INBOX_CAP || bytes + Buffer.byteLength(message) > INBOX_BYTES_CAP) {
      return Promise.reject(relayError('peer inbox is full', 409, 'PEER_INBOX_FULL'));
    }
    const item = { id: crypto.randomUUID(), message, queued_at: new Date().toISOString() };
    queued.push(item);
    return Promise.resolve({ id, delivered: false, queued: true, message_id: item.id, peer: peerView(s) });
  }
  try { requireMessageable(s); } catch (error) { return Promise.reject(error); }
  const deliver = async () => {
    if (peerOf(id) !== s) throw relayError('peer not found', 404, 'PEER_NOT_FOUND');
    requireMessageable(s);
    const bracketed = !!s.shadow?.modes?.bracketedPasteMode;
    if (!bracketed && /[\r\n\t]/.test(message)) {
      throw relayError('peer does not support bracketed paste; multiline and tabbed messages cannot be delivered exactly', 409, 'BRACKETED_PASTE_REQUIRED');
    }
    if (bracketed) {
      writeInput(s, `\x1b[200~${message}\x1b[201~`, 'relay');
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (peerOf(id) !== s) throw relayError('peer not found', 404, 'PEER_NOT_FOUND');
      requireMessageable(s);
      writeInput(s, '\r', 'relay');
    } else writeInput(s, `${message}\r`, 'relay');
    return { id, delivered: true, queued: false, bracketed, peer: peerView(s) };
  };
  const delivered = (s.relayQueue ?? Promise.resolve()).then(deliver);
  s.relayQueue = delivered.catch(() => {});
  return delivered;
}

export function pullPeerInbox(id) {
  const s = peerOf(id);
  if (!s) throw relayError('peer not found', 404, 'PEER_NOT_FOUND');
  return { id, messages: s.inbox?.splice(0) ?? [], peer: peerView(s) };
}

// tmux semantics: detached sessions persist until the process exits or an
// explicit kill — no grace reaper
function detach(s) {
  s.ws = null;
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
  s.ws = ws;
  ws.on('message', (m) => {
    try {
      const j = JSON.parse(m.toString());
      if (j.t === 'i' && !writeInput(s, j.d, 'human')) ws.send(ctl({ inputBlocked: true, relayEnabled: true }));
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
// the ESCAPED BODY of a PowerShell single-quoted string, without the quotes —
// remote-data.js has a same-named helper that returns the quotes too
const powershellBody = (s) => String(s).replace(/'/g, "''");

function localPty(cwd, tool, line, relayEnabled = false, ws = null, env = {}) {
  const p = pty.spawn(SHELL, [], {
    name: 'xterm-256color', cols: 100, rows: 30, cwd, env: { ...sanitizedEnv(), ...env },
    ...(WIN ? { useConptyDll: true } : {}),
  });
  const s = {
    id: crypto.randomBytes(8).toString('hex'), p, buffer: '', ws: null,
    tool, cwd, created: Date.now(), session: null, title: '', relayEnabled,
    relayQueue: Promise.resolve(),
    shadow: new ShadowTerminal({ cols: 100, rows: 30, scrollback: 20, allowProposedApi: true }),
  };
  try { s.shadow.onTitleChange((t) => { s.title = t; }); } catch { /* preview only */ }
  sessions.set(s.id, s);
  saveLive();
  if (ws?.readyState === 1) {
    ws.send(ctl({ ptyId: s.id, relayEnabled }));
    wire(s, ws);
  }
  if (line) setTimeout(() => { try { p.write(`${line}\r`); } catch { /* ended */ } }, 600);
  p.onData((d) => record(s, d));
  p.onExit(() => {
    if (s.ws?.readyState === 1) {
      s.ws.send(ctl({ exit: true }));
      s.ws.close();
    }
    try { s.shadow?.dispose(); } catch { /* already gone */ }
    sessions.delete(s.id);
    saveLive();
  });
  return s;
}

const shellQuote = WIN ? (value) => `'${powershellBody(value)}'` : shQuote;

// Programmatic peers use the exact same PTY registry as UI-launched terminals.
// The prompt is shell-quoted and relay starts enabled, so no human keystroke can
// interleave with later MCP messages.
export function launchAgentPty(tool, cwd, args, prompt) {
  if (hasTerminalControls(prompt)) throw new Error('prompt contains terminal control characters');
  const promptArg = WIN ? '$env:MCFLY_AGENT_PROMPT' : '"$MCFLY_AGENT_PROMPT"';
  const line = [tool + toolFlags(tool), ...args.map(shellQuote), promptArg].join(' ');
  return peerView(localPty(cwd, tool, line, true, null, { MCFLY_AGENT_PROMPT: prompt }));
}

function remoteShell(record, cwd, cb) {
  const ps = `try { Set-Location -LiteralPath '${powershellBody(cwd)}' -ErrorAction Stop } catch { Write-Error $_; exit 1 }`;
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
        ws.send(ctl({ ptyId: s.id, attached: true, relayEnabled: !!s.relayEnabled }));
        if (s.buffer) ws.send(s.buffer);
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
            id: crypto.randomBytes(8).toString('hex'), p, buffer: '', ws: null,
            connection, tool, cwd, created: Date.now(), session: null, title: '',
            relayEnabled: false, relayQueue: Promise.resolve(),
            shadow: new ShadowTerminal({ cols: 100, rows: 30, scrollback: 20, allowProposedApi: true }),
          };
          try { s.shadow.onTitleChange((t) => { s.title = t; }); } catch { /* preview only */ }
          remoteSessions.set(remoteKey(connection, s.id), s);
          if (tool !== '_' && /^[\w.-]+$/.test(tool)) setTimeout(() => { try { p.write(tool + toolFlags(tool) + '\r'); } catch { /* ended */ } }, 600);
          const onData = (d) => record(s, d);
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
            ws.send(ctl({ ptyId: s.id, relayEnabled: false }));
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
      try {
        // creation is shared with MCP-launched relay peers; UI terminals start
        // with their websocket already attached.
        const line = tool !== '_' && /^[\w.-]+$/.test(tool) ? tool + toolFlags(tool) : '';
        localPty(cwd, tool, line, false, ws);
        return;
      } catch (e) {
        ws.send(`\r\nfailed to start ${SHELL}: ${e.message}\r\n`);
        ws.close();
        return;
      }
    });
  });
}
