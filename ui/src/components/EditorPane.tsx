import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import hljs from 'highlight.js/lib/common';
import powershell from 'highlight.js/lib/languages/powershell';
import 'highlight.js/styles/vs2015.css';
import { TYPE_CPS, normPath, resolveWaypoint, type FileView, type WaypointEntry } from '../lib/timeline';
import { Md } from './ChatPane';
import type { Review, ReviewComment } from '../types';

hljs.registerLanguage('powershell', powershell);

const LH = 18; // line height px; must match .code/.gutter CSS

const LANGS: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript', json: 'json', css: 'css', scss: 'scss', less: 'less',
  html: 'xml', xml: 'xml', svg: 'xml', md: 'markdown', ps1: 'powershell', psm1: 'powershell',
  sh: 'bash', bash: 'bash', py: 'python', cs: 'csharp', rs: 'rust', go: 'go', java: 'java',
  yml: 'yaml', yaml: 'yaml', sql: 'sql', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', rb: 'ruby',
  php: 'php', kt: 'kotlin', swift: 'swift', diff: 'diff', ini: 'ini', toml: 'ini',
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function highlightHtml(content: string, path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const lang = LANGS[ext];
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(content, { language: lang, ignoreIllegals: true }).value;
    } catch { /* fall through to plain */ }
  }
  return escapeHtml(content);
}

const shortName = (p: string) => p.split(/[\\/]/).slice(-1)[0];

// Width of the line-number gutter in px — must match .gutter CSS flex-basis
// (50px total; its 12px padding is inside that, box-sizing: border-box).
const GUTTER_W = 50;

let cachedCharW = 0;
function charWidth(): number {
  if (!cachedCharW) {
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = '12px Consolas, "Cascadia Mono", monospace'; // matches .code CSS
    cachedCharW = ctx.measureText('M').width;
  }
  return cachedCharW;
}

// Full-file (or slice) view: always rendered fully syntax highlighted.
// Edits/writes "type out": overlay masks hide the not-yet-typed characters of
// the changed region and recede as a caret sweeps through, so the code appears
// to be typed live — in full color. A region band flashes and fades after.
export interface BlameMark { text: string; title: string; step: number }

