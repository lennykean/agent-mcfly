import { useEffect, useRef, useState } from 'react';

export interface QuickItem { label: string; detail?: string; path: string; line?: number }

// The floating quick picker (grep, find file): same dialog language as the
// session picker but WITHOUT the dimmed backdrop — the app stays visible.
// Type to query (debounced), arrows walk, Enter jumps, Escape closes.
export function QuickPick({ title, hint, placeholder, onQuery, onPick, onClose }: {
  title: string;
  hint?: string; // shown dim in the head: what root was searched, which build
  placeholder: string;
  onQuery: (q: string) => Promise<QuickItem[]>;
  onPick: (item: QuickItem) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<QuickItem[]>([]);
  const [cur, setCur] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const id = ++seq.current;
    const t = setTimeout(() => {
      void onQuery(q).then((res) => {
        if (seq.current === id) { setItems(res); setCur(0); }
      });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  useEffect(() => { listRef.current?.querySelector('.hi')?.scrollIntoView({ block: 'nearest' }); }, [cur, items]);

  // a text input: keys are hardcoded on purpose (typing must never feed the
  // binding engine's counts or sequences)
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'ArrowUp') { e.preventDefault(); setCur((c) => Math.max(0, c - 1)); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setCur((c) => Math.min(Math.max(0, items.length - 1), c + 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[cur]) onPick(items[cur]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  return (
    <div className="quickPickOverlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pickerModal quickPick">
        <div className="pickerHead">
          <span>{title}</span>
          {hint && <span className="quickHint" title={hint}>{hint}</span>}
          <button className="pickerClose" onClick={onClose}>✕</button>
        </div>
        <input
          ref={inputRef} className="pickerInput" placeholder={placeholder}
          value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown}
        />
        <div className="pickerList" ref={listRef}>
          {items.map((it, i) => (
            <div key={`${it.path}:${it.line ?? i}`} className={`pickerItem ${i === cur ? 'hi' : ''}`} onClick={() => onPick(it)}>
              <span className="pickerItemLabel">{it.label}</span>
              {it.detail && <span className="pickerItemMeta">{it.detail}</span>}
            </div>
          ))}
          {!items.length && q.trim() && <div className="pickerItem"><span className="pickerItemMeta">no matches</span></div>}
        </div>
      </div>
    </div>
  );
}
