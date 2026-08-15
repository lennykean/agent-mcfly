import { useMemo, useState } from 'react';
import { type Action, bindingsFor, overlayActions, parseKeys } from '../lib/keys';

// Everything the app remembers about the user, stored server-side in
// ~/.mcfly/settings.json. autoLive/autoTour are START states for a session,
// not live toggles — the topbar buttons stay the in-the-moment controls.
export interface McflySettings {
  vim?: boolean;
  tmux?: boolean;
  vimLeader?: string; // one key in vim notation; Space when unset
  tmuxPrefix?: string; // a chord in vim notation; <C-b> when unset
  autoLive?: boolean;
  autoTour?: boolean;
  autoSync?: boolean; // start with terminals synced to sessions
  keymap?: Record<string, string[]>;
}

// a small notation input for the vim leader / tmux prefix: saves on Enter
// or blur, keeps the default on bad notation
function LeaderInput({ label, hint, value, placeholder, onSave }: {
  label: string; hint: string; value: string; placeholder: string; onSave: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [bad, setBad] = useState(false);
  const commit = () => {
    const t = draft.trim();
    if (t && parseKeys(t) === null) { setBad(true); return; }
    setBad(false);
    onSave(t);
  };
  return (
    <div className="setSub">
      <span className="setLabel">{label}</span>
      <input
        className={`pickerInput setMini${bad ? ' bad' : ''}`}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commit(); }}
        spellCheck={false}
      />
      <span className="setHint">{hint}</span>
      {bad && <span className="setErr">bad notation</span>}
    </div>
  );
}

