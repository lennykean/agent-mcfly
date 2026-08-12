import { useCallback, useEffect, useRef, useState } from 'react';
import { useReplay } from './hooks/useReplay';
import { AgentTree } from './components/AgentTree';
import { ChatPane } from './components/ChatPane';
import { EditorPane, type UserTab } from './components/EditorPane';
import { Explorer } from './components/Explorer';
import { LiveTerm, storedPty } from './components/LivePane';
import { SessionPicker } from './components/SessionPicker';
import { Splitter } from './components/Splitter';
import type { SessionMeta } from './types';
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
  const [bottomTab, setBottomTab] = useStoredTab<'term' | 'tool'>('bottomTab', 'term');
  const [editorTab, setEditorTab] = useState('pinned');
  const [userTabs, setUserTabs] = useState<UserTab[]>([]);
  const [pwd, setPwd] = useState<string>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const centerRef = useRef<HTMLDivElement>(null);

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
  const [hunt, setHunt] = useState<{ provider: string; since: number } | null>(null);
  const onToolStart = useCallback((tool: string) => {
    const provider = TOOL_PROVIDERS[tool];
    if (provider) setHunt({ provider, since: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const sessionId = r.session?.id;
  useEffect(() => {
    if (!hunt || !pwd) return;
    const id = setInterval(async () => {
      if (Date.now() - hunt.since > 120_000) { setHunt(null); return; }
      try {
        const list: SessionMeta[] = await (
          await fetch(`/api/sessions?pwd=${encodeURIComponent(pwd)}&provider=${encodeURIComponent(hunt.provider)}`)
        ).json();
        const cand = Array.isArray(list)
          ? list.find((s) => s.updated_at > hunt.since - 5_000 && s.id !== sessionId)
          : undefined;
        if (cand) {
          setHunt(null);
          applyPick(pwd, cand);
          // label the PTY with its transcript so the live-terminal picker can offer it
          const pty = storedPty();
          if (pty) {
            void fetch('/api/pty-session', {
              method: 'POST',
              body: JSON.stringify({ ptyId: pty.id, provider: cand.provider, session: cand.id, pwd }),
            });
          }
        }
      } catch { /* retry next tick */ }
    }, 3000);
    return () => clearInterval(id);
  }, [hunt, pwd, sessionId, applyPick]);


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

  const animStep = r.animateIndex >= 0 ? r.steps[r.animateIndex] : undefined;
  const animatedPath =
    animStep?.kind === 'tool' && animStep.result?.path
      ? (animStep.result.path ?? animStep.call.path)
      : undefined;
  const animatedTermAt = animStep?.kind === 'tool' && animStep.call.command ? r.animateIndex : -1;

  const pinned = r.view.tabs.find((t) => t.path === r.view.activePath);

  // any touch of a file yanks the editor to the pinned live tab
  useEffect(() => { setEditorTab('pinned'); }, [pinned?.path, pinned?.touchedAt]);

  // the project pwd governs terminals and the explorer; session cwd is fallback
  const cwd = pwd ?? r.session?.cwd;

  // open any absolute path as a read-only tab, current on-disk content
  const openAbs = useCallback((abs: string) => {
    const m = abs.match(/^(.*)[\\/]([^\\/]+)$/);
    if (!m) return;
    const [, dir, name] = m;
    setEditorTab(abs);
    setUserTabs((tabs) => {
      if (tabs.some((t) => t.path === abs)) return tabs;
      fetch(`/api/fs/read?root=${encodeURIComponent(dir)}&path=${encodeURIComponent(name)}`)
        .then((res) => res.json())
        .then((d) => setUserTabs((cur) => cur.map((t) => (t.path === abs ? { ...t, ...d } : t))))
        .catch(() => setUserTabs((cur) => cur.map((t) => (t.path === abs ? { ...t, error: 'failed to read' } : t))));
      return [...tabs, { path: abs }];
    });
  }, []);

  const openFile = useCallback((rel: string) => {
    if (!cwd) return;
    openAbs(`${cwd.replace(/[\\/]+$/, '')}\\${rel.replace(/\//g, '\\')}`);
  }, [cwd, openAbs]);

  const closeFile = useCallback((path: string) => {
    setUserTabs((tabs) => tabs.filter((t) => t.path !== path));
    setEditorTab((cur) => (cur === path ? 'pinned' : cur));
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
                    TOOL TERMINAL <span className="roBadge">read only</span>
                  </div>
                  <div className={`paneTab ${bottomTab === 'tool' ? 'active' : ''}`} onClick={() => setBottomTab('tool')}>
                    TOOL CALL
                  </div>
                </div>
                <div className={bottomTab === 'term' ? 'tabBody' : 'tabBody hiddenTab'}>
                  <Terminal blocks={r.view.term} animatedAt={animatedTermAt} speed={r.speed} visible={bottomTab === 'term'} />
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
                  onOpenAgent={openAgent}
                  visible={rightTab === 'chat'}
                />
              </div>
              {/* stays mounted across tab switches so the PTY session survives */}
              <div className={rightTab === 'term' ? 'tabBody' : 'tabBody hiddenTab'}>
                <LiveTerm cwd={cwd} onToolStart={onToolStart} />
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
