import { useEffect, useMemo, useRef, useState } from 'react';
import { actionOf } from '../lib/keys';
import { useRowWalk } from '../lib/rowwalk';
import { fileIcon } from './Explorer';
import { Splitter } from './Splitter';
import type { Review, ReviewComment } from '../types';

// the review checklist: a punch list of files differing from the base ref.
// Ticks only track what you've looked at; clicking a name opens the diff.
export interface ChecklistProps {
  base: string | null; // the configured ref (null = not set up)
  refLabel: string | null; // resolved short hash, for the header
  files: { status: string; path: string; sig: string }[];
  checked: Record<string, string>;
  error: string | null;
  onSetBase: (ref: string | null) => void;
  onToggle: (path: string) => void;
  onToggleMany: (paths: string[], on: boolean) => void;
  onOpen: (path: string) => void;
}

type ClFile = ChecklistProps['files'][number];
interface ClNode { name: string; path: string; dirs: ClNode[]; files: ClFile[] }

// the same tree the git CHANGES section draws: dirs first, single-child
// directory chains compressed into one row
function clTree(files: ClFile[]): ClNode {
  const root: ClNode = { name: '', path: '', dirs: [], files: [] };
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
  const compress = (n: ClNode): ClNode => {
    while (n.dirs.length === 1 && n.files.length === 0 && n.path) {
      const only = n.dirs[0];
      n = { ...only, name: `${n.name}/${only.name}` };
    }
    return { ...n, dirs: n.dirs.map(compress) };
  };
  return { ...root, dirs: root.dirs.map(compress) };
}

const allFiles = (n: ClNode): ClFile[] => [...n.dirs.flatMap(allFiles), ...n.files];

