import { useEffect, useMemo, useState } from 'react';
import { type Action, bindingsFor, overlayActions, parseKeys } from '../lib/keys';
import type { DataMatcher } from '../lib/matchers';

export type SettingsPage = 'settings' | 'keys' | 'data';

// One matcher, edited in place. Targets are both optional — neither set means
// the rule applies everywhere, which is why the scope line says so out loud
// rather than leaving two empty boxes to interpret.
function MatcherRow({ matcher, pwd, onChange, onRemove }: {
  matcher: DataMatcher; pwd?: string;
  onChange: (next: DataMatcher) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<DataMatcher>) => onChange({ ...matcher, ...patch });
  const paramPairs = Object.entries(matcher.params ?? {});
  const scope = matcher.session ? 'this session' : matcher.workspace ? matcher.workspace : 'everywhere';
  return (
    <div className="matcher">
      <div className="matcherHead">
        <input
          type="checkbox"
          checked={matcher.enabled !== false}
          onChange={(e) => set({ enabled: e.target.checked })}
          title="enabled"
        />
        <span className="matcherTool" onClick={() => setOpen(!open)}>{matcher.tool}</span>
        <span className="setHint">{scope}</span>
        {matcher.transform && <span className="matcherTag">transform</span>}
        <button className="matcherX" onClick={onRemove} title="remove">×</button>
      </div>
      {open && (
        <div className="matcherBody">
          <TextRow
            label="name" hint="shown as the data pane title"
            value={matcher.name} placeholder={matcher.tool}
            onSave={(v) => set({ name: v || matcher.tool })}
          />
          <TextRow
            label="tool" hint="glob against the tool name, e.g. mcp__github__*"
            value={matcher.tool} placeholder="Bash"
            onSave={(v) => v && set({ tool: v })}
          />
          <TextRow
            label="param" hint="optional: param name = glob the call must match"
            value={paramPairs.map(([k, v]) => `${k}=${v}`).join(', ')}
            placeholder="command=kubectl get* -o json"
            onSave={(v) => {
              const params: Record<string, string> = {};
              for (const pair of v.split(',')) {
                const at = pair.indexOf('=');
                if (at > 0) params[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
              }
              set({ params: Object.keys(params).length ? params : undefined });
            }}
          />
          <TextRow
            label="workspace" hint="optional: this project and below it. blank = any"
            value={matcher.workspace ?? ''} placeholder={pwd ?? '/path/to/project'}
            onSave={(v) => set({ workspace: v || undefined })}
          />
          <TextRow
            label="session" hint="optional: one transcript id. blank = any"
            value={matcher.session ?? ''} placeholder="any session"
            onSave={(v) => set({ session: v || undefined })}
          />
          <div className="setSub matcherCode">
            <span className="setLabel">transform</span>
            <textarea
              className="pickerInput matcherScript"
              defaultValue={matcher.transform ?? ''}
              placeholder="return data.items;"
              spellCheck={false}
              onKeyDown={(e) => e.stopPropagation()}
              onBlur={(e) => set({ transform: e.target.value.trim() || undefined })}
            />
            <span className="setHint">optional JS body: gets `data`, returns what to show. Sandboxed, no I/O.</span>
          </div>
        </div>
      )}
    </div>
  );
}

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
  // extra CLI flags per tool, appended when mcfly launches it in a terminal
  flags?: Record<string, string>;
  defaultTool?: string; // what a new terminal starts as ('_' = blank shell)
  keymap?: Record<string, string[]>;
}

// a small notation input for the vim leader / tmux prefix: saves on Enter
// or blur, keeps the default on bad notation
// a plain text row (extra CLI flags): commits on Enter or blur, no validation
// beyond the server's control-character strip
function TextRow({ label, hint, value, placeholder, onSave }: {
  label: string; hint: string; value: string; placeholder: string; onSave: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <div className="setSub">
      <span className="setLabel">{label}</span>
      <input
        className="pickerInput setFlags"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onSave(draft.trim())}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') onSave(draft.trim()); }}
        spellCheck={false}
      />
      <span className="setHint">{hint}</span>
    </div>
  );
}

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
export function Settings({
  settings, initialPage = 'settings', keysVersion = 0, tools, pwd,
  matchers = [], onSaveMatchers, onSave, onClose,
}: {
  settings: McflySettings;
  initialPage?: SettingsPage;
  keysVersion?: number; // bumped AFTER the keys module absorbed the settings
  tools?: string[]; // agent CLIs found on PATH, for the default-terminal picker
  pwd?: string; // the open project, offered as the workspace target for a new rule
  matchers?: DataMatcher[];
  onSaveMatchers?: (next: DataMatcher[]) => void;
  onSave: (patch: Partial<McflySettings>) => void;
  onClose: () => void;
}) {
  const [page, setPage] = useState<SettingsPage>(initialPage);
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
          <div className={`paneTab ${page === 'data' ? 'active' : ''}`} onClick={() => setPage('data')}>DATA TOOLS</div>
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

            <div className="setSection">terminals</div>
            <div className="setSub">
              <span className="setLabel">default terminal</span>
              <select
                className="pickerInput setMini"
                value={settings.defaultTool ?? '_'}
                onChange={(e) => onSave({ defaultTool: e.target.value })}
                onKeyDown={(e) => e.stopPropagation()}
              >
                {['_', ...(tools ?? []).filter((t) => t !== '_')].map((t) => (
                  <option key={t} value={t}>{t === '_' ? 'blank shell' : t}</option>
                ))}
              </select>
              <span className="setHint">what a new terminal starts as</span>
            </div>
            {['claude', 'codex'].map((tool) => (
              <TextRow
                key={tool}
                label={`${tool} flags`}
                hint={`appended when mcfly launches ${tool}`}
                value={settings.flags?.[tool] ?? ''}
                placeholder={tool === 'claude' ? '--model opus' : '--search'}
                onSave={(v) => onSave({ flags: { ...(settings.flags ?? {}), [tool]: v } })}
              />
            ))}
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

        {page === 'data' && (
          <div className="setBody">
            <div className="setSection">data tool matchers</div>
            <div className="setHint setBlurb">
              Results from a matching tool call render in the DATA tab as JSON. Agents add these
              themselves with the <b>data_matcher</b> tool; you can edit or remove them here.
            </div>
            {matchers.length === 0 && <div className="emptyHint">no matchers yet</div>}
            {matchers.map((m, i) => (
              <MatcherRow
                key={m.id}
                matcher={m}
                pwd={pwd}
                onChange={(next) => onSaveMatchers?.(matchers.map((x, j) => (j === i ? next : x)))}
                onRemove={() => onSaveMatchers?.(matchers.filter((_, j) => j !== i))}
              />
            ))}
            <button
              className="matcherAdd"
              onClick={() => onSaveMatchers?.([...matchers, {
                id: `m${Date.now().toString(36)}`, name: 'new matcher', tool: '', enabled: true,
              }])}
            >+ add matcher</button>
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
