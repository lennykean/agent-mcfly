// Live terminal hosting: websocket <-> node-pty. The UI opens /ws/pty with a
// per-boot token and an optional tool to launch inside the shell.
//
// PTYs survive their websocket: on disconnect (page reload, HMR full reload)
// the shell stays alive for a grace window buffering output, and the page
// re-attaches with ?attach=<ptyId>. Control frames to the client are a \x00
// prefix + JSON; everything else is raw terminal data.
import os from 'node:os';
import fs from 'node:fs';
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

// ptyId -> { p, buffer: string[], size, ws, reap, tool, cwd, created, session }
const sessions = new Map();

const ctl = (obj) => '\x00' + JSON.stringify(obj);

// "screenshot": the shadow's full viewport — actual rendered terminal state,
// with dimensions so the client can scale it into a thumbnail
function screenOf(s) {
  try {
    const b = s.shadow.buffer.active;
    const rows = s.shadow.rows;
    const lines = [];
    for (let y = Math.max(0, b.length - rows); y < b.length; y++) {
      lines.push(b.getLine(y)?.translateToString(true) ?? '');
    }
    return { text: lines.join('\n'), cols: s.shadow.cols, rows };
  } catch {
    return null;
  }
}

// registry view for the live-terminal picker (agent tmux: list-sessions)
export function listPtys() {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    tool: s.tool,
    cwd: s.cwd,
    created: s.created,
    attached: !!s.ws,
    session: s.session ?? null, // { provider, id, pwd } once the hunter maps it
    screen: screenOf(s),
  }));
}

export function setPtySession(ptyId, mapping) {
  const s = sessions.get(ptyId);
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

export function killPty(id) {
  const s = sessions.get(id);
  if (!s) return false;
  try { s.p.kill(); } catch { /* onExit cleans up */ }
  return true;
}

export function killAllPtys() {
  for (const id of sessions.keys()) killPty(id);
}

function wire(s, ws) {
  s.detachedAt = null;
  s.ws = ws;
  ws.on('message', (m) => {
    try {
      const j = JSON.parse(m.toString());
      if (j.t === 'i') s.p.write(j.d);
      else if (j.t === 'r' && j.cols > 0 && j.rows > 0) {
        s.p.resize(j.cols, j.rows);
        try { s.shadow?.resize(j.cols, j.rows); } catch { /* preview only */ }
      }
    } catch { /* ignore malformed frames */ }
  });
  ws.on('close', () => {
    if (s.ws === ws) detach(s);
  });
}

export function attachPty(server, allowedHosts) {
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
      // ---- (re-)attach to a surviving pty; steal=1 takes it from a live holder ----
      const attach = url.searchParams.get('attach');
      if (attach) {
        const s = sessions.get(attach);
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
        if (s.buffer.length) ws.send(s.buffer.join(''));
        wire(s, ws);
        return;
      }

      // ---- fresh session ----
      const tool = url.searchParams.get('tool') ?? '_';
      const cwdParam = url.searchParams.get('cwd');
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
        });
      } catch (e) {
        ws.send(`\r\nfailed to start ${SHELL}: ${e.message}\r\n`);
        ws.close();
        return;
      }
      const s = {
        id: crypto.randomBytes(8).toString('hex'), p, buffer: [], size: 0, ws: null,
        tool, cwd, created: Date.now(), session: null,
        shadow: new ShadowTerminal({ cols: 100, rows: 30, scrollback: 20, allowProposedApi: true }),
      };
      sessions.set(s.id, s);
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
      });
      wire(s, ws);
    });
  });
}
