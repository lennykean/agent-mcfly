import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionMeta } from '../types';

interface ProviderInfo { provider: string; count: number }

const PROVIDER_LABELS: Record<string, string> = { 'claude-code': 'claude', codex: 'codex' };

// Open-session flow: pwd -> go (scopes the workbench to the folder) ->
// agent type -> type-ahead over that project's sessions; picking a session
// is optional. The ... button browses folders through the server.
export function SessionPicker({ initialPwd, initialProvider, initialFilter, onPick, onGo, onClose }: {
  initialPwd: string;
  initialProvider?: string; // pre-select this agent and load its sessions
  initialFilter?: string; // pre-fill the filter (e.g. an ambiguous title match)
  onPick: (pwd: string, session: SessionMeta) => void;
  onGo?: (pwd: string) => void; // scope the workbench to this folder, no session needed
  onClose: () => void;
}) {
  // the currently-open project wins; last-used pwd only seeds a bare open
  const [pwd, setPwd] = useState(() => initialPwd || localStorage.getItem('mcfly.lastPwd') || '');

  // Escape ALWAYS cancels the dialog, wherever focus sits (window capture:
  // the inputs and the app's key engine never see it)
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, []);
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [provider, setProvider] = useState<string>();
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  const [filter, setFilter] = useState('');
  const [hi, setHi] = useState(0);
  const [scanning, setScanning] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);

  // server-backed folder browser (the native dialog cannot give real paths)
  const [browse, setBrowse] = useState<string | null>(null);
  const [browseDirs, setBrowseDirs] = useState<string[] | null>(null);
  useEffect(() => {
    if (browse === null) return;
    setBrowseDirs(null);
    fetch(`/api/fs/list?root=${encodeURIComponent(browse)}&path=`)
      .then((r) => r.json())
      .then((d) => setBrowseDirs(Array.isArray(d) ? d.filter((e) => e.dir).map((e) => e.name) : []))
      .catch(() => setBrowseDirs([]));
  }, [browse]);
  const atRoot = browse !== null && /^[A-Za-z]:[\\/]?$/.test(browse);
  const browseUp = () => setBrowse((b) => (b === null || atRoot ? b : b.replace(/[\\/][^\\/]+[\\/]?$/, '') || b));
  const go = (raw: string) => {
    // typed paths arrive messy: collapse repeated separators (UNC prefix stays)
    const dir = raw.trim().replace(/(?!^)[\\/]{2,}/g, '\\').replace(/[\\/]+$/, '');
    if (!dir) return;
    onGo?.(dir);
    onClose();
  };

  const loadProviders = (dir: string) => {
    if (!dir.trim()) return;
    setScanning(true);
    setProviders(null);
    setProvider(undefined);
    setSessions(null);
    fetch(`/api/providers?pwd=${encodeURIComponent(dir)}`)
      .then((r) => r.json())
      .then((d) => setProviders(Array.isArray(d) ? d : []))
      .catch(() => setProviders([]))
      .finally(() => setScanning(false));
  };

  const loadSessions = (prov: string) => {
    setProvider(prov);
    setSessions(null);
    setFilter('');
    setHi(0);
    fetch(`/api/sessions?pwd=${encodeURIComponent(pwd)}&provider=${encodeURIComponent(prov)}`)
      .then((r) => r.json())
      .then((d) => setSessions(Array.isArray(d) ? d : []))
      .catch(() => setSessions([]));
  };

  useEffect(() => {
    const dir = initialPwd || localStorage.getItem('mcfly.lastPwd');
    if (dir) { setPwd(dir); return; } // the pwd effect below loads it
    fetch('/api/config').then((r) => r.json()).then((d) => {
      if (typeof d.pwd === 'string') setPwd((current) => current || d.pwd);
    }).catch(() => {});
  }, [initialPwd]); // eslint-disable-line react-hooks/exhaustive-deps
  // the project field is LIVE: editing it reloads that folder's agents and
  // sessions right here in the dialog (debounced while typing) — changing
  // projects must never require "opening" the folder first
  const loadedDir = useRef<string | undefined>(undefined);
  useEffect(() => {
    const dir = pwd.trim().replace(/[\\/]+$/, '');
    if (!dir || dir === loadedDir.current) return;
    const t = setTimeout(() => {
      loadedDir.current = dir;
      loadProviders(dir);
    }, 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pwd]);
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
    <div className="pickerOverlay" onClick={onClose}>
      <div className="pickerModal" onClick={(e) => e.stopPropagation()}>
        <div className="pickerHead">
          open a session
          <button className="pickerClose" onClick={onClose}>✕</button>
        </div>

        <div className="pickerRow">
          <span className="pickerLabel">project</span>
          <input
            className="pickerInput"
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            onKeyDown={(e) => {
              // Enter = load THIS folder's sessions now (never a bare open)
              if (e.key !== 'Enter') return;
              const dir = pwd.trim().replace(/[\\/]+$/, '');
              if (!dir) return;
              loadedDir.current = dir;
              loadProviders(dir);
            }}
            spellCheck={false}
          />
          <button title="Browse folders" onClick={() => setBrowse((b) => (b === null ? (pwd.trim() || 'C:\\') : null))}>…</button>
          <button onClick={() => go(pwd)} title="Open the folder bare — no session; sessions load below as you type">folder only</button>
        </div>

        {browse !== null && (
          <div className="folderBrowse">
            <div className="fbPath" title={browse}>{browse}</div>
            <div className="fbList">
              {!atRoot && <div className="fbRow" onClick={browseUp}><span className="codicon codicon-arrow-up" /> ..</div>}
              {browseDirs === null && <div className="pickerHint">listing…</div>}
              {browseDirs?.map((d) => (
                <div key={d} className="fbRow" onClick={() => setBrowse(`${browse.replace(/[\\/]+$/, '')}\\${d}`)}>
                  <span className="codicon codicon-folder expFolder" /> {d}
                </div>
              ))}
              {browseDirs?.length === 0 && <div className="pickerHint">no subfolders</div>}
            </div>
            <div className="fbActions">
              <button onClick={() => { setPwd(browse); setBrowse(null); }}>use this folder</button>
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
    </div>
  );
}