export function CodeView({ file, animate, speed, flashOnly, blame, waypoint, marks, onCompose, composer, reviewMarks, thread, scrollTo, textBand }: {
  file: FileView; animate: boolean; speed: number;
  flashOnly?: boolean;
  blame?: { marks: (BlameMark | null)[]; compact?: boolean; onJump: (step: number) => void; onToggle?: () => void };
  waypoint?: { line: number; note: string; open: boolean; onToggle: () => void };
  // tour-driven scroll target; human expand/collapse must never move the view
  scrollTo?: { line: number; nonce: number };
  // the persistent text selection fragments (native selection dies on focus loss)
  textBand?: { rects: { x: number; y: number; w: number; h: number }[] };
  // all waypoint markers for this file: resolved ones open their card here;
  // stale ones are just something to GO TO — click opens the snapshot tab
  marks?: { line: number; stale: boolean; onClick: () => void }[];
  // human review: click (or click-drag a range of) line numbers to comment
  onCompose?: (line: number, lineEnd: number) => void;
  composer?: { line: number; lineEnd: number; onSubmit: (body: string) => void; onCancel: () => void };
  reviewMarks?: { id: string; line: number; lineEnd: number; state: ReviewComment['state']; onClick: () => void }[];
  thread?: {
    comment: ReviewComment; line: number; stale: boolean;
    onReply: (body: string) => void; onResolve: () => void;
    onViewOriginal: () => void; onClose: () => void;
  };
}) {
  const r = file.render;
  const ref = useRef<HTMLDivElement>(null);
  const content = r.content ?? '';
  const startLine = r.start_line ?? 1;
  const region = r.region;
  const isEdit = r.verb === 'patch_file' || r.verb === 'write_file';
  const typing = !!(animate && region && isEdit && !flashOnly);
  const [typedDone, setTypedDone] = useState(!typing);
  const [typedChars, setTypedChars] = useState(0);
  // single click toggles blame detail; a short timer lets double-click (jump)
  // cancel it so jumping doesn't also flip the gutter
  const blameClickTimer = useRef<number>(undefined);

  // gutter drag: press a line number and drag to comment on a range
  const [dragSel, setDragSel] = useState<{ from: number; to: number } | null>(null);
  useEffect(() => {
    if (!dragSel) return;
    const up = () => {
      setDragSel((sel) => {
        if (sel && onCompose) onCompose(Math.min(sel.from, sel.to), Math.max(sel.from, sel.to));
        return null;
      });
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragSel !== null]);

  // the {__html} OBJECT must be identity-stable: React 19 rewrites innerHTML
  // whenever the object is new, even for equal strings — and a rewrite
  // detaches every text node, killing any live text selection in the view
  const html = useMemo(() => ({ __html: highlightHtml(content, file.path) }), [content, file.path]);
  const total = useMemo(() => content.split('\n').length, [content]);

  const regionText = useMemo(() => {
    if (!region) return '';
    const lines = content.split('\n');
    const a = Math.max(0, region.start - startLine);
    const b = Math.min(lines.length, region.end - startLine + 1);
    return lines.slice(a, b).join('\n');
  }, [content, region, startLine]);

  // clock-based so the rate is exact at any playback speed (a per-tick
  // character floor would silently clamp slow speeds to the tick rate);
  // restarts on speed change, resuming from current progress
  const progressRef = useRef(0);
  useEffect(() => {
    if (typedDone || !typing || !region) return; // pause de-animates: stop the clock
    const totalChars = regionText.length;
    const cps = TYPE_CPS * speed;
    const startChars = progressRef.current;
    const start = Date.now();
    const id = setInterval(() => {
      const n = startChars + Math.floor(((Date.now() - start) / 1000) * cps);
      if (n >= totalChars) {
        clearInterval(id);
        progressRef.current = totalChars;
        setTypedChars(totalChars);
        setTypedDone(true);
      } else {
        progressRef.current = n;
        setTypedChars(n);
      }
    }, 30);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speed, typing]);

  // caret position from the typed-so-far text (tabs expanded like pre does)
  const typed = regionText.slice(0, typedChars);
  const typedLines = typed.split('\n');
  const lastLine = typedLines[typedLines.length - 1].replace(/\t/g, '        ');
  const regionTopLine = region ? Math.max(0, region.start - startLine) : 0;
  const caretY = (regionTopLine + typedLines.length - 1) * LH;
  const caretX = GUTTER_W + lastLine.length * charWidth();
  const regionBottomY = region ? (Math.min(total, region.end - startLine + 1)) * LH : 0;

  // scroll: follow the typing point; when done, stay put (a jump reads as pop-in)
  const appliedScroll = useRef<number>(undefined);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // a pending tour target outranks everything once typing settles: the
    // tour must land with its card in view. Applied once per nonce, so a
    // human toggling a card never moves the view.
    if (scrollTo && scrollTo.nonce !== appliedScroll.current && (!typing || typedDone)) {
      appliedScroll.current = scrollTo.nonce;
      el.scrollTo({ top: Math.max(0, (scrollTo.line - startLine) * LH - 60) });
      return;
    }
    if (typing) {
      if (typedDone) return;
      if (caretY > el.scrollTop + el.clientHeight - 80) el.scrollTop = caretY - el.clientHeight + 80;
      else if (caretY < el.scrollTop) el.scrollTop = Math.max(0, caretY - 60);
    } else {
      const headroom = 60;
      const target = region?.start;
      el.scrollTo({ top: target !== undefined ? Math.max(0, (target - startLine) * LH - headroom) : 0 });
    }
    // content is a dep: user tabs load asynchronously, and the region scroll
    // must re-fire once the real content (and thus scrollHeight) exists
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path, file.touchedAt, typedDone, caretY, content, scrollTo?.nonce]);

  const regionTop = region ? (region.start - startLine) * LH : 0;
  const regionH = region ? (region.end - region.start + 1) * LH : 0;
  const maskBH = regionBottomY - (caretY + LH);

  return (
    <div className="editorBody" ref={ref} data-path={file.path} data-start-line={startLine}>
      <div className="codewrap" style={{ minHeight: total * LH }}>
        <div className={`gutter${onCompose ? ' composable' : ''}`}>
          {Array.from({ length: total }, (_, i) => {
            const ln = startLine + i;
            const inDrag = dragSel && ln >= Math.min(dragSel.from, dragSel.to) && ln <= Math.max(dragSel.from, dragSel.to);
            return (
              <div
                key={i}
                className={inDrag ? 'gutterSel' : undefined}
                title={onCompose ? 'Comment — drag to select a range' : undefined}
                onMouseDown={onCompose ? (e) => { e.preventDefault(); setDragSel({ from: ln, to: ln }); } : undefined}
                onMouseEnter={onCompose && dragSel ? () => setDragSel((s) => (s ? { ...s, to: ln } : s)) : undefined}
              >{ln}</div>
            );
          })}
        </div>
        {blame && (
          <div
            className={`blameGutter${blame.compact ? ' compact' : ''}`}
            onClick={() => {
              if (!blame.onToggle) return;
              clearTimeout(blameClickTimer.current);
              blameClickTimer.current = window.setTimeout(blame.onToggle, 220);
            }}
            onDoubleClick={() => clearTimeout(blameClickTimer.current)}
            title={blame.onToggle ? 'Click to toggle blame detail' : undefined}
          >
            {Array.from({ length: total }, (_, i) => {
              const m = blame.marks[i] ?? null;
              return m ? (
                <div
                  key={i}
                  className="blameStamp"
                  title={`${m.title} · double-click to jump`}
                  onDoubleClick={(e) => { e.stopPropagation(); clearTimeout(blameClickTimer.current); blame.onJump(m.step); }}
                >{m.text}</div>
              ) : (
                <div key={i} className="blameNone">·</div>
              );
            })}
          </div>
        )}
        {(waypoint || marks?.length || reviewMarks?.length) ? (
          <div className="wpTrough">
            {Array.from({ length: total }, (_, i) => {
              const line = startLine + i;
              if (waypoint && line === waypoint.line) {
                return (
                  <div
                    key={i}
                    className="wpMark codicon codicon-location"
                    title={waypoint.open ? 'Collapse note' : 'Show note'}
                    onClick={waypoint.onToggle}
                  />
                );
              }
              const rv = reviewMarks?.find((m) => m.line === line);
              if (rv) {
                return (
                  <div
                    key={i}
                    className={`wpMark rvMark codicon codicon-comment rv-${rv.state}`}
                    title={`review comment (${rv.state})`}
                    onClick={rv.onClick}
                  />
                );
              }
              const mark = marks?.find((m) => m.line === line);
              if (mark) {
                return (
                  <div
                    key={i}
                    className={`wpMark codicon codicon-location${mark.stale ? ' wpStaleMark' : ''}`}
                    title={mark.stale ? 'waypoint [stale] — opens the snapshot' : 'waypoint'}
                    onClick={mark.onClick}
                  />
                );
              }
              return <div key={i} />;
            })}
          </div>
        ) : null}
        <pre className="code hljs" dangerouslySetInnerHTML={html} />
        {waypoint?.open && (() => {
          const lineTop = (waypoint.line - startLine) * LH;
          // below the line, same as review threads
          return (
            <div className="wpOverlayWrap" style={{ top: lineTop + LH + 6, transform: 'none' }}>
              <div className="wpCard">
                <div className="wpCardHead">
                  <span className="codicon codicon-location" /> waypoint
                  <span className="wpCollapse codicon codicon-chevron-up" title="Collapse (reopen from the trough marker)" onClick={waypoint.onToggle} />
                </div>
                <Md text={waypoint.note} />
              </div>
            </div>
          );
        })()}
        {textBand?.rects.map((rc, i) => (
          <div key={`ts${i}`} className="textSelBand" style={{ left: rc.x, top: rc.y, width: rc.w, height: rc.h }} />
        ))}
        {dragSel && (
          <div className="rvBand" style={{ top: (Math.min(dragSel.from, dragSel.to) - startLine) * LH, height: (Math.abs(dragSel.to - dragSel.from) + 1) * LH }} />
        )}
        {composer && composer.lineEnd > composer.line && (
          <div className="rvBand" style={{ top: (composer.line - startLine) * LH, height: (composer.lineEnd - composer.line + 1) * LH }} />
        )}
        {reviewMarks?.filter((m) => m.lineEnd > m.line).map((m) => (
          <div key={`band-${m.id}`} className="rvBand" style={{ top: (m.line - startLine) * LH, height: (m.lineEnd - m.line + 1) * LH }} />
        ))}
        {composer && (
          <div className="wpOverlayWrap" style={{ top: (composer.lineEnd - startLine + 1) * LH + 4, transform: 'none' }}>
            <ComposerCard onSubmit={composer.onSubmit} onCancel={composer.onCancel} />
          </div>
        )}
        {thread && (
          <div
            className="wpOverlayWrap"
            style={{ top: (thread.line + ((thread.comment.line_end ?? thread.comment.line) - thread.comment.line) - startLine + 1) * LH + 4, transform: 'none' }}
          >
            <ThreadCard {...thread} />
          </div>
        )}
        {r.highlights?.map((h, i) => (
          <div
            key={i}
            className="hlBand"
            style={{ top: (h.start - startLine) * LH, height: (h.end - h.start + 1) * LH }}
          />
        ))}
        {typing && <div className="regionTint" style={{ top: regionTop, height: regionH }} />}
        {typing && !typedDone && (
          <>
            <div className="typeMask" style={{ top: caretY, left: caretX, height: LH }} />
            {maskBH > 0 && <div className="typeMask" style={{ top: caretY + LH, left: GUTTER_W, height: maskBH }} />}
          </>
        )}
        {animate && (!isEdit || flashOnly) && region && <div className="flashBand" style={{ top: regionTop, height: regionH }} />}
      </div>
    </div>
  );
}

