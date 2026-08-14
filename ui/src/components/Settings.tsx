import { useState } from 'react';
import { ACTIONS, applyKeymap } from '../lib/keys';

// The settings panel: keyboard modes and the custom keymap. Bindings are
// vim notation — "gg", "<C-End>", "<A-S-g>" — keyed by action name; an
// override replaces that action's bindings in whichever mode table is live.
export function Settings({ tour, onTour, vim, onVim, tmux, onTmux, onClose }: {
  tour: boolean; onTour: (v: boolean) => void;
  vim: boolean; onVim: (v: boolean) => void;
  tmux: boolean; onTmux: (v: boolean) => void;
  onClose: () => void;
}) {
  const [keymap, setKeymap] = useState(() => {
    try { return localStorage.getItem('mcfly.keymap') ?? ''; } catch { return ''; }
  });
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const apply = () => {
    const raw = keymap.trim();
    try {
      if (!raw) {
        localStorage.removeItem('mcfly.keymap');
        applyKeymap({});
      } else {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object of action -> bindings');
        const unknown = Object.keys(parsed).filter((k) => !(ACTIONS as string[]).includes(k));
        if (unknown.length) throw new Error(`unknown action(s): ${unknown.join(', ')}`);
        applyKeymap(parsed);
        localStorage.setItem('mcfly.keymap', raw);
      }
      setErr(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  };

  const row = (label: string, hint: string, value: boolean, set: (v: boolean) => void) => (
    <label className="setRow">
      <input type="checkbox" checked={value} onChange={(e) => set(e.target.checked)} />
      <span className="setLabel">{label}</span>
      <span className="setHint">{hint}</span>
    </label>
  );

  return (
    <div className="pickerOverlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pickerModal settingsModal">
        <div className="pickerHead">
          <span>settings</span>
          <button className="pickerClose" onClick={onClose}>✕</button>
        </div>
        {row('tour guide', 'the view follows files, tables, and waypoints as they happen', tour, onTour)}
        {row('vim mode', 'hjkl, visual mode, yy, gg/G, / find, : commands, space leader, status bar', vim, onVim)}
        {row('tmux mode', 'ctrl+b prefix: c new terminal, n/p cycle, x kill — the shell gives up ctrl+b', tmux, onTmux)}
        <div className="setKeymapHead">
          custom keymap
          <span className="setHint">JSON of action → bindings in vim notation, merged over the active mode</span>
        </div>
        <textarea
          className="setKeymap"
          rows={6}
          placeholder={'{ "docEnd": ["<C-End>", "G"], "gotoGit": ["<A-S-g>"] }'}
          value={keymap}
          onChange={(e) => setKeymap(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          spellCheck={false}
        />
        <div className="setActions">
          <button onClick={apply}>apply</button>
          {saved && <span className="setOk">applied</span>}
          {err && <span className="setErr">{err}</span>}
        </div>
        <details className="setActionsList">
          <summary>bindable actions</summary>
          <div>{ACTIONS.join('  ')}</div>
        </details>
      </div>
    </div>
  );
}
