import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionMeta } from '../types';

interface ProviderInfo { provider: string; count: number }

const PROVIDER_LABELS: Record<string, string> = { 'claude-code': 'claude', codex: 'codex' };

// Open-session flow: pwd -> agent type (detected from session history) ->
// type-ahead over that project's sessions. Live terminals live in the
// LIVE TERMINAL pane, not here.
export function SessionPicker({ initialPwd, initialProvider, initialFilter, onPick, onOpenFolder, onClose }: {
  initialPwd: string;
  initialProvider?: string; // pre-select this agent and load its sessions
  initialFilter?: string; // pre-fill the filter (e.g. an ambiguous title match)
  onPick: (pwd: string, session: SessionMeta) => void;
  onOpenFolder?: (pwd: string) => void;
  onClose: () => void;
}) {
  // the currently-open project wins; last-used pwd only seeds a bare open
  const [pwd, setPwd] = useState(() => initialPwd || localStorage.getItem('mcfly.lastPwd') || '');
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [provider, setProvider] = useState<string>();
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  const [filter, setFilter] = useState('');
  const [hi, setHi] = useState(0);
  const [scanning, setScanning] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);

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
    if (dir) { setPwd(dir); loadProviders(dir); return; }
    fetch('/api/config').then((r) => r.json()).then((d) => {
      if (typeof d.pwd === 'string') setPwd((current) => current || d.pwd);
    }).catch(() => {});
  }, [initialPwd]); // eslint-disable-line react-hooks/exhaustive-deps
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
            onKeyDown={(e) => { if (e.key === 'Enter') loadProviders(pwd); }}
            spellCheck={false}
          />
          <button onClick={() => loadProviders(pwd)}>go</button>
          {onOpenFolder && (
            <button onClick={() => onOpenFolder(pwd)} title="Scope to this folder without loading a session">
              open folder only
            </button>
          )}
        </div>

        {scanning && <div className="pickerHint">scanning session history…</div>}
        {providers && (
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

        {provider && (
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
