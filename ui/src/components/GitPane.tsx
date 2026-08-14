import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { memo } from 'react';
import { Splitter } from './Splitter';
import { fileIcon } from './Explorer';
import { applySelect, clickMode } from '../lib/select';
import { actionOf, focusEditor, synthClick } from '../lib/keys';

export interface GitFile { path: string; status: string }
export interface GitSelection { path: string; area: 'staged' | 'changed' }
interface GitCommit { hash: string; parents: string[]; author: string; time: number; refs: string[]; subject: string }
interface GitWorktree { path: string; head?: string; branch?: string; bare?: boolean; detached?: boolean }

const STATUS_COLOR: Record<string, string> = { M: '#e2c08d', U: '#73c991', A: '#73c991', D: '#f14c4c', R: '#4ec9b0', C: '#4ec9b0', T: '#e2c08d' };
const LANE_COLORS = ['#4fc1ff', '#73c991', '#e2c08d', '#f14c4c', '#c586c0', '#dcdcaa', '#4ec9b0', '#d18616'];

function usePersistedHeight(key: string, initial: number) {
  const [h, setH] = useState(() => Number(localStorage.getItem(`mcfly.${key}`)) || initial);
  useEffect(() => { localStorage.setItem(`mcfly.${key}`, String(h)); }, [key, h]);
  return [h, (dy: number) => setH((v) => Math.max(60, Math.min(600, v + dy)))] as const;
}

// ---- changes tree: nested dirs, single-child chains compressed ----
interface Node { name: string; path: string; dirs: Node[]; files: GitFile[] }

function buildTree(files: GitFile[]): Node {
  const root: Node = { name: '', path: '', dirs: [], files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = cur.dirs.find((d) => d.name === parts[i]);
      if (!next) {
        next = { name: parts[i], path: parts.slice(0, i + 1).join('/'), dirs: [], files: [] };
        cur.dirs.push(next);
        cur.dirs.sort((a, b) => a.name.localeCompare(b.name));
      }
      cur = next;
    }
    cur.files.push(f);
  }
  const compress = (n: Node): Node => {
    while (n.dirs.length === 1 && n.files.length === 0 && n.path) {
      const only = n.dirs[0];
      n = { ...only, name: `${n.name}/${only.name}` };
    }
    return { ...n, dirs: n.dirs.map(compress) };
  };
  return { ...root, dirs: root.dirs.map(compress) };
}

// ---- commit graph: lane layout, first parent keeps the lane ----
interface GraphRow { c: GitCommit; lane: number; merges: number[]; forks: number[]; before: (string | null)[]; after: (string | null)[] }

function layoutGraph(commits: GitCommit[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  return commits.map((c) => {
    const before = [...lanes];
    let lane = lanes.indexOf(c.hash);
    if (lane < 0) { lane = lanes.indexOf(null); if (lane < 0) { lane = lanes.length; lanes.push(null); } }
    const merges: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (i !== lane && lanes[i] === c.hash) { merges.push(i); lanes[i] = null; }
    }
    const forks: number[] = [];
    if (!c.parents.length) {
      lanes[lane] = null;
    } else {
      lanes[lane] = c.parents[0];
      for (let pi = 1; pi < c.parents.length; pi++) {
        let l = lanes.indexOf(c.parents[pi]);
        if (l < 0) { l = lanes.indexOf(null); if (l < 0) { l = lanes.length; lanes.push(null); } lanes[l] = c.parents[pi]; }
        forks.push(l);
      }
    }
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    return { c, lane, merges, forks, before, after: [...lanes] };
  });
}

const LANE_W = 12;
const ROW_H = 22;

