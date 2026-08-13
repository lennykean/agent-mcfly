import { useCallback, useEffect, useRef, useState } from 'react';
import { useReplay } from './hooks/useReplay';
import { AgentTree } from './components/AgentTree';
import { ChatPane } from './components/ChatPane';
import { DataPane } from './components/DataPane';
import { EditorPane, type UserTab } from './components/EditorPane';
import { Explorer } from './components/Explorer';
import { FileTimeline } from './components/FileTimeline';
import { LiveTerm } from './components/LivePane';
import { SessionPicker } from './components/SessionPicker';
import { Wayfinder } from './components/Wayfinder';
import { Splitter } from './components/Splitter';
import type { SessionMeta } from './types';
import { resolveWaypoint, type WaypointEntry } from './lib/timeline';
import { emit, updateSnapshot, watchSelections } from './lib/workspace';
import { Terminal } from './components/Terminal';
import { ToolDetail } from './components/ToolDetail';
import { ToolLog } from './components/ToolLog';
import { Transport } from './components/Transport';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function usePanelSize(key: string, initial: number, lo: number, hi: number) {
  const [size, setSize] = useState(() => {
    const saved = Number(localStorage.getItem(`mcfly.${key}`));
    return saved ? clamp(saved, lo, hi) : initial;
  });
  useEffect(() => { localStorage.setItem(`mcfly.${key}`, String(size)); }, [key, size]);
  return [size, (delta: number) => setSize((s) => clamp(s + delta, lo, hi))] as const;
}

function useStoredBool(key: string, initial: boolean) {
  const [v, setV] = useState(() => {
    const saved = localStorage.getItem(`mcfly.${key}`);
    return saved === null ? initial : saved === '1';
  });
  useEffect(() => { localStorage.setItem(`mcfly.${key}`, v ? '1' : '0'); }, [key, v]);
  return [v, setV] as const;
}

function useStoredTab<T extends string>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => (localStorage.getItem(`mcfly.${key}`) as T) ?? initial);
  useEffect(() => { localStorage.setItem(`mcfly.${key}`, v); }, [key, v]);
  return [v, setV] as const;
}

