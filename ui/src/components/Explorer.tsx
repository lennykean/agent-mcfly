import { useEffect, useState } from 'react';

interface Entry { name: string; dir: boolean }

const CODE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'cs', 'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'css', 'html', 'ps1', 'sh', 'sql', 'yml', 'yaml', 'toml']);
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']);

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'json') return 'json';
  if (ext === 'md') return 'markdown';
  if (CODE_EXT.has(ext)) return 'file-code';
  if (IMG_EXT.has(ext)) return 'file-media';
  return 'file';
}

function Dir({ root, rel, name, depth, onOpen }: {
  root: string; rel: string; name?: string; depth: number; onOpen: (rel: string) => void;
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
        <div className="expRow" style={{ paddingLeft: 8 + (depth - 1) * 12 }} onClick={() => setOpen(!open)}>
          <span className={`codicon codicon-chevron-${open ? 'down' : 'right'} expChevron`} />
          <span className={`codicon codicon-folder${open ? '-opened' : ''} expIcon expFolder`} />
          {name}
        </div>
      )}
      {open && entries?.map((e) =>
        e.dir ? (
          <Dir key={e.name} root={root} rel={`${rel}${rel ? '/' : ''}${e.name}`} name={e.name} depth={depth + 1} onOpen={onOpen} />
        ) : (
          <div key={e.name} className="expRow expFile" style={{ paddingLeft: 24 + depth * 12 }}
            onClick={() => onOpen(`${rel}${rel ? '/' : ''}${e.name}`)}>
            <span className={`codicon codicon-${fileIcon(e.name)} expIcon`} />
            {e.name}
          </div>
        ),
      )}
      {open && entries === null && <div className="expRow expDim" style={{ paddingLeft: 24 + depth * 12 }}>…</div>}
    </div>
  );
}

export function Explorer({ root, onOpen }: { root?: string; onOpen: (relPath: string) => void }) {
  if (!root) return <div className="expDim expRow">no cwd recorded for this session</div>;
  return (
    <div className="explorer">
      <Dir root={root} rel="" depth={0} onOpen={onOpen} />
    </div>
  );
}