// The settings popover: SETTINGS (modes and start behavior) and KEYBINDINGS
// (a VS Code-style grid of every action, its live chords, and their source;
// click a row to override in vim notation). Enabling vim/tmux over custom
// bindings asks before overwriting them; disabling a mode removes only what
// the mode itself brought.
export function Settings({ settings, initialPage = 'settings', keysVersion = 0, onSave, onClose }: {
  settings: McflySettings;
  initialPage?: 'settings' | 'keys';
  keysVersion?: number; // bumped AFTER the keys module absorbed the settings
  onSave: (patch: Partial<McflySettings>) => void;
  onClose: () => void;
}) {
  const [page, setPage] = useState<'settings' | 'keys'>(initialPage);
  const keymap = settings.keymap ?? {};
  const [ask, setAsk] = useState<null | { mode: 'vim' | 'tmux'; conflicts: string[] }>(null);

  const enableMode = (mode: 'vim' | 'tmux') => {
    const conflicts = overlayActions(mode).filter((a) => keymap[a]?.length);
    if (conflicts.length) setAsk({ mode, conflicts });
    else onSave({ [mode]: true });
  };
  const resolveAsk = (overwrite: boolean) => {
    if (!ask) return;
    if (overwrite) {
      const next = { ...keymap };
      for (const a of ask.conflicts) delete next[a];
      onSave({ [ask.mode]: true, keymap: next });
    } else {
      onSave({ [ask.mode]: true }); // custom bindings stay and shadow the mode
    }
    setAsk(null);
  };

  const toggleRow = (label: string, hint: string, value: boolean, set: (v: boolean) => void) => (
    <label className="setRow">
      <input type="checkbox" checked={value} onChange={(e) => set(e.target.checked)} />
      <span className="setLabel">{label}</span>
      <span className="setHint">{hint}</span>
    </label>
  );

  // ---- keybindings grid ----
  const [edit, setEdit] = useState<Action | null>(null);
  const [editVal, setEditVal] = useState('');
  const [editErr, setEditErr] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const rows = useMemo(() => bindingsFor(), [keysVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = rows.filter((r) => !filter.trim() || r.action.toLowerCase().includes(filter.toLowerCase()));
  const startEdit = (a: Action) => {
    setEdit(a);
    setEditVal((keymap[a] ?? []).join(', '));
    setEditErr(null);
  };
  const saveEdit = () => {
    if (!edit) return;
    const tokens = editVal.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = tokens.filter((t) => parseKeys(t) === null);
    if (bad.length) { setEditErr(`can't parse: ${bad.join(', ')}`); return; }
    const next = { ...keymap };
    if (tokens.length) next[edit] = tokens;
    else delete next[edit];
    onSave({ keymap: next });
    setEdit(null);
  };
  const resetOverride = (a: Action) => {
    const next = { ...keymap };
    delete next[a];
    onSave({ keymap: next });
  };

  return (
    <div className="pickerOverlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pickerModal settingsModal">
        <div className="pickerHead">
          <span>settings</span>
          <button className="pickerClose" onClick={onClose}>✕</button>
        </div>
        <div className="paneTabs setTabs">
          <div className={`paneTab ${page === 'settings' ? 'active' : ''}`} onClick={() => setPage('settings')}>SETTINGS</div>
          <div className={`paneTab ${page === 'keys' ? 'active' : ''}`} onClick={() => setPage('keys')}>KEYBINDINGS</div>
        </div>

        {page === 'settings' && (
          <div className="setBody">
            {toggleRow('vim mode', 'hjkl, visual mode, yy, gg/G, / find, : commands, leader chords, status bar',
              !!settings.vim, (v) => (v ? enableMode('vim') : onSave({ vim: false })))}
            {settings.vim && (
              <LeaderInput
                label="leader key"
                hint="one key, vim notation — <leader>/ grep, <leader>ff find file, <leader>q close tab"
                value={settings.vimLeader ?? ''}
                placeholder="<Space>"
                onSave={(v) => onSave({ vimLeader: v })}
              />
            )}
            {toggleRow('tmux style terminal', 'prefix chords: w projects, c new terminal, n/p cycle, x kill — the shell gives up the prefix',
              !!settings.tmux, (v) => (v ? enableMode('tmux') : onSave({ tmux: false })))}
            {settings.tmux && (
              <LeaderInput
                label="prefix chord"
                hint="a chord, vim notation — the tmux-style prefix"
                value={settings.tmuxPrefix ?? ''}
                placeholder="<C-b>"
                onSave={(v) => onSave({ tmuxPrefix: v })}
              />
            )}
            {toggleRow('auto-live', 'start in live mode: sessions open following the end',
              !!settings.autoLive, (v) => onSave({ autoLive: v }))}
            {toggleRow('auto tour guide', 'start in tour guide mode: the view follows files, tables, and waypoints',
              settings.autoTour !== false, (v) => onSave({ autoTour: v }))}
            {toggleRow('auto-sync terminals', 'start with terminals synced: picking an agent shows its terminal and vice versa',
              !!settings.autoSync, (v) => onSave({ autoSync: v }))}
            {ask && (
              <div className="setAsk">
                <div>
                  {ask.mode === 'vim' ? 'vim mode' : 'tmux style terminal'} wants to bind{' '}
                  <b>{ask.conflicts.join(', ')}</b> — you have custom bindings there.
                </div>
                <div className="setAskActions">
                  <button onClick={() => resolveAsk(true)}>overwrite mine</button>
                  <button onClick={() => resolveAsk(false)}>keep mine</button>
                  <button onClick={() => setAsk(null)}>cancel</button>
                </div>
              </div>
            )}
          </div>
        )}

        {page === 'keys' && (
          <div className="setBody">
            <input
              className="pickerInput"
              placeholder="filter actions…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <div className="kbGrid">
              {shown.map((r) => (
                <div key={r.action} className={`kbRow ${r.source === 'custom' ? 'custom' : ''}`}>
                  <span className="kbAction" onClick={() => startEdit(r.action)}>{r.action}</span>
                  {edit === r.action ? (
                    <span className="kbEdit">
                      <input
                        className="pickerInput"
                        autoFocus
                        placeholder='vim notation, comma-separated — e.g. gg, <C-End> (empty = reset)'
                        value={editVal}
                        onChange={(e) => setEditVal(e.target.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter') saveEdit();
                          else if (e.key === 'Escape') setEdit(null);
                        }}
                      />
                      {editErr && <span className="setErr">{editErr}</span>}
                    </span>
                  ) : (
                    <span className="kbKeys" onClick={() => startEdit(r.action)}>
                      {r.bindings.length
                        ? r.bindings.map((b, i) => <kbd key={i}>{b}</kbd>)
                        : <span className="setHint">unbound</span>}
                    </span>
                  )}
                  <span className={`kbSource kb-${r.source}`}>{r.source}</span>
                  {r.source === 'custom' && (
                    <span className="kbReset codicon codicon-discard" title="Reset to default" onClick={() => resetOverride(r.action)} />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