export default function App() {
  const r = useReplay();
  const [sideW, dragSide] = usePanelSize('sideW', 300, 180, 640);
  const [rightW, dragRight] = usePanelSize('chatW', 420, 260, 1000);
  const [editPct, dragEdit] = usePanelSize('editPct', 60, 15, 90);
  const [leftOpen, setLeftOpen] = useStoredBool('leftOpen', true);
  const [rightOpen, setRightOpen] = useStoredBool('rightOpen', true);
  const [bottomOpen, setBottomOpen] = useStoredBool('bottomOpen', true);
  const [leftTab, setLeftTab] = useStoredTab<'tools' | 'explorer'>('leftTab', 'tools');
  const [rightTab, setRightTab] = useStoredTab<'chat' | 'term'>('rightTab', 'chat');
  const [bottomTab, setBottomTab] = useStoredTab<'term' | 'data' | 'tool' | 'way'>('bottomTab', 'term');
  const [editorTab, setEditorTab] = useState('pinned');
  const [userTabs, setUserTabs] = useState<UserTab[]>([]);
  // singleton by construction: the timeline is a projection of the one global
  // playhead, so a second timeline tab would just be the same cursor
  const [timelinePath, setTimelinePath] = useState<string>();
  const [pwd, setPwd] = useState<string>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const centerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (pwd) localStorage.setItem('mcfly.lastPwd', pwd); }, [pwd]);

  // URL is the source of truth: ?pwd=&provider=&session= loads that view;
  // bare startup scopes to the server's pwd with nothing loaded.
  const { selectSession } = r;
  const loadFromUrl = useCallback(async () => {
    const q = new URLSearchParams(location.search);
    const uPwd = q.get('pwd') ?? undefined;
    const provider = q.get('provider');
    const sid = q.get('session');
    // bare URL = truly bare: no folder, no session, until the user opens one
    if (uPwd) setPwd(uPwd);
    if (uPwd && provider && sid) {
      let meta: SessionMeta | undefined;
      try {
        const list: SessionMeta[] = await (
          await fetch(`/api/sessions?pwd=${encodeURIComponent(uPwd)}&provider=${encodeURIComponent(provider)}`)
        ).json();
        meta = Array.isArray(list) ? list.find((s) => s.id === sid) : undefined;
      } catch { /* fall through to minimal meta */ }
      selectSession(meta ?? { id: sid, provider, label: sid.split('/').pop() ?? sid, cwd: uPwd, updated_at: 0, size: 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectSession]);

  useEffect(() => {
    void loadFromUrl();
    const onPop = () => void loadFromUrl();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [loadFromUrl]);

  const applyPick = useCallback((newPwd: string, s: SessionMeta) => {
    setPwd(newPwd);
    setPickerOpen(false);
    setUserTabs([]);
    setEditorTab('pinned');
    selectSession(s);
    history.pushState(null, '', `?${new URLSearchParams({ pwd: newPwd, provider: s.provider, session: s.id })}`);
  }, [selectSession]);

  const { clearSession } = r;
  const openFolderOnly = useCallback((newPwd: string) => {
    setPwd(newPwd);
    setPickerOpen(false);
    setUserTabs([]);
    setEditorTab('pinned');
    clearSession();
    history.pushState(null, '', `?${new URLSearchParams({ pwd: newPwd })}`);
  }, [clearSession]);

  // Session detection: a tool started in the live terminal announces itself by
  // writing its transcript; poll this pwd's session list and auto-load the one
  // that appears after launch.
  const TOOL_PROVIDERS: Record<string, string> = { claude: 'claude-code', codex: 'codex' };
  // one hunt per launch, each remembering which PTY it came from — a second
  // terminal starting mid-hunt must not steal or clobber the first's identity
  const [hunts, setHunts] = useState<{ key: number; provider: string; tool: string; since: number; ptyId?: string }[]>([]);
  const huntKey = useRef(1);
  const claimed = useRef(new Set<string>());
  const onToolStart = useCallback((tool: string) => {
    const provider = TOOL_PROVIDERS[tool];
    if (provider) setHunts((hs) => [...hs, { key: huntKey.current++, provider, tool, since: Date.now() }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onPtyStart = useCallback((id: string, tool: string, fresh: boolean) => {
    // only a freshly started terminal (not an adoption/take-back) can be the
    // one a hunt launched; bind to the oldest unbound hunt of that tool
    if (!fresh) return;
    setHunts((hs) => {
      const i = hs.findIndex((h) => h.tool === tool && !h.ptyId);
      return i < 0 ? hs : hs.map((h, j) => (j === i ? { ...h, ptyId: id } : h));
    });
  }, []);
  const sessionId = r.session?.id;
  useEffect(() => {
    if (!hunts.length || !pwd) return;
    const id = setInterval(async () => {
      const now = Date.now();
      if (hunts.some((h) => now - h.since > 120_000)) {
        setHunts((hs) => hs.filter((h) => now - h.since <= 120_000));
        return;
      }
      for (const h of hunts) {
        try {
          const list: SessionMeta[] = await (
            await fetch(`/api/sessions?pwd=${encodeURIComponent(pwd)}&provider=${encodeURIComponent(h.provider)}`)
          ).json();
          const cand = Array.isArray(list)
            ? list.filter((s) => s.updated_at > h.since - 5_000 && s.id !== sessionId && !claimed.current.has(s.id))
              .sort((a, b) => a.updated_at - b.updated_at)[0]
            : undefined;
          if (!cand) continue;
          claimed.current.add(cand.id);
          setHunts((hs) => hs.filter((x) => x.key !== h.key));
          applyPick(pwd, cand);
          // label the PTY with its transcript so the live-terminal picker can offer it
          if (h.ptyId) {
            void fetch('/api/pty-session', {
              method: 'POST',
              body: JSON.stringify({ ptyId: h.ptyId, provider: cand.provider, session: cand.id, pwd }),
            });
          }
        } catch { /* retry next tick */ }
      }
    }, 3000);
    return () => clearInterval(id);
  }, [hunts, pwd, sessionId, applyPick]);


  const folder = pwd?.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  useEffect(() => {
    document.title = ['Agent McFly', folder, r.session && (r.session.label || r.session.id.slice(0, 8))]
      .filter(Boolean).join(' - ');
  }, [folder, r.session]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
      if (t instanceof Element && t.closest('.livePane')) return; // never steal keys from the live terminal
      if (e.code === 'Space') { e.preventDefault(); r.togglePlay(); }
      else if (e.code === 'ArrowLeft') r.stepBy(-1);
      else if (e.code === 'ArrowRight') r.stepBy(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [r]);

  const { switchView } = r;
  const openAgent = useCallback((key: string) => switchView(key, key), [switchView]);

  // ---- workspace reporting: what the user has open/focused/selected, so
  // agents can query it via the workspace_state MCP tool ----
  useEffect(() => { watchSelections(); }, []);
  useEffect(() => {
    updateSnapshot({
      session: r.session ? { provider: r.session.provider, id: r.session.id } : null,
      playhead: { pointer: r.pointer, head: r.head, playing: r.playing, speed: r.speed },
      editor: {
        active: editorTab,
        pinned: r.view.activePath ?? null,
        timeline: timelinePath ?? null,
        tabs: userTabs.map((t) => ({ path: t.path, flavor: t.snapshot ? 'snapshot' : 'read-only' })),
      },
      panels: { left: leftTab, right: rightTab, bottom: bottomOpen ? bottomTab : null },
    });
  }, [r.session, r.pointer, r.head, r.playing, r.speed, r.view.activePath, editorTab, timelinePath, userTabs, leftTab, rightTab, bottomTab, bottomOpen]);

  const prevTabKeys = useRef<string[]>([]);
  useEffect(() => {
    const cur = userTabs.map((t) => t.key);
    for (const t of userTabs) {
      if (!prevTabKeys.current.includes(t.key)) {
        emit({ kind: 'file_open', path: t.path, flavor: t.snapshot ? 'snapshot' : 'read-only' });
      }
    }
    for (const k of prevTabKeys.current) if (!cur.includes(k)) emit({ kind: 'file_close', key: k });
    prevTabKeys.current = cur;
  }, [userTabs]);
  useEffect(() => { emit({ kind: 'tab_focus', tab: editorTab }); }, [editorTab]);
  useEffect(() => {
    if (timelinePath) emit({ kind: 'file_open', path: timelinePath, flavor: 'timeline' });
  }, [timelinePath]);
  useEffect(() => { emit({ kind: 'pane_switch', bottom: bottomTab }); }, [bottomTab]);
  useEffect(() => { emit({ kind: 'pane_switch', right: rightTab }); }, [rightTab]);
  const wsSessionId = r.session?.id;
  useEffect(() => {
    if (r.session) emit({ kind: 'session_open', provider: r.session.provider, id: r.session.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsSessionId]);

  // seeks: only NON-contiguous playhead movement is signal — playback humming
  // forward stays silent; a scrub/jump burst coalesces into one from->to
  const trailPointer = useRef(r.pointer);
  const pendingSeek = useRef<{ from: number; timer: number } | null>(null);
  useEffect(() => {
    if (r.seekTick === 0) return;
    if (pendingSeek.current) clearTimeout(pendingSeek.current.timer);
    const from = pendingSeek.current?.from ?? trailPointer.current;
    const timer = window.setTimeout(() => {
      emit({ kind: 'seek', from, to: trailPointer.current });
      pendingSeek.current = null;
    }, 800);
    pendingSeek.current = { from, timer };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.seekTick]);
  useEffect(() => { trailPointer.current = r.pointer; }, [r.pointer]);

  const animStep = r.animateIndex >= 0 ? r.steps[r.animateIndex] : undefined;
  const animatedPath =
    animStep?.kind === 'tool' && animStep.result?.path
      ? (animStep.result.path ?? animStep.call.path)
      : undefined;
  const animatedTermAt = animStep?.kind === 'tool' && animStep.call.command ? r.animateIndex : -1;

  useEffect(() => {
    if (r.view.data?.touchedAt === undefined) return;
    setBottomOpen(true);
    setBottomTab('data');
  }, [r.view.data?.touchedAt, setBottomOpen, setBottomTab]);

  const pinned = r.view.tabs.find((t) => t.path === r.view.activePath);

  // any touch of a file yanks the editor to the pinned live tab — unless
  // you're inspecting a file timeline, which follows the playhead itself
  useEffect(() => {
    setEditorTab((cur) => (cur === 'timeline' ? cur : 'pinned'));
  }, [pinned?.path, pinned?.touchedAt]);

  // the project pwd governs terminals and the explorer; session cwd is fallback
  const cwd = pwd ?? r.session?.cwd;

  // open any absolute path as a read-only tab, current on-disk content;
  // an optional line scrolls/flashes there (nonce so re-clicks re-scroll),
  // an optional waypoint renders its note card above the line
  const openSeq = useRef(1);
  const openAbs = useCallback((abs: string, line?: number, waypoint?: { line: number; note: string }) => {
    const m = abs.match(/^(.*)[\\/]([^\\/]+)$/);
    if (!m) return;
    const [, dir, name] = m;
    setEditorTab(abs);
    setUserTabs((tabs) => {
      const nonce = openSeq.current++;
      if (tabs.some((t) => t.key === abs)) {
        return tabs.map((t) => (t.key === abs ? { ...t, line, nonce, waypoint, waypointOpen: !!waypoint } : t));
      }
      fetch(`/api/fs/read?root=${encodeURIComponent(dir)}&path=${encodeURIComponent(name)}`)
        .then((res) => res.json())
        .then((d) => setUserTabs((cur) => cur.map((t) => (t.key === abs ? { ...t, ...d } : t))))
        .catch(() => setUserTabs((cur) => cur.map((t) => (t.key === abs ? { ...t, error: 'failed to read' } : t))));
      return [...tabs, { key: abs, path: abs, line, nonce, waypoint, waypointOpen: !!waypoint }];
    });
  }, []);

  const toggleWaypoint = useCallback((key: string) => {
    setUserTabs((tabs) => tabs.map((t) => (t.key === key ? { ...t, waypointOpen: !t.waypointOpen } : t)));
  }, []);

  // the capture-time view of a waypoint; many snapshot tabs can coexist
  const openSnapshot = useCallback((wp: WaypointEntry) => {
    const key = `snapshot:${wp.path}:${wp.touchedAt}`;
    setEditorTab(key);
    setUserTabs((tabs) => (tabs.some((t) => t.key === key)
      ? tabs
      : [...tabs, {
        key, path: wp.path,
        snapshot: { line: wp.line, note: wp.note, before: wp.before, anchor: wp.anchor, after: wp.after },
      }]));
  }, []);

  // resolve a waypoint against the file on disk NOW: a unique context match
  // opens the file at the (possibly moved) line; anything else opens its snapshot
  const openWaypoint = useCallback((wp: WaypointEntry) => {
    const m = wp.path.match(/^(.*)[\\/]([^\\/]+)$/);
    if (!m) { openSnapshot(wp); return; }
    fetch(`/api/fs/read?root=${encodeURIComponent(m[1])}&path=${encodeURIComponent(m[2])}`)
      .then((res) => res.json())
      .then((d: { content?: string }) => {
        const line = typeof d.content === 'string' ? resolveWaypoint(d.content, wp) : null;
        if (line === null) openSnapshot(wp);
        else openAbs(wp.path, line, { line, note: wp.note });
      })
      .catch(() => openSnapshot(wp));
  }, [openAbs, openSnapshot]);

  // clicking a resolved (purple) marker in a real file opens/toggles its card
  const activateTabWaypoint = useCallback((key: string, line: number, note: string) => {
    setUserTabs((tabs) => tabs.map((t) => (t.key === key
      ? {
        ...t, line, nonce: openSeq.current++,
        waypoint: { line, note },
        waypointOpen: !(t.waypoint?.line === line && t.waypointOpen),
      }
      : t)));
  }, []);

  // a waypoint step takes you to it — during playback, live follow, or scrub
  const lastWaypointAt = r.view.waypoints.at(-1)?.touchedAt;
  useEffect(() => {
    const wp = r.view.waypoints.at(-1);
    if (wp) openWaypoint(wp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastWaypointAt]);

  const openFile = useCallback((rel: string) => {
    if (!cwd) return;
    openAbs(`${cwd.replace(/[\\/]+$/, '')}/${rel}`);
  }, [cwd, openAbs]);

  // terminal file:line links; relative paths resolve against the project cwd
  const openFileRef = useCallback((p: string, line?: number) => {
    const abs = /^[A-Za-z]:[\\/]|^[\\/]/.test(p) ? p : cwd ? `${cwd.replace(/[\\/]+$/, '')}/${p}` : null;
    if (abs) openAbs(abs, line);
  }, [cwd, openAbs]);

  const closeFile = useCallback((key: string) => {
    setUserTabs((tabs) => tabs.filter((t) => t.key !== key));
    setEditorTab((cur) => (cur === key ? 'pinned' : cur));
  }, []);

  const currentTool = r.view.currentToolIndex >= 0
    ? (r.steps[r.view.currentToolIndex] as (typeof r.steps[number] & { kind: 'tool' }))
    : undefined;

  const cols = [leftOpen ? `${sideW}px 5px` : '', '1fr', rightOpen ? `5px ${rightW}px` : ''].join(' ');

  return (
    <div className="app">
      <div className="titlebar">
        <span className="logo">⏱ Agent McFly</span>
        {pwd && <span className="pwdChip" title={pwd}>{folder}</span>}
        <button onClick={() => setPickerOpen(true)} title="Open a session">
          <span className="codicon codicon-folder-opened" /> open
        </button>
        {r.session && <span className="sessionChip" title={r.session.id}>{r.session.label || r.session.id.slice(0, 8)}</span>}
        {r.viewKey !== 'main' && (
          <span className="crumb">
            <button onClick={() => r.switchView('main')}>← main</button>
            <span className="crumbName">{r.agents.find((a) => a.key === r.viewKey)?.label ?? r.viewKey}</span>
            <button onClick={r.syncToMain} title="Seek to main timeline's current time">sync</button>
          </span>
        )}
        <span className="titleRight">
          {r.playing && r.pointer >= r.head && <span className="liveBadge">● LIVE</span>}
          <span className="layoutToggles">
            <button className={leftOpen ? 'on' : ''} title="Toggle left pane" onClick={() => setLeftOpen(!leftOpen)}>◧</button>
            <button className={bottomOpen ? 'on' : ''} title="Toggle bottom pane" onClick={() => setBottomOpen(!bottomOpen)}>⬓</button>
            <button className={rightOpen ? 'on' : ''} title="Toggle right pane" onClick={() => setRightOpen(!rightOpen)}>◨</button>
          </span>
        </span>
      </div>

      <div className="workbench" style={{ gridTemplateColumns: cols }}>
        {leftOpen && (
          <>
            <div className="sidebar">
              <div className="paneTabs">
                <div className={`paneTab ${leftTab === 'tools' ? 'active' : ''}`} onClick={() => setLeftTab('tools')}>TOOL CALLS</div>
                <div className={`paneTab ${leftTab === 'explorer' ? 'active' : ''}`} onClick={() => setLeftTab('explorer')}>EXPLORER</div>
              </div>
              <div className={leftTab === 'tools' ? 'tabBody' : 'tabBody hiddenTab'}>
                <ToolLog
                  key={`${r.session?.id}:${r.viewKey}`}
                  steps={r.steps} pointer={r.pointer} currentToolIndex={r.view.currentToolIndex} onJump={r.jump}
                  seekTick={r.seekTick}
                  visible={leftTab === 'tools'}
                />
              </div>
              <div className={leftTab === 'explorer' ? 'tabBody' : 'tabBody hiddenTab'}>
                <Explorer root={cwd} onOpen={openFile} />
              </div>
            </div>
            <Splitter dir="col" onDrag={dragSide} />
          </>
        )}

        <div className="center" ref={centerRef}>
          <div className="editorSlot" style={{ flex: bottomOpen ? `0 0 ${editPct}%` : '1 1 auto' }}>
            <EditorPane
              pinned={pinned}
              animate={!!pinned && pinned.path === animatedPath}
              speed={r.speed}
              userTabs={userTabs}
              active={editorTab}
              onSelect={setEditorTab}
              onClose={closeFile}
              onOpenCurrent={openAbs}
              timelinePath={timelinePath}
              onOpenTimeline={(p) => { setTimelinePath(p); setEditorTab('timeline'); }}
              onCloseTimeline={() => { setTimelinePath(undefined); setEditorTab('pinned'); }}
              timelineBody={timelinePath && (
                <FileTimeline steps={r.steps} pointer={r.pointer} path={timelinePath} speed={r.speed} onJump={r.jump} />
              )}
              onToggleWaypoint={toggleWaypoint}
              waypoints={r.view.waypoints}
              onOpenSnapshot={openSnapshot}
              onActivateWaypoint={activateTabWaypoint}
            />
          </div>
          {bottomOpen && (
            <>
              <Splitter dir="row" onDrag={(dy) => {
                const h = centerRef.current?.clientHeight ?? 900;
                dragEdit((dy / h) * 100);
              }} />
              <div className="bottomPane">
                <div className="paneTabs">
                  <div className={`paneTab ${bottomTab === 'term' ? 'active' : ''}`} onClick={() => setBottomTab('term')}>
                    AGENT TERMINAL <span className="roBadge">read only</span>
                  </div>
                  <div className={`paneTab ${bottomTab === 'data' ? 'active' : ''}`} onClick={() => setBottomTab('data')}>
                    DATA
                  </div>
                  <div className={`paneTab wayfinderTab ${bottomTab === 'way' ? 'active' : ''}`} onClick={() => setBottomTab('way')}>
                    WAYFINDER{r.view.waypoints.length > 0 && <span className="wfCount">{r.view.waypoints.length}</span>}
                  </div>
                  <div className={`paneTab ${bottomTab === 'tool' ? 'active' : ''}`} onClick={() => setBottomTab('tool')}>
                    TOOL CALL
                  </div>
                </div>
                <div className={bottomTab === 'term' ? 'tabBody' : 'tabBody hiddenTab'}>
                  <Terminal blocks={r.view.term} animatedAt={animatedTermAt} speed={r.speed} seekTick={r.seekTick} visible={bottomTab === 'term'} />
                </div>
                <div className={bottomTab === 'data' ? 'tabBody' : 'tabBody hiddenTab'}>
                  <DataPane data={r.view.data} animate={r.view.data?.touchedAt === r.animateIndex} />
                </div>
                <div className={bottomTab === 'way' ? 'tabBody' : 'tabBody hiddenTab'}>
                  <Wayfinder waypoints={r.view.waypoints} onSelect={openWaypoint} />
                </div>
                <div className={bottomTab === 'tool' ? 'tabBody' : 'tabBody hiddenTab'}>
                  <ToolDetail step={currentTool} />
                </div>
              </div>
            </>
          )}
        </div>

        {rightOpen && (
          <>
            <Splitter dir="col" onDrag={(dx) => dragRight(-dx)} />
            <div className="rightPane">
              <div className="paneTabs">
                <div className={`paneTab ${rightTab === 'chat' ? 'active' : ''}`} onClick={() => setRightTab('chat')}>CHAT</div>
                <div className={`paneTab ${rightTab === 'term' ? 'active' : ''}`} onClick={() => setRightTab('term')}>LIVE TERMINAL</div>
              </div>
              <div className={rightTab === 'chat' ? 'tabBody rightChat' : 'tabBody rightChat hiddenTab'}>
                <div className="sideHead">AGENTS</div>
                <AgentTree agents={r.agents} viewKey={r.viewKey} onSelect={openAgent} />
                <ChatPane
                  steps={r.steps}
                  pointer={r.pointer}
                  animateIndex={r.animateIndex}
                  seekTick={r.seekTick}
                  onJump={r.jump}
                  onOpenAgent={openAgent}
                  visible={rightTab === 'chat'}
                />
              </div>
              {/* stays mounted across tab switches so the PTY session survives */}
              <div className={rightTab === 'term' ? 'tabBody' : 'tabBody hiddenTab'}>
                <LiveTerm
                  cwd={cwd}
                  currentSession={r.session && { provider: r.session.provider, id: r.session.id }}
                  onToolStart={onToolStart}
                  onPtyId={onPtyStart}
                  onOpenFileRef={openFileRef}
                  onFollowSession={(s) => applyPick(s.pwd || pwd || '', {
                    id: s.id, provider: s.provider,
                    label: s.id.split('/').pop() ?? s.id,
                    cwd: s.pwd, updated_at: 0, size: 0,
                  })}
                />
              </div>
            </div>
          </>
        )}
      </div>

      <Transport r={r} />

      {pickerOpen && (
        <SessionPicker initialPwd={pwd ?? ''} onPick={applyPick} onOpenFolder={openFolderOnly} onClose={() => setPickerOpen(false)} />
      )}
    </div>
  );
}