function Checklist({ cl, width, onEscapeTop, onExitDown, boxRef }: {
  cl: ChecklistProps;
  width?: number;
  onEscapeTop?: () => void; // up past the first row: the tab strip
  onExitDown?: () => void; // down past the last row: the comment list
  boxRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const [draft, setDraft] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = useMemo(() => clTree(cl.files), [cl.files]);

  // the standard walk, tree flavored: Space ticks, Enter/right opens files,
  // left collapses or climbs, down past the end hands off to the comments
  const barRef = { current: null as HTMLDivElement | null };
  const cursor = useMemo(() => ({ i: -1 }), []);
  const rowsNow = () => [...(boxRef?.current?.querySelectorAll('.clRow') ?? [])] as HTMLElement[];
  const paintBar = () => {
    const bar = boxRef?.current?.querySelector('.expCursor') as HTMLElement | null;
    const row = rowsNow()[cursor.i];
    if (!bar) return;
    if (!row) { bar.style.display = 'none'; return; }
    bar.style.display = 'block';
    bar.style.top = `${row.offsetTop}px`;
    bar.style.height = `${row.offsetHeight}px`;
    row.scrollIntoView({ block: 'nearest' });
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const rows = rowsNow();
    if (!rows.length) return;
    const action = actionOf(e, ['select', 'open', 'up', 'down', 'left', 'right', 'home', 'end', 'activate', 'dismiss']);
    if (!action) return;
    let i = Math.max(0, Math.min(cursor.i, rows.length - 1));
    const row = rows[i];
    const isDir = row?.classList.contains('clDir');
    const openDir = isDir && !!row.querySelector('.codicon-chevron-down');
    const depthOf = (el: HTMLElement) => parseInt(el.style.paddingLeft || '0');
    switch (action) {
      case 'up':
        if (i === 0 && onEscapeTop) {
          e.preventDefault();
          e.stopPropagation();
          cursor.i = -1;
          paintBar();
          onEscapeTop();
          return;
        }
        i = Math.max(0, i - 1);
        break;
      case 'down':
        if (cursor.i >= 0 && i === rows.length - 1 && onExitDown) {
          e.preventDefault();
          e.stopPropagation();
          onExitDown();
          return;
        }
        i = Math.min(rows.length - 1, cursor.i < 0 ? 0 : i + 1);
        break;
      case 'home': i = 0; break;
      case 'end': i = rows.length - 1; break;
      case 'select':
        // no active cursor row: the key is not ours (a leader may want it)
        if (cursor.i < 0) return;
        (row?.querySelector('input') as HTMLElement | null)?.click(); // tick the box
        break;
      case 'open':
      case 'activate':
        if (isDir) (row.querySelector('.clDirName') as HTMLElement | null)?.click();
        else (row?.querySelector('.clName') as HTMLElement | null)?.click();
        break;
      case 'right':
        if (isDir && !openDir) (row.querySelector('.clDirName') as HTMLElement | null)?.click();
        else if (!isDir) (row?.querySelector('.clName') as HTMLElement | null)?.click();
        break;
      case 'left': {
        if (isDir && openDir) { (row.querySelector('.clDirName') as HTMLElement | null)?.click(); break; }
        const d = row ? depthOf(row) : 0;
        for (let j = i - 1; j >= 0; j--) {
          if (rows[j].classList.contains('clDir') && depthOf(rows[j]) < d) { i = j; break; }
        }
        break;
      }
      case 'dismiss': (e.target as HTMLElement).blur(); cursor.i = -1; paintBar(); return;
    }
    e.preventDefault();
    e.stopPropagation();
    cursor.i = i;
    requestAnimationFrame(paintBar);
  };
  const onMouseDown = (e: React.MouseEvent) => {
    const row = (e.target as Element).closest?.('.clRow') as HTMLElement | null;
    if (!row) return;
    const idx = rowsNow().indexOf(row);
    if (idx >= 0) cursor.i = idx;
    requestAnimationFrame(() => {
      boxRef?.current?.focus();
      paintBar();
    });
  };
  void barRef;
  if (!cl.base) {
    // no width here: the drag width belongs to the file list, and it is often
    // too narrow for these buttons
    return (
      <div className="rvChecklist">
        <div className="clSetup">
          <button onClick={() => cl.onSetBase('HEAD')}>review uncommitted</button>
          <input
            className="pickerInput"
            placeholder="or diff from: branch / commit / tag"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && draft.trim()) cl.onSetBase(draft.trim()); }}
          />
          <span className="setHint">or pick a commit in the git pane — the checklist icon on a row</span>
        </div>
      </div>
    );
  }
  const done = cl.files.filter((f) => cl.checked[f.path] !== undefined).length;
  const toggleDir = (path: string) => setCollapsed((c) => {
    const next = new Set(c);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  const renderNode = (n: ClNode, depth: number): React.ReactNode => {
    const kids = !n.path || !collapsed.has(n.path);
    const childDepth = n.path ? depth + 1 : 0;
    return (
      <div key={n.path || '(root)'}>
        {n.path && (() => {
          const sub = allFiles(n);
          const subDone = sub.filter((f) => cl.checked[f.path] !== undefined).length;
          const state = subDone === 0 ? 'none' : subDone === sub.length ? 'all' : 'some';
          return (
            <div className="clRow clDir" style={{ paddingLeft: 4 + depth * 12 }}>
              <input
                type="checkbox"
                checked={state === 'all'}
                ref={(el) => { if (el) el.indeterminate = state === 'some'; }}
                onChange={() => cl.onToggleMany(sub.map((f) => f.path), state !== 'all')}
              />
              <span className={`codicon codicon-chevron-${kids ? 'down' : 'right'} clChev`} onClick={() => toggleDir(n.path)} />
              <span className={`codicon codicon-folder${kids ? '-opened' : ''} expIcon expFolder`} />
              <span className="clDirName" onClick={() => toggleDir(n.path)}>{n.name}</span>
              <span className="clProg">{subDone}/{sub.length}</span>
            </div>
          );
        })()}
        {kids && (
          <>
            {n.dirs.map((d) => renderNode(d, childDepth))}
            {n.files.map((f) => (
              <div key={f.path} className={`clRow ${cl.checked[f.path] !== undefined ? 'done' : ''}`} style={{ paddingLeft: 4 + childDepth * 12 }}>
                <input type="checkbox" checked={cl.checked[f.path] !== undefined} onChange={() => cl.onToggle(f.path)} />
                {/* invisible chevron: files column-align with their dir rows */}
                <span className="codicon codicon-chevron-down clChev" style={{ visibility: 'hidden' }} />
                <span className={`codicon codicon-${fileIcon(f.path)} expIcon`} />
                <span className="clName" title={f.path} onClick={() => cl.onOpen(f.path)}>{f.path.split('/').pop()}</span>
                <span className="gitStatus">{f.status}</span>
              </div>
            ))}
          </>
        )}
      </div>
    );
  };
  return (
    <div className="rvChecklist" style={{ flex: width ? `0 0 ${width}px` : undefined }}>
      <div className="clHead">
        <span className="clBase" title={cl.base}>{cl.base === 'HEAD' ? 'uncommitted' : `vs ${cl.refLabel ?? cl.base}`}</span>
        <span className="clProg">{done}/{cl.files.length}</span>
        <span className="codicon codicon-close clClear" title="Remove the checklist" onClick={() => cl.onSetBase(null)} />
      </div>
      {cl.error && <div className="setErr">{cl.error}</div>}
      <div className="clList" ref={boxRef} tabIndex={-1} onKeyDown={onKeyDown} onMouseDown={onMouseDown}>
        <div className="expCursor" style={{ display: 'none' }} />
        {renderNode(tree, 0)}
        {!cl.files.length && !cl.error && <div className="emptyHint">{cl.base === 'HEAD' ? 'nothing uncommitted' : `no differences from ${cl.refLabel ?? cl.base}`}</div>}
      </div>
    </div>
  );
}

const timeOf = (ts: number) => new Date(ts).toLocaleTimeString();
const shortName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const teaser = (n: string) => n.replace(/[#*`>~]/g, '').replace(/\s+/g, ' ').trim();

const StateChip = ({ state }: { state: ReviewComment['state'] }) => (
  <span className={`rvChip rv-${state}`}>{state}</span>
);

// HUMAN REVIEW (bottom panel): the human's red pen. One open review per
// session; comments are threads the agent answers through the MCP.
export function HumanReview({ active, sessionLoaded, onCreate, onClose, onOpenComment, onEscapeTop, checklist }: {
  active: Review | null;
  sessionLoaded: boolean;
  onCreate: () => void;
  onClose: () => void;
  onOpenComment: (review: Review, comment: ReviewComment) => void;
  onEscapeTop?: () => void;
  checklist?: ChecklistProps;
}) {
  const clBoxRef = useRef<HTMLDivElement | null>(null);
  const hasChecklist = !!(active && checklist?.base);
  // the punch list column resizes like every other pane, width persisted.
  // The drag tracks the ABSOLUTE pointer from its start position: clamping
  // accumulated deltas would detach the handle at the bounds ("wiggle to
  // unstick").
  const [clW, setClW] = useState(() => Number(localStorage.getItem('mcfly.clW')) || 200);
  useEffect(() => { localStorage.setItem('mcfly.clW', String(clW)); }, [clW]);
  const dragBase = useRef(clW);
  const dragAcc = useRef(0);
  const clDragStart = () => { dragBase.current = clW; dragAcc.current = 0; };
  const clDrag = (dx: number) => {
    dragAcc.current += dx;
    setClW(Math.max(100, Math.min(800, dragBase.current + dragAcc.current)));
  };
  // up past the first comment goes back to the checklist when there is one
  const walk = useRowWalk('.rvThread', hasChecklist ? () => clBoxRef.current?.focus() : onEscapeTop);
  // no active review: Enter IS the "start review" button
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!active && actionOf(e, ['activate'])) {
      e.preventDefault();
      e.stopPropagation();
      if (sessionLoaded) onCreate();
      return;
    }
    walk.onKeyDown(e);
  };
  const rows = (review: Review) => review.comments.map((c) => (
    <div key={c.id} className="rvThread" onClick={() => onOpenComment(review, c)}>
      <div className="rvRow">
        <StateChip state={c.state} />
        <span className="rvFile">{shortName(c.path)}:{c.line}{c.line_end && c.line_end !== c.line ? `-${c.line_end}` : ''}</span>
        <span className="rvTeaser">{teaser(c.body)}</span>
        <span className="rvTime">{timeOf(c.ts)}</span>
      </div>
      {c.replies.map((rep, i) => (
        <div key={i} className="rvSubRow">
          <span className={`rvSubAuthor ${rep.author === 'human' ? '' : 'rvSubAgent'}`}>↳ {rep.author}</span>
          <span className="rvTeaser">{teaser(rep.body)}</span>
        </div>
      ))}
    </div>
  ));

  return (
    <div className="humanReview">
      <div className="rvBar">
        {active ? (
          <>
            <span className="rvTitle">review {active.id} · {active.comments.length} comments</span>
            <span className="rvHint">click a line number in a file to comment</span>
            <button onClick={onClose}>close review</button>
          </>
        ) : (
          <>
            <span className="rvTitle">no active review</span>
            {sessionLoaded
              ? <button onClick={onCreate} title="Start a review for this session">start review</button>
              : <span className="rvHint">open a session to start a review</span>}
          </>
        )}
      </div>
      <div className="rvSplit">
        {active && checklist && (
          <Checklist
            cl={checklist}
            width={clW}
            boxRef={clBoxRef}
            onEscapeTop={onEscapeTop}
            onExitDown={() => walk.boxRef.current?.focus()}
          />
        )}
        {active && checklist && (
          <Splitter dir="col" onStart={clDragStart} onDrag={clDrag} />
        )}
        <div className="rvList" ref={walk.boxRef} tabIndex={-1} onKeyDown={onKeyDown} onMouseDown={walk.onMouseDown}>
          <div className="expCursor" ref={walk.barRef} style={{ display: 'none' }} />
          {active && rows(active)}
          {active && active.comments.length === 0 && (
            <div className="emptyHint">no comments yet — click a line number in any file</div>
          )}
          {!active && <div className="emptyHint">no open review for this session</div>}
        </div>
      </div>
    </div>
  );
}
