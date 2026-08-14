import { useEffect, useRef, useState } from 'react';
import { applySelect, clickMode } from '../lib/select';

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

function Dir({ root, rel, name, depth, onFileClick, selection, onToggleSelect }: {
  root: string; rel: string; name?: string; depth: number;
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
      fetch(`/api/fs/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(rel)}`)
        .then((r) => r.json())
        .then((d) => {
          const next: Entry[] = Array.isArray(d) ? d : [];
          setEntries((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
        })
        .catch(() => setEntries((cur) => cur ?? []));
    void load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [open, root, rel]);

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
          <Dir key={e.name} root={root} rel={`${rel}${rel ? '/' : ''}${e.name}`} name={e.name} depth={depth + 1} onFileClick={onFileClick} selection={selection} onToggleSelect={onToggleSelect} />
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
export function Explorer({ root, onOpen, selection = [], onSelect }: {
  root?: string; onOpen: (relPath: string) => void;
  selection?: string[]; onSelect?: (sel: string[]) => void;
}) {
  const anchor = useRef<string | null>(null);
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
    <div className="explorer">
      <Dir root={root} rel="" depth={0} onFileClick={fileClick} selection={selection} onToggleSelect={toggle} />
    </div>
  );
}
