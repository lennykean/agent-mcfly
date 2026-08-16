import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal as Xterm, type FontWeight } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { emitTerminalSelection, updateSnapshot } from '../lib/workspace';
import { actionOf, termReleasedChord } from '../lib/keys';
import { rgba } from '../lib/palette';
import { withConnection } from '../lib/api';
import { sameTerminalProject, terminalProjectKey, terminalProjectScope, type TerminalProject } from '../lib/terminal-project';
import type { WorkspaceSource } from '../types';

interface Config { tools: string[]; token: string; platform?: string }

export interface LivePty {
  id: string;
  tool: string;
  cwd: string;
  created: number;
  attached: boolean;
  session: { provider: string; id: string; pwd: string; label?: string } | null;
  screen?: { text: string; cols: number; rows: number } | null;
  source?: WorkspaceSource;
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
function PtySession({ tool, token, cwd, source, reportScope, platform, attachId, steal, visible, focusArm, onPtyId, onExit, onTakeBack, onOpenFileRef }: {
  tool: string; token: string; cwd?: string; source?: WorkspaceSource; platform?: string; attachId?: string; steal?: boolean; visible: boolean;
  reportScope: string;
  // false while a reveal is PROGRAMMATIC (sync following a workspace
  // switch) — revealing must not steal focus from what the user is doing
  focusArm?: React.MutableRefObject<boolean>;
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
  const reportScopeRef = useRef(reportScope);
  reportScopeRef.current = reportScope;

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
      if (tool === 'claude' && !source) {
        const chord = (platform ?? 'win32') === 'win32' ? '\x1bv' : '\x16'; // Alt+V / Ctrl+V
        if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'i', d: chord }));
        return;
      }
      void file.arrayBuffer()
        .then((buf) => fetch(withConnection('/api/paste-image', source?.connection), { method: 'POST', headers: { 'Content-Type': file.type }, body: buf }))
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
      const scope = reportScopeRef.current;
      selTimer = window.setTimeout(() => emitTerminalSelection(scope, tool, term.getSelection()), 600);
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
        + (source ? `&connection=${encodeURIComponent(source.connection)}` : '')
        + (attach ? `&attach=${attach}` : '')
        + (attach && doSteal ? '&steal=1' : ''),
      );
      ws = sock;
      sock.onopen = () => {
        setStatus('up');
        sock.send(JSON.stringify({ t: 'r', cols: term.cols, rows: term.rows }));
      };
      sock.onmessage = (e) => {
        if (typeof e.data === 'string' && e.data.charCodeAt(0) === 0) {
          try {
            const c = JSON.parse(e.data.slice(1));
            if (c.ptyId) { myPty.current = c.ptyId; onPtyIdRef.current(c.ptyId); }
            if (c.exit) setStatus('closed');
            if (c.gone) onExitRef.current();
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
  }, [tool, token, cwd, source?.connection, platform, attachId, steal]);

  // focus when this terminal's tab is revealed BY THE USER (clicks, chords);
  // a sync-driven reveal keeps the user's focus where it is. The disarm is
  // CONSUMED here (exactly one reveal follows each disarm) — a timer could
  // re-arm before a slow render's effects run and let the steal through.
  useEffect(() => {
    if (!visible) return;
    if (focusArm && !focusArm.current) { focusArm.current = true; return; }
    termRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  source?: WorkspaceSource;
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
  // no dir: a new shell in the selected project. A dir targets that project
  // directly (the folder-row icon).
  startNew: (project?: TerminalProject) => void;
  focusProjects: () => void;
  focusOrNext: (fromTerm: boolean) => void;
  cycle: (dir: 1 | -1) => void;
  confirmKill: () => void;
  dropProject: (project: TerminalProject) => void;
  // multi-root: reveal the terminal tab running a session, if one is open here
  showSession: (provider: string, id: string, source?: WorkspaceSource) => boolean;
}

// a root workspace whose session is open in the workbench — terminals tied
// to one get the green dot, the agent's name, and the root's color
export interface LinkedRoot { provider: string; id: string; label: string; color?: string; active: boolean; source?: WorkspaceSource }

export function LiveTerm({ cwd, source, projects, currentSession, linkedRoots, onToolStart, onPtyId, onOpenFileRef, onFollowSession, onFollowResolve, onActiveSession, ctl }: {
  cwd?: string;
  source?: WorkspaceSource;
  // distinct open project folders; local and server PTYs add any surviving
  // folders that are no longer open in the workbench
  projects?: TerminalProject[];
  currentSession?: { provider: string; id: string; source?: WorkspaceSource } | null;
  linkedRoots?: LinkedRoot[];
  onToolStart?: (tool: string, project?: TerminalProject) => void;
  onPtyId?: (id: string, tool: string, fresh: boolean, project?: TerminalProject) => void;
  onOpenFileRef?: (path: string, line?: number, project?: TerminalProject) => void;
  onFollowSession?: (session: { provider: string; id: string; pwd: string }, source?: WorkspaceSource) => void;
  // ptyId rides along so a manually-picked session still TIES this terminal
  onFollowResolve?: (pty: { id: string; title?: string | null; cwd: string; source?: WorkspaceSource }) => void;
  // a USER terminal-tab switch, with the session that terminal is linked to
  // (null when unlinked) — the shell switches workbenches on it
  onActiveSession?: (session: LivePty['session'], source?: WorkspaceSource) => void;
  // keyboard chords reach in from the app: focus/cycle terminals, start new
  ctl?: React.MutableRefObject<TermCtl | null>;
}) {
  const [configs, setConfigs] = useState<Record<string, Config>>({});
  const [error, setError] = useState<string>();
  const [terms, setTerms] = useState<TermEntry[]>([]);
  const [active, setActive] = useState<number | null>(null); // null => picker
  const [ptys, setPtys] = useState<LivePty[]>([]);
  const [confirmSteal, setConfirmSteal] = useState<string>();
  const [project, setProject] = useState<TerminalProject | undefined>(cwd ? { cwd, source } : undefined);
  const [droppedProjects, setDroppedProjects] = useState<ReadonlySet<string>>(() => new Set());
  const nextKey = useRef(1);
  const paneRef = useRef<HTMLDivElement>(null);
  const projectTabsRef = useRef<HTMLDivElement>(null);
  const termTabsRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  // armed = a revealed terminal may take focus; sync-driven reveals disarm
  const focusArm = useRef(true);

  const currentProject = useMemo(() => cwd ? { cwd, source } : undefined, [cwd, source]);
  const sourceKey = (value?: WorkspaceSource) => value?.connection ?? '';
  const ptyKey = (id: string, value?: WorkspaceSource) => `${sourceKey(value)}\0${id}`;
  const seedSources = useMemo(() => {
    const out = new Map<string, WorkspaceSource | undefined>([['', undefined]]);
    for (const p of projects ?? []) out.set(sourceKey(p.source), p.source);
    if (source) out.set(source.connection, source);
    for (const t of terms) if (t.source) out.set(t.source.connection, t.source);
    return [...out.values()];
  }, [projects, source, terms]);

  useEffect(() => {
    const reopened = new Set([...(projects ?? []), ...(currentProject ? [currentProject] : [])].map(terminalProjectKey));
    setDroppedProjects((cur) => {
      if (![...cur].some((key) => reopened.has(key))) return cur;
      const next = new Set(cur);
      for (const key of reopened) next.delete(key);
      return next;
    });
  }, [projects, currentProject]);

  // registry poll: feeds the gallery AND the tab badges (which terminal is
  // the live agent of the session being watched)
  useEffect(() => {
    let stopped = false;
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      const sources = new Map(seedSources.map((item) => [sourceKey(item), item]));
      let liveConnections: Set<string> | undefined;
      try {
        const response = await fetch('/api/ssh/connections');
        const saved = response.ok ? await response.json() : undefined;
        if (Array.isArray(saved)) liveConnections = new Set(saved.map((item) => String(item?.id ?? '')).filter(Boolean));
        for (const item of Array.isArray(saved) ? saved : []) {
          if (item?.id) sources.set(item.id, {
            connection: item.id,
            host: item.host || item.id,
            port: Number(item.port) || 22,
          });
        }
      } catch { /* open projects still supply their connection */ }
      const batches = await Promise.all([...sources.values()].map(async (item) => {
        try {
          const [ptyResponse, configResponse] = await Promise.all([
            // thumbnails only when the gallery is showing (active === null)
            fetch(withConnection(active === null ? '/api/ptys?screens=1' : '/api/ptys', item?.connection)),
            fetch(withConnection('/api/config', item?.connection)),
          ]);
          if (!ptyResponse.ok || !configResponse.ok) throw new Error('unavailable');
          const [live, config] = await Promise.all([ptyResponse.json(), configResponse.json()]);
          return {
            key: sourceKey(item), config: config as Config,
            ptys: (Array.isArray(live) ? live : []).map((p: LivePty) => ({ ...p, source: item })),
          };
        } catch { return null; }
      }));
      if (!stopped) {
        const ok = batches.filter((batch) => batch !== null);
        setPtys(ok.flatMap((batch) => batch.ptys));
        setConfigs((cur) => Object.assign(
          {},
          Object.fromEntries(Object.entries(cur).filter(([key]) => !key || !liveConnections || liveConnections.has(key))),
          ...ok.map((batch) => ({ [batch.key]: batch.config })),
        ));
        if (liveConnections) {
          setTerms((cur) => {
            const next = cur.filter((term) => !term.source || liveConnections!.has(term.source.connection));
            // identity MUST survive a no-op sweep: `terms` feeds seedSources,
            // which is this effect's own dependency — handing back a fresh
            // array restarts the poll, which sweeps again, which restarts…
            // a self-feeding request storm that pegs the server
            if (next.length === cur.length) return cur;
            setActive((key) => key !== null && !next.some((term) => term.key === key) ? null : key);
            return next;
          });
          setProject((cur) => cur?.source && !liveConnections!.has(cur.source.connection) ? undefined : cur);
        }
        setError(ok.length ? undefined : 'api unreachable');
      }
      busy = false;
    };
    void load();
    const t = setInterval(load, active === null ? 4000 : 8000);
    return () => { stopped = true; clearInterval(t); };
  }, [active, seedSources]);

  const sessionOf = (ptyId?: string, value?: WorkspaceSource) =>
    ptys.find((p) => p.id === ptyId && sourceKey(p.source) === sourceKey(value))?.session ?? null;
  // the open root a terminal's session ties it to, if any
  const linkOf = (session: LivePty['session'], value?: WorkspaceSource) =>
    (session ? linkedRoots?.find((r) => r.provider === session.provider && r.id === session.id
      && sourceKey(r.source) === sourceKey(value)) : undefined);

  const isWatched = (session: LivePty['session'], value?: WorkspaceSource) =>
    !!session && !!currentSession
    && sourceKey(value) === sourceKey(currentSession.source)
    && session.provider === currentSession.provider && session.id === currentSession.id;

  const projectChoices = useMemo(() => {
    const seen = new Set<string>();
    const out: TerminalProject[] = [];
    const choices = [
      ...(projects ?? []), ...(currentProject ? [currentProject] : []),
      ...terms.flatMap((t) => t.cwd ? [{ cwd: t.cwd, source: t.source }] : []),
      ...ptys.flatMap((p) => p.cwd ? [{ cwd: p.cwd, source: p.source }] : []),
    ];
    for (const p of choices) {
      const key = terminalProjectKey(p);
      if (seen.has(key) || droppedProjects.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
    return out;
  }, [projects, currentProject, terms, ptys, droppedProjects]);
  const activeProject = projectChoices.find((p) => sameTerminalProject(p, project))
    ?? projectChoices.find((p) => sameTerminalProject(p, currentProject))
    ?? projectChoices[0];
  const scopedTerms = terms.filter((t) => t.cwd && sameTerminalProject({ cwd: t.cwd, source: t.source }, activeProject));
  const scopedPtys = ptys.filter((p) => sameTerminalProject({ cwd: p.cwd, source: p.source }, activeProject));
  const config = configs[sourceKey(activeProject?.source)];

  // Each project reports only its terminals; the shared terminal DOM happens
  // to sit inside one workbench, but must not relabel the other projects.
  useEffect(() => {
    for (const scope of projectChoices.length ? projectChoices : (currentProject ? [currentProject] : [])) {
      updateSnapshot(terminalProjectScope(scope), {
        terminals: terms.filter((e) => e.cwd && sameTerminalProject({ cwd: e.cwd, source: e.source }, scope)).map((e) => ({
          tool: e.tool,
          ptyId: e.ptyId ?? null,
          active: sameTerminalProject(scope, activeProject) && active === e.key,
          session: sessionOf(e.ptyId, e.source),
        })),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectChoices, activeProject, currentProject, terms, active, ptys]);

  const addTerm = (entry: Omit<TermEntry, 'key' | 'nonce'>) => {
    const key = nextKey.current++;
    setTerms((t) => [...t, { ...entry, key, nonce: 0 }]);
    if (entry.cwd) setProject({ cwd: entry.cwd, source: entry.source });
    setActive(key);
    setConfirmSteal(undefined);
    return key;
  };

  const startNew = (tool: string, target?: TerminalProject) => {
    const at = target ?? activeProject ?? currentProject;
    if (!at) { setActive(null); return; }
    addTerm({ tool, cwd: at.cwd, source: at.source });
    onToolStart?.(tool, at);
  };

  const adopt = (p: LivePty, doSteal: boolean) => {
    addTerm({ tool: p.tool, cwd: p.cwd, source: p.source, attachId: p.id, steal: doSteal, ptyId: p.id });
  };

  const removeTerm = (key: number) => {
    setTerms((t) => {
      const removed = t.find((e) => e.key === key);
      const rest = t.filter((e) => e.key !== key);
      const same = rest.filter((e) => e.cwd && removed?.cwd
        && sameTerminalProject({ cwd: e.cwd, source: e.source }, { cwd: removed.cwd, source: removed.source }));
      setActive((cur) => (cur === key ? (same.at(-1)?.key ?? null) : cur));
      return rest;
    });
  };

  const focusSoon = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(fn));
  const focusProjectTabs = (p = activeProject) => focusSoon(() => {
    const i = projectChoices.findIndex((x) => sameTerminalProject(x, p));
    (projectTabsRef.current?.querySelector(`[data-project-tab="${i}"]`) as HTMLElement | null)?.focus();
  });
  const focusTermTabs = (key: number | null = active) => focusSoon(() => {
    (termTabsRef.current?.querySelector(`[data-term-tab="${key ?? 'plus'}"]`) as HTMLElement | null)?.focus();
  });
  const focusTerminal = () => focusSoon(() => {
    (paneRef.current?.querySelector('.tabBody:not(.hiddenTab) .xterm-helper-textarea') as HTMLElement | null)?.focus();
  });
  const focusPicker = () => focusSoon(() => {
    ((pickerRef.current?.querySelector('[data-term-choice]') as HTMLElement | null) ?? pickerRef.current)?.focus();
  });
  const openPicker = () => {
    setActive(null);
    setConfirmSteal(undefined);
    focusPicker();
  };
  const selectProject = (p: TerminalProject) => {
    const next = terms.find((t) => t.cwd && sameTerminalProject({ cwd: t.cwd, source: t.source }, p));
    if (next && next.key !== active) focusArm.current = false;
    setProject(p);
    setActive(next?.key ?? null);
    setConfirmSteal(undefined);
  };

  // A workbench switch establishes the terminal context; manual project-tab
  // changes remain sticky until the active workbench changes again.
  useEffect(() => {
    if (currentProject && !sameTerminalProject(project, currentProject)) selectProject(currentProject);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, source?.connection]);

  const killTerm = (key: number) => {
    const entry = terms.find((e) => e.key === key);
    if (entry?.ptyId) {
      void fetch(withConnection('/api/pty-kill', entry.source?.connection), { method: 'POST', body: JSON.stringify({ id: entry.ptyId }) });
    }
    removeTerm(key);
  };

  const takeBack = (key: number) => {
    setTerms((t) => t.map((e) => (
      e.key === key ? { ...e, attachId: e.ptyId ?? e.attachId, steal: true, nonce: e.nonce + 1 } : e
    )));
  };

  // every running PTY in this project shows in its gallery — ones already
  // open as tabs in this window included; choosing those switches tabs
  const tabOf = (ptyId: string, value?: WorkspaceSource) =>
    terms.find((e) => e.ptyId === ptyId && sourceKey(e.source) === sourceKey(value));

  // the terminal chords: termNew starts a shell; termFocus focuses the
  // active terminal, and pressed again FROM a terminal it cycles the tabs
  useEffect(() => {
    if (!ctl) return;
    // keyboard tab switches are USER switches: report the landing terminal's
    // session, same as a click, so sync mode follows either way
    const goTo = (entry: TermEntry) => {
      if (entry.cwd) setProject({ cwd: entry.cwd, source: entry.source });
      setActive(entry.key);
      onActiveSession?.(sessionOf(entry.ptyId, entry.source), entry.source);
    };
    ctl.current = {
      startNew: (target?: TerminalProject) => startNew('_', target),
      focusProjects: () => focusProjectTabs(),
      focusOrNext: (fromTerm: boolean) => {
        if (!scopedTerms.length) { openPicker(); return; }
        if (fromTerm && active !== null && scopedTerms.length > 1) {
          const i = scopedTerms.findIndex((t) => t.key === active);
          goTo(scopedTerms[(Math.max(0, i) + 1) % scopedTerms.length]);
        } else if (active === null) {
          goTo(scopedTerms[0]);
        }
      },
      cycle: (dir: 1 | -1) => {
        if (!scopedTerms.length) return;
        const i = scopedTerms.findIndex((t) => t.key === active);
        const next = i < 0 ? (dir === 1 ? 0 : scopedTerms.length - 1)
          : (i + dir + scopedTerms.length) % scopedTerms.length;
        goTo(scopedTerms[next]);
      },
      confirmKill: () => { if (active !== null) setConfirmKill(active); },
      dropProject: (target: TerminalProject) => {
        const key = terminalProjectKey(target);
        setDroppedProjects((cur) => cur.has(key) ? cur : new Set(cur).add(key));
        setTerms((cur) => {
          const removed = cur.filter((term) => term.cwd
            && sameTerminalProject({ cwd: term.cwd, source: term.source }, target));
          const next = cur.filter((term) => !removed.includes(term));
          setActive((activeKey) => activeKey !== null && !next.some((term) => term.key === activeKey) ? null : activeKey);
          setConfirmKill((killKey) => killKey !== null && removed.some((term) => term.key === killKey) ? null : killKey);
          return next;
        });
        setConfirmSteal((stealKey) => stealKey && ptys.some((pty) => ptyKey(pty.id, pty.source) === stealKey
          && sameTerminalProject({ cwd: pty.cwd, source: pty.source }, target)) ? undefined : stealKey);
        setProject((cur) => sameTerminalProject(cur, target) ? undefined : cur);
        updateSnapshot(terminalProjectScope(target), { terminals: [] });
      },
      showSession: (provider: string, id: string, targetSource?: WorkspaceSource) => {
        const hit = terms.find((e) => {
          const s = sessionOf(e.ptyId, e.source);
          return sourceKey(e.source) === sourceKey(targetSource) && !!s && s.provider === provider && s.id === id;
        });
        if (hit && hit.key !== active) {
          // programmatic reveal: show the tab, do NOT steal focus — the
          // revealed session's effect consumes this and re-arms
          focusArm.current = false;
          if (hit.cwd) setProject({ cwd: hit.cwd, source: hit.source });
          setActive(hit.key);
        }
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

  const projectKeys = (e: React.KeyboardEvent) => {
    const action = actionOf(e, ['left', 'right', 'home', 'end', 'down', 'activate', 'select', 'dismiss']);
    if (!action || !projectChoices.length) return;
    e.preventDefault();
    e.stopPropagation();
    if (action === 'down' || action === 'activate' || action === 'select') {
      focusTermTabs();
      return;
    }
    if (action === 'dismiss') {
      (e.target as HTMLElement).blur();
      return;
    }
    const i = Math.max(0, projectChoices.findIndex((p) => sameTerminalProject(p, activeProject)));
    const next = action === 'home' ? 0 : action === 'end' ? projectChoices.length - 1
      : (i + (action === 'right' ? 1 : -1) + projectChoices.length) % projectChoices.length;
    selectProject(projectChoices[next]);
    focusProjectTabs(projectChoices[next]);
  };

  const termTabKeys = (e: React.KeyboardEvent) => {
    const action = actionOf(e, ['left', 'right', 'home', 'end', 'up', 'down', 'activate', 'select', 'dismiss']);
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (action === 'up' || action === 'dismiss') {
      focusProjectTabs();
      return;
    }
    if (action === 'down' || action === 'activate' || action === 'select') {
      if (active === null) openPicker();
      else focusTerminal();
      return;
    }
    const tabs: (number | null)[] = [...scopedTerms.map((t) => t.key), null];
    const i = Math.max(0, tabs.findIndex((key) => key === active));
    const next = action === 'home' ? 0 : action === 'end' ? tabs.length - 1
      : (i + (action === 'right' ? 1 : -1) + tabs.length) % tabs.length;
    const key = tabs[next];
    if (key !== null && key !== active) focusArm.current = false;
    setActive(key);
    if (key !== null) {
      const term = terms.find((t) => t.key === key);
      onActiveSession?.(sessionOf(term?.ptyId, term?.source), term?.source);
    }
    focusTermTabs(key);
  };

  const pickerKeys = (e: React.KeyboardEvent) => {
    const action = actionOf(e, ['left', 'right', 'up', 'down', 'home', 'end', 'dismiss']);
    if (!action) return;
    if (action === 'dismiss') {
      e.preventDefault();
      e.stopPropagation();
      setConfirmSteal(undefined);
      focusTermTabs(null);
      return;
    }
    const attach = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[data-term-choice="attach"]')];
    const start = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[data-term-choice="start"]')];
    const choice = (e.target as HTMLElement).closest<HTMLElement>('[data-term-choice]');
    if (!choice) {
      if (e.target !== e.currentTarget) return;
      const next = action === 'end' ? (start.at(-1) ?? attach.at(-1)) : (attach[0] ?? start[0]);
      if (action === 'up') focusTermTabs(null);
      else if (next) next.focus();
      else return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const group = choice.dataset.termChoice === 'attach' ? attach : start;
    const i = Math.max(0, group.indexOf(choice));
    let next: HTMLElement | undefined;
    if (choice.dataset.termChoice === 'attach') {
      if (action === 'up') { focusTermTabs(null); next = undefined; }
      else if (action === 'down') next = start[0];
      else if (action === 'home') next = attach[0];
      else if (action === 'end') next = attach.at(-1);
      else next = attach[(i + (action === 'right' ? 1 : -1) + attach.length) % attach.length];
    } else {
      if (action === 'up') {
        next = attach[0] ?? (i > 0 ? start[i - 1] : undefined);
        if (!next) focusTermTabs(null);
      }
      else if (action === 'down') next = start[Math.min(start.length - 1, i + 1)];
      else if (action === 'home') next = start[0];
      else if (action === 'end') next = start.at(-1);
      else next = start[(i + (action === 'right' ? 1 : -1) + start.length) % start.length];
    }
    e.preventDefault();
    e.stopPropagation();
    next?.focus();
  };

  return (
    <div className="livePane" ref={paneRef}>
      {confirmKill !== null && (
        <div className="tmuxConfirm">
          kill terminal “{(() => {
            const t = terms.find((x) => x.key === confirmKill);
            return t ? (t.tool === '_' ? 'shell' : t.tool) : '?';
          })()}”? <b>y</b> / <b>n</b>
        </div>
      )}
      {projectChoices.length > 0 && (
        <div className="liveProjects" ref={projectTabsRef} role="tablist" aria-label="Terminal projects" onKeyDown={projectKeys}>
          {projectChoices.map((p, i) => {
            const selected = sameTerminalProject(p, activeProject);
            const label = p.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
            return (
              <button
                key={terminalProjectKey(p)}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                data-project-tab={i}
                className={`liveProject ${selected ? 'active' : ''}`}
                title={p.source ? `${p.source.host}: ${p.cwd}` : p.cwd}
                onClick={() => selectProject(p)}
              >
                <span className={`codicon ${p.source ? 'codicon-radio-tower' : 'codicon-folder'}`} />
                <span className="liveTabLabel">{p.source ? `${p.source.host}: ${label}` : label}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="liveTabs" ref={termTabsRef} role="tablist" aria-label={`Terminals in ${activeProject?.cwd ?? 'project'}`} onKeyDown={termTabKeys}>
        {scopedTerms.map((e) => {
          const sess = sessionOf(e.ptyId, e.source);
          const link = linkOf(sess, e.source);
          const label = link ? link.label : e.tool === '_' ? 'shell' : e.tool;
          return (
            <span
              key={e.key}
              role="tab"
              aria-selected={active === e.key}
              tabIndex={active === e.key ? 0 : -1}
              data-term-tab={e.key}
              className={`liveTab ${active === e.key ? 'active' : ''}`}
              style={link?.color ? { background: rgba(link.color, 0.22) } : undefined}
              title={label}
              onClick={() => {
                focusArm.current = true;
                setActive(e.key);
                onActiveSession?.(sess, e.source);
                focusTerminal();
              }}
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
        <button
          type="button"
          role="tab"
          aria-label={`New or attach a terminal in ${activeProject?.cwd ?? 'this project'}`}
          aria-selected={active === null}
          tabIndex={active === null ? 0 : -1}
          data-term-tab="plus"
          className={`liveTab plus ${active === null ? 'active' : ''}`}
          title="New / attach"
          onClick={openPicker}
        >
          <span className="codicon codicon-add" />
        </button>
        {active !== null && (() => {
          const term = terms.find((e) => e.key === active);
          const pty = ptys.find((x) => x.id === term?.ptyId && sourceKey(x.source) === sourceKey(term?.source));
          const sess = pty?.session ?? null;
          const same = isWatched(sess, pty?.source);
          return (
            <span className="liveTabActions">
              {sess && onFollowSession && (
                <button
                  disabled={same}
                  onClick={() => onFollowSession(sess, pty?.source)}
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

      {terms.map((e) => {
        const termConfig = configs[sourceKey(e.source)];
        const termProject = e.cwd ? { cwd: e.cwd, source: e.source } : undefined;
        return (
        <div key={e.key} className={active === e.key ? 'tabBody' : 'tabBody hiddenTab'}>
          {termConfig && (
            <PtySession
              key={`${e.key}:${e.nonce}`}
              tool={e.tool}
              token={termConfig.token}
              cwd={e.cwd ?? cwd}
              source={e.source}
              reportScope={termProject ? terminalProjectScope(termProject) : ''}
              platform={termConfig.platform}
              attachId={e.attachId}
              steal={e.steal}
              visible={active === e.key}
              focusArm={focusArm}
              onPtyId={(id) => {
                setTerms((t) => t.map((x) => (x.key === e.key ? { ...x, ptyId: id } : x)));
                // fresh = started here, not adopted/taken back — only fresh
                // starts may satisfy a session hunt
                onPtyId?.(id, e.tool, !e.attachId, termProject);
              }}
              onExit={() => removeTerm(e.key)}
              onTakeBack={() => takeBack(e.key)}
              onOpenFileRef={(path, line) => {
                const abs = /^[A-Za-z]:[\\/]|^[\\/]/.test(path) || !e.cwd
                  ? path : `${e.cwd.replace(/[\\/]+$/, '')}/${path}`;
                onOpenFileRef?.(abs, line, termProject);
              }}
            />
          )}
        </div>
        );
      })}

      {active === null && (
        <div className="livePicker" ref={pickerRef} tabIndex={-1} onKeyDown={pickerKeys}>
          {error && <div className="pickerError">{error}</div>}

          {scopedPtys.length > 0 && (
            <>
              <div className="pickerTitle">attach a terminal</div>
              <div className="liveGallery">
                {scopedPtys.map((p) => {
                  const own = tabOf(p.id, p.source);
                  return (
                  <div
                    key={ptyKey(p.id, p.source)}
                    data-pty-id={p.id}
                    className={`ptyTile ${p.attached && !own ? 'inUse' : ''} ${isWatched(p.session, p.source) ? 'watching' : ''}`}
                  >
                    <button
                      type="button"
                      className="ptyTileHit"
                      data-term-choice="attach"
                      aria-label={`Attach ${p.tool === '_' ? 'shell' : p.tool} terminal in ${p.cwd}`}
                      onKeyDown={(e) => {
                        if (!actionOf(e, ['activate', 'select'])) return;
                        e.preventDefault();
                        e.stopPropagation();
                        e.currentTarget.click();
                      }}
                      onClick={() => {
                        if (own) { setActive(own.key); onActiveSession?.(p.session, p.source); }
                        else if (p.attached) {
                          setConfirmSteal(ptyKey(p.id, p.source));
                          focusSoon(() => {
                            (pickerRef.current?.querySelector(`[data-pty-id="${p.id}"] .tileConfirm button`) as HTMLElement | null)?.focus();
                          });
                        } else { adopt(p, false); onActiveSession?.(p.session, p.source); }
                      }}
                    />
                    <div className="tileHead">
                      {linkOf(p.session, p.source)
                        ? <span className="liveDot" title={isWatched(p.session, p.source) ? "running the session you're watching" : `linked to ${linkOf(p.session, p.source)?.label}`} />
                        : <span className="codicon codicon-terminal" />}
                      <span className="tileName">
                        {p.tool === '_' ? 'shell' : p.tool} · {p.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}
                      </span>
                      <span className={`tileBadge ${p.attached && !own ? 'busy' : ''}`}>
                        {own ? 'this window' : p.attached ? 'in use' : 'detached'}
                      </span>
                      {!p.attached && (
                        <button
                          type="button"
                          className="codicon codicon-close tileKill"
                          title="Kill this terminal"
                          aria-label="Kill this terminal"
                          onClick={(e) => {
                            e.stopPropagation();
                            void fetch(withConnection('/api/pty-kill', p.source?.connection), { method: 'POST', body: JSON.stringify({ id: p.id }) })
                              .then(() => setPtys((cur) => cur.filter((x) => ptyKey(x.id, x.source) !== ptyKey(p.id, p.source))));
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
                    {confirmSteal === ptyKey(p.id, p.source) && (
                      <div className="tileConfirm" onClick={(e) => e.stopPropagation()}>
                        live in another window — take the terminal?
                        <div>
                          <button onClick={() => adopt(p, true)}>yes</button>
                          <button onClick={() => {
                            setConfirmSteal(undefined);
                            focusSoon(() => {
                              (pickerRef.current?.querySelector(`[data-pty-id="${p.id}"] .ptyTileHit`) as HTMLElement | null)?.focus();
                            });
                          }}>no</button>
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
          {activeProject ? (
            <>
              <div className="pickerHint">in {activeProject.source ? `${activeProject.source.host}: ` : ''}{activeProject.cwd}</div>
              {config?.tools.map((t) => (
                <button key={t} className="pickerTool" data-term-choice="start" onClick={() => startNew(t)}>
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