function ImageView({ file, animate }: { file: FileView; animate: boolean }) {
  return (
    <div className={`editorBody imageView ${animate ? 'diffFlash' : ''}`}>
      <img src={file.render.image_src} alt={file.path} />
    </div>
  );
}

interface DiffRow { kind: 'ctx' | 'add' | 'del'; oldNo?: number; newNo?: number; text: string; hunk: number }
interface GapRow { kind: 'gap'; id: number; pos: 'top' | 'mid' | 'bottom'; startNew: number; endNew: number; delta: number; hunk: number }
interface HunkRow { kind: 'hunk'; label: string; hunk: number }
type AnyRow = DiffRow | GapRow | HunkRow;

// a comment born in a diff: the new-side line number IS the real on-disk
// line, and the context comes from the hunk's new side
export interface DiffComment { line: number; lineEnd: number; before: string[]; anchor: string; after: string[]; body: string }

// with fileLines, hunk headers become expandable gaps (VS Code style); an
// expanded gap synthesizes real context rows from the on-disk file
function diffRows(hunks: NonNullable<FileView['render']['hunks']>, fileLines: string[] | undefined, expanded: Set<number>): AnyRow[] {
  const out: AnyRow[] = [];
  let gapId = 0;
  const pushGap = (pos: GapRow['pos'], startNew: number, endNew: number, delta: number, hunk: number) => {
    if (endNew < startNew) return;
    const id = gapId++;
    if (expanded.has(id)) {
      for (let n = startNew; n <= endNew; n++) {
        out.push({ kind: 'ctx', oldNo: n + delta, newNo: n, text: fileLines?.[n - 1] ?? '', hunk });
      }
    } else {
      out.push({ kind: 'gap', id, pos, startNew, endNew, delta, hunk });
    }
  };
  let prevNewEnd = 1;
  let prevDeltaEnd = 0;
  hunks.forEach((h, hi2) => {
    if (fileLines) {
      pushGap(hi2 === 0 ? 'top' : 'mid', prevNewEnd, h.newStart - 1, h.oldStart - h.newStart, hi2);
    } else {
      out.push({ kind: 'hunk', label: h.oldStart >= 1 ? `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` : '@@', hunk: hi2 });
    }
    let oldNo = h.oldStart;
    let newNo = h.newStart;
    for (const line of h.lines) {
      const text = line.slice(1);
      if (line.startsWith('+')) out.push({ kind: 'add', newNo: newNo++, text, hunk: hi2 });
      else if (line.startsWith('-')) out.push({ kind: 'del', oldNo: oldNo++, text, hunk: hi2 });
      else out.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text, hunk: hi2 });
    }
    prevNewEnd = newNo;
    prevDeltaEnd = (oldNo - 1) - (newNo - 1);
  });
  if (fileLines) pushGap('bottom', prevNewEnd, fileLines.length, prevDeltaEnd, hunks.length - 1);
  return out;
}