function GraphCell({ row }: { row: GraphRow }) {
  const width = (Math.max(row.before.length, row.after.length, row.lane + 1)) * LANE_W + 4;
  const x = (l: number) => l * LANE_W + LANE_W / 2;
  const color = (l: number) => LANE_COLORS[l % LANE_COLORS.length];
  const cy = ROW_H / 2;
  const lines: React.ReactNode[] = [];
  for (let i = 0; i < Math.max(row.before.length, row.after.length); i++) {
    const through = i !== row.lane && row.before[i] && row.after[i] && row.before[i] === row.after[i] && !row.merges.includes(i);
    if (through) lines.push(<line key={`t${i}`} x1={x(i)} y1={0} x2={x(i)} y2={ROW_H} stroke={color(i)} strokeWidth={2} />);
  }
  if (row.before[row.lane]) lines.push(<line key="up" x1={x(row.lane)} y1={0} x2={x(row.lane)} y2={cy} stroke={color(row.lane)} strokeWidth={2} />);
  if (row.after[row.lane]) lines.push(<line key="dn" x1={x(row.lane)} y1={cy} x2={x(row.lane)} y2={ROW_H} stroke={color(row.lane)} strokeWidth={2} />);
  for (const m of row.merges) lines.push(<line key={`m${m}`} x1={x(m)} y1={0} x2={x(row.lane)} y2={cy} stroke={color(m)} strokeWidth={2} />);
  for (const f of row.forks) lines.push(<line key={`f${f}`} x1={x(row.lane)} y1={cy} x2={x(f)} y2={ROW_H} stroke={color(f)} strokeWidth={2} />);
  return (
    <svg className="ggSvg" width={width} height={ROW_H}>
      {lines}
      <circle cx={x(row.lane)} cy={cy} r={3.5} fill={color(row.lane)} />
    </svg>
  );
}

const refChip = (r: string) => r.replace('HEAD -> ', '').replace('tag: ', '');
const refClass = (r: string) => (r.startsWith('tag: ') ? 'ggTag' : r.includes('/') ? 'ggRemote' : 'ggBranch');

