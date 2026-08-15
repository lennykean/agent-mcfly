import { useEffect, useRef, useState } from 'react';
import { Terminal as Xterm, type FontWeight } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { emitTerminalSelection, updateSnapshot } from '../lib/workspace';
import { termReleasedChord } from '../lib/keys';
import { rgba } from '../lib/palette';

interface Config { tools: string[]; token: string; platform?: string }

export interface LivePty {
  id: string;
  tool: string;
  cwd: string;
  created: number;
  attached: boolean;
  session: { provider: string; id: string; pwd: string; label?: string } | null;
  screen?: { text: string; cols: number; rows: number } | null;
}

// VS Code dark terminal palette
const THEME = {
  background: '#181818',
  foreground: '#cccccc',
  cursor: '#cccccc',
  selectionBackground: '#264f78',
  black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
  blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
  brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b',
  brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6',
  brightCyan: '#29b8db', brightWhite: '#e5e5e5',
};

// minimap: render the screen at natural size, CSS-scale into a portrait tile
const CHAR_W = 6.02;
const LINE_H = 13;
const TILE_W = 168;
const TILE_H = 300;

function MiniScreen({ screen }: { screen: { text: string; cols: number; rows: number } }) {
  const w = Math.max(1, screen.cols) * CHAR_W;
  const h = Math.max(1, screen.rows) * LINE_H;
  const scale = Math.min(TILE_W / w, TILE_H / h);
  return (
    <div className="miniClip" style={{ height: h * scale }}>
      <pre className="miniScreen" style={{ transform: `scale(${scale})`, width: w, height: h }}>
        {screen.text}
      </pre>
    </div>
  );
}

// file references in terminal output: absolute or separator-containing paths,
// or bare filenames when a :line follows; optional trailing :line(:col)
const FILE_REF = /(?:[A-Za-z]:[\\/][\w.\\/-]+|[\\/]?[\w.-]+(?:[\\/][\w.-]+)+|[\w-]+\.[A-Za-z]\w{0,7}(?=:\d))(?::\d+(?::\d+)?)?/g;

function parseFileRef(text: string): { path: string; line?: number } | null {
  const m = text.match(/^(.*?)(?::(\d+)(?::\d+)?)?$/);
  if (!m || !m[1]) return null;
  // require an extension-ish tail or a separator so prose doesn't linkify
  if (!/[\\/]/.test(m[1]) && !/\.\w+$/.test(m[1])) return null;
  return { path: m[1], line: m[2] ? Number(m[2]) : undefined };
}