export function DiffView({ file, animate, onComment, fileLines }: {
  file: FileView; animate: boolean;
  // present = review mode: lines that exist on disk (green + context) take comments
  onComment?: (c: DiffComment) => void;
  // present = the on-disk file: hunk gaps become expandable context
  fileLines?: string[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: 0 });
  }, [file.path, file.touchedAt]);
  // gutter drag over new-side numbers, same as the buffer gutter; a range
  // stays inside one hunk so the context capture stays honest
  const [drag, setDrag] = useState<{ hunk: number; from: number; to: number } | null>(null);
  const [compose, setCompose] = useState<{ hunk: number; line: number; lineEnd: number } | null>(null);
  useEffect(() => { setCompose(null); setDrag(null); }, [file.path, file.touchedAt]);
  useEffect(() => {
    if (!drag) return;
    const up = () => {
      setDrag((d) => {
        if (d) setCompose({ hunk: d.hunk, line: Math.min(d.from, d.to), lineEnd: Math.max(d.from, d.to) });
        return null;
      });
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null]);

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  useEffect(() => { setExpanded(new Set()); }, [file.path, file.touchedAt]);
  const rows = useMemo(
    () => diffRows(file.render.hunks ?? [], fileLines, expanded),
    [file.render.hunks, fileLines, expanded],
  );

  // per-line highlighting: stateless, so multi-line constructs lose their
  // color across lines — the standard trade every inline diff viewer makes.
  // The whole body is memoized so re-renders keep stable {__html} objects:
  // React 19 rewrites innerHTML on object identity, which kills selections.
  const body = useMemo(() => {
    const lang = LANGS[file.path.split('.').pop()?.toLowerCase() ?? ''];
    const hi = (code: string) => {
      if (!lang) return undefined;
      try { return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch { return undefined; }
    };
    return rows.map((row, ri) => {
      if (row.kind === 'hunk') {
        return (
          <div key={`h${ri}`} className="codeline hunk">
            <span className="dln" /><span className="dln" />
            <span>{row.label}</span>
          </div>
        );
      }
      if (row.kind === 'gap') {
        const n = row.endNew - row.startNew + 1;
        const icon = row.pos === 'top' ? 'fold-up' : row.pos === 'bottom' ? 'fold-down' : 'unfold';
        return (
          <div key={`g${row.id}`} className="codeline gapline" data-gap={row.id} title={`Show ${n} unchanged ${n === 1 ? 'line' : 'lines'}`}>
            <span className="dln" /><span className="dln" />
            <span className="gapAction"><span className={`codicon codicon-${icon}`} /> {n} unchanged {n === 1 ? 'line' : 'lines'}</span>
          </div>
        );
      }
      const cls = row.kind === 'add' ? 'added' : row.kind === 'del' ? 'removed' : '';
      const html = hi(row.text);
      const commentable = onComment && row.newNo !== undefined;
      return (
        <div key={ri} className={`codeline ${cls}`}>
          <span className="dln">{row.oldNo ?? ''}</span>
          <span
            className={`dln${commentable ? ' dlnLive' : ''}`}
            title={commentable ? 'Comment — drag to select a range' : undefined}
            data-newno={row.newNo}
            data-hunk={row.hunk}
          >{row.newNo ?? ''}</span>
          <span className="lc">
            {html !== undefined
              ? <span className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
              : row.text}
          </span>
        </div>
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, file.path, onComment !== undefined]);

  // drag handling by delegation so the memoized body never re-renders
  const rowFromEvent = (e: React.MouseEvent) => {
    const t = (e.target as Element).closest?.('.dlnLive') as HTMLElement | null;
    if (!t || t.dataset.newno === undefined) return null;
    return { newNo: Number(t.dataset.newno), hunk: Number(t.dataset.hunk) };
  };
  const onMouseDown = (e: React.MouseEvent) => {
    const r2 = rowFromEvent(e);
    if (!r2) return;
    e.preventDefault();
    setCompose(null);
    setDrag({ hunk: r2.hunk, from: r2.newNo, to: r2.newNo });
  };
  const onClick = (e: React.MouseEvent) => {
    const gapEl = (e.target as Element).closest?.('.gapline') as HTMLElement | null;
    if (gapEl?.dataset.gap !== undefined) {
      const id = Number(gapEl.dataset.gap);
      setExpanded((cur) => new Set(cur).add(id));
    }
  };
  const onMouseOver = (e: React.MouseEvent) => {
    if (!drag) return;
    const r2 = rowFromEvent(e);
    if (r2 && r2.hunk === drag.hunk) setDrag((d) => (d ? { ...d, to: r2.newNo } : d));
  };

  const submit = (bodyText: string) => {
    if (!onComment || !compose) return;
    const side = rows.filter((r): r is DiffRow => r.kind !== 'hunk' && r.hunk === compose.hunk && (r as DiffRow).newNo !== undefined) as DiffRow[];
    const at = side.findIndex((r) => r.newNo === compose.line);
    if (at < 0) return;
    onComment({
      line: compose.line,
      lineEnd: compose.lineEnd,
      before: side.slice(Math.max(0, at - 3), at).map((r) => r.text),
      anchor: side[at].text,
      after: side.slice(at + 1, at + 4).map((r) => r.text),
      body: bodyText,
    });
    setCompose(null);
  };

  // overlays position by row index: every diff row is one LH tall
  const range = drag ?? (compose ? { hunk: compose.hunk, from: compose.line, to: compose.lineEnd } : null);
  const rowIdxOfNew = (hunk: number, newNo: number) => rows.findIndex((r) => r.kind !== 'hunk' && r.hunk === hunk && (r as DiffRow).newNo === newNo);
  let band: { top: number; height: number } | null = null;
  if (range) {
    const a = rowIdxOfNew(range.hunk, Math.min(range.from, range.to));
    const b = rowIdxOfNew(range.hunk, Math.max(range.from, range.to));
    if (a >= 0 && b >= 0) band = { top: a * LH, height: (b - a + 1) * LH };
  }
  const composerTop = compose ? (rowIdxOfNew(compose.hunk, compose.lineEnd) + 1) * LH + 4 : 0;

  return (
    <div className={`editorBody ${animate ? 'diffFlash' : ''}`} ref={ref}>
      <div className="diffwrap" onMouseDown={onMouseDown} onMouseOver={onMouseOver} onClick={onClick}>
        {body}
        {band && <div className="rvBand" style={{ top: band.top, height: band.height }} />}
        {compose && (
          <div className="wpOverlayWrap" style={{ top: composerTop, transform: 'none' }}>
            <ComposerCard onSubmit={submit} onCancel={() => setCompose(null)} />
          </div>
        )}
      </div>
    </div>
  );
}

export interface UserTab {
  key: string; // normal tabs: the path; snapshot waypoint tabs: their own key (many allowed)
  path: string; content?: string; image_src?: string; error?: string;
  line?: number; // scroll/flash target (from terminal file:line links)
  nonce?: number; // bumped per open so re-clicking re-scrolls
  waypoint?: { line: number; note: string }; // wayfinder: card above the line
  waypointOpen?: boolean;
  // a waypoint whose context no longer exists in the real file: the captured
  // chunk, shown as a snapshot of the code as it was
  snapshot?: { line: number; note: string; before: string[]; anchor: string; after: string[] };
  // a git diff tab: inline hunks; comments land on real file lines, and the
  // on-disk lines let hunk gaps expand
  diff?: { hunks: NonNullable<FileView['render']['hunks']>; area: 'staged' | 'changed'; fileLines?: string[] };
}

function ComposerCard({ onSubmit, onCancel }: { onSubmit: (body: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState('');
  return (
    <div className="wpCard rvCard">
      <div className="wpCardHead"><span className="codicon codicon-comment" /> new review comment</div>
      <textarea
        className="rvInput" autoFocus rows={3} value={body} placeholder="What should change here?"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey && body.trim()) onSubmit(body.trim()); }}
      />
      <div className="rvActions">
        <button disabled={!body.trim()} onClick={() => onSubmit(body.trim())}>comment</button>
        <button onClick={onCancel}>cancel</button>
      </div>
    </div>
  );
}

function ThreadCard({ comment, stale, onReply, onResolve, onViewOriginal, onClose }: {
  comment: ReviewComment; line: number; stale: boolean;
  onReply: (body: string) => void; onResolve: () => void; onViewOriginal: () => void; onClose: () => void;
}) {
  const [body, setBody] = useState('');
  return (
    <div className="wpCard rvCard">
      <div className="wpCardHead">
        <span className="codicon codicon-comment" /> {comment.author}
        <span className={`rvChip rv-${comment.state}`}>{comment.state}</span>
        {stale && <button className="rvGhostBtn" onClick={onViewOriginal} title="The code moved — see it as it was when commented">view original</button>}
        <span className="wpCollapse codicon codicon-chevron-up" onClick={onClose} />
      </div>
      <Md text={comment.body} />
      {comment.replies.map((rep, i) => (
        <div key={i} className={`rvReply ${rep.author === 'human' ? 'rvHuman' : 'rvAgent'}`}>
          <span className="rvAuthor">{rep.author}</span>
          <Md text={rep.body} />
        </div>
      ))}
      <textarea
        className="rvInput" rows={2} value={body} placeholder="Reply…"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey && body.trim()) { onReply(body.trim()); setBody(''); } }}
      />
      <div className="rvActions">
        <button disabled={!body.trim()} onClick={() => { onReply(body.trim()); setBody(''); }}>reply</button>
        {comment.state !== 'resolved' && <button onClick={onResolve}>resolve</button>}
      </div>
    </div>
  );
}