// GIT pane: read-only. Changes (staged/changed trees), the commit graph, and
// worktrees. The human selects here; agents read the selection through
// workspace_state and act in their own terminal.
// memo: worktrees + changes tree + a big commit graph — unrelated app
// renders (splitter drags, selections elsewhere) must not re-reconcile it
export const GitPane = memo(function GitPane({ root, visible, selection, onSelect, commitSelection, onSelectCommits, onOpenDiff, onOpenWorktree, currentRoot, onEscapeTop, onReviewFrom }: {
  onReviewFrom?: (hash: string) => void; // "diff from here" -> review checklist
  root: string;
  visible: boolean;
  selection: GitSelection[];
  onSelect: (sel: GitSelection[]) => void;
  commitSelection: { hash: string; subject: string }[];
  onSelectCommits: (sel: { hash: string; subject: string }[]) => void;
  onOpenDiff: (file: GitFile, area: 'staged' | 'changed') => void;
  onOpenWorktree: (path: string) => void;
  currentRoot: string; // what the explorer shows now, to badge the active worktree
  onEscapeTop?: () => void; // 'up' beyond the first row: focus climbs to the tab strip
}) {
  const [status, setStatus] = useState<{ staged: GitFile[]; changed: GitFile[]; error?: string }>({ staged: [], changed: [] });
  const [log, setLog] = useState<GitCommit[]>([]);
  const [wts, setWts] = useState<GitWorktree[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [secClosed, setSecClosed] = useState<Set<string>>(new Set());
  // worktrees: two rows by default; changes and tree split the rest 50/50
  const [wtH, dragWt] = usePersistedHeight('gitWtH', 72);
  const [treePct, setTreePct] = useState(() => Number(localStorage.getItem('mcfly.gitTreePct')) || 46);
  useEffect(() => { localStorage.setItem('mcfly.gitTreePct', String(treePct)); }, [treePct]);
  const paneRef = useRef<HTMLDivElement>(null);

  const refreshStatus = useCallback(() => {
    fetch(`/api/git/status?root=${encodeURIComponent(root)}`)
      .then((r) => r.json())
      .then((d) => setStatus(d.error ? { staged: [], changed: [], error: d.error } : d))
      .catch(() => { /* keep last */ });
  }, [root]);
  const LOG_PAGE = 150;
  const [logDone, setLogDone] = useState(false);
  const refreshLog = useCallback(() => {
    fetch(`/api/git/log?root=${encodeURIComponent(root)}&limit=${LOG_PAGE}`)
      .then((r) => r.json())
      .then((d) => {
        if (!Array.isArray(d)) return;
        setLog(d);
        setLogDone(d.length < LOG_PAGE);
      })
      .catch(() => { /* keep last */ });
  }, [root]);
  const loadMoreLog = useCallback(() => {
    fetch(`/api/git/log?root=${encodeURIComponent(root)}&limit=${LOG_PAGE}&skip=${log.length}`)
      .then((r) => r.json())
      .then((d) => {
        if (!Array.isArray(d)) return;
        setLog((cur) => [...cur, ...d]);
        setLogDone(d.length < LOG_PAGE);
      })
      .catch(() => { /* retry by clicking again */ });
  }, [root, log.length]);
  const refreshWts = useCallback(() => {
    fetch(`/api/git/worktrees?root=${encodeURIComponent(root)}`)
      .then((r) => r.json())
      .then((d) => setWts(Array.isArray(d) ? d : []))
      .catch(() => { /* keep last */ });
  }, [root]);

  // slow poll while visible; the graph only loads on reveal and on refresh
  useEffect(() => {
    if (!visible) return;
    refreshStatus();
    refreshWts();
    refreshLog();
    const t = setInterval(() => { refreshStatus(); refreshWts(); }, 10_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, root]);

  const rows = useMemo(() => layoutGraph(log), [log]);
  const stagedTree = useMemo(() => buildTree(status.staged), [status.staged]);
  const changedTree = useMemo(() => buildTree(status.changed), [status.changed]);

  // visible files in render order (dirs first, collapsed subtrees skipped):
  // the flat list shift-ranges walk over, spanning both sections
  const SEP = '\u0000';
  const fileKey = (area: GitSelection['area'], path: string) => `${area}${SEP}${path}`;
  const flatFiles = useMemo(() => {
    const out: string[] = [];
    const walk = (n: Node, area: GitSelection['area']) => {
      if (n.path && collapsed.has(`${area}:${n.path}`)) return;
      n.dirs.forEach((d) => walk(d, area));
      n.files.forEach((f) => out.push(fileKey(area, f.path)));
    };
    if (!secClosed.has('staged')) walk(stagedTree, 'staged');
    if (!secClosed.has('changed')) walk(changedTree, 'changed');
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stagedTree, changedTree, collapsed, secClosed]);
  const fileAnchor = useRef<string | null>(null);
  const clickFile = (e: React.MouseEvent, f: GitFile, area: GitSelection['area']) => {
    const mode = clickMode(e);
    const res = applySelect(flatFiles, selection.map((s) => fileKey(s.area, s.path)), fileAnchor.current, fileKey(area, f.path), mode);
    fileAnchor.current = res.anchor;
    onSelect(res.sel.map((k) => {
      const i = k.indexOf(SEP);
      return { area: k.slice(0, i) as GitSelection['area'], path: k.slice(i + 1) };
    }));
    if (mode === 'plain') onOpenDiff(f, area);
  };

  const isSelected = (path: string, area: GitSelection['area']) => selection.some((s) => s.path === path && s.area === area);
  const toggleSec = (k: string) => setSecClosed((c) => {
    const next = new Set(c);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  const secHead = (label: string, k: string) => (
    <div className="gitSection gitSecHead" onClick={() => toggleSec(k)}>
      <span className={`codicon codicon-chevron-${secClosed.has(k) ? 'right' : 'down'}`} /> {label}
    </div>
  );

  const renderNode = (n: Node, area: GitSelection['area'], depth: number): React.ReactNode => (
    <div key={`${area}:${n.path}`}>
      {n.path && (
        <div
          className="gitRow gitDir"
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => setCollapsed((c) => { const next = new Set(c); const k = `${area}:${n.path}`; if (next.has(k)) next.delete(k); else next.add(k); return next; })}
        >
          <span className={`codicon codicon-chevron-${collapsed.has(`${area}:${n.path}`) ? 'right' : 'down'}`} />
          <span className={`codicon codicon-folder${collapsed.has(`${area}:${n.path}`) ? '' : '-opened'} expIcon expFolder`} />
          <span className="gitName">{n.name}</span>
        </div>
      )}
      {!collapsed.has(`${area}:${n.path}`) && (
        <>
          {n.dirs.map((d) => renderNode(d, area, n.path ? depth + 1 : depth))}
          {n.files.map((f) => (
            <div
              key={f.path}
              className={`gitRow gitFile ${isSelected(f.path, area) ? 'sel' : ''}`}
              style={{ paddingLeft: 8 + (n.path ? depth + 1 : depth) * 12 + 14 }}
              title={f.path}
              onClick={(e) => clickFile(e, f, area)}
              onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
            >
              <span className={`codicon codicon-${fileIcon(f.path)} expIcon`} />
              <span className="gitName">{f.path.split('/').pop()}</span>
              <span className="gitStatus" style={{ color: STATUS_COLOR[f.status] ?? 'var(--fg-dim)' }}>{f.status}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );

  const head = (label: string, count: number | null, onRefresh: () => void) => (
    <div className="gitHead">
      {label}{count !== null && count > 0 && <span className="wfCount">{count}</span>}
      <span className="codicon codicon-refresh gitRefresh" title="Refresh" onClick={onRefresh} />
    </div>
  );

  const commitSelected = (h: string) => commitSelection.some((c) => c.hash === h);
  const commitAnchor = useRef<string | null>(null);
  const clickCommit = (e: React.MouseEvent, c: GitCommit) => {
    const res = applySelect(log.map((x) => x.hash), commitSelection.map((x) => x.hash), commitAnchor.current, c.hash, clickMode(e));
    commitAnchor.current = res.anchor;
    const byHash = new Map(log.map((x) => [x.hash, x]));
    onSelectCommits(res.sel.map((h) => ({ hash: h, subject: byHash.get(h)?.subject ?? '' })));
  };

  // ---- keyboard: one continuous walk from worktrees through changes into
  // the commit tree; on the more… row, another 'down' IS the expand click.
  // Imperative cursor + a rect-positioned bar (three scroll containers). ----
  const kbCursor = useRef(-1);
  const kbBar = useRef<HTMLDivElement>(null);
  const kbRows = () => [...(paneRef.current?.querySelectorAll('.gitRow, .gitSecHead, .ggRow, .ggMore') ?? [])] as HTMLElement[];
  const paintKb = useCallback(() => {
    const bar = kbBar.current;
    const pane = paneRef.current;
    if (!bar || !pane) return;
    const row = kbRows()[kbCursor.current];
    if (!row) { bar.style.display = 'none'; return; }
    const pr = pane.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    // clip to the row's own scroll container: a row scrolled out of view
    // must not paint its bar over the neighboring sections
    let top = rr.top;
    let bottom = rr.bottom;
    const cont = row.closest('.gitWtScroll, .gitChangesScroll, .gitGraphScroll');
    if (cont) {
      const cr = cont.getBoundingClientRect();
      top = Math.max(top, cr.top);
      bottom = Math.min(bottom, cr.bottom);
    }
    if (bottom - top < 2) { bar.style.display = 'none'; return; }
    bar.style.display = 'block';
    bar.style.top = `${top - pr.top}px`;
    bar.style.height = `${bottom - top}px`;
  }, []);
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    pane.addEventListener('scroll', paintKb, true); // inner containers scroll; capture catches them
    return () => pane.removeEventListener('scroll', paintKb, true);
  }, [paintKb]);
  const kbKeyDown = (e: React.KeyboardEvent) => {
    const rows = kbRows();
    if (!rows.length) return;
    let i = Math.max(0, Math.min(kbCursor.current, rows.length - 1));
    const row = rows[i];
    const selectable = (el?: HTMLElement | null) => !!el && (el.classList.contains('gitFile') || el.classList.contains('ggRow'));
    // file rows understand 'open' (Enter or right): the diff opens and the
    // caret lands in it
    const action = actionOf(e, row?.classList.contains('gitFile')
      ? ['extendUp', 'extendDown', 'select', 'extendActivate', 'open', 'up', 'down', 'left', 'dismiss']
      : ['extendUp', 'extendDown', 'select', 'extendActivate', 'up', 'down', 'left', 'right', 'activate', 'dismiss']);
    if (!action) return;
    switch (action) {
      case 'open':
        row.click();
        focusEditor(row.querySelector('.gitName')?.textContent?.trim() || undefined);
        break;
      case 'up':
        if (i === 0 && onEscapeTop) {
          e.preventDefault();
          e.stopPropagation();
          kbCursor.current = -1;
          paintKb();
          onEscapeTop();
          return;
        }
        i = Math.max(0, i - 1);
        break;
      case 'down':
        if (row?.classList.contains('ggMore')) row.click(); // deeper history; the cursor lands on the new commits
        else i = Math.min(rows.length - 1, kbCursor.current < 0 ? 0 : i + 1);
        break;
      case 'extendUp':
      case 'extendDown': {
        i = action === 'extendUp' ? Math.max(0, i - 1) : Math.min(rows.length - 1, i + 1);
        const target = rows[i];
        if (selectable(target)) synthClick(target, { shiftKey: true });
        break;
      }
      case 'select':
        if (selectable(row)) synthClick(row, { ctrlKey: true });
        break;
      case 'extendActivate':
        if (selectable(row)) synthClick(row, { shiftKey: true }); // range: anchor -> here
        break;
      case 'right':
        if (row?.querySelector('.codicon-chevron-right')) row.click();
        break;
      case 'left': {
        if (row?.querySelector('.codicon-chevron-down')) { row.click(); break; }
        // in the changes tree, left climbs to the parent dir (or the section)
        if (row?.classList.contains('gitFile') || row?.classList.contains('gitDir')) {
          const depth = parseInt(row.style.paddingLeft || '0');
          for (let j = i - 1; j >= 0; j--) {
            const cand = rows[j];
            const cDepth = cand.classList.contains('gitSecHead') ? -1 : parseInt(cand.style.paddingLeft || '0');
            if ((cand.classList.contains('gitDir') || cand.classList.contains('gitSecHead')) && cDepth < depth) { i = j; break; }
          }
        }
        break;
      }
      case 'activate': row?.click(); break;
      case 'dismiss': (e.target as HTMLElement).blur(); kbCursor.current = -1; paintKb(); break;
    }
    e.preventDefault();
    e.stopPropagation();
    if (action !== 'dismiss') {
      kbCursor.current = i;
      requestAnimationFrame(() => {
        kbRows()[kbCursor.current]?.scrollIntoView({ block: 'nearest' });
        paintKb();
      });
    }
  };
  const kbMouseDown = (e: React.MouseEvent) => {
    const row = (e.target as Element).closest?.('.gitRow, .gitSecHead, .ggRow, .ggMore') as HTMLElement | null;
    if (!row) return;
    // preventDefault stops the browser's own focus-steal to <body>;
    // the click event still fires, so row actions are unaffected
    e.preventDefault();
    kbCursor.current = kbRows().indexOf(row);
    // focus AFTER the mousedown sequence: Chromium reverts a focus made
    // during the handler even when the default is prevented
    requestAnimationFrame(() => {
      paneRef.current?.focus();
      paintKb();
    });
  };

  const mainWt = wts[0]?.path;
  return (
    <div className="gitPane" ref={paneRef} tabIndex={-1} onKeyDown={kbKeyDown} onMouseDown={kbMouseDown}>
      <div className="expCursor" ref={kbBar} style={{ display: 'none' }} />
      <div className="gitWts" style={{ height: wtH }}>
        {head('WORKTREES', null, refreshWts)}
        <div className="gitWtScroll">
          {wts.map((w) => {
            const cur = w.path.replace(/\//g, '\\').toLowerCase() === currentRoot.replace(/\//g, '\\').toLowerCase();
            return (
              <div
                key={w.path}
                className={`gitRow gitWt ${cur && w.path !== mainWt ? 'cur' : ''}`}
                title={cur ? `${w.path} — you are here` : w.path}
                onClick={cur ? undefined : () => onOpenWorktree(w.path)}
              >
                <span className={`codicon codicon-${w.path === mainWt ? 'repo' : 'git-branch'}`} />
                <span className="gitName">{w.branch ?? (w.detached ? `detached @ ${w.head?.slice(0, 7)}` : w.path.split(/[\\/]/).pop())}</span>
                <span className="gitWtPath">{w.path.split(/[\\/]/).pop()}</span>
              </div>
            );
          })}
          {!wts.length && <div className="emptyHint">no worktrees</div>}
        </div>
      </div>
      <Splitter dir="row" onDrag={dragWt} />

      <div className="gitChanges">
        {head('CHANGES', status.staged.length + status.changed.length, refreshStatus)}
        <div className="gitChangesScroll">
          {status.error && <div className="emptyHint">{status.error}</div>}
          {!status.error && status.staged.length > 0 && (
            <>
              {secHead('staged', 'staged')}
              {!secClosed.has('staged') && (
                <>
                  {stagedTree.dirs.map((d) => renderNode(d, 'staged', 0))}
                  {stagedTree.files.map((f) => renderNode({ name: '', path: '', dirs: [], files: [f] }, 'staged', 0))}
                </>
              )}
            </>
          )}
          {!status.error && status.staged.length > 0 && status.changed.length > 0 && <div className="gitSep" />}
          {!status.error && status.changed.length > 0 && (
            <>
              {secHead('changes', 'changed')}
              {!secClosed.has('changed') && (
                <>
                  {changedTree.dirs.map((d) => renderNode(d, 'changed', 0))}
                  {changedTree.files.map((f) => renderNode({ name: '', path: '', dirs: [], files: [f] }, 'changed', 0))}
                </>
              )}
            </>
          )}
          {!status.error && !status.staged.length && !status.changed.length && <div className="emptyHint">working tree clean</div>}
        </div>
      </div>

      <Splitter dir="row" onDrag={(dy) => setTreePct((p) => Math.max(12, Math.min(80, p - (dy / (paneRef.current?.clientHeight || 600)) * 100)))} />
      <div className="gitGraph" style={{ flex: `0 0 ${treePct}%` }}>
        {head('TREE', null, refreshLog)}
        <div className="gitGraphScroll">
          {rows.map((row) => (
            <div
              key={row.c.hash}
              className={`ggRow ${commitSelected(row.c.hash) ? 'sel' : ''}`}
              title={`${row.c.hash.slice(0, 10)} · ${row.c.author} · ${new Date(row.c.time).toLocaleString()}`}
              onClick={(e) => clickCommit(e, row.c)}
              onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
            >
              <GraphCell row={row} />
              {row.c.refs.map((r) => <span key={r} className={`ggRef ${refClass(r)}`}>{refChip(r)}</span>)}
              <span className="ggSubject">{row.c.subject}</span>
              {onReviewFrom && (
                <span
                  className="codicon codicon-checklist ggAction"
                  title="Review checklist: diff from here"
                  onClick={(e) => { e.stopPropagation(); onReviewFrom(row.c.hash); }}
                />
              )}
              <span className="ggHash">{row.c.hash.slice(0, 7)}</span>
            </div>
          ))}
          {!rows.length && <div className="emptyHint">no commits</div>}
          {rows.length > 0 && !logDone && (
            <div className="ggMore" onClick={loadMoreLog}>more…</div>
          )}
        </div>
      </div>

    </div>
  );
});