// A live PTY session: xterm.js <-> websocket <-> node-pty on the server.
// Control frames from the server are \x00-prefixed JSON; everything else is
// terminal data. 'taken' = another window stole the terminal (tmux attach -d).
// Stays mounted while hidden so backgrounded terminals keep their sockets.
function PtySession({ tool, token, cwd, platform, attachId, steal, visible, onPtyId, onExit, onTakeBack, onOpenFileRef }: {
  tool: string; token: string; cwd?: string; platform?: string; attachId?: string; steal?: boolean; visible: boolean;
  onPtyId: (id: string) => void; onExit: () => void; onTakeBack: () => void;
  onOpenFileRef?: (path: string, line?: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Xterm | null>(null);
  const [status, setStatus] = useState<'connecting' | 'up' | 'closed' | 'taken'>('connecting');
  // the PTY this session OWNS, learned from the server's control frame: a
  // reconnect (any effect re-run) must re-attach to it, never spawn fresh
  const myPty = useRef<string | undefined>(attachId);
  const onPtyIdRef = useRef(onPtyId);
  onPtyIdRef.current = onPtyId;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onOpenFileRefRef = useRef(onOpenFileRef);
  onOpenFileRefRef.current = onOpenFileRef;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Xterm({
      fontSize: 14,
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      // 350 is valid CSS the xterm types don't model; user-approved look
      fontWeight: '350' as FontWeight, // Cascadia regular blooms on dark backgrounds
      fontWeightBold: '600', // 700 smears glyphs together at terminal sizes
      lineHeight: 1.15,
      letterSpacing: 0,
      cursorBlink: true,
      theme: THEME,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      term.loadAddon(new WebglAddon()); // GPU renderer: crisp cells, like VS Code
    } catch { /* WebGL unavailable; DOM renderer still works */ }
    fit.fit();

    // Ctrl+V: xterm would encode it as ^V for the pty, swallowing the paste.
    // Decline to handle it so the browser's native paste reaches xterm's
    // textarea instead (VS Code intercepts the same way). Ctrl+Shift+V
    // already pastes natively. App chords (tab jumps, terminal switch/new)
    // are declined the same way: the window handler owns them.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && termReleasedChord(e)) return false; // pure check: never arms sequences
      return !(e.type === 'keydown' && e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'v');
    });

    // image paste: no text for xterm to insert, so route by tool.
    // claude reads the OS clipboard itself — and the browser's clipboard IS
    // the server's clipboard (loopback only) — so its paste chord gives a
    // native [Image #1]. Everything else gets the drag-and-drop flow: bytes
    // to a temp file server-side, quoted path typed into the terminal.
    const onPaste = (e: ClipboardEvent) => {
      const cd = e.clipboardData;
      if (!cd || cd.getData('text/plain') || !cd.files.length) return; // text: xterm's business
      const file = cd.files[0];
      if (!file.type.startsWith('image/')) return;
      e.preventDefault();
      e.stopPropagation();
      if (tool === 'claude') {
        const chord = (platform ?? 'win32') === 'win32' ? '\x1bv' : '\x16'; // Alt+V / Ctrl+V
        if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'i', d: chord }));
        return;
      }
      void file.arrayBuffer()
        .then((buf) => fetch('/api/paste-image', { method: 'POST', headers: { 'Content-Type': file.type }, body: buf }))
        .then((r) => r.json())
        .then((d: { path?: string }) => {
          if (d.path && ws?.readyState === 1) ws.send(JSON.stringify({ t: 'i', d: `"${d.path}" ` }));
        })
        .catch(() => { /* paste is best-effort */ });
    };
    host.addEventListener('paste', onPaste, true);

    // report terminal selections for workspace_state (debounced)
    let selTimer: number | undefined;
    const selSub = term.onSelectionChange(() => {
      clearTimeout(selTimer);
      selTimer = window.setTimeout(() => emitTerminalSelection(tool, term.getSelection()), 600);
    });

    // clickable file:line references -> open in the editor at that line
    const linkProvider = term.registerLinkProvider({
      provideLinks(y, callback) {
        const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? '';
        const links = [];
        for (const m of text.matchAll(FILE_REF)) {
          const ref = parseFileRef(m[0]);
          if (!ref) continue;
          links.push({
            range: { start: { x: m.index + 1, y }, end: { x: m.index + m[0].length, y } },
            text: m[0],
            activate: () => onOpenFileRefRef.current?.(ref.path, ref.line),
          });
        }
        callback(links.length ? links : undefined);
      },
    });

    let ws: WebSocket | null = null;
    let dataSub: { dispose(): void } | null = null;

    // deferred connect: StrictMode's throwaway first mount must never reach
    // the server, or every terminal start leaves a ghost PTY
    const timer = setTimeout(() => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      // re-runs attach to the pty we already own (self-reattach steals: the
      // dying socket is our own); only a truly fresh session spawns one
      const attach = myPty.current ?? attachId;
      const doSteal = attach && attach !== attachId ? true : steal;
      const sock = new WebSocket(
        `${proto}://${location.host}/ws/pty?token=${token}&tool=${encodeURIComponent(tool)}&cwd=${encodeURIComponent(cwd ?? '')}`
        + (attach ? `&attach=${attach}` : '')
        + (attach && doSteal ? '&steal=1' : ''),
      );
      ws = sock;
      sock.onopen = () => {
        setStatus('up');
        sock.send(JSON.stringify({ t: 'r', cols: term.cols, rows: term.rows }));
        term.focus();
      };
      sock.onmessage = (e) => {
        if (typeof e.data === 'string' && e.data.charCodeAt(0) === 0) {
          try {
            const c = JSON.parse(e.data.slice(1));
            if (c.ptyId) { myPty.current = c.ptyId; onPtyIdRef.current(c.ptyId); }
            if (c.exit || c.gone) onExitRef.current();
            if (c.busy || c.taken) setStatus('taken'); // take-back stays possible
          } catch { /* not a control frame after all */ }
          return;
        }
        term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer));
      };
      sock.onclose = () => setStatus((s) => (s === 'taken' ? s : 'closed'));
      dataSub = term.onData((d) => {
        if (sock.readyState === 1) sock.send(JSON.stringify({ t: 'i', d }));
      });
    }, 150);

    const ro = new ResizeObserver(() => {
      fit.fit();
      if (ws?.readyState === 1 && term.cols > 1 && term.rows > 1) {
        ws.send(JSON.stringify({ t: 'r', cols: term.cols, rows: term.rows }));
      }
    });
    ro.observe(host);

    return () => {
      // teardown detaches; the PTY lives on server-side. Null the handlers —
      // this socket's async close must not stamp state on a successor.
      clearTimeout(timer);
      if (ws) {
        ws.onclose = null;
        ws.onmessage = null;
        ws.close();
      }
      ro.disconnect();
      dataSub?.dispose();
      linkProvider.dispose();
      host.removeEventListener('paste', onPaste, true);
      clearTimeout(selTimer);
      selSub.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [tool, token, cwd, platform, attachId, steal]);

  // focus when this terminal's tab is revealed
  useEffect(() => {
    if (visible) termRef.current?.focus();
  }, [visible]);

  return (
    <div className="ptySession">
      <div className="ptyHost" ref={hostRef} />
      {status === 'closed' && (
        <div className="ptyClosed">
          session ended
          <button onClick={onExit}>close</button>
        </div>
      )}
      {status === 'taken' && (
        <div className="ptyClosed">
          terminal is live in another window
          <div className="ptyTakenActions">
            <button onClick={onTakeBack}>take it back</button>
            <button onClick={onExit}>close</button>
          </div>
        </div>
      )}
    </div>
  );
}

