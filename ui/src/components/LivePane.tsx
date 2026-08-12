import { useEffect, useRef, useState } from 'react';
import { Terminal as Xterm, type FontWeight } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';

interface Config { tools: string[]; token: string }

export interface LivePty {
  id: string;
  tool: string;
  cwd: string;
  created: number;
  attached: boolean;
  session: { provider: string; id: string; pwd: string } | null;
  screen?: { text: string; cols: number; rows: number } | null;
}

// the PTY this tab currently holds (or last held); no auto-reattach — the
// gallery is the only way back in
const PTY_KEY = 'mcfly.pty';
export const storedPty = (): { id: string; tool: string } | null => {
  try { return JSON.parse(sessionStorage.getItem(PTY_KEY) ?? 'null'); } catch { return null; }
};

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

// A live PTY session: xterm.js <-> websocket <-> node-pty on the server.
// Control frames from the server are \x00-prefixed JSON; everything else is
// terminal data. 'taken' = another window stole the terminal (tmux attach -d).
function PtySession({ tool, token, cwd, steal, onExit, onTakeBack }: {
  tool: string; token: string; cwd?: string; steal?: boolean;
  onExit: () => void; onTakeBack: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'connecting' | 'up' | 'closed' | 'taken'>('connecting');
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

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
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      term.loadAddon(new WebglAddon()); // GPU renderer: crisp cells, like VS Code
    } catch { /* WebGL unavailable; DOM renderer still works */ }
    fit.fit();

    let ws: WebSocket | null = null;
    let dataSub: { dispose(): void } | null = null;

    // deferred connect: StrictMode's throwaway first mount must never reach
    // the server, or every terminal start leaves a ghost PTY
    const timer = setTimeout(() => {
      const prior = storedPty();
      const attach = prior && prior.tool === tool ? prior.id : null;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const sock = new WebSocket(
        `${proto}://${location.host}/ws/pty?token=${token}&tool=${encodeURIComponent(tool)}&cwd=${encodeURIComponent(cwd ?? '')}`
        + (attach ? `&attach=${attach}` : '')
        + (attach && steal ? '&steal=1' : ''),
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
            if (c.ptyId) sessionStorage.setItem(PTY_KEY, JSON.stringify({ id: c.ptyId, tool }));
            if (c.exit) sessionStorage.removeItem(PTY_KEY);
            if (c.gone) { sessionStorage.removeItem(PTY_KEY); onExitRef.current(); }
            if (c.busy || c.taken) setStatus('taken'); // keep ptyId: take-back stays possible
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
      if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'r', cols: term.cols, rows: term.rows }));
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
      term.dispose();
    };
  }, [tool, token, cwd, steal]);

  return (
    <div className="ptySession">
      <div className="ptyHost" ref={hostRef} />
      {status === 'closed' && (
        <div className="ptyClosed">
          session ended
          <button onClick={() => { sessionStorage.removeItem(PTY_KEY); onExit(); }}>back</button>
        </div>
      )}
      {status === 'taken' && (
        <div className="ptyClosed">
          terminal is live in another window
          <div className="ptyTakenActions">
            <button onClick={onTakeBack}>take it back</button>
            <button onClick={() => { sessionStorage.removeItem(PTY_KEY); onExit(); }}>close</button>
          </div>
        </div>
      )}
    </div>
  );
}

// LIVE TERMINAL pane: attach to an existing terminal from the gallery, or
// start a new one in the open folder. Terminals are independent of the
// folder/session you have open; refresh detaches (never kills).
export function LiveTerm({ cwd, onToolStart }: {
  cwd?: string; onToolStart?: (tool: string) => void;
}) {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string>();
  const [tool, setTool] = useState<string>();
  const [steal, setSteal] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [ptys, setPtys] = useState<LivePty[]>([]);
  const [confirmSteal, setConfirmSteal] = useState<string>();

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setError('api unreachable'));
  }, []);

  // gallery refresh while in picker state
  useEffect(() => {
    if (tool) return;
    const load = () =>
      fetch('/api/ptys')
        .then((r) => r.json())
        .then((d) => setPtys(Array.isArray(d) ? d : []))
        .catch(() => setPtys([]));
    void load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [tool]);

  const startNew = (t: string) => {
    sessionStorage.removeItem(PTY_KEY); // never silently attach an old id
    setSteal(false);
    setNonce((n) => n + 1);
    setTool(t);
    onToolStart?.(t);
  };

  const adopt = (p: LivePty, doSteal: boolean) => {
    sessionStorage.setItem(PTY_KEY, JSON.stringify({ id: p.id, tool: p.tool }));
    setSteal(doSteal);
    setNonce((n) => n + 1);
    setTool(p.tool);
  };

  const detach = () => {
    sessionStorage.removeItem(PTY_KEY);
    setTool(undefined);
  };

  const kill = (id?: string) => {
    const target = id ?? storedPty()?.id;
    if (target) {
      void fetch('/api/pty-kill', { method: 'POST', body: JSON.stringify({ id: target }) })
        .then(() => setPtys((cur) => cur.filter((p) => p.id !== target)));
    }
    if (!id) detach();
  };

  const takeBack = () => {
    setSteal(true);
    setNonce((n) => n + 1);
  };

  return (
    <div className="livePane">
      {tool && (
        <div className="liveBar">
          <span>{tool === '_' ? 'shell' : tool}</span>
          <span>
            <button onClick={detach} title="Detach: leave it running">⏏ detach</button>
            <button onClick={() => kill()} title="Kill the terminal">■ kill</button>
          </span>
        </div>
      )}
      {tool && config ? (
        <PtySession
          key={`${tool}:${nonce}`}
          tool={tool} token={config.token} cwd={cwd} steal={steal}
          onExit={detach} onTakeBack={takeBack}
        />
      ) : (
        <div className="livePicker">
          {error && <div className="pickerError">{error}</div>}

          {ptys.length > 0 && (
            <>
              <div className="pickerTitle">attach a terminal</div>
              <div className="liveGallery">
                {ptys.map((p) => (
                  <div
                    key={p.id}
                    className={`ptyTile ${p.attached ? 'inUse' : ''}`}
                    onClick={() => (p.attached ? setConfirmSteal(p.id) : adopt(p, false))}
                  >
                    <div className="tileHead">
                      <span className="codicon codicon-terminal" />
                      <span className="tileName">
                        {p.tool === '_' ? 'shell' : p.tool} · {p.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}
                      </span>
                      <span className={`tileBadge ${p.attached ? 'busy' : ''}`}>{p.attached ? 'in use' : 'detached'}</span>
                      {!p.attached && (
                        <span
                          className="codicon codicon-close tileKill"
                          title="Kill this terminal"
                          onClick={(e) => { e.stopPropagation(); kill(p.id); }}
                        />
                      )}
                    </div>
                    {p.screen?.text?.trim() ? (
                      <MiniScreen screen={p.screen} />
                    ) : (
                      <div className="miniEmpty">no output yet</div>
                    )}
                    <div className="tileMeta">
                      {new Date(p.created).toLocaleTimeString()}
                      {p.session && <span> ▸ {p.session.id.split('/').pop()}</span>}
                    </div>
                    {confirmSteal === p.id && (
                      <div className="tileConfirm" onClick={(e) => e.stopPropagation()}>
                        live in another window — take the terminal?
                        <div>
                          <button onClick={() => { setConfirmSteal(undefined); adopt(p, true); }}>yes</button>
                          <button onClick={() => setConfirmSteal(undefined)}>no</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="pickerTitle">start a session</div>
          {cwd ? (
            <>
              <div className="pickerHint">in {cwd}</div>
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
