import { useEffect, useRef, useState } from 'react';
import { applySelect, clickMode } from '../lib/select';
import { actionOf, focusEditor, synthClick } from '../lib/keys';
import { withConnection } from '../lib/api';

interface Entry { name: string; dir: boolean }

const CODE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'cs', 'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'css', 'html', 'ps1', 'sh', 'sql', 'yml', 'yaml', 'toml']);
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']);

export function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'json') return 'json';
  if (ext === 'md') return 'markdown';
  if (CODE_EXT.has(ext)) return 'file-code';
  if (IMG_EXT.has(ext)) return 'file-media';
  return 'file';
}

function Dir({ root, rel, name, depth, connection, onFileClick, selection, onToggleSelect }: {
  root: string; rel: string; name?: string; depth: number;
  connection?: string;
  onFileClick: (rel: string, ev: React.MouseEvent, dirFiles: string[]) => void;
  selection: string[]; onToggleSelect: (rel: string) => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  const [entries, setEntries] = useState<Entry[] | null>(null);

  // an open directory stays fresh: re-list on an interval so files created
  // or deleted by live agents appear without a reload; keep identity when
  // nothing changed so the subtree does not re-render
  useEffect(() => {
    if (!open) return;
    const load = () =>
      fetch(withConnection(`/api/fs/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(rel)}`, connection))
        .then((r) => r.json())
        .then((d) => {
          const next: Entry[] = Array.isArray(d) ? d : [];
          setEntries((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
        })
        .catch(() => setEntries((cur) => cur ?? []));
    void load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [open, root, rel, connection]);

  return (
    <div>
      {name !== undefined && (
        <div
          className={`expRow ${selection.includes(rel) ? 'sel' : ''}`}
          style={{ paddingLeft: 8 + (depth - 1) * 12 }}
          onClick={(e) => ((e.ctrlKey || e.metaKey) ? onToggleSelect(rel) : setOpen(!open))}
        >
          <span className={`codicon codicon-chevron-${open ? 'down' : 'right'} expChevron`} />
          <span className={`codicon codicon-folder${open ? '-opened' : ''} expIcon expFolder`} />
          {name}
        </div>
      )}
      {open && entries?.map((e) =>
        e.dir ? (
          <Dir key={e.name} root={root} rel={`${rel}${rel ? '/' : ''}${e.name}`} name={e.name} depth={depth + 1} connection={connection} onFileClick={onFileClick} selection={selection} onToggleSelect={onToggleSelect} />
        ) : (
          (() => {
            const fileRel = `${rel}${rel ? '/' : ''}${e.name}`;
            return (
              <div key={e.name} className={`expRow expFile ${selection.includes(fileRel) ? 'sel' : ''}`} style={{ paddingLeft: 24 + depth * 12 }}
                onClick={(ev) => onFileClick(fileRel, ev, entries.filter((x) => !x.dir).map((x) => `${rel}${rel ? '/' : ''}${x.name}`))}
                onMouseDown={(ev) => { if (ev.shiftKey) ev.preventDefault(); }}>
                <span className={`codicon codicon-${fileIcon(e.name)} expIcon`} />
                {e.name}
              </div>
            );
          })()
        ),
      )}
      {open && entries === null && <div className="expRow expDim" style={{ paddingLeft: 24 + depth * 12 }}>…</div>}
    </div>
  );
}

// Plain click on a file selects it and opens it; clicking the sole selected
// file again clears the selection. Ctrl/meta toggles membership; shift
// ranges within the clicked file's directory. The selection feeds
// workspace_state, so an agent can resolve "these files".
//
// Keyboard: up/down walk the visible rows, right expands (or steps into) a
// folder, left collapses (or jumps to the parent), Enter acts like a click.
// Fully imperative — cursor in a ref, an overlay bar for the highlight — so
// keys cost no renders and the 5s listing refresh cannot wipe it.
export function Explorer({ root, connection, onOpen, selection = [], onSelect, onEscapeTop }: {
  root?: string; onOpen: (relPath: string) => void;
  connection?: string;
  selection?: string[]; onSelect?: (sel: string[]) => void;
  onEscapeTop?: () => void; // 'up' beyond the first row: focus climbs to the tab strip
}) {
  const anchor = useRef<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const cursor = useRef(-1);

  const rowsNow = () => [...(boxRef.current?.querySelectorAll('.expRow:not(.expDim)') ?? [])] as HTMLElement[];
  const paintBar = () => {
    const bar = barRef.current;
    const row = rowsNow()[cursor.current];
    if (!bar) return;
    if (!row) { bar.style.display = 'none'; return; }
    bar.style.display = 'block';
    bar.style.top = `${row.offsetTop}px`;
    bar.style.height = `${row.offsetHeight}px`;
    row.scrollIntoView({ block: 'nearest' });
  };
  const isDir = (row: HTMLElement) => !row.classList.contains('expFile');
  const isOpenDir = (row: HTMLElement) => !!row.querySelector('.codicon-chevron-down');
  const depthOf = (row: HTMLElement) => parseInt(row.style.paddingLeft || '0');

  const onKeyDown = (e: React.KeyboardEvent) => {
    const rows = rowsNow();
    if (!rows.length) return;
    let i = Math.max(0, Math.min(cursor.current, rows.length - 1));
    const row = rows[i];
    // file rows understand 'open' (Enter or right): GO INTO the file — the
    // caret lands in the editor; dirs keep toggle/expand on those chords
    const action = actionOf(e, row?.classList.contains('expFile')
      ? ['extendUp', 'extendDown', 'select', 'extendActivate', 'open', 'up', 'down', 'left', 'dismiss']
      : ['extendUp', 'extendDown', 'select', 'extendActivate', 'up', 'down', 'left', 'right', 'activate', 'dismiss']);
    if (!action) return;
    switch (action) {
      case 'open':
        row.click();
        focusEditor(row.textContent?.trim() || undefined);
        break;
      case 'extendUp':
      case 'extendDown': {
        i = action === 'extendUp' ? Math.max(0, i - 1) : Math.min(rows.length - 1, i + 1);
        const target = rows[i];
        if (target?.classList.contains('expFile')) synthClick(target, { shiftKey: true });
        break;
      }
      case 'select':
        // no active cursor row: the key is not ours (a leader may want it)
        if (cursor.current < 0) return;
        if (row?.classList.contains('expFile') || isDir(row)) synthClick(row, { ctrlKey: true });
        break;
      case 'extendActivate':
        if (row?.classList.contains('expFile')) synthClick(row, { shiftKey: true }); // range: anchor -> here
        break;
      case 'up':
        if (i === 0 && onEscapeTop) {
          e.preventDefault();
          e.stopPropagation();
          cursor.current = -1;
          paintBar();
          onEscapeTop();
          return;
        }
        i = Math.max(0, i - 1);
        break;
      case 'down': i = Math.min(rows.length - 1, cursor.current < 0 ? 0 : i + 1); break;
      case 'right':
        if (row && isDir(row) && !isOpenDir(row)) row.click();
        else i = Math.min(rows.length - 1, i + 1);
        break;
      case 'left': {
        if (row && isDir(row) && isOpenDir(row)) { row.click(); break; }
        // jump to the parent: the nearest row above with a smaller indent
        const d = row ? depthOf(row) : 0;
        for (let j = i - 1; j >= 0; j--) {
          if (depthOf(rows[j]) < d) { i = j; break; }
        }
        break;
      }
      case 'activate': row?.click(); break;
      case 'dismiss': (e.target as HTMLElement).blur(); cursor.current = -1; paintBar(); break;
    }
    e.preventDefault();
    e.stopPropagation();
    if (action !== 'dismiss') {
      cursor.current = i;
      // clicks mutate the tree; paint after the DOM settles
      requestAnimationFrame(paintBar);
    }
  };

  // clicking a row moves the cursor there and focuses the tree
  const onMouseDown = (e: React.MouseEvent) => {
    const row = (e.target as Element).closest?.('.expRow') as HTMLElement | null;
    if (!row) return;
    // preventDefault: the browser's default would move focus to <body>
    e.preventDefault();
    const idx = rowsNow().indexOf(row);
    if (idx >= 0) cursor.current = idx;
    // focus AFTER the mousedown sequence (Chromium reverts an in-handler focus)
    requestAnimationFrame(() => {
      boxRef.current?.focus();
      paintBar();
    });
  };

  if (!root) return <div className="expDim expRow">no cwd recorded for this session</div>;
  const toggle = (rel: string) => {
    anchor.current = rel;
    onSelect?.(selection.includes(rel) ? selection.filter((s) => s !== rel) : [...selection, rel]);
  };
  const fileClick = (rel: string, ev: React.MouseEvent, dirFiles: string[]) => {
    const mode = clickMode(ev);
    const res = applySelect(dirFiles, selection, anchor.current, rel, mode);
    anchor.current = res.anchor;
    onSelect?.(res.sel);
    if (mode === 'plain') onOpen(rel);
  };
  return (
    <div className="explorer" ref={boxRef} tabIndex={-1} onKeyDown={onKeyDown} onMouseDown={onMouseDown}>
      <div className="expCursor" ref={barRef} style={{ display: 'none' }} />
      <Dir root={root} rel="" depth={0} connection={connection} onFileClick={fileClick} selection={selection} onToggleSelect={toggle} />
    </div>
  );
}