interface TermEntry {
  key: number;
  tool: string;
  // the folder this terminal LAUNCHED in, frozen at creation — the live cwd
  // prop follows the active workspace, and a prop change must never touch
  // an established socket (it would respawn fresh-started PTYs)
  cwd?: string;
  attachId?: string; // set when adopting an existing PTY
  steal?: boolean;
  nonce: number; // bump to force a fresh socket (take-back)
  ptyId?: string; // learned from the server's control frame
}

// LIVE TERMINAL pane: multiple terminals as tabs (tmux windows). Every
// terminal stays mounted while backgrounded; '+' opens the picker (attach an
// existing PTY from the gallery, or start a new tool in the open folder).
// Refresh detaches all (PTYs persist server-side; re-adopt via the gallery).
export interface TermCtl {
  // no dir: a new shell in the CURRENT terminal's project (fallback: the
  // active workspace). A dir targets that project (the folder-row icon).
  startNew: (dir?: string) => void;
  focusOrNext: (fromTerm: boolean) => void;
  cycle: (dir: 1 | -1) => void;
  confirmKill: () => void;
  // multi-root: reveal the terminal tab running a session, if one is open here
  showSession: (provider: string, id: string) => boolean;
}

// a root workspace whose session is open in the workbench — terminals tied
// to one get the green dot, the agent's name, and the root's color
export interface LinkedRoot { provider: string; id: string; label: string; color?: string; active: boolean }