function FileBody({ file, animate, speed, onCompose, composer, waypoint, reviewMarks, thread, scrollTo, textBand }: {
  file: FileView; animate: boolean; speed: number;
  onCompose?: (line: number, lineEnd: number) => void;
  composer?: { line: number; lineEnd: number; onSubmit: (body: string) => void; onCancel: () => void };
  waypoint?: { line: number; note: string; open: boolean; onToggle: () => void };
  reviewMarks?: ComponentProps<typeof CodeView>['reviewMarks'];
  thread?: ComponentProps<typeof CodeView>['thread'];
  scrollTo?: { line: number; nonce: number };
  textBand?: { rects: { x: number; y: number; w: number; h: number }[] };
}) {
  return file.mode === 'diff'
    ? <DiffView key={`${file.path}:${file.touchedAt}`} file={file} animate={animate} />
    : file.mode === 'image'
      ? <ImageView key={`${file.path}:${file.touchedAt}`} file={file} animate={animate} />
      : <CodeView key={`${file.path}:${file.touchedAt}`} file={file} animate={animate} speed={speed} onCompose={onCompose} composer={composer} waypoint={waypoint} reviewMarks={reviewMarks} thread={thread} scrollTo={scrollTo} textBand={textBand} />;
}

// context capture for a review comment: the anchor line and its surroundings,
// from the CONTENT ON SCREEN (live file or historical view alike)
function captureContext(content: string, startLine: number, line: number) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const idx = line - startLine;
  return {
    before: lines.slice(Math.max(0, idx - 3), idx),
    anchor: lines[idx] ?? '',
    after: lines.slice(idx + 1, idx + 4),
  };
}

