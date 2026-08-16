import { useEffect, useMemo, useRef, useState } from 'react';
import { withConnection } from '../lib/api';
import type { SessionMeta, WorkspaceSource } from '../types';

interface ProviderInfo { provider: string; count: number }

const PROVIDER_LABELS: Record<string, string> = { 'claude-code': 'claude', codex: 'codex' };

// Open-session flow: choose a folder -> confirm session history -> agent type
// -> type-ahead over that project's sessions. Opening only the project is a
// separate action. The ... button browses folders through the server.
export function SessionPicker({ initialPwd, initialProvider, initialFilter, source, onPick, onGo, onClose }: {
  initialPwd: string;
  initialProvider?: string; // pre-select this agent and load its sessions
  initialFilter?: string; // pre-fill the filter (e.g. an ambiguous title match)
  source?: WorkspaceSource;
  onPick: (pwd: string, session: SessionMeta) => void;
  onGo?: (pwd: string) => void; // scope the workbench to this folder, no session needed
  onClose: () => void;
}) {
  // the currently-open project wins; last-used pwd only seeds a bare open
  const [pwd, setPwd] = useState(() => initialPwd || (!source ? localStorage.getItem('mcfly.lastPwd') : '') || '');
  const endpoint = (path: string) => withConnection(path, source?.connection);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const projectRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    projectRef.current?.focus();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [provider, setProvider] = useState<string>();
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  const [filter, setFilter] = useState('');
  const [hi, setHi] = useState(0);
  const [scanning, setScanning] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const providerLoad = useRef(0);
  const sessionLoad = useRef(0);

  // server-backed folder browser (the native dialog cannot give real paths)
  const [browse, setBrowse] = useState<string | null>(null);
  const [browseDirs, setBrowseDirs] = useState<string[] | null>(null);
  useEffect(() => {
    if (browse === null) return;
    setBrowseDirs(null);
    fetch(endpoint(`/api/fs/list?root=${encodeURIComponent(browse)}&path=`))
      .then((r) => r.json())
      .then((d) => setBrowseDirs(Array.isArray(d) ? d.filter((e) => e.dir).map((e) => e.name) : []))
      .catch(() => setBrowseDirs([]));
  }, [browse, source?.connection]); // eslint-disable-line react-hooks/exhaustive-deps
  const atRoot = browse !== null && (browse === '/' || /^[A-Za-z]:[\\/]?$/.test(browse));
  const browseUp = () => setBrowse((b) => {
    if (b === null || atRoot) return b;
    const clean = b.replace(/[\\/]+$/, '');
    const cut = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
    if (cut === 0) return '/';
    if (cut === 2 && /^[A-Za-z]:/.test(clean)) return clean.slice(0, 3);
    return cut > 0 ? clean.slice(0, cut) : clean;
  });
  const browseInto = (name: string) => {
    if (browse === null) return;
    const slash = browse.includes('\\') || /^[A-Za-z]:/.test(browse) ? '\\' : '/';
    setBrowse(browse === '/' ? `/${name}` : `${browse.replace(/[\\/]+$/, '')}${slash}${name}`);
  };
  const go = (raw: string) => {
    const clean = raw.trim();
    const dir = clean === '/' ? clean : clean.replace(/[\\/]+$/, '');
    if (!dir) return;
    onGo?.(dir);
  };

  const loadProviders = (dir: string) => {
    if (!dir.trim()) return;
    const load = ++providerLoad.current;
    setScanning(true);
    setProviders(null);
    setProvider(undefined);
    setSessions(null);
    sessionLoad.current++;
    fetch(endpoint(`/api/providers?pwd=${encodeURIComponent(dir)}`))
      .then((r) => r.json())
      .then((d) => { if (load === providerLoad.current) setProviders(Array.isArray(d) ? d : []); })
      .catch(() => { if (load === providerLoad.current) setProviders([]); })
      .finally(() => { if (load === providerLoad.current) setScanning(false); });
  };

  const hideProviders = () => {
    providerLoad.current++;
    setScanning(false);
    setProviders(null);
    setProvider(undefined);
    setSessions(null);
    sessionLoad.current++;
  };

  const openSessionsIn = (raw: string) => {
    const clean = raw.trim();
    const dir = clean === '/' ? clean : clean.replace(/[\\/]+$/, '');
    if (!dir) return;
    setPwd(dir);
    setBrowse(null);
    loadProviders(dir);
  };

  const loadSessions = (prov: string) => {
    const load = ++sessionLoad.current;
    setProvider(prov);
    setSessions(null);
    setFilter('');
    setHi(0);
    fetch(endpoint(`/api/sessions?pwd=${encodeURIComponent(pwd)}&provider=${encodeURIComponent(prov)}`))
      .then((r) => r.json())
      .then((d) => { if (load === sessionLoad.current) setSessions(Array.isArray(d) ? d : []); })
      .catch(() => { if (load === sessionLoad.current) setSessions([]); });
  };

  useEffect(() => {
    const dir = initialPwd || (!source ? localStorage.getItem('mcfly.lastPwd') : null);
    if (dir) { setPwd(dir); return; }
    fetch(endpoint('/api/config')).then((r) => r.json()).then((d) => {
      const seed = source ? d.home ?? d.pwd : d.pwd;
      if (typeof seed === 'string') setPwd((current) => current || seed);
    }).catch(() => {});
  }, [initialPwd, source?.connection]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow-resolve already carries an explicit provider intent, so it keeps
  // its direct jump. A normal picker waits for the folder confirmation.
  const seededLoad = useRef(false);
  useEffect(() => {
    if (seededLoad.current || !initialProvider) return;
    const dir = pwd.trim().replace(/[\\/]+$/, '');
    if (!dir) return;
    seededLoad.current = true;
    loadProviders(dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pwd, initialProvider]);
  useEffect(() => { if (sessions) filterRef.current?.focus(); }, [sessions]);

  // seeded open (follow-resolve): jump straight to the agent's sessions,
  // pre-filtered to the ambiguous candidates
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !initialProvider || !providers) return;
    if (providers.some((p) => p.provider === initialProvider && p.count > 0)) {
      seeded.current = true;
      loadSessions(initialProvider);
      if (initialFilter) setFilter(initialFilter);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers]);

  const shown = useMemo(() => {
    const q = filter.toLowerCase();
    return (sessions ?? [])
      .filter((s) => !q || s.label.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
      .slice(0, 50);
  }, [sessions, filter]);

  useEffect(() => { setHi((h) => Math.min(h, Math.max(0, shown.length - 1))); }, [shown.length]);

  return (
    <dialog
      ref={dialogRef}
      className="pickerOverlay"
      aria-labelledby="session-picker-title"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={onClose}
    >
      <div className="pickerModal" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <div className="pickerHead">
          <span id="session-picker-title">open a session{source ? ` on ${source.host}` : ''}</span>
          <button className="pickerClose" aria-label="Close session picker" onClick={onClose}>✕</button>
        </div>

        <div className="pickerRow">
          <span className="pickerLabel">project</span>
          <input
            ref={projectRef}
            className="pickerInput"
            aria-label="Project folder"
            value={pwd}
            onChange={(e) => { setPwd(e.target.value); hideProviders(); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') openSessionsIn(pwd);
            }}
            spellCheck={false}
          />
          <button aria-label="Browse folders" title="Browse folders" onClick={() => setBrowse((b) => (b === null ? (pwd.trim() || (source ? '/' : 'C:\\')) : null))}>…</button>
          <button onClick={() => go(pwd)} title="Open the project without choosing a session">open project folder</button>
        </div>

        {browse !== null && (
          <div className="folderBrowse">
            <div className="fbPath" title={browse}>{browse}</div>
            <div className="fbList">
              {!atRoot && <button className="fbRow" onClick={browseUp}><span className="codicon codicon-arrow-up" /> ..</button>}
              {browseDirs === null && <div className="pickerHint">listing…</div>}
              {browseDirs?.map((d) => (
                <button key={d} className="fbRow" onClick={() => browseInto(d)}>
                  <span className="codicon codicon-folder expFolder" /> {d}
                </button>
              ))}
              {browseDirs?.length === 0 && <div className="pickerHint">no subfolders</div>}
            </div>
            <div className="fbActions">
              <button onClick={() => openSessionsIn(browse)}>open a session in this folder</button>
              <button onClick={() => setBrowse(null)}>cancel</button>
            </div>
          </div>
        )}

        {/* the browser replaces the agent/session sections while open — both
            at once squeeze the modal past its height and the rows overlap */}
        {browse === null && scanning && <div className="pickerHint">scanning session history…</div>}
        {browse === null && providers && (
          <div className="pickerRow">
            <span className="pickerLabel">agent</span>
            {providers.map((p) => (
              <button
                key={p.provider}
                className={`pickerTool ${provider === p.provider ? 'active' : ''}`}
                disabled={p.count === 0}
                onClick={() => loadSessions(p.provider)}
              >
                ▸ {PROVIDER_LABELS[p.provider] ?? p.provider} <span className="pickerCount">{p.count}</span>
              </button>
            ))}
            {providers.every((p) => p.count === 0) && <span className="pickerHint">no session history here</span>}
          </div>
        )}

        {browse === null && provider && (
          sessions === null ? <div className="pickerHint">loading sessions…</div> : (
            <>
              <div className="pickerRow">
                <span className="pickerLabel">session</span>
                <input
                  ref={filterRef}
                  className="pickerInput"
                  placeholder="type to filter…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, shown.length - 1)); }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
                    else if (e.key === 'Enter' && shown[hi]) onPick(pwd, shown[hi]);
                  }}
                  spellCheck={false}
                />
              </div>
              <div className="pickerList">
                {shown.map((s, i) => (
                  <div
                    key={s.id}
                    className={`pickerItem ${i === hi ? 'hi' : ''}`}
                    onMouseEnter={() => setHi(i)}
                    onClick={() => onPick(pwd, s)}
                  >
                    <span className="pickerItemLabel">{s.label}</span>
                    <span className="pickerItemMeta">
                      {new Date(s.updated_at).toLocaleString()} · {(s.size / 1024 / 1024).toFixed(1)} MB
                    </span>
                  </div>
                ))}
                {!shown.length && <div className="pickerHint">no matches</div>}
              </div>
            </>
          )
        )}
      </div>
    </dialog>
  );
}