export function LiveTerm({ cwd, projects, currentSession, linkedRoots, onToolStart, onPtyId, onOpenFileRef, onFollowSession, onFollowResolve, onActiveSession, ctl }: {
  cwd?: string;
  // distinct open project folders — with 2+, the picker asks WHICH one a
  // new terminal starts in (default: the active workspace's)
  projects?: string[];
  currentSession?: { provider: string; id: string } | null;
  linkedRoots?: LinkedRoot[];
  onToolStart?: (tool: string, dir?: string) => void;
  onPtyId?: (id: string, tool: string, fresh: boolean) => void;
  onOpenFileRef?: (path: string, line?: number) => void;
  onFollowSession?: (session: { provider: string; id: string; pwd: string }) => void;
  // ptyId rides along so a manually-picked session still TIES this terminal
  onFollowResolve?: (pty: { id: string; title?: string | null; cwd: string }) => void;
  // a USER terminal-tab switch, with the session that terminal is linked to
  // (null when unlinked) — the shell switches workbenches on it
  onActiveSession?: (session: LivePty['session']) => void;
  // keyboard chords reach in from the app: focus/cycle terminals, start new
  ctl?: React.MutableRefObject<TermCtl | null>;
}) {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string>();
  const [terms, setTerms] = useState<TermEntry[]>([]);
  const [active, setActive] = useState<number | null>(null); // null => picker
  const [ptys, setPtys] = useState<LivePty[]>([]);
  const [confirmSteal, setConfirmSteal] = useState<string>();
  const nextKey = useRef(1);

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setError('api unreachable'));
  }, []);

  // registry poll: feeds the gallery AND the tab badges (which terminal is
  // the live agent of the session being watched)
  useEffect(() => {
    const load = () =>
      fetch('/api/ptys')
        .then((r) => r.json())
        .then((d) => setPtys(Array.isArray(d) ? d : []))
        .catch(() => setPtys([]));
    void load();
    const t = setInterval(load, active === null ? 4000 : 8000);
    return () => clearInterval(t);
  }, [active]);

  const sessionOf = (ptyId?: string) => ptys.find((p) => p.id === ptyId)?.session ?? null;
  // the open root a terminal's session ties it to, if any
  const linkOf = (session: LivePty['session']) =>
    (session ? linkedRoots?.find((r) => r.provider === session.provider && r.id === session.id) : undefined);

  // workspace_state: which terminals exist, which is focused, whose session
  useEffect(() => {
    updateSnapshot({
      terminals: terms.map((e) => ({
        tool: e.tool,
        ptyId: e.ptyId ?? null,
        active: active === e.key,
        session: sessionOf(e.ptyId),
      })),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terms, active, ptys]);
  const isWatched = (session: LivePty['session']) =>
    !!session && !!currentSession
    && session.provider === currentSession.provider && session.id === currentSession.id;

  const addTerm = (entry: Omit<TermEntry, 'key' | 'nonce'>) => {
    const key = nextKey.current++;
    setTerms((t) => [...t, { ...entry, key, nonce: 0 }]);
    setActive(key);
    setConfirmSteal(undefined);
    return key;
  };

  // which project the picker starts tools in: sticky choice, defaulting to
  // the active workspace's folder
  const projectChoices = projects?.length ? projects : cwd ? [cwd] : [];
  const [startIn, setStartIn] = useState<string>();
  const effStart = startIn && projectChoices.includes(startIn) ? startIn
    : cwd && projectChoices.includes(cwd) ? cwd : projectChoices[0];

  const startNew = (tool: string, dir?: string) => {
    const at = dir ?? effStart ?? cwd;
    addTerm({ tool, cwd: at });
    onToolStart?.(tool, at);
  };
  // the tmux-style chord inherits the CURRENT terminal's project
  const dirOfCurrent = () => terms.find((t) => t.key === active)?.cwd ?? cwd;

  const adopt = (p: LivePty, doSteal: boolean) => {
    addTerm({ tool: p.tool, cwd: p.cwd, attachId: p.id, steal: doSteal, ptyId: p.id });
  };

  const removeTerm = (key: number) => {
    setTerms((t) => {
      const rest = t.filter((e) => e.key !== key);
      setActive((cur) => (cur === key ? (rest.at(-1)?.key ?? null) : cur));
      return rest;
    });
  };

  const killTerm = (key: number) => {
    const entry = terms.find((e) => e.key === key);
    if (entry?.ptyId) {
      void fetch('/api/pty-kill', { method: 'POST', body: JSON.stringify({ id: entry.ptyId }) });
    }
    removeTerm(key);
  };

  const takeBack = (key: number) => {
    setTerms((t) => t.map((e) => (
      e.key === key ? { ...e, attachId: e.ptyId ?? e.attachId, steal: true, nonce: e.nonce + 1 } : e
    )));
  };

  // every running PTY shows in the gallery — ones already open as tabs in
  // this window included; clicking those just switches to their tab
  const tabOf = (ptyId: string) => terms.find((e) => e.ptyId === ptyId);

  // the terminal chords: termNew starts a shell; termFocus focuses the
  // active terminal, and pressed again FROM a terminal it cycles the tabs
  useEffect(() => {
    if (!ctl) return;
    // keyboard tab switches are USER switches: report the landing terminal's
    // session, same as a click, so sync mode follows either way
    const goTo = (entry: TermEntry) => {
      setActive(entry.key);
      onActiveSession?.(sessionOf(entry.ptyId));
    };
    ctl.current = {
      startNew: (dir?: string) => startNew('_', dir ?? dirOfCurrent()),
      focusOrNext: (fromTerm: boolean) => {
        if (!terms.length) return; // the picker is already the view
        if (fromTerm && active !== null && terms.length > 1) {
          const i = terms.findIndex((t) => t.key === active);
          goTo(terms[(i + 1) % terms.length]);
        } else if (active === null) {
          goTo(terms[0]);
        }
      },
      cycle: (dir: 1 | -1) => {
        if (!terms.length) return;
        const i = Math.max(0, terms.findIndex((t) => t.key === active));
        goTo(terms[(i + dir + terms.length) % terms.length]);
      },
      confirmKill: () => { if (active !== null) setConfirmKill(active); },
      showSession: (provider: string, id: string) => {
        const hit = terms.find((e) => {
          const s = sessionOf(e.ptyId);
          return !!s && s.provider === provider && s.id === id;
        });
        if (hit) setActive(hit.key);
        return !!hit;
      },
    };
  });

  // tmux-style kill confirmation: an inline y/n strip, keys captured at the
  // window so the shell never sees them
  const [confirmKill, setConfirmKill] = useState<number | null>(null);
  useEffect(() => {
    if (confirmKill === null) return;
    const on = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key.toLowerCase() === 'y') {
        killTerm(confirmKill);
        setConfirmKill(null);
      } else if (e.key.toLowerCase() === 'n' || e.key === 'Escape') {
        setConfirmKill(null);
      }
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmKill]);

  return (
    <div className="livePane">
      {confirmKill !== null && (
        <div className="tmuxConfirm">
          kill terminal “{(() => {
            const t = terms.find((x) => x.key === confirmKill);
            return t ? (t.tool === '_' ? 'shell' : t.tool) : '?';
          })()}”? <b>y</b> / <b>n</b>
        </div>
      )}
      <div className="liveTabs">
        {terms.map((e) => {
          const sess = sessionOf(e.ptyId);
          const link = linkOf(sess);
          const label = link ? link.label : e.tool === '_' ? 'shell' : e.tool;
          return (
            <span
              key={e.key}
              className={`liveTab ${active === e.key ? 'active' : ''}`}
              style={link?.color ? { background: rgba(link.color, 0.22) } : undefined}
              title={label}
              onClick={() => { setActive(e.key); onActiveSession?.(sess); }}
            >
              {link
                ? <span className="liveDot" title={link.active ? "this terminal is running the session you're watching" : `linked to ${link.label}`} />
                : <span className="codicon codicon-terminal" />}
              <span className="liveTabLabel">{label}</span>
              <span
                className="codicon codicon-close liveTabClose"
                title="Detach (leave it running)"
                onClick={(ev) => { ev.stopPropagation(); removeTerm(e.key); }}
              />
            </span>
          );
        })}
        <span className={`liveTab plus ${active === null ? 'active' : ''}`} title="New / attach" onClick={() => setActive(null)}>
          <span className="codicon codicon-add" />
        </span>
        {active !== null && (() => {
          const pty = ptys.find((x) => x.id === terms.find((e) => e.key === active)?.ptyId);
          const sess = pty?.session ?? null;
          const same = isWatched(sess);
          return (
            <span className="liveTabActions">
              {sess && onFollowSession && (
                <button
                  disabled={same}
                  onClick={() => onFollowSession(sess)}
                  title={same ? "You're already watching this terminal's session" : "Open this terminal's session in the replayer"}
                >⏵ follow</button>
              )}
              {!sess && pty && onFollowResolve && (
                <button
                  onClick={() => onFollowResolve(pty)}
                  title="Find this terminal's session — follows it when the title settles on one, asks when it doesn't"
                >⏵ follow</button>
              )}
              <button onClick={() => removeTerm(active)} title="Detach: leave it running">⏏ detach</button>
              <button onClick={() => killTerm(active)} title="Kill the terminal">■ kill</button>
            </span>
          );
        })()}
      </div>

      {terms.map((e) => (
        <div key={e.key} className={active === e.key ? 'tabBody' : 'tabBody hiddenTab'}>
          {config && (
            <PtySession
              key={`${e.key}:${e.nonce}`}
              tool={e.tool}
              token={config.token}
              cwd={e.cwd ?? cwd}
              platform={config.platform}
              attachId={e.attachId}
              steal={e.steal}
              visible={active === e.key}
              onPtyId={(id) => {
                setTerms((t) => t.map((x) => (x.key === e.key ? { ...x, ptyId: id } : x)));
                // fresh = started here, not adopted/taken back — only fresh
                // starts may satisfy a session hunt
                onPtyId?.(id, e.tool, !e.attachId);
              }}
              onExit={() => removeTerm(e.key)}
              onTakeBack={() => takeBack(e.key)}
              onOpenFileRef={onOpenFileRef}
            />
          )}
        </div>
      ))}

      {active === null && (
        <div className="livePicker">
          {error && <div className="pickerError">{error}</div>}

          {ptys.length > 0 && (
            <>
              <div className="pickerTitle">
                attach a terminal
                {ptys.some((p) => !p.attached && !tabOf(p.id)) && (
                  <button
                    className="killDetached"
                    title="Kill every detached terminal (ones no window is using)"
                    onClick={() => {
                      const dead = ptys.filter((p) => !p.attached && !tabOf(p.id));
                      void Promise.all(dead.map((p) => fetch('/api/pty-kill', { method: 'POST', body: JSON.stringify({ id: p.id }) })))
                        .then(() => setPtys((cur) => cur.filter((x) => !dead.some((d) => d.id === x.id))));
                    }}
                  >✕ clean up detached</button>
                )}
              </div>
              <div className="liveGallery">
                {ptys.map((p) => {
                  const own = tabOf(p.id);
                  return (
                  <div
                    key={p.id}
                    className={`ptyTile ${p.attached && !own ? 'inUse' : ''} ${isWatched(p.session) ? 'watching' : ''}`}
                    onClick={() => {
                      if (own) { setActive(own.key); onActiveSession?.(p.session); }
                      else if (p.attached) setConfirmSteal(p.id);
                      else { adopt(p, false); onActiveSession?.(p.session); }
                    }}
                  >
                    <div className="tileHead">
                      {linkOf(p.session)
                        ? <span className="liveDot" title={isWatched(p.session) ? "running the session you're watching" : `linked to ${linkOf(p.session)?.label}`} />
                        : <span className="codicon codicon-terminal" />}
                      <span className="tileName">
                        {p.tool === '_' ? 'shell' : p.tool} · {p.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}
                      </span>
                      {isWatched(p.session) && <span className="tileBadge watchBadge">watching</span>}
                      <span className={`tileBadge ${p.attached && !own ? 'busy' : ''}`}>
                        {own ? 'this window' : p.attached ? 'in use' : 'detached'}
                      </span>
                      {!p.attached && (
                        <span
                          className="codicon codicon-close tileKill"
                          title="Kill this terminal"
                          onClick={(e) => {
                            e.stopPropagation();
                            void fetch('/api/pty-kill', { method: 'POST', body: JSON.stringify({ id: p.id }) })
                              .then(() => setPtys((cur) => cur.filter((x) => x.id !== p.id)));
                          }}
                        />
                      )}
                    </div>
                    {p.screen?.text?.trim() ? (
                      <MiniScreen screen={p.screen} />
                    ) : (
                      <div className="miniEmpty">no output yet</div>
                    )}
                    {p.session && (
                      <div className="tileSess" title={p.session.id}>
                        ▸ {p.session.label ?? p.session.id.split('/').pop()}
                      </div>
                    )}
                    <div className="tileMeta">{new Date(p.created).toLocaleString()}</div>
                    {confirmSteal === p.id && (
                      <div className="tileConfirm" onClick={(e) => e.stopPropagation()}>
                        live in another window — take the terminal?
                        <div>
                          <button onClick={() => adopt(p, true)}>yes</button>
                          <button onClick={() => setConfirmSteal(undefined)}>no</button>
                        </div>
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            </>
          )}

          <div className="pickerTitle">start a session</div>
          {effStart ? (
            <>
              {projectChoices.length > 1 && (
                <div className="startProjects">
                  {projectChoices.map((p) => (
                    <button
                      key={p}
                      className={`projChip ${effStart === p ? 'active' : ''}`}
                      title={p}
                      onClick={() => setStartIn(p)}
                    >
                      <span className="codicon codicon-folder" /> {p.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}
                    </button>
                  ))}
                </div>
              )}
              <div className="pickerHint">in {effStart}</div>
              {config?.tools.map((t) => (
                <button key={t} className="pickerTool" onClick={() => startNew(t)}>
                  {t === '_' ? '_ blank terminal' : `▸ ${t}`}
                </button>
              ))}
              {config && config.tools.length === 1 && (
                <div className="pickerHint">no agent CLIs found on PATH — blank shell only</div>
              )}
            </>
          ) : (
            <div className="pickerHint">open a folder first — new terminals start in it</div>
          )}
        </div>
      )}
    </div>
  );
}
