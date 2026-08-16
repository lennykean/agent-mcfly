import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Workbench, { shortSessionId, type RootInfo, type UrlState, type WorkbenchHandle, type WsInfo } from './App';
import { LiveTerm, type LinkedRoot, type TermCtl } from './components/LivePane';
import { SessionPicker } from './components/SessionPicker';
import { SshConnect } from './components/SshConnect';
import { PALETTE } from './lib/palette';
import { Settings, type McflySettings } from './components/Settings';
import { applyKeymap, focusEditor, setLeaders, setTmuxMode, setVimMode } from './lib/keys';
import { normPath } from './lib/timeline';
import { sameTerminalProject, terminalProjectKey, type TerminalProject } from './lib/terminal-project';
import { withConnection } from './lib/api';
import type { SessionMeta, WorkspaceSource } from './types';

// ---- multi-root shell: the URL carries PARALLEL pwd/provider/session query
// arrays (?pwd=A&pwd=B&session=x&session=y — index i is one root workspace;
// repeated pwd values are fine) plus `active` for which root is visible.
// Every root's Workbench stays mounted — switching hides one and shows
// another with all its state (playhead, tabs, carets) intact. ----

interface Ws { id: number; url: UrlState; source?: WorkspaceSource }
type WsSeed = Omit<Ws, 'id'>;
type WorkbenchAction = (handle: WorkbenchHandle) => void;

let nextWsId = 1;

function parseUrl(): { list: WsSeed[]; active: number } {
  const q = new URLSearchParams(location.search);
  const pwds = q.getAll('pwd');
  const provs = q.getAll('provider');
  const sids = q.getAll('session');
  const connections = q.getAll('connection');
  const hosts = q.getAll('host');
  const list: WsSeed[] = pwds.map((p, i) => ({
    url: {
      pwd: p || undefined,
      provider: provs[i] || undefined,
      session: sids[i] || undefined,
    },
    source: connections[i] ? { connection: connections[i], host: hosts[i] || connections[i] } : undefined,
  }));
  if (!list.length) list.push({ url: {} });
  const active = Math.min(Math.max(0, Number(q.get('active') ?? 0) || 0), list.length - 1);
  return { list, active };
}

const folderOf = (p?: string) => p?.replace(/[\\/]+$/, '').split(/[\\/]/).pop();