// One PINNED tab always shows the file the replay is touching (jumps active on
// every touch, cannot be closed); explorer files open as closable read-only tabs.
export function EditorPane({
  pinned, animate, speed, userTabs, active, onSelect, onClose, onOpenCurrent,
  timelinePath, onOpenTimeline, onCloseTimeline, timelineBody, onToggleWaypoint, onCloseAll,
  waypoints, onOpenSnapshot, onActivateWaypoint, pinnedFlash = 0, pointer = 0, worktreeBanner, textSel,
  activeReview, focusThreadId, onReviewComment, onReviewReply, onReviewResolve, onReviewViewOriginal,
}: {
  pinned?: FileView; animate: boolean; speed: number; pointer?: number;
  // the active view shows a file inside a linked worktree: say so, in orange
  worktreeBanner?: { label: string; onOpen?: () => void };
  onCloseAll?: () => void;
  // the persistent text selection: char-precise fragments that outlive focus
  textSel?: { path: string; rects: { x: number; y: number; w: number; h: number }[] } | null;
  userTabs: UserTab[]; active: string; // 'pinned' | 'timeline' | user tab path
  onSelect: (key: string) => void; onClose: (path: string) => void;
  onOpenCurrent?: (path: string) => void;
  timelinePath?: string;
  onOpenTimeline?: (path: string) => void;
  onCloseTimeline?: () => void;
  timelineBody?: React.ReactNode;
  onToggleWaypoint?: (path: string) => void;
  waypoints?: WaypointEntry[];
  onOpenSnapshot?: (wp: WaypointEntry) => void;
  onActivateWaypoint?: (key: string, line: number, note: string) => void;
  activeReview?: Review | null;
  focusThreadId?: string;
  pinnedFlash?: number;
  onReviewComment?: (c: { path: string; line: number; line_end?: number; step?: number; before: string[]; anchor: string; after: string[]; body: string }) => void;
  onReviewReply?: (commentId: string, body: string) => void;
  onReviewResolve?: (commentId: string) => void;
  onReviewViewOriginal?: (comment: ReviewComment) => void;
}) {
  const activeTabRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  const userTab = active !== 'pinned' && active !== 'timeline' ? userTabs.find((t) => t.key === active) : undefined;

  // ---- human review state for the active view ----
  const [composeAt, setComposeAt] = useState<{ path: string; line: number; lineEnd: number; step?: number; content: string; startLine: number } | null>(null);
  const [openThreadId, setOpenThreadId] = useState<string | undefined>();
  useEffect(() => { setOpenThreadId(focusThreadId); }, [focusThreadId]);
  useEffect(() => { setComposeAt(null); }, [active]);

  const reviewing = !!(activeReview && onReviewComment);
  const submitComment = (body: string) => {
    if (!composeAt || !onReviewComment) return;
    onReviewComment({
      path: composeAt.path, line: composeAt.line,
      ...(composeAt.lineEnd > composeAt.line ? { line_end: composeAt.lineEnd } : {}),
      ...(composeAt.step !== undefined ? { step: composeAt.step } : {}),
      ...captureContext(composeAt.content, composeAt.startLine, composeAt.line),
      body,
    });
    setComposeAt(null);
  };
  const composerFor = (path: string) => (composeAt && composeAt.path === path
    ? { line: composeAt.line, lineEnd: composeAt.lineEnd, onSubmit: submitComment, onCancel: () => setComposeAt(null) }
    : undefined);

  // passive tab marker ladder: comments -> gray, agent replied -> purple,
  // ALL resolved -> green, none -> no bubble
  const tabReviewDot = (path: string) => {
    if (!activeReview) return null;
    const cs = activeReview.comments.filter((c) => normPath(c.path) === normPath(path));
    if (!cs.length) return null;
    const allResolved = cs.every((c) => c.state === 'resolved');
    const replied = cs.some((c) => c.replies.some((rp) => rp.author !== 'human'));
    const flavor = allResolved ? ' allResolved' : replied ? ' replied' : '';
    const title = allResolved ? 'review comments · all resolved' : replied ? 'review comments · agent replied' : 'review comments';
    return <span className={`codicon codicon-comment rvTabDot${flavor}`} title={title} />;
  };

  // comments for the live file on screen: pin to the CURRENT line when the
  // context still matches, or clamp to the recorded line when it drifted
  const tabReview = userTab && !userTab.snapshot && userTab.content !== undefined && activeReview
    ? activeReview.comments
      .filter((c) => normPath(c.path) === normPath(userTab.path))
      .map((c) => {
        const found = resolveWaypoint(userTab.content!, { path: c.path, line: c.line, note: '', before: c.before, anchor: c.anchor, after: c.after });
        const total = userTab.content!.split('\n').length;
        const line = found ?? Math.max(1, Math.min(c.line, total));
        return { comment: c, line, lineEnd: line + ((c.line_end ?? c.line) - c.line), stale: found === null };
      })
    : [];
  const openThread = tabReview.find((t) => t.comment.id === openThreadId);

  // review threads for the live pinned view: resolved against the session
  // content on screen, in file coordinates (the content may be a region)
  const pinnedReview = pinned && pinned.mode === 'file' && pinned.render.content !== undefined && activeReview
    ? activeReview.comments
      .filter((c) => normPath(c.path) === normPath(pinned.path))
      .flatMap((c) => {
        const found = resolveWaypoint(pinned.render.content!, { path: c.path, line: c.line, note: '', before: c.before, anchor: c.anchor, after: c.after });
        if (found === null) return [];
        const line = (pinned.render.start_line ?? 1) - 1 + found;
        return [{ comment: c, line, lineEnd: line + ((c.line_end ?? c.line) - c.line), stale: false }];
      })
    : [];
  const pinnedThread = pinnedReview.find((t) => t.comment.id === openThreadId);

  // the agent's newest waypoint on the pinned file pops its card right in
  // the live view — the session content is what the agent saw when marking
  const [pinnedWpOpen, setPinnedWpOpen] = useState(true);
  const lastWpAt = waypoints?.at(-1)?.touchedAt;
  useEffect(() => { setPinnedWpOpen(true); }, [lastWpAt]);
  // any rewind re-arms the card: replaying a stretch must show what the
  // waypoint points at, even when the jump lands past its create step
  const lastPointer = useRef(pointer);
  useEffect(() => {
    if (pointer < lastPointer.current) setPinnedWpOpen(true);
    lastPointer.current = pointer;
  }, [pointer]);
  const pinnedWaypoint = (() => {
    if (!pinned || pinned.mode !== 'file' || pinned.render.content === undefined || !waypoints?.length) return undefined;
    const w = waypoints.filter((x) => normPath(x.path) === normPath(pinned.path)).at(-1);
    if (!w) return undefined;
    const found = resolveWaypoint(pinned.render.content, w);
    if (found === null) return undefined;
    return { line: (pinned.render.start_line ?? 1) - 1 + found, note: w.note, open: pinnedWpOpen, onToggle: () => setPinnedWpOpen((o) => !o) };
  })();

  // tour signals set the scroll target; nothing else does. A human toggling
  // a card open or closed keeps the view exactly where it is.
  const [scrollTo, setScrollTo] = useState<{ line: number; nonce: number }>();
  const scrollSeq = useRef(1);
  useEffect(() => {
    const t = [...pinnedReview, ...tabReview].find((x) => x.comment.id === focusThreadId);
    if (t) setScrollTo({ line: t.line, nonce: scrollSeq.current++ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusThreadId]);
  useEffect(() => {
    if (pinnedWaypoint) setScrollTo({ line: pinnedWaypoint.line, nonce: scrollSeq.current++ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastWpAt]);

  // waypoint markers for the real on-disk file being shown: re-resolve each
  // against its content — matched ones live at their found line, stale ones
  // sit at their recorded line purely as a way to GO TO their snapshot
  const tabMarks = userTab && !userTab.snapshot && userTab.content !== undefined && waypoints?.length && onOpenSnapshot
    ? waypoints
      .filter((w) => normPath(w.path) === normPath(userTab.path))
      .map((w) => {
        const line = resolveWaypoint(userTab.content!, w);
        // a stale pin whose recorded line is past EOF still needs somewhere
        // to live: clamp into the file so it stays clickable
        const pin = Math.max(1, Math.min(w.line, userTab.content!.split('\n').length));
        return line === null
          ? { line: pin, stale: true, onClick: () => onOpenSnapshot(w) }
          : { line, stale: false, onClick: () => onActivateWaypoint?.(userTab.key, line, w.note) };
      })
    : undefined;

  const textBandFor = (path: string) => (textSel?.rects.length && normPath(textSel.path) === normPath(path)
    ? { rects: textSel.rects }
    : undefined);

  const historyAction = (path: string) => onOpenTimeline && (
    <span
      className="codicon codicon-history tabAction"
      title="File timeline: every touch of this file in the session"
      onClick={(e) => { e.stopPropagation(); onOpenTimeline(path); }}
    />
  );

  return (
    <div className="editorPane">
      <div className="tabs">
        <div
          key={`pf${pinnedFlash}`}
          ref={active === 'pinned' ? activeTabRef : undefined}
          className={`tab pinnedTab ${active === 'pinned' ? 'active' : ''} ${pinnedFlash ? 'tabFlashAnim' : ''}`}
          title={pinned?.path ?? 'the file being read or edited by the replay'}
          onClick={() => onSelect('pinned')}
        >
          <span className="pinDot" />
          {pinned ? (pinned.mode === 'diff' ? '± ' : '') + shortName(pinned.path) : 'live'}
          {pinned && tabReviewDot(pinned.path)}
          {pinned && onOpenCurrent && (
            <span
              className="codicon codicon-go-to-file tabAction"
              title="Open the current on-disk version (read only)"
              onClick={(e) => { e.stopPropagation(); onOpenCurrent(pinned.path); }}
            />
          )}
          {pinned && historyAction(pinned.path)}
        </div>
        {timelinePath && (
          <div
            ref={active === 'timeline' ? activeTabRef : undefined}
            className={`tab timelineTab ${active === 'timeline' ? 'active' : ''}`}
            title={`${timelinePath} — session history of this file`}
            onClick={() => onSelect('timeline')}
          >
            <span className="codicon codicon-history tabAction" style={{ margin: 0 }} />
            {shortName(timelinePath)} <span className="roBadge">timeline</span>
            <span className="tabClose" onClick={(e) => { e.stopPropagation(); onCloseTimeline?.(); }}>✕</span>
          </div>
        )}
        {userTabs.map((t) => (
          <div key={t.key}
            ref={t.key === active ? activeTabRef : undefined}
            className={`tab ${t.key === active ? 'active' : ''} ${t.snapshot ? 'snapshotTab' : ''}`}
            title={t.snapshot ? `${t.path} — waypoint snapshot: the file as it was when the waypoint was dropped` : t.diff ? `${t.path} — git diff` : `${t.path} (read only)`}
            onClick={() => onSelect(t.key)}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); onClose(t.key); } }}>
            {t.diff ? '± ' : ''}{shortName(t.path)}{t.snapshot
              ? ' [snapshot]'
              : t.diff
                ? <> <span className="roBadge">{t.diff.area === 'staged' ? 'staged' : 'changes'}</span></>
                : <> <span className="roBadge">read only</span></>}
            {tabReviewDot(t.path)}
            {(t.snapshot || t.diff) && onOpenCurrent && (
              <span
                className="codicon codicon-go-to-file tabAction"
                title="Open the current on-disk version (read only)"
                onClick={(e) => { e.stopPropagation(); onOpenCurrent(t.path); }}
              />
            )}
            {historyAction(t.path)}
            <span className="tabClose" onClick={(e) => { e.stopPropagation(); onClose(t.key); }}>✕</span>
          </div>
        ))}
        {userTabs.length >= 2 && onCloseAll && (
          <span
            className="codicon codicon-close-all tabsCloseAll"
            title="Close all tabs (the live tab stays)"
            onClick={onCloseAll}
          />
        )}
      </div>
      {worktreeBanner && (
        <div className="wtBanner">
          <span className="codicon codicon-git-branch" />
          WORKTREE · {worktreeBanner.label}
          {worktreeBanner.onOpen && (
            <span className="wtBannerAction" onClick={worktreeBanner.onOpen}>open this worktree</span>
          )}
        </div>
      )}
      {active === 'timeline' && timelinePath ? (
        timelineBody
      ) : userTab ? (
        userTab.diff ? (
          userTab.diff.hunks.length ? (
            <DiffView
              key={userTab.key}
              file={{ path: userTab.path, mode: 'diff', render: { verb: 'patch_file', hunks: userTab.diff.hunks }, touchedAt: userTab.nonce ?? 0 }}
              animate={false}
              fileLines={userTab.diff.fileLines}
              onComment={reviewing ? (c) => onReviewComment!({
                path: userTab.path, line: c.line,
                ...(c.lineEnd > c.line ? { line_end: c.lineEnd } : {}),
                before: c.before, anchor: c.anchor, after: c.after, body: c.body,
              }) : undefined}
            />
          ) : (
            <div className="emptyHint">no changes in this file</div>
          )
        ) : userTab.snapshot ? (
          // a virtual file: the chunk the waypoint captured, rendered exactly
          // like a real one — line numbers from the capture position
          <CodeView
            key={userTab.key}
            file={{
              path: userTab.path,
              mode: 'file',
              render: {
                verb: 'read_file',
                content: [...userTab.snapshot.before, userTab.snapshot.anchor, ...userTab.snapshot.after].join('\n'),
                start_line: userTab.snapshot.line - userTab.snapshot.before.length,
                region: { start: userTab.snapshot.line, end: userTab.snapshot.line },
              },
              touchedAt: userTab.nonce ?? 0,
            }}
            animate
            speed={speed}
            waypoint={onToggleWaypoint ? {
              line: userTab.snapshot.line,
              note: userTab.snapshot.note,
              open: userTab.waypointOpen ?? true,
              onToggle: () => onToggleWaypoint(userTab.key),
            } : undefined}
          />
        ) : userTab.error ? (
          <div className="emptyHint">{userTab.error}</div>
        ) : userTab.image_src ? (
          <div className="editorBody imageView"><img src={userTab.image_src} alt={userTab.path} /></div>
        ) : (
          <CodeView
            key={userTab.path}
            file={{
              path: userTab.path,
              mode: 'file',
              render: {
                verb: 'read_file',
                content: userTab.content ?? '',
                ...(userTab.line ? { region: { start: userTab.line, end: userTab.line } } : {}),
              },
              touchedAt: userTab.nonce ?? 0,
            }}
            animate={!!userTab.line}
            speed={speed}
            waypoint={userTab.waypoint && onToggleWaypoint ? {
              line: userTab.waypoint.line,
              note: userTab.waypoint.note,
              open: userTab.waypointOpen ?? true,
              onToggle: () => onToggleWaypoint(userTab.key),
            } : undefined}
            marks={tabMarks}
            onCompose={reviewing ? (line, lineEnd) => setComposeAt({
              path: userTab.path, line, lineEnd, content: userTab.content ?? '', startLine: 1,
            }) : undefined}
            composer={composerFor(userTab.path)}
            reviewMarks={tabReview.map((t) => ({
              id: t.comment.id, line: t.line, lineEnd: t.lineEnd, state: t.comment.state,
              onClick: () => setOpenThreadId((cur) => (cur === t.comment.id ? undefined : t.comment.id)),
            }))}
            thread={openThread && onReviewReply && onReviewResolve && onReviewViewOriginal ? {
              comment: openThread.comment, line: openThread.line, stale: openThread.stale,
              onReply: (body) => onReviewReply(openThread.comment.id, body),
              onResolve: () => onReviewResolve(openThread.comment.id),
              onViewOriginal: () => onReviewViewOriginal(openThread.comment),
              onClose: () => setOpenThreadId(undefined),
            } : undefined}
            scrollTo={scrollTo}
            textBand={textBandFor(userTab.path)}
          />
        )
      ) : pinned ? (
        <FileBody
          file={pinned}
          animate={animate}
          speed={speed}
          onCompose={reviewing && pinned.mode === 'file' && pinned.render.content !== undefined ? (line, lineEnd) => setComposeAt({
            path: pinned.path, line, lineEnd, step: pinned.touchedAt,
            content: pinned.render.content ?? '', startLine: pinned.render.start_line ?? 1,
          }) : undefined}
          composer={composerFor(pinned.path)}
          waypoint={pinnedWaypoint}
          reviewMarks={pinnedReview.map((t) => ({
            id: t.comment.id, line: t.line, lineEnd: t.lineEnd, state: t.comment.state,
            onClick: () => setOpenThreadId((cur) => (cur === t.comment.id ? undefined : t.comment.id)),
          }))}
          thread={pinnedThread && onReviewReply && onReviewResolve && onReviewViewOriginal ? {
            comment: pinnedThread.comment, line: pinnedThread.line, stale: pinnedThread.stale,
            onReply: (body) => onReviewReply(pinnedThread.comment.id, body),
            onResolve: () => onReviewResolve(pinnedThread.comment.id),
            onViewOriginal: () => onReviewViewOriginal(pinnedThread.comment),
            onClose: () => setOpenThreadId(undefined),
          } : undefined}
          scrollTo={scrollTo}
          textBand={textBandFor(pinned.path)}
        />
      ) : (
        <div className="emptyHint">files the agent reads will open here</div>
      )}
    </div>
  );
}
