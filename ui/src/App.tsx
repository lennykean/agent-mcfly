import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReplay } from './hooks/useReplay';
import { AgentTree } from './components/AgentTree';
import { ChatPane } from './components/ChatPane';
import { DataPane } from './components/DataPane';
import { EditorPane, type UserTab } from './components/EditorPane';
import { Explorer } from './components/Explorer';
import { GitPane, type GitFile, type GitSelection } from './components/GitPane';
import { FileTimeline } from './components/FileTimeline';
import { LiveTerm } from './components/LivePane';
import { SessionPicker } from './components/SessionPicker';
import { Wayfinder } from './components/Wayfinder';
import { Splitter } from './components/Splitter';
import { HumanReview } from './components/HumanReview';
import { HistoryBar } from './components/HistoryBar';
import type { Review, ReviewComment, SessionMeta } from './types';
import { normPath, resolveWaypoint, type WaypointEntry } from './lib/timeline';
import { APP_CHORDS, actionOf, applyKeymap, focusEditor, justArmed, setLeaders, setTmuxMode, setVimMode } from './lib/keys';
import { QuickPick } from './components/QuickPick';
import { Settings, type McflySettings } from './components/Settings';
import { emit, onEditorSelection, updateSnapshot, watchSelections } from './lib/workspace';
import { applySelect, clickMode } from './lib/select';
import { Terminal } from './components/Terminal';
import { ToolDetail } from './components/ToolDetail';
import { ToolLog } from './components/ToolLog';
import { Transport } from './components/Transport';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// URLs carry the bare session id (basename, no extension); the full transcript
// path re-derives from pwd + provider via the session list
const shortSessionId = (id: string) => (id.split('/').pop() ?? id).replace(/\.[^.]+$/, '');

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
  const [agentsH, dragAgents] = usePanelSize('agentsH', 140, 56, 600);
  const [leftOpen, setLeftOpen] = useStoredBool('leftOpen', true);
  const [rightOpen, setRightOpen] = useStoredBool('rightOpen', true);
  const [bottomOpen, setBottomOpen] = useStoredBool('bottomOpen', true);
  const [leftTab, setLeftTab] = useStoredTab<'tools' | 'explorer' | 'git'>('leftTab', 'tools');
  const [rightTab, setRightTab] = useStoredTab<'chat' | 'term'>('rightTab', 'chat');
  const [bottomTab, setBottomTab] = useStoredTab<'term' | 'data' | 'tool' | 'way' | 'review'>('bottomTab', 'term');
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
        meta = Array.isArray(list) ? list.find((s) => s.id === sid || shortSessionId(s.id) === sid) : undefined;
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
    history.pushState(null, '', `?${new URLSearchParams({ pwd: newPwd, provider: s.provider, session: shortSessionId(s.id) })}`);
  }, [selectSession]);

  // follow on a terminal whose session the title could not settle: session
  // names fully contained in the title are the candidates — exactly one
  // follows straight away, anything else asks via the picker (pre-filtered)
  const [pickerSeed, setPickerSeed] = useState<{ pwd?: string; provider?: string; filter?: string }>();
  const followResolve = useCallback(async (p: { title?: string | null; cwd: string }) => {
    const dir = p.cwd || pwd || '';
    const cands: { provider: string; s: SessionMeta }[] = [];
    for (const provider of ['claude-code', 'codex']) {
      try {
        const list: SessionMeta[] = await (
          await fetch(`/api/sessions?pwd=${encodeURIComponent(dir)}&provider=${provider}`)
        ).json();
        if (!Array.isArray(list) || !p.title) continue;
        for (const s of list) {
          if (s.label && s.label.length >= 8 && p.title.includes(s.label)) cands.push({ provider, s });
        }
      } catch { /* picker fallback */ }
    }
    if (cands.length === 1) { applyPick(dir, cands[0].s); return; }
    setPickerSeed({ pwd: dir, provider: cands[0]?.provider, filter: cands[0]?.s.label });
    setPickerOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pwd, applyPick]);

  const { clearSession } = r;
  // "go" in the picker: the workbench opens the folder BARE, right away —
  // no session until one is picked. The picker stays open offering them.
  const scopeFolder = useCallback((newPwd: string) => {
    setPwd(newPwd);
    setUserTabs([]);
    setEditorTab('pinned');
    clearSession();
    history.pushState(null, '', `?${new URLSearchParams({ pwd: newPwd })}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearSession]);

  // Session detection: a tool started in the live terminal announces itself by
  // writing its transcript; poll this pwd's session list and auto-load the one
  // that appears after launch.
  const TOOL_PROVIDERS: Record<string, string> = { claude: 'claude-code', codex: 'codex' };
  // one hunt per launch, each remembering which PTY it came from — a second
  // terminal starting mid-hunt must not steal or clobber the first's identity
  const [hunts, setHunts] = useState<{ key: number; provider: string; tool: string; since: number; ptyId?: string; adopt?: boolean }[]>([]);
  const huntKey = useRef(1);
  const claimed = useRef(new Set<string>());
  const onToolStart = useCallback((tool: string) => {
    const provider = TOOL_PROVIDERS[tool];
    if (provider) setHunts((hs) => [...hs, { key: huntKey.current++, provider, tool, since: Date.now() }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onPtyStart = useCallback((id: string, tool: string, fresh: boolean) => {
    // an adopted terminal (page reload, take-back) lost its transcript label
    // with the old page: re-detect so the follow button comes back. Label
    // only — never yank the view the way a fresh launch does.
    // ponytail: two adopted terminals of one tool guess the same session
    if (!fresh) {
      const provider = TOOL_PROVIDERS[tool];
      if (provider) setHunts((hs) => [...hs, { key: huntKey.current++, provider, tool, since: Date.now(), ptyId: id, adopt: true }]);
      return;
    }
    // only a freshly started terminal can be the one a hunt launched; bind
    // to the oldest unbound hunt of that tool
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
            ? (h.adopt
              ? [...list].sort((a, b) => b.updated_at - a.updated_at)[0]
              : list.filter((s) => s.updated_at > h.since - 5_000 && s.id !== sessionId && !claimed.current.has(s.id))
                .sort((a, b) => a.updated_at - b.updated_at)[0])
            : undefined;
          if (!cand) continue;
          if (h.adopt) {
            setHunts((hs) => hs.filter((x) => x.key !== h.key));
            void fetch('/api/pty-session', {
              method: 'POST',
              body: JSON.stringify({ ptyId: h.ptyId, provider: cand.provider, session: cand.id, pwd }),
            });
            continue;
          }
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

  // title reads context-first: agent (when a session is open), then the
  // project (~-relative when under home), then the app. Bare = just the app.
  const [home, setHome] = useState<string>();
  useEffect(() => {
    fetch('/api/config').then((r) => r.json())
      .then((d) => { if (typeof d.home === 'string') setHome(d.home); })
      .catch(() => { /* title just shows the full path */ });
  }, []);
  useEffect(() => {
    const tildePwd = pwd && home && pwd.toLowerCase().startsWith(home.toLowerCase())
      ? `~${pwd.slice(home.length)}` : pwd;
    document.title = [
      r.session && (r.session.label || r.session.id.slice(0, 8)),
      tildePwd,
      'Agent McFly',
    ].filter(Boolean).join(' - ');
  }, [pwd, home, r.session]);

  // the global key handler lives further down, after the state it drives
  // (editor order, active path) is declared

  // tab strips are navigable: left/right switch panes, down (or Enter)
  // descends into the pane's focusable content, and content components
  // escalate back up with their onEscapeTop
  const leftStripRef = useRef<HTMLDivElement>(null);
  const stripKeys = useCallback((order: readonly string[], cur: string, set: (t: string) => void) => (e: React.KeyboardEvent) => {
    const action = actionOf(e, ['left', 'right', 'down', 'activate', 'dismiss']);
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    const i = Math.max(0, order.indexOf(cur));
    if (action === 'left') set(order[(i - 1 + order.length) % order.length]);
    else if (action === 'right') set(order[(i + 1) % order.length]);
    else if (action === 'down' || action === 'activate') {
      // descend into the visible body: an inner focusable, the body itself
      // (term/data/way/review/tool), or a live terminal's textarea
      const body = (e.currentTarget as HTMLElement).parentElement?.querySelector('.tabBody:not(.hiddenTab)') as HTMLElement | null;
      const el = (body?.querySelector('[tabindex]') as HTMLElement | null)
        ?? (body?.hasAttribute('tabindex') ? body : null)
        ?? (body?.querySelector('textarea') as HTMLElement | null);
      el?.focus();
    } else if (action === 'dismiss') (e.target as HTMLElement).blur();
  }, []);

  // the bottom and right strips get the same treatment as the left one
  const bottomStripRef = useRef<HTMLDivElement>(null);
  const rightStripRef = useRef<HTMLDivElement>(null);

  // a focused pane BODY (term/data/tool detail): plain arrows scroll its
  // content; up at the very top escalates to the strip. Left/right fall
  // through to the contextual transport.
  const scrollKeys = useCallback((e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return; // inner widgets own their keys
    const action = actionOf(e, ['up', 'down', 'pageUp', 'pageDown', 'home', 'end']);
    if (!action) return;
    const box = e.currentTarget as HTMLElement;
    const sc = (box.querySelector('.term, .dataScroll, .toolDetail') ?? box) as HTMLElement;
    if (action === 'up' && sc.scrollTop === 0) {
      e.preventDefault();
      e.stopPropagation();
      bottomStripRef.current?.focus();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const page = Math.max(54, sc.clientHeight - 54);
    const delta: Record<string, number> = { up: -54, down: 54, pageUp: -page, pageDown: page };
    if (action === 'home') sc.scrollTop = 0;
    else if (action === 'end') sc.scrollTop = sc.scrollHeight;
    else sc.scrollBy({ top: delta[action] ?? 0 });
  }, []);

  // panels are separate keyboard worlds: plain arrows never cross a panel
  // boundary, only tabs WITHIN a panel — hopping panels takes the deliberate
  // panel* chords, caught here as unhandled keys bubble up. Each panel keeps
  // its own state (cursors, carets live in refs), so a hop back lands where
  // you were.
  const lastSideFocus = useRef<HTMLElement | null>(null);
  const workbenchKeys = useCallback((e: React.KeyboardEvent) => {
    const t = e.target as Element;
    // real text inputs keep their ctrl+arrows (word jumps); the live
    // terminal's textarea is the exception — xterm already released the
    // hops that leave it, everything else never reaches here
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !t.closest?.('.livePane')) return;
    const action = actionOf(e, ['panelLeft', 'panelRight', 'panelUp', 'panelDown']);
    if (!action) return;
    // the full panel graph, by geometry: sidebar | editor / bottom | right
    const region = t.closest?.('.sidebar') ? 'side'
      : t.closest?.('.bottomPane') ? 'bottom'
        : t.closest?.('.rightPane') ? 'right'
          : 'editor';
    const focusSide = () => {
      const back = lastSideFocus.current?.isConnected ? lastSideFocus.current : leftStripRef.current;
      back?.focus();
    };
    const descend = (rootSel: string) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const body = document.querySelector(`${rootSel} .tabBody:not(.hiddenTab)`) as HTMLElement | null;
      const el = (body?.querySelector('[tabindex]') as HTMLElement | null)
        ?? (body?.hasAttribute('tabindex') ? body : null)
        ?? (body?.querySelector('textarea') as HTMLElement | null);
      el?.focus();
    }));
    const focusBottom = () => { setBottomOpen(true); descend('.bottomPane'); };
    const focusRight = () => { setRightOpen(true); descend('.rightPane'); };
    const go: Record<string, (() => void) | undefined> = {
      'editor:panelLeft': focusSide,
      'editor:panelRight': focusRight,
      'editor:panelDown': focusBottom,
      'bottom:panelUp': () => focusEditor(),
      'bottom:panelLeft': focusSide,
      'bottom:panelRight': focusRight,
      'right:panelLeft': () => focusEditor(),
      'right:panelDown': focusBottom,
      'side:panelRight': () => focusEditor(),
    };
    const fn = go[`${region}:${action}`];
    if (!fn) return;
    fn();
    e.preventDefault();
    e.stopPropagation();
  }, [setBottomOpen, setRightOpen]);

  const sidebarKeys = useCallback((e: React.KeyboardEvent) => {
    const action = actionOf(e, ['panelUp', 'panelDown']);
    if (!action) return;
    const inAgents = !!(e.target as Element).closest?.('.agentsSection');
    if (action === 'panelUp' && !inAgents) {
      ((e.currentTarget as HTMLElement).querySelector('.agentTree') as HTMLElement | null)?.focus();
    } else if (action === 'panelDown' && inAgents) {
      leftStripRef.current?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }, []);

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

  // auto-follow: ON = the view jumps to activity (tour-guide mode); OFF = the
  // same things happen quietly, and the tab that had activity flashes instead
  // ---- settings: persisted server-side in ~/.mcfly/settings.json. The
  // topbar eye/LIVE buttons are in-the-moment; autoTour/autoLive are the
  // START states applied when a session opens. ----
  const [settings, setSettings] = useState<McflySettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [autoFollow, setAutoFollow] = useState(true);
  useEffect(() => {
    void fetch('/api/settings').then((r2) => r2.json()).then((s: McflySettings) => {
      if (s && Object.keys(s).length) { setSettings(s); return; }
      // first run: adopt the old localStorage toggles, then persist
      let keymap: Record<string, string[]> = {};
      try { keymap = JSON.parse(localStorage.getItem('mcfly.keymap') ?? '{}'); } catch { /* fresh */ }
      const seed: McflySettings = {
        vim: localStorage.getItem('mcfly.vimMode') === '1',
        tmux: localStorage.getItem('mcfly.tmuxMode') === '1',
        autoTour: localStorage.getItem('mcfly.autoFollow') !== '0',
        autoLive: false,
        keymap,
      };
      setSettings(seed);
      void fetch('/api/settings', { method: 'POST', body: JSON.stringify(seed) });
    }).catch(() => setSettings({ autoTour: true }));
  }, []);
  // saves go through state, persistence follows in an effect: an updater
  // must stay pure (React may re-invoke it), and the debounce keeps posts
  // ordered — last state wins
  const settingsDirty = useRef(false);
  const saveSettings = useCallback((patch: Partial<McflySettings>) => {
    settingsDirty.current = true;
    setSettings((cur) => ({ ...(cur ?? {}), ...patch }));
  }, []);
  useEffect(() => {
    if (!settings || !settingsDirty.current) return;
    const t = setTimeout(() => {
      settingsDirty.current = false;
      void fetch('/api/settings', { method: 'POST', body: JSON.stringify(settings) }).catch(() => { /* runtime state stands */ });
    }, 250);
    return () => clearTimeout(t);
  }, [settings]);
  // the keymap tables follow the settings
  useEffect(() => {
    if (!settings) return;
    setLeaders(settings.vimLeader, settings.tmuxPrefix);
    setVimMode(!!settings.vim);
    setTmuxMode(!!settings.tmux);
    applyKeymap(settings.keymap ?? {});
  }, [settings]);
  const vimMode = !!settings?.vim;
  // session START state: tour + live per settings, applied when a session
  // opens and once at boot (a session may already be open when settings land)
  const sessKey = r.session ? `${r.session.provider}:${r.session.id}` : null;
  const settingsRef = useRef<McflySettings | null>(null);
  settingsRef.current = settings;
  useEffect(() => {
    const s = settingsRef.current;
    if (!sessKey || !s) return;
    setAutoFollow(s.autoTour !== false);
    if (s.autoLive) {
      setPinnedOverride(undefined);
      r.goLive();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessKey, settings === null]);
  const [flashes, setFlashes] = useState<Record<string, number>>({});
  const flash = useCallback((key: string) => {
    setFlashes((f) => ({ ...f, [key]: (f[key] ?? 0) + 1 }));
  }, []);

  useEffect(() => {
    if (r.view.data?.touchedAt === undefined) return;
    if (autoFollow) {
      setBottomOpen(true);
      setBottomTab('data');
    } else flash('data');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.view.data?.touchedAt, setBottomOpen, setBottomTab]);

  // terminal commands take you to the agent terminal; unknown tool calls
  // (nothing renders them specially) take you to the tool call detail.
  // In quiet mode the terminal flashes; tool call stays silent by design.
  useEffect(() => {
    const s = r.view.currentToolIndex >= 0 ? r.steps[r.view.currentToolIndex] : undefined;
    if (!s || s.kind !== 'tool') return;
    // run_table belongs to the DATA pane even when its result fell back to
    // an exec-shaped error — the call verb owns the pane
    if (s.call.verb === 'data') return;
    const verb = s.result?.verb ?? s.call.verb;
    if (verb === 'exec') {
      if (autoFollow) {
        setBottomOpen(true);
        setBottomTab('term');
      } else flash('term');
    } else if (verb === 'other' && !s.result?.waypoint && !s.result?.waypoint_remove) {
      if (autoFollow) {
        setBottomOpen(true);
        setBottomTab('tool');
      }
      // quiet mode: no flash for tool call — every step is a tool call
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.view.currentToolIndex]);

  // the tour can point the live tab at any session-known file (waypoint or
  // review stop); the next fold touch takes the tab back. Declared before
  // the tour effects so the clear-on-touch runs first, never after them.
  const [pinnedOverride, setPinnedOverride] = useState<string | undefined>();
  useEffect(() => {
    // the LIVE file ALWAYS follows the playhead — that tab is "what the
    // agent is doing with files"; tour-off only stops the tab/pane yanking.
    // A tour placement (waypoint/review pin) lasts until the next touch.
    setPinnedOverride(undefined);
  }, [r.view.activePath]);
  const pinned = (pinnedOverride ? r.view.tabs.find((t) => normPath(t.path) === normPath(pinnedOverride)) : undefined)
    ?? r.view.tabs.find((t) => t.path === r.view.activePath);

  // any touch of a file yanks the editor to the pinned live tab — unless
  // you're inspecting a file timeline, which follows the playhead itself
  useEffect(() => {
    if (autoFollow) setEditorTab((cur) => (cur === 'timeline' ? cur : 'pinned'));
    else flash('pinned');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned?.path, pinned?.touchedAt]);

  // the project pwd governs terminals and the explorer; session cwd is fallback
  const cwd = pwd ?? r.session?.cwd;

  // ---- git pane + worktrees. The explorer can point at a worktree; git
  // panels follow it. A vanished worktree falls back to main, silently. ----
  const [explorerRoot, setExplorerRoot] = useState<string>();
  const [gitSelection, setGitSelectionRaw] = useState<GitSelection[]>([]);
  const [explorerSelection, setExplorerSelectionRaw] = useState<string[]>([]);
  // selection changes also land in the event history: even a replaced
  // selection stays visible to agents with a timestamp
  const setGitSelection = useCallback((s: GitSelection[]) => {
    setGitSelectionRaw(s);
    emit({ kind: 'git_select', files: s });
  }, []);
  const setExplorerSelection = useCallback((s: string[]) => {
    setExplorerSelectionRaw(s);
    emit({ kind: 'explorer_select', paths: s });
  }, []);
  const [gitCommitSel, setGitCommitSelRaw] = useState<{ hash: string; subject: string }[]>([]);
  const setGitCommitSel = useCallback((s: { hash: string; subject: string }[]) => {
    setGitCommitSelRaw(s);
    emit({ kind: 'git_commit_select', commits: s });
  }, []);

  // data table rows are selectable too, same gestures, agent-visible
  const [dataSel, setDataSel] = useState<number[]>([]);
  const dataAnchor = useRef<string | null>(null);
  useEffect(() => { setDataSel([]); dataAnchor.current = null; }, [r.view.data?.touchedAt]);
  const dataRowClick = useCallback((e: React.MouseEvent, i: number) => {
    const rows = r.view.data?.table?.rows ?? [];
    const res = applySelect(rows.map((_, idx) => String(idx)), dataSel.map(String), dataAnchor.current, String(i), clickMode(e));
    dataAnchor.current = res.anchor;
    const sel = res.sel.map(Number);
    setDataSel(sel);
    emit({ kind: 'data_select', rows: sel.map((idx) => rows[idx]) });
  }, [r.view.data, dataSel]);

  // the persistent editor text selection: survives terminal clicks, clears
  // only on a click back inside an editor body; shown char-precise
  const [textSel, setTextSel] = useState<{ path: string; rects: { x: number; y: number; w: number; h: number }[] }[]>([]);
  useEffect(() => { onEditorSelection((sels) => setTextSel(sels.map((s) => ({ path: s.path, rects: s.rects })))); }, []);
  useEffect(() => { setExplorerSelectionRaw([]); }, [explorerRoot]);
  const [worktreeList, setWorktreeList] = useState<{ path: string; branch?: string }[]>([]);
  const gitRoot = explorerRoot ?? cwd ?? '';
  useEffect(() => {
    if (!cwd) return;
    const load = () => fetch(`/api/git/worktrees?root=${encodeURIComponent(cwd)}`)
      .then((res) => res.json())
      .then((d) => setWorktreeList(Array.isArray(d) ? d : []))
      .catch(() => { /* keep last */ });
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [cwd]);
  useEffect(() => {
    if (!explorerRoot || !worktreeList.length) return;
    if (!worktreeList.some((w) => normPath(w.path) === normPath(explorerRoot))) setExplorerRoot(undefined);
  }, [worktreeList, explorerRoot]);
  // a path under a linked worktree gets the orange banner, wherever it came
  // from — the explorer, a diff, or a file some subagent is editing
  const worktreeOf = useCallback((p?: string) => {
    if (!p || !cwd) return undefined;
    const norm = normPath(p);
    return worktreeList.find((w) => normPath(w.path) !== normPath(cwd)
      && (norm === normPath(w.path) || norm.startsWith(`${normPath(w.path)}\\`)));
  }, [worktreeList, cwd]);
  const openWorktree = useCallback((p: string) => {
    setExplorerRoot(cwd && normPath(p) === normPath(cwd) ? undefined : p);
    setLeftTab('explorer');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

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

  // ---- human review: session-scoped threads; agents reply through the MCP ----
  const [reviews, setReviews] = useState<Review[]>([]);
  const [focusThreadId, setFocusThreadId] = useState<string | undefined>();
  const refreshReviews = useCallback(() => {
    if (!cwd) return;
    fetch(`/api/reviews?pwd=${encodeURIComponent(cwd)}`)
      .then((res) => res.json())
      .then((d) => setReviews(Array.isArray(d) ? d : []))
      .catch(() => { /* keep last */ });
  }, [cwd]);
  useEffect(() => {
    refreshReviews();
    const id = setInterval(refreshReviews, 4000); // agent replies appear live
    return () => clearInterval(id);
  }, [refreshReviews]);

  const activeReview = reviews.find((v) => v.status === 'open'
    && v.session?.provider === r.session?.provider && v.session?.id === r.session?.id) ?? null;

  const reviewPost = useCallback((route: string, body: Record<string, unknown>) => {
    if (!cwd) return;
    void fetch(route, { method: 'POST', body: JSON.stringify({ pwd: cwd, ...body }) }).then(refreshReviews);
  }, [cwd, refreshReviews]);

  const createReview = useCallback(() => {
    if (!r.session) return;
    reviewPost('/api/review-create', { session: { provider: r.session.provider, id: r.session.id } });
    setBottomTab('review');
  }, [r.session, reviewPost, setBottomTab]);

  // after submit the new thread stays OPEN at its line until collapsed
  const reviewComment = useCallback(async (c: { path: string; line: number; line_end?: number; step?: number; before: string[]; anchor: string; after: string[]; body: string }) => {
    if (!activeReview || !cwd) return;
    try {
      const res = await fetch('/api/review-comment', { method: 'POST', body: JSON.stringify({ pwd: cwd, id: activeReview.id, comment: c }) });
      const updated: Review = await res.json();
      setReviews((cur) => cur.map((v) => (v.id === updated.id ? updated : v)));
      const newest = updated.comments.at(-1);
      if (newest) setFocusThreadId(newest.id);
    } catch { /* next poll reconciles */ }
  }, [activeReview, cwd]);

  const openReviewComment = useCallback((_review: Review, c: ReviewComment) => {
    // the live tab first: when the session view holds content the comment
    // resolves in, the thread shows there; the disk file is the fallback
    const tab = r.view.tabs.find((t) => normPath(t.path) === normPath(c.path));
    if (tab?.mode === 'file' && tab.render.content !== undefined
      && resolveWaypoint(tab.render.content, { path: c.path, line: c.line, note: '', before: c.before, anchor: c.anchor, after: c.after }) !== null) {
      setPinnedOverride(c.path);
      setEditorTab('pinned');
      setFocusThreadId(c.id);
      return;
    }
    const m = c.path.match(/^(.*)[\\/]([^\\/]+)$/);
    if (!m) return;
    fetch(`/api/fs/read?root=${encodeURIComponent(m[1])}&path=${encodeURIComponent(m[2])}`)
      .then((res) => res.json())
      .then((d: { content?: string }) => {
        const found = typeof d.content === 'string'
          ? resolveWaypoint(d.content, { path: c.path, line: c.line, note: '', before: c.before, anchor: c.anchor, after: c.after })
          : null;
        const total = typeof d.content === 'string' ? d.content.split('\n').length : c.line;
        openAbs(c.path, found ?? Math.max(1, Math.min(c.line, total)));
        setFocusThreadId(c.id);
      })
      .catch(() => { openAbs(c.path, c.line); setFocusThreadId(c.id); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAbs, r.view.tabs]);

  const reviewViewOriginal = useCallback((c: ReviewComment) => {
    const key = `snapshot:review:${c.id}`;
    setEditorTab(key);
    setUserTabs((tabs) => (tabs.some((t) => t.key === key)
      ? tabs
      : [...tabs, { key, path: c.path, snapshot: { line: c.line, note: c.body, before: c.before, anchor: c.anchor, after: c.after } }]));
  }, []);

  // a waypoint step takes you to it — during playback, live follow, or scrub
  const lastWaypointAt = r.view.waypoints.at(-1)?.touchedAt;
  useEffect(() => {
    const wp = r.view.waypoints.at(-1);
    if (!wp) return;
    if (autoFollow) {
      // pin only when the session view can actually show the card — the
      // file tab holds content the waypoint resolves in. Anything less
      // goes on disk so the tour always lands on a visible note.
      const tab = r.view.tabs.find((t) => normPath(t.path) === normPath(wp.path));
      const showable = tab?.mode === 'file' && tab.render.content !== undefined
        && resolveWaypoint(tab.render.content, wp) !== null;
      if (showable) { setPinnedOverride(wp.path); setEditorTab('pinned'); }
      else openWaypoint(wp);
    } else flash('way');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastWaypointAt]);

  // an agent reply on the active review is a tour stop too: go to the
  // thread, or flash the review tab in quiet mode
  const lastReplies = useRef<{ id: string; count: number } | null>(null);
  useEffect(() => {
    if (!activeReview) { lastReplies.current = null; return; }
    const count = activeReview.comments.reduce((n, c) => n + c.replies.filter((p) => p.author !== 'human').length, 0);
    const prev = lastReplies.current;
    lastReplies.current = { id: activeReview.id, count };
    if (!prev || prev.id !== activeReview.id || count <= prev.count) return;
    if (autoFollow) {
      setBottomOpen(true);
      setBottomTab('review');
      const c = activeReview.comments
        .filter((x) => x.replies.some((p) => p.author !== 'human'))
        .sort((a, b) => (b.replies.at(-1)?.ts ?? 0) - (a.replies.at(-1)?.ts ?? 0))[0];
      if (c) openReviewComment(activeReview, c);
    } else flash('review');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviews]);

  const openFile = useCallback((rel: string) => {
    const root = explorerRoot ?? cwd;
    if (!root) return;
    openAbs(`${root.replace(/[\\/]+$/, '')}/${rel}`);
  }, [cwd, explorerRoot, openAbs]);

  // a changes-tree click: fetch the inline diff and open it as a tab
  const openGitDiff = useCallback((f: GitFile, area: GitSelection['area']) => {
    const root = gitRoot;
    if (!root) return;
    const abs = `${root.replace(/[\\/]+$/, '')}/${f.path}`;
    const key = `diff:${area}:${abs}`;
    const m = abs.match(/^(.*)[\\/]([^\\/]+)$/);
    Promise.all([
      fetch(`/api/git/diff?root=${encodeURIComponent(root)}&path=${encodeURIComponent(f.path)}&staged=${area === 'staged' ? '1' : '0'}`).then((res) => res.json()),
      // the on-disk file rides along so gaps between hunks can expand
      m ? fetch(`/api/fs/read?root=${encodeURIComponent(m[1])}&path=${encodeURIComponent(m[2])}`).then((res) => res.json()).catch(() => ({})) : Promise.resolve({}),
    ])
      .then(([d, fileData]) => {
        const fileLines = typeof fileData?.content === 'string' ? fileData.content.replace(/\r\n/g, '\n').split('\n') : undefined;
        if (fileLines?.at(-1) === '') fileLines.pop(); // the trailing newline is not a line
        setUserTabs((tabs) => {
          const tab = { key, path: abs, nonce: openSeq.current++, diff: { hunks: d.hunks ?? [], area, fileLines } };
          return tabs.some((t) => t.key === key) ? tabs.map((t) => (t.key === key ? { ...t, ...tab } : t)) : [...tabs, tab];
        });
        setEditorTab(key);
      })
      .catch(() => { /* refresh will heal it */ });
  }, [gitRoot]);

  // terminal file:line links; relative paths resolve against the project cwd
  const openFileRef = useCallback((p: string, line?: number) => {
    const abs = /^[A-Za-z]:[\\/]|^[\\/]/.test(p) ? p : cwd ? `${cwd.replace(/[\\/]+$/, '')}/${p}` : null;
    if (abs) openAbs(abs, line);
  }, [cwd, openAbs]);

  const closeFile = useCallback((key: string) => {
    setUserTabs((tabs) => tabs.filter((t) => t.key !== key));
    setEditorTab((cur) => (cur === key ? 'pinned' : cur));
  }, []);

  const closeAllFiles = useCallback(() => {
    setUserTabs([]);
    setTimelinePath(undefined);
    setEditorTab('pinned');
  }, []);

  const currentTool = r.view.currentToolIndex >= 0
    ? (r.steps[r.view.currentToolIndex] as (typeof r.steps[number] & { kind: 'tool' }))
    : undefined;

  // step indices where each bottom pane's content changed — the history
  // bars walk these
  const dataSteps = useMemo(
    () => r.steps.flatMap((s, i) => (s.kind === 'tool' && s.call.verb === 'data' ? [i] : [])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [r.steps, r.head],
  );
  const termSteps = useMemo(
    () => r.steps.flatMap((s, i) => (
      s.kind === 'tool' && s.call.verb !== 'data' && (s.result?.verb ?? s.call.verb) === 'exec' ? [i] : [])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [r.steps, r.head],
  );

  // the active editor view shows a file inside a linked worktree: orange
  // banner, wherever the file came from (explorer, diff, or a subagent)
  const activeViewPath = editorTab === 'pinned' ? pinned?.path
    : editorTab === 'timeline' ? timelinePath
      : userTabs.find((t) => t.key === editorTab)?.path;
  const activeWt = worktreeOf(activeViewPath);

  // ---- the global keyboard: app chords work everywhere (live terminal
  // included — xterm declines them); transport keys are CONTEXTUAL: a pane
  // with its own history bar owns prev/next/first/last while focus is in it,
  // everywhere else they drive the session playhead ----
  const termCtl = useRef<{ startNew: () => void; focusOrNext: (fromTerm: boolean) => void; cycle: (dir: 1 | -1) => void; confirmKill: () => void } | null>(null);
  const [quick, setQuick] = useState<null | 'grep' | 'file'>(null);
  const editorOrder = useMemo(
    () => ['pinned', ...(timelinePath ? ['timeline'] : []), ...userTabs.map((t) => t.key)],
    [timelinePath, userTabs],
  );
  useEffect(() => {
    const focusTerm = () => requestAnimationFrame(() => {
      ([...document.querySelectorAll('.livePane .xterm-helper-textarea')]
        .find((x) => (x as HTMLElement).offsetParent !== null) as HTMLElement | undefined)?.focus();
    });
    // a tab jump is a jump: focus lands IN the pane, so arrows work
    // immediately (double rAF: the tab switch has to render first)
    const focusPane = (rootSel: string) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const body = document.querySelector(`${rootSel} .tabBody:not(.hiddenTab)`) as HTMLElement | null;
      const inner = (body?.querySelector('[tabindex]') as HTMLElement | null)
        ?? (body?.hasAttribute('tabindex') ? body : null)
        ?? (body?.querySelector('textarea') as HTMLElement | null);
      inner?.focus();
    }));
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      const el = t instanceof Element ? t : null;
      // typing is typing: text inputs never trigger chords and never arm
      // sequences (the leader must not eat a space mid-sentence). The live
      // terminal's textarea is the exception — xterm releases app chords.
      if ((t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) && !el?.closest('.livePane')) return;
      const chord = actionOf(e, APP_CHORDS.filter((a) => a !== 'playHome' && a !== 'playEnd'));
      if (chord) {
        e.preventDefault();
        e.stopPropagation();
        switch (chord) {
          case 'gotoTools': setLeftOpen(true); setLeftTab('tools'); focusPane('.sidebar'); break;
          case 'gotoExplorer': setLeftOpen(true); setLeftTab('explorer'); focusPane('.sidebar'); break;
          case 'gotoGit': setLeftOpen(true); setLeftTab('git'); focusPane('.sidebar'); break;
          case 'gotoChat': setRightOpen(true); setRightTab('chat'); focusPane('.rightPane'); break;
          case 'gotoLiveTerm': setRightOpen(true); setRightTab('term'); focusTerm(); break;
          case 'gotoAgentTerm': setBottomOpen(true); setBottomTab('term'); focusPane('.bottomPane'); break;
          case 'gotoData': setBottomOpen(true); setBottomTab('data'); focusPane('.bottomPane'); break;
          case 'gotoWayfinder': setBottomOpen(true); setBottomTab('way'); focusPane('.bottomPane'); break;
          case 'gotoReview': setBottomOpen(true); setBottomTab('review'); focusPane('.bottomPane'); break;
          case 'gotoToolDetail': setBottomOpen(true); setBottomTab('tool'); focusPane('.bottomPane'); break;
          case 'bufferPrev':
          case 'bufferNext': {
            const i = Math.max(0, editorOrder.indexOf(editorTab));
            const n = editorOrder.length;
            setEditorTab(editorOrder[(i + (chord === 'bufferNext' ? 1 : n - 1)) % n]);
            break;
          }
          case 'paneNext':
          case 'panePrev': {
            // cycle the tabs of whatever panel holds focus, focus following
            const dir = chord === 'paneNext' ? 1 : -1;
            const cycle = (order: readonly string[], cur: string, set: (t: string) => void) => {
              const i = Math.max(0, order.indexOf(cur));
              set(order[(i + dir + order.length) % order.length]);
            };
            if (el?.closest('.sidebar')) {
              cycle(['tools', 'explorer', 'git'], leftTab, (t) => setLeftTab(t as typeof leftTab));
              focusPane('.sidebar');
            } else if (el?.closest('.bottomPane')) {
              cycle(['term', 'data', 'way', 'review', 'tool'], bottomTab, (t) => setBottomTab(t as typeof bottomTab));
              focusPane('.bottomPane');
            } else if (el?.closest('.rightPane')) {
              cycle(['chat', 'term'], rightTab, (t) => setRightTab(t as typeof rightTab));
              focusPane('.rightPane');
            } else {
              cycle(editorOrder, editorTab, setEditorTab);
              focusEditor();
            }
            break;
          }
          case 'openTimeline':
            if (activeViewPath) { setTimelinePath(activeViewPath); setEditorTab('timeline'); }
            break;
          case 'openReal':
            // snapshot, diff, or the LIVE view: jump to the on-disk file
            if (activeViewPath) openAbs(activeViewPath);
            break;
          case 'grep': setQuick('grep'); break;
          case 'findFile': setQuick('file'); break;
          case 'closeTab':
            if (editorTab === 'timeline') { setTimelinePath(undefined); setEditorTab('pinned'); }
            else if (editorTab !== 'pinned') closeFile(editorTab);
            break;
          case 'termFocus':
            setRightOpen(true); setRightTab('term');
            termCtl.current?.focusOrNext(!!el?.closest('.livePane'));
            focusTerm();
            break;
          case 'termNew':
            setRightOpen(true); setRightTab('term');
            termCtl.current?.startNew();
            focusTerm();
            break;
          case 'termNext':
          case 'termPrev':
            setRightOpen(true); setRightTab('term');
            termCtl.current?.cycle(chord === 'termNext' ? 1 : -1);
            focusTerm();
            break;
          case 'termKill':
            setRightOpen(true); setRightTab('term');
            termCtl.current?.confirmKill();
            break;
          default: { // tab1..tab9: pick from the editor strip by position
            const idx = Number(chord.slice(3)) - 1;
            if (editorOrder[idx]) setEditorTab(editorOrder[idx]);
          }
        }
        return;
      }
      // a leader keystroke (space, ctrl+b, g...) armed a sequence: consume
      // it silently — it must not ALSO play/pause or reach anything else
      if (justArmed(e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (el?.closest('.livePane')) return; // plain keys belong to the live terminal
      const action = actionOf(e, ['playPause', 'stepBack', 'stepForward', 'playHome', 'playEnd']);
      if (!action) return;
      const bar = el?.closest('.tabBody, .editorSlot')?.querySelector('.histBar');
      const press = (title: string) => { (bar?.querySelector(`button[title="${title}"]`) as HTMLButtonElement | null)?.click(); };
      if (action === 'playPause') { e.preventDefault(); r.togglePlay(); }
      else if (action === 'stepBack') { if (bar) press('Previous change'); else r.stepBy(-1); }
      else if (action === 'stepForward') { if (bar) press('Next change'); else r.stepBy(1); }
      else if (action === 'playHome') { e.preventDefault(); if (bar) press('First change'); else r.jump(0); }
      else if (action === 'playEnd') { e.preventDefault(); if (bar) press('Last change'); else r.jump(Math.max(0, r.steps.length - 1)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [r, editorOrder, editorTab, activeViewPath, openAbs, closeFile, leftTab, bottomTab, rightTab, setLeftOpen, setRightOpen, setBottomOpen, setLeftTab, setRightTab, setBottomTab]);

  // agents see the git surface through workspace_state: the selection, the
  // open diff, and the worktree — "commit these 3 files" resolves from here
  useEffect(() => {
    const active = userTabs.find((t) => t.key === editorTab);
    updateSnapshot({
      git: {
        root: gitRoot || null,
        selection: gitSelection,
        commits: gitCommitSel,
        diff: active?.diff ? { path: active.path, area: active.diff.area } : null,
      },
      explorer: { root: explorerRoot ?? cwd ?? null, selection: explorerSelection },
      worktree: explorerRoot ?? null,
      data_selection: dataSel.length && r.view.data?.table
        ? { title: r.view.data.title, rows: dataSel.map((i) => r.view.data!.table!.rows[i]).filter(Boolean) }
        : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gitRoot, gitSelection, gitCommitSel, editorTab, userTabs, explorerRoot, explorerSelection, cwd, dataSel]);

  const cols = [leftOpen ? `${sideW}px 5px` : '', '1fr', rightOpen ? `5px ${rightW}px` : ''].join(' ');

  return (
    <div className="app">
      <div className="titlebar">
        <span className="logo">⏱ Agent McFly</span>
        {pwd && <span className="pwdChip" title={pwd}>{folder}</span>}
        <button onClick={() => setPickerOpen(true)} title="Open a session">
          <span className="codicon codicon-folder-opened" /> open
        </button>
        {r.session && (() => {
          // the chip is the agent hierarchy of the current view: root session
          // down to whichever agent you are inside, however deep
          const chain: typeof r.agents = [];
          for (let k: string | null = r.viewKey; k; ) {
            const n = r.agents.find((a) => a.key === k);
            if (!n) break;
            chain.unshift(n);
            k = n.parentKey;
          }
          if (!chain.length) chain.push({ key: 'main', parentKey: null, label: r.session.label || r.session.id.slice(0, 8) });
          return (
            <span className="crumb">
              {chain.map((n, i) => (
                <span key={n.key} className="crumbStep">
                  {i > 0 && <span className="crumbSep">›</span>}
                  <span
                    className={`sessionChip ${n.key === r.viewKey ? 'cur' : ''}`}
                    title={n.label}
                    onClick={() => n.key !== r.viewKey && r.switchView(n.key)}
                  >{n.label}</span>
                </span>
              ))}
            </span>
          );
        })()}
        <span className="titleRight">
          {r.session && (
            <button
              className={`liveToggle ${r.follow ? 'on' : ''}`}
              title={r.follow
                ? 'Following the end of the session. Click to stop.'
                : 'Jump to the end and follow new activity live.'}
              onClick={() => {
                if (r.follow) { r.stopLive(); return; }
                setPinnedOverride(undefined); // live means the end, hold included
                r.goLive();
              }}
            ><span className="liveDotT">●</span> LIVE</button>
          )}
          <button
            className={`tourToggle ${autoFollow ? 'on' : ''}`}
            title={autoFollow
              ? 'Tour guide ON: the view takes you to files, tables, and waypoints as they happen. Click to wander freely.'
              : 'Tour guide OFF: activity flashes its tab instead of moving you. Click to be shown around.'}
            onClick={() => {
              if (!autoFollow) setPinnedOverride(undefined); // tour back on: release any hold
              setAutoFollow(!autoFollow);
            }}
          >
            <span className={`codicon codicon-${autoFollow ? 'eye' : 'eye-closed'}`} />
          </button>
          <span className="layoutToggles">
            <button className={leftOpen ? 'on' : ''} title="Toggle left pane" onClick={() => setLeftOpen(!leftOpen)}>◧</button>
            <button className={bottomOpen ? 'on' : ''} title="Toggle bottom pane" onClick={() => setBottomOpen(!bottomOpen)}>⬓</button>
            <button className={rightOpen ? 'on' : ''} title="Toggle right pane" onClick={() => setRightOpen(!rightOpen)}>◨</button>
          </span>
          <button className="tourToggle" title="Settings and keybindings" onClick={() => setSettingsOpen(true)}>
            <span className="codicon codicon-settings-gear" />
          </button>
        </span>
      </div>

      <div className="workbench" style={{ gridTemplateColumns: cols }} onKeyDown={workbenchKeys}>
        {leftOpen && (
          <>
            <div className="sidebar" onKeyDown={sidebarKeys} onFocusCapture={(e) => { lastSideFocus.current = e.target as HTMLElement; }}>
              {r.session && (
                <>
                  <div className="agentsSection" style={{ height: agentsH }}>
                    <div className="sideHead">AGENTS</div>
                    <AgentTree agents={r.agents} viewKey={r.viewKey} onSelect={openAgent} />
                  </div>
                  <Splitter dir="row" onDrag={dragAgents} />
                </>
              )}
              <div className="paneTabs" ref={leftStripRef} tabIndex={-1} onKeyDown={stripKeys(['tools', 'explorer', 'git'], leftTab, (t) => setLeftTab(t as typeof leftTab))}>
                <div className={`paneTab ${leftTab === 'tools' ? 'active' : ''}`} onClick={() => setLeftTab('tools')}>TOOL CALLS</div>
                <div className={`paneTab ${leftTab === 'explorer' ? 'active' : ''}`} onClick={() => setLeftTab('explorer')}>EXPLORER</div>
                <div className={`paneTab ${leftTab === 'git' ? 'active' : ''}`} onClick={() => setLeftTab('git')}>GIT</div>
              </div>
              <div className={leftTab === 'tools' ? 'tabBody' : 'tabBody hiddenTab'}>
                <ToolLog
                  key={`${r.session?.id}:${r.viewKey}`}
                  steps={r.steps} pointer={r.pointer} currentToolIndex={r.view.currentToolIndex} onJump={r.jump}
                  seekTick={r.seekTick}
                  visible={leftTab === 'tools'}
                  onEscapeTop={() => leftStripRef.current?.focus()}
                />
              </div>
              <div className={leftTab === 'explorer' ? 'tabBody' : 'tabBody hiddenTab'}>
                {explorerRoot && cwd && normPath(explorerRoot) !== normPath(cwd) && (
                  <div className="wtBanner">
                    <span className="codicon codicon-git-branch" />
                    WORKTREE · {worktreeList.find((w) => normPath(w.path) === normPath(explorerRoot))?.branch ?? explorerRoot.split(/[\\/]/).pop()}
                    <span className="wtBannerAction" onClick={() => setExplorerRoot(undefined)}>back to main</span>
                  </div>
                )}
                <Explorer key={explorerRoot ?? cwd} root={explorerRoot ?? cwd} onOpen={openFile} selection={explorerSelection} onSelect={setExplorerSelection} onEscapeTop={() => leftStripRef.current?.focus()} />
              </div>
              <div className={leftTab === 'git' ? 'tabBody' : 'tabBody hiddenTab'}>
                <GitPane
                  root={gitRoot}
                  visible={leftTab === 'git'}
                  selection={gitSelection}
                  onSelect={setGitSelection}
                  commitSelection={gitCommitSel}
                  onSelectCommits={setGitCommitSel}
                  onOpenDiff={openGitDiff}
                  onOpenWorktree={openWorktree}
                  currentRoot={explorerRoot ?? cwd ?? ''}
                  onEscapeTop={() => leftStripRef.current?.focus()}
                />
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
              onSelect={(k) => {
                // re-clicking the pinned tab releases a tour-off hold
                if (k === 'pinned' && editorTab === 'pinned') setPinnedOverride(undefined);
                setEditorTab(k);
              }}
              onClose={closeFile}
              onOpenCurrent={openAbs}
              timelinePath={timelinePath}
              onOpenTimeline={(p) => { setTimelinePath(p); setEditorTab('timeline'); }}
              onCloseTimeline={() => { setTimelinePath(undefined); setEditorTab('pinned'); }}
              timelineBody={timelinePath && (
                <FileTimeline steps={r.steps} pointer={r.pointer} path={timelinePath} speed={r.speed} onJump={r.jump} textSel={textSel} />
              )}
              onToggleWaypoint={toggleWaypoint}
              onCloseAll={closeAllFiles}
              textSel={textSel}
              pinnedFlash={flashes.pinned ?? 0}
              pointer={r.pointer}
              worktreeBanner={activeWt ? {
                label: activeWt.branch ?? activeWt.path.split(/[\\/]/).pop() ?? activeWt.path,
                // the jump only offers itself when the explorer is elsewhere
                ...(normPath(activeWt.path) !== normPath(explorerRoot ?? cwd ?? '')
                  ? { onOpen: () => openWorktree(activeWt.path) } : {}),
              } : undefined}
              waypoints={r.view.waypoints}
              onOpenSnapshot={openSnapshot}
              onActivateWaypoint={activateTabWaypoint}
              activeReview={activeReview}
              focusThreadId={focusThreadId}
              onReviewComment={reviewComment}
              onReviewReply={(commentId, body) => reviewPost('/api/review-reply', { commentId, body, author: 'human' })}
              onReviewResolve={(commentId) => activeReview && reviewPost('/api/review-thread-state', { id: activeReview.id, commentId, state: 'resolved' })}
              onReviewViewOriginal={reviewViewOriginal}
              vim={vimMode}
            />
          </div>
          {bottomOpen && (
            <>
              <Splitter dir="row" onDrag={(dy) => {
                const h = centerRef.current?.clientHeight ?? 900;
                dragEdit((dy / h) * 100);
              }} />
              <div className="bottomPane">
                <div className="paneTabs" ref={bottomStripRef} tabIndex={-1} onKeyDown={stripKeys(['term', 'data', 'way', 'review', 'tool'], bottomTab, (t) => setBottomTab(t as typeof bottomTab))}>
                  <div key={`t${flashes.term ?? 0}`} className={`paneTab ${bottomTab === 'term' ? 'active' : ''} ${flashes.term ? 'tabFlashAnim' : ''}`} onClick={() => setBottomTab('term')}>
                    AGENT TERMINAL <span className="roBadge">read only</span>
                  </div>
                  <div key={`d${flashes.data ?? 0}`} className={`paneTab ${bottomTab === 'data' ? 'active' : ''} ${flashes.data ? 'tabFlashAnim' : ''}`} onClick={() => setBottomTab('data')}>
                    DATA
                  </div>
                  <div key={`w${flashes.way ?? 0}`} className={`paneTab wayfinderTab ${bottomTab === 'way' ? 'active' : ''} ${flashes.way ? 'tabFlashAnim' : ''}`} onClick={() => setBottomTab('way')}>
                    WAYFINDER{r.view.waypoints.length > 0 && <span className="wfCount">{r.view.waypoints.length}</span>}
                  </div>
                  <div key={`r${flashes.review ?? 0}`} className={`paneTab reviewTab ${bottomTab === 'review' ? 'active' : ''} ${flashes.review ? 'tabFlashAnim' : ''}`} onClick={() => setBottomTab('review')}>
                    HUMAN REVIEW{activeReview && <span className="wfCount rvCount">{activeReview.comments.filter((c) => c.state !== 'resolved').length}</span>}
                  </div>
                  <div className={`paneTab ${bottomTab === 'tool' ? 'active' : ''}`} onClick={() => setBottomTab('tool')}>
                    TOOL CALL
                  </div>
                </div>
                {/* tabIndex: a click parks focus here, so the transport keys
                    (prev/next/first/last) drive THIS pane's history bar */}
                <div className={bottomTab === 'term' ? 'tabBody' : 'tabBody hiddenTab'} tabIndex={-1} onKeyDown={scrollKeys}>
                  <HistoryBar positions={termSteps} pointer={r.pointer} onJump={r.jump} />
                  <Terminal blocks={r.view.term} animatedAt={animatedTermAt} speed={r.speed} seekTick={r.seekTick} visible={bottomTab === 'term'} />
                </div>
                <div className={bottomTab === 'data' ? 'tabBody' : 'tabBody hiddenTab'} tabIndex={-1} onKeyDown={scrollKeys}>
                  <HistoryBar positions={dataSteps} pointer={r.pointer} onJump={r.jump} />
                  <DataPane data={r.view.data} animate={r.view.data?.touchedAt === r.animateIndex} selection={dataSel} onRowClick={dataRowClick} />
                </div>
                <div className={bottomTab === 'way' ? 'tabBody' : 'tabBody hiddenTab'} tabIndex={-1}>
                  <Wayfinder waypoints={r.view.waypoints} onSelect={openWaypoint} onEscapeTop={() => bottomStripRef.current?.focus()} />
                </div>
                <div className={bottomTab === 'review' ? 'tabBody' : 'tabBody hiddenTab'} tabIndex={-1}>
                  <HumanReview
                    active={activeReview}
                    sessionLoaded={!!r.session}
                    onCreate={createReview}
                    onClose={() => activeReview && reviewPost('/api/review-close', { id: activeReview.id })}
                    onOpenComment={openReviewComment}
                    onEscapeTop={() => bottomStripRef.current?.focus()}
                  />
                </div>
                <div className={bottomTab === 'tool' ? 'tabBody' : 'tabBody hiddenTab'} tabIndex={-1} onKeyDown={scrollKeys}>
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
              <div className="paneTabs" ref={rightStripRef} tabIndex={-1} onKeyDown={stripKeys(['chat', 'term'], rightTab, (t) => setRightTab(t as typeof rightTab))}>
                <div className={`paneTab ${rightTab === 'chat' ? 'active' : ''}`} onClick={() => setRightTab('chat')}>CHAT</div>
                <div className={`paneTab ${rightTab === 'term' ? 'active' : ''}`} onClick={() => setRightTab('term')}>LIVE TERMINAL</div>
              </div>
              <div className={rightTab === 'chat' ? 'tabBody rightChat' : 'tabBody rightChat hiddenTab'}>
                <ChatPane
                  steps={r.steps}
                  pointer={r.pointer}
                  animateIndex={r.animateIndex}
                  seekTick={r.seekTick}
                  onJump={r.jump}
                  onOpenAgent={openAgent}
                  visible={rightTab === 'chat'}
                  onEscapeTop={() => rightStripRef.current?.focus()}
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
                  onFollowResolve={(p) => void followResolve({ title: p.title, cwd: p.cwd || pwd || '' })}
                  ctl={termCtl}
                />
              </div>
            </div>
          </>
        )}
      </div>

      <Transport r={r} />

      {pickerOpen && (
        <SessionPicker
          initialPwd={pickerSeed?.pwd ?? pwd ?? ''}
          initialProvider={pickerSeed?.provider}
          initialFilter={pickerSeed?.filter}
          onPick={applyPick}
          onGo={scopeFolder}
          onClose={() => { setPickerOpen(false); setPickerSeed(undefined); }}
        />
      )}

      {settingsOpen && settings && (
        <Settings settings={settings} onSave={saveSettings} onClose={() => setSettingsOpen(false)} />
      )}

      {quick && (
        <QuickPick
          key={quick}
          title={quick === 'grep' ? 'grep' : 'find file'}
          placeholder={quick === 'grep' ? 'regex…' : 'file name…'}
          onQuery={async (q) => {
            const root = explorerRoot ?? cwd;
            if (!root || !q.trim()) return [];
            const kind = quick === 'grep' ? 'grep' : 'files';
            const res = await fetch(`/api/${kind}?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}`)
              .then((r2) => r2.json())
              .catch(() => []);
            if (!Array.isArray(res)) return [];
            return quick === 'grep'
              ? (res as { path: string; line: number; text: string }[]).map((m) => ({
                label: `${m.path}:${m.line}`, detail: m.text.trim().slice(0, 160), path: m.path, line: m.line,
              }))
              : (res as string[]).map((p) => ({ label: p, path: p }));
          }}
          onPick={(it) => {
            setQuick(null);
            const root = explorerRoot ?? cwd;
            if (!root) return;
            openAbs(`${root}/${it.path}`, it.line);
            // the caret follows the pick: onto the match line (grep) or the
            // top of the file (find file). Fired twice — the tab mounts async.
            if (it.line) {
              const line = it.line;
              const go = () => window.dispatchEvent(new CustomEvent('mcfly:goline', { detail: line }));
              setTimeout(go, 300);
              setTimeout(go, 900);
            } else {
              focusEditor(it.path.split('/').pop());
            }
          }}
          onClose={() => setQuick(null)}
        />
      )}
    </div>
  );
}