export default function Shell() {
  const initial = useMemo(parseUrl, []);
  const [wss, setWss] = useState<Ws[]>(() => initial.list.map((seed) => ({ id: nextWsId++, ...seed })));
  const [activeIdx, setActiveIdx] = useState(initial.active);
  const [infos, setInfos] = useState<Record<number, WsInfo>>({});
  const handles = useRef(new Map<number, WorkbenchHandle>());
  const pendingHandleActions = useRef(new Map<number, WorkbenchAction[]>());
  const pendingProjectIds = useRef(new Map<string, number>());
  const activeId = wss[Math.min(activeIdx, wss.length - 1)]?.id;

  const onState = useCallback((wsId: number, info: WsInfo) => {
    setInfos((cur) => (JSON.stringify(cur[wsId]) === JSON.stringify(info) ? cur : { ...cur, [wsId]: info }));
  }, []);
  const registerHandle = useCallback((wsId: number, h: WorkbenchHandle | null) => {
    if (!h) { handles.current.delete(wsId); return; }
    handles.current.set(wsId, h);
    for (const [key, id] of pendingProjectIds.current) {
      if (id === wsId) pendingProjectIds.current.delete(key);
    }
    const pending = pendingHandleActions.current.get(wsId);
    pendingHandleActions.current.delete(wsId);
    pending?.forEach((run) => run(h));
  }, []);

  // the workspace a workbench reports beats the (possibly older) URL intent
  const stateOf = useCallback(
    (w: Ws): UrlState => {
      const i = infos[w.id];
      return i ? { pwd: i.pwd, provider: i.provider, session: i.sessionShort } : w.url;
    },
    [infos],
  );

  // ---- URL writing: parallel arrays, one column per root that has a folder;
  // roots still empty (a fresh ⊕) stay out of the URL until they open one ----
  useEffect(() => {
    const cols = wss.map((w) => ({ w, st: stateOf(w) })).filter((c) => c.st.pwd);
    const params = new URLSearchParams();
    for (const c of cols) params.append('pwd', c.st.pwd!);
    if (cols.some((c) => c.st.provider)) for (const c of cols) params.append('provider', c.st.provider ?? '');
    if (cols.some((c) => c.st.session)) for (const c of cols) params.append('session', c.st.session ?? '');
    if (cols.some((c) => c.w.source)) {
      for (const c of cols) params.append('connection', c.w.source?.connection ?? '');
      for (const c of cols) params.append('host', c.w.source?.host ?? '');
    }
    const activeCol = cols.findIndex((c) => c.w.id === activeId);
    if (activeCol > 0) params.set('active', String(activeCol));
    const next = params.toString();
    if (next !== location.search.replace(/^\?/, '')) {
      history.pushState(null, '', next ? `?${next}` : location.pathname);
    }
  }, [wss, infos, activeId, stateOf]);

  // back/forward: re-adopt the URL; existing workbenches keep their identity
  // by position, extras unmount, new columns mount fresh
  useEffect(() => {
    const onPop = () => {
      const { list, active } = parseUrl();
      setWss((cur) => list.map((seed, i) => ({
        id: cur[i] && cur[i].source?.connection === seed.source?.connection ? cur[i].id : nextWsId++,
        ...seed,
      })));
      setActiveIdx(active);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // ---- settings: one popover, one persisted file, one keymap module sync ----
  const [settings, setSettings] = useState<McflySettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<false | 'settings' | 'keys'>(false);
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
  // the keymap tables follow the settings; keysVersion tells the grid the
  // MODULE is now in sync (it reads module state, which lags one render)
  const [keysVersion, setKeysVersion] = useState(0);
  useEffect(() => {
    if (!settings) return;
    setLeaders(settings.vimLeader, settings.tmuxPrefix);
    setVimMode(!!settings.vim);
    setTmuxMode(!!settings.tmux);
    applyKeymap(settings.keymap ?? {});
    setKeysVersion((v) => v + 1);
  }, [settings]);
  const onOpenSettings = useCallback((page: 'settings' | 'keys') => setSettingsOpen(page), []);

  // ---- root colors: ephemeral, random from the 16-grid, never two alike ----
  const [colors, setColors] = useState<Record<number, number>>({});
  useEffect(() => {
    setColors((cur) => {
      const missing = wss.filter((w) => cur[w.id] === undefined);
      if (!missing.length) return cur;
      const next = { ...cur };
      for (const w of missing) {
        const taken = Object.values(next);
        const free = PALETTE.map((_, i) => i).filter((i) => !taken.includes(i));
        const pool = free.length ? free : PALETTE.map((_, i) => i);
        next[w.id] = pool[Math.floor(Math.random() * pool.length)];
      }
      return next;
    });
  }, [wss]);
  const onPickColor = useCallback((idx: number) => {
    const cur = wssRef.current;
    const me = cur[Math.min(activeIdxRef.current, cur.length - 1)]?.id;
    if (me === undefined) return;
    setColors((c) => (Object.entries(c).some(([k, v]) => Number(k) !== me && v === idx)
      ? c : { ...c, [me]: idx }));
  }, []);

  // ---- terminals⇄sessions sync: OFF by default; when on, picking an agent
  // reveals its linked terminal and picking a linked terminal switches the
  // workbench. Ephemeral, like the colors. ----
  const [sync, setSync] = useState(false);
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const onToggleSync = useCallback(() => setSync((v) => !v), []);
  // autoSync is the START state (like autoLive/autoTour): applied once when
  // the settings land; the titlebar toggle stays the in-the-moment control
  const syncSeeded = useRef(false);
  useEffect(() => {
    if (!settings || syncSeeded.current) return;
    syncSeeded.current = true;
    if (settings.autoSync) setSync(true);
  }, [settings]);

  // AGENTS tree folds: shell-owned so they survive root adds/switches (every
  // workbench renders the same panel; per-instance state would reset)
  const [treeCollapsed, setTreeCollapsed] = useState<ReadonlySet<string>>(new Set());
  const onTreeToggle = useCallback((key: string) => {
    setTreeCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  // ---- roots list for the AGENTS panel (same array to every workbench) ----
  const roots = useMemo<RootInfo[]>(() => wss.map((w) => ({
    id: w.id,
    label: infos[w.id]?.label ?? folderOf(infos[w.id]?.pwd ?? w.url.pwd) ?? 'new workspace',
    active: w.id === activeId,
    hasSession: !!infos[w.id]?.sessionFull,
    pwd: infos[w.id]?.pwd ?? w.url.pwd,
    color: PALETTE[colors[w.id] ?? 0],
    colorIndex: colors[w.id] ?? 0,
    agents: infos[w.id]?.agents,
    source: w.source,
  })), [wss, infos, activeId, colors]);

  const wssRef = useRef(wss);
  wssRef.current = wss;
  const infosRef = useRef(infos);
  infosRef.current = infos;
  const activeIdxRef = useRef(activeIdx);
  activeIdxRef.current = activeIdx;

  const switchToId = useCallback((wsId: number) => {
    const i = wssRef.current.findIndex((w) => w.id === wsId);
    if (i >= 0) setActiveIdx(i);
  }, []);

  // ⊕ opens the SHELL's picker; a root is only ever created from a COMPLETED
  // intent (a picked session or an explicit bare folder). No empty scaffold
  // roots exist, so there is nothing to clean up on cancel.
  const [addPicker, setAddPicker] = useState<{ source?: WorkspaceSource; initialPwd?: string; followPty?: string; disconnectOnCancel?: boolean } | null>(null);
  const [sshOpen, setSshOpen] = useState(false);
  const onAddRoot = useCallback(() => setAddPicker({}), []);
  const onAddRemote = useCallback(() => setSshOpen(true), []);
  const closeAddPicker = useCallback(() => {
    const connection = addPicker?.source?.connection;
    setAddPicker(null);
    if (connection && addPicker?.disconnectOnCancel
      && !wssRef.current.some((w) => w.source?.connection === connection)) {
      void fetch('/api/ssh/disconnect', { method: 'POST', body: JSON.stringify({ id: connection }) });
    }
    focusEditor();
  }, [addPicker]);
  const attachSession = useCallback((pwd: string, s: SessionMeta) => {
    const source = addPicker?.source;
    setAddPicker(null);
    const hit = findOpen(s, source);
    // already open: go there (focus revives via the workbench's activation
    // effect on a real switch; refocus here covers the already-active case)
    if (hit >= 0) { setActiveIdx(hit); focusEditor(); return; }
    const id = nextWsId++;
    setWss([...wssRef.current, { id, source, url: { pwd, provider: s.provider, session: shortSessionId(s.id) } }]);
    setActiveIdx(wssRef.current.length);
  }, [addPicker]);
  const attachFolder = useCallback((pwd: string) => {
    const source = addPicker?.source;
    setAddPicker(null);
    if (source) {
      const key = normPath(pwd.replace(/[\\/]+$/, ''));
      const hit = wssRef.current.findIndex((w) => w.source?.connection === source.connection
        && normPath((infosRef.current[w.id]?.pwd ?? w.url.pwd ?? '').replace(/[\\/]+$/, '')) === key
        && !infosRef.current[w.id]?.sessionFull);
      if (hit >= 0) { setActiveIdx(hit); focusEditor(); return; }
    }
    const id = nextWsId++;
    setWss([...wssRef.current, { id, source, url: { pwd } }]);
    setActiveIdx(wssRef.current.length);
  }, [addPicker]);
  const onCloseRoot = useCallback((wsId: number) => {
    const cur = wssRef.current;
    const rest = cur.filter((w) => w.id !== wsId);
    const next = rest.length ? rest : [{ id: nextWsId++, url: {} }];
    const curActive = cur[Math.min(activeIdxRef.current, cur.length - 1)]?.id;
    const keep = next.findIndex((w) => w.id === curActive);
    setWss(next);
    setActiveIdx(keep >= 0 ? keep : Math.max(0, Math.min(activeIdxRef.current, next.length - 1)));
    setInfos((c) => {
      const { [wsId]: _gone, ...restInfo } = c;
      return restInfo;
    });
  }, []);

  // ---- the shared live terminal: ONE LiveTerm for all roots, portaled into
  // the active workbench's right-pane slot (offscreen keeps it mounted when
  // the slot is closed, so PTY sockets survive) ----
  const termCtl = useRef<TermCtl | null>(null);
  const [slots, setSlots] = useState<Record<number, HTMLDivElement | null>>({});
  const termSlot = useCallback((wsId: number, el: HTMLDivElement | null) => {
    setSlots((cur) => (cur[wsId] === el ? cur : { ...cur, [wsId]: el }));
  }, []);
  // LiveTerm renders ONCE inside a permanent host div; switching roots MOVES
  // that DOM node into the active workspace's slot. A React portal can't do
  // this — changing a portal's container remounts its children, which would
  // drop every PTY socket on a workspace switch. React never reconciles the
  // host again (its props never change), so the manual move is safe.
  const parkRef = useRef<HTMLDivElement>(null);
  const [termHost, setTermHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!termHost) return;
    const dest = (activeId !== undefined ? slots[activeId] : null) ?? parkRef.current;
    if (dest && termHost.parentElement !== dest) {
      // a DOM move blurs whatever was focused inside — restore it, or a
      // terminal click that switches roots leaves the keyboard dead
      const hadFocus = termHost.contains(document.activeElement);
      dest.appendChild(termHost);
      if (hadFocus) {
        ([...termHost.querySelectorAll('.xterm-helper-textarea')]
          .find((x) => (x as HTMLElement).offsetParent !== null) as HTMLElement | undefined)?.focus();
      }
    }
    // back to the park before React could ever try to unmount it elsewhere
    return () => {
      const park = parkRef.current;
      if (park && termHost.parentElement !== park) park.appendChild(termHost);
    };
  }, [termHost, slots, activeId]);

  const findOpen = (s: SessionMeta, source?: WorkspaceSource) => wssRef.current.findIndex((w) => {
    const i = infosRef.current[w.id];
    return w.source?.connection === source?.connection && i?.sessionFull === s.id && i?.provider === s.provider;
  });
  const activeWs = () => wssRef.current[Math.min(activeIdxRef.current, wssRef.current.length - 1)];

  // FOLLOW (the explicit button): attach, never replace — already open in a
  // root switches there; an empty active root adopts it; anything else
  // becomes a NEW root
  const followSession = useCallback((pwd: string, s: SessionMeta, source?: WorkspaceSource) => {
    const hit = findOpen(s, source);
    if (hit >= 0) { setActiveIdx(hit); return; }
    const act = activeWs();
    if (act && act.source?.connection === source?.connection && !infosRef.current[act.id]?.sessionFull) {
      handles.current.get(act.id)?.applyPick(pwd, s);
      return;
    }
    const id = nextWsId++;
    setWss([...wssRef.current, { id, source, url: { pwd, provider: s.provider, session: shortSessionId(s.id) } }]);
    setActiveIdx(wssRef.current.length);
  }, []);

  // a session picked to FOLLOW a specific terminal: tie the pty to it, then
  // attach (the user SPECIFIED the link — honor it even when the title
  // could not resolve automatically)
  const onFollowedPick = useCallback((pwd: string, s: SessionMeta, ptyId?: string, source?: WorkspaceSource) => {
    if (ptyId) {
      void fetch(withConnection('/api/pty-session', source?.connection), {
        method: 'POST',
        body: JSON.stringify({ ptyId, provider: s.provider, session: s.id, pwd }),
      });
    }
    followSession(pwd, s, source);
  }, [followSession]);

  // a session DETECTED from a terminal launch: only auto-open when the
  // active root has no session; otherwise the terminal is tied quietly
  // (the hunt already labeled the PTY) and follow stays a click away
  const autoSessionFound = useCallback((pwd: string, s: SessionMeta, source?: WorkspaceSource) => {
    if (findOpen(s, source) >= 0) return;
    const act = activeWs();
    if (act && act.source?.connection === source?.connection && !infosRef.current[act.id]?.sessionFull) {
      handles.current.get(act.id)?.applyPick(pwd, s);
    }
  }, []);

  // an agent row of another root was picked: switch workbenches, open that
  // agent's view there
  const onSelectAgent = useCallback((wsId: number, key: string) => {
    switchToId(wsId);
    handles.current.get(wsId)?.openAgent(key);
  }, [switchToId]);

  // a session picked in workspace wsId's OWN picker (bare startup, follow
  // resolution). IDEMPOTENT: already open in another root → just go there;
  // otherwise it opens in wsId itself.
  const onPickSession = useCallback((wsId: number, pwd: string, s: SessionMeta) => {
    const source = wssRef.current.find((w) => w.id === wsId)?.source;
    const hit = findOpen(s, source);
    if (hit >= 0 && wssRef.current[hit]?.id !== wsId) {
      setActiveIdx(hit);
      return;
    }
    handles.current.get(wsId)?.applyPick(pwd, s);
  }, []);

  const activeInfo = activeId !== undefined ? infos[activeId] : undefined;
  const activeSource = activeWs()?.source;
  const activeHandle = () => (activeId !== undefined ? handles.current.get(activeId) : undefined);
  const withProjectHandle = (project: TerminalProject | undefined, run: WorkbenchAction) => {
    if (!project) {
      const handle = activeHandle();
      if (handle) run(handle);
      return;
    }
    const ws = wssRef.current.find((w) => {
      const p = infosRef.current[w.id]?.cwd ?? infosRef.current[w.id]?.pwd ?? w.url.pwd;
      return !!p && sameTerminalProject({ cwd: p, source: w.source }, project);
    });
    const handle = ws ? handles.current.get(ws.id) : undefined;
    if (handle) { run(handle); return; }

    const key = terminalProjectKey(project);
    let wsId = ws?.id ?? pendingProjectIds.current.get(key);
    if (wsId === undefined) {
      wsId = nextWsId++;
      pendingProjectIds.current.set(key, wsId);
      const next = [...wssRef.current, { id: wsId, source: project.source, url: { pwd: project.cwd } }];
      wssRef.current = next;
      setWss(next);
      setActiveIdx(next.length - 1);
    }
    pendingHandleActions.current.set(wsId, [...(pendingHandleActions.current.get(wsId) ?? []), run]);
  };

  // In SYNC mode, a linked terminal follows the workspace switch (and a
  // terminal switch follows back).
  useEffect(() => {
    if (syncRef.current && activeInfo?.provider && activeInfo.sessionFull) {
      termCtl.current?.showSession(activeInfo.provider, activeInfo.sessionFull, activeSource);
    }
  }, [activeId, activeInfo?.cwd, activeInfo?.pwd, activeInfo?.provider, activeInfo?.sessionFull, activeSource?.connection]);

  // a USER terminal-tab switch in SYNC mode: jump to the root workspace
  // linked to that terminal's session, if one is open
  const onActiveSession = useCallback((sess: { provider: string; id: string } | null, source?: WorkspaceSource) => {
    if (!sess || !syncRef.current) return;
    const i = wssRef.current.findIndex((w) => {
      const inf = infosRef.current[w.id];
      return w.source?.connection === source?.connection
        && inf?.sessionFull === sess.id && inf?.provider === sess.provider;
    });
    if (i >= 0) setActiveIdx(i);
  }, []);

  // the distinct open project folders, for the terminal's project tabs
  const projects = useMemo(() => {
    const seen = new Set<string>();
    const out: TerminalProject[] = [];
    for (const w of wss) {
      const p = infos[w.id]?.pwd ?? w.url.pwd;
      if (!p) continue;
      const project = { cwd: p, source: w.source };
      const key = terminalProjectKey(project);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(project);
    }
    return out;
  }, [wss, infos]);

  // terminals tied to an OPEN root get the green dot, the agent's name, and
  // (with 2+ roots) the root's color on their tab
  const linkedRoots = useMemo<LinkedRoot[]>(() => wss.flatMap((w) => {
    const i = infos[w.id];
    if (!i?.provider || !i.sessionFull) return [];
    return [{
      provider: i.provider,
      id: i.sessionFull,
      label: i.label ?? folderOf(i.pwd) ?? 'agent',
      color: wss.length > 1 ? PALETTE[colors[w.id] ?? 0] : undefined,
      active: w.id === activeId,
      source: w.source,
    }];
  }), [wss, infos, colors, activeId]);

  return (
    <>
      {wss.map((w) => (
        <div key={w.id} className="wsHost" style={{ display: w.id === activeId ? 'contents' : 'none' }}>
          <Workbench
            wsId={w.id}
            active={w.id === activeId}
            source={w.source}
            url={w.url}
            roots={roots}
            onState={onState}
            onAddRoot={onAddRoot}
            onAddRemote={onAddRemote}
            onCloseRoot={onCloseRoot}
            onSelectAgent={onSelectAgent}
            onSessionFound={autoSessionFound}
            onPickSession={onPickSession}
            onFollowedPick={onFollowedPick}
            sync={sync}
            onToggleSync={onToggleSync}
            treeCollapsed={treeCollapsed}
            onTreeToggle={onTreeToggle}
            onPickColor={onPickColor}
            settings={settings}
            onOpenSettings={onOpenSettings}
            termCtl={termCtl}
            termSlot={termSlot}
            registerHandle={registerHandle}
          />
        </div>
      ))}

      {/* parking spot keeps the terminal alive when no slot is visible */}
      <div ref={parkRef} style={{ display: 'none' }}>
        <div ref={setTermHost} className="termHost">
          <LiveTerm
            cwd={activeInfo?.cwd ?? activeInfo?.pwd}
            source={activeSource}
            projects={projects}
            currentSession={activeInfo?.provider && activeInfo.sessionFull
              ? { provider: activeInfo.provider, id: activeInfo.sessionFull, source: activeSource } : null}
            linkedRoots={linkedRoots}
            onToolStart={(tool, project) => withProjectHandle(project, (handle) => handle.onToolStart(tool, project?.cwd))}
            onPtyId={(id, tool, fresh, project) => withProjectHandle(project, (handle) => handle.onPtyStart(id, tool, fresh))}
            onOpenFileRef={(p, line, project) => withProjectHandle(project, (handle) => handle.openFileRef(p, line))}
            onFollowSession={(s, source) => followSession(s.pwd || activeInfo?.pwd || '', {
              id: s.id, provider: s.provider,
              label: s.id.split('/').pop() ?? s.id,
              cwd: s.pwd, updated_at: 0, size: 0,
            }, source)}
            onFollowResolve={(p) => {
              withProjectHandle({ cwd: p.cwd, source: p.source }, (handle) => (
                handle.followResolve({ id: p.id, title: p.title, cwd: p.cwd })
              ));
            }}
            onActiveSession={onActiveSession}
            ctl={termCtl}
          />
        </div>
      </div>

      {addPicker && (
        <SessionPicker
          initialPwd={addPicker.initialPwd ?? (!activeWs()?.source ? activeInfo?.pwd ?? '' : '')}
          source={addPicker.source}
          onPick={(pwd, session) => {
            if (addPicker.followPty) {
              setAddPicker(null);
              onFollowedPick(pwd, session, addPicker.followPty, addPicker.source);
            }
            else attachSession(pwd, session);
          }}
          onGo={attachFolder}
          onClose={closeAddPicker}
        />
      )}

      {sshOpen && (
        <SshConnect
          onConnected={(source, home) => {
            setSshOpen(false);
            setAddPicker({ source, initialPwd: home, disconnectOnCancel: true });
          }}
          onClose={() => { setSshOpen(false); focusEditor(); }}
        />
      )}

      {settingsOpen && settings && (
        <Settings
          settings={settings}
          initialPage={settingsOpen}
          keysVersion={keysVersion}
          onSave={saveSettings}
          onClose={() => { setSettingsOpen(false); focusEditor(); }}
        />
      )}
    </>
  );
}
