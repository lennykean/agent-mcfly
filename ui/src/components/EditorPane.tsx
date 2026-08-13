import { useEffect, useMemo, useRef, useState } from 'react';
import hljs from 'highlight.js/lib/common';
import powershell from 'highlight.js/lib/languages/powershell';
import 'highlight.js/styles/vs2015.css';
import { TYPE_CPS, normPath, resolveWaypoint, type FileView, type WaypointEntry } from '../lib/timeline';
import { Md } from './ChatPane';

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

export function CodeView({ file, animate, speed, flashOnly, blame, waypoint, marks }: {
  file: FileView; animate: boolean; speed: number;
  flashOnly?: boolean;
  blame?: { marks: (BlameMark | null)[]; compact?: boolean; onJump: (step: number) => void; onToggle?: () => void };
  waypoint?: { line: number; note: string; open: boolean; onToggle: () => void };
  // all waypoint markers for this file: resolved ones open their card here;
  // stale ones are just something to GO TO — click opens the snapshot tab
  marks?: { line: number; stale: boolean; onClick: () => void }[];
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

  const html = useMemo(() => highlightHtml(content, file.path), [content, file.path]);
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
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typing) {
      if (typedDone) return;
      if (caretY > el.scrollTop + el.clientHeight - 80) el.scrollTop = caretY - el.clientHeight + 80;
      else if (caretY < el.scrollTop) el.scrollTop = Math.max(0, caretY - 60);
    } else {
      // leave headroom above the target line for an open waypoint card
      const headroom = waypoint?.open ? 190 : 60;
      el.scrollTo({ top: region ? Math.max(0, (region.start - startLine) * LH - headroom) : 0 });
    }
    // content is a dep: user tabs load asynchronously, and the region scroll
    // must re-fire once the real content (and thus scrollHeight) exists
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path, file.touchedAt, typedDone, caretY, content]);

  const regionTop = region ? (region.start - startLine) * LH : 0;
  const regionH = region ? (region.end - region.start + 1) * LH : 0;
  const maskBH = regionBottomY - (caretY + LH);

  return (
    <div className="editorBody" ref={ref} data-path={file.path} data-start-line={startLine}>
      <div className="codewrap" style={{ minHeight: total * LH }}>
        <div className="gutter">
          {Array.from({ length: total }, (_, i) => <div key={i}>{startLine + i}</div>)}
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
        {(waypoint || marks?.length) ? (
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
        <pre className="code hljs" dangerouslySetInnerHTML={{ __html: html }} />
        {waypoint?.open && (() => {
          const lineTop = (waypoint.line - startLine) * LH;
          // near the top there's no room above the line: place the card below
          const below = lineTop < 190;
          return (
            <div className="wpOverlayWrap" style={below ? { top: lineTop + LH + 6, transform: 'none' } : { top: lineTop - 4 }}>
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

export function DiffView({ file, animate }: { file: FileView; animate: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: 0 });
  }, [file.path, file.touchedAt]);
  return (
    <div className={`editorBody ${animate ? 'diffFlash' : ''}`} ref={ref}>
      {(file.render.hunks ?? []).map((h, hi) => (
        <div key={hi}>
          <div className="codeline hunk">
            <span className="ln" />
            <span>{h.oldStart >= 1 ? `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` : '@@'}</span>
          </div>
          {h.lines.map((line, li) => {
            const cls = line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : '';
            return (
              <div key={li} className={`codeline ${cls}`}>
                <span className="ln" />
                <span className="lc">{line}</span>
              </div>
            );
          })}
        </div>
      ))}
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
}

function FileBody({ file, animate, speed }: { file: FileView; animate: boolean; speed: number }) {
  return file.mode === 'diff'
    ? <DiffView key={`${file.path}:${file.touchedAt}`} file={file} animate={animate} />
    : file.mode === 'image'
      ? <ImageView key={`${file.path}:${file.touchedAt}`} file={file} animate={animate} />
      : <CodeView key={`${file.path}:${file.touchedAt}`} file={file} animate={animate} speed={speed} />;
}

// One PINNED tab always shows the file the replay is touching (jumps active on
// every touch, cannot be closed); explorer files open as closable read-only tabs.
export function EditorPane({
  pinned, animate, speed, userTabs, active, onSelect, onClose, onOpenCurrent,
  timelinePath, onOpenTimeline, onCloseTimeline, timelineBody, onToggleWaypoint,
  waypoints, onOpenSnapshot, onActivateWaypoint,
}: {
  pinned?: FileView; animate: boolean; speed: number;
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
}) {
  const activeTabRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  const userTab = active !== 'pinned' && active !== 'timeline' ? userTabs.find((t) => t.key === active) : undefined;

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
          ref={active === 'pinned' ? activeTabRef : undefined}
          className={`tab pinnedTab ${active === 'pinned' ? 'active' : ''}`}
          title={pinned?.path ?? 'the file being read or edited by the replay'}
          onClick={() => onSelect('pinned')}
        >
          <span className="pinDot" />
          {pinned ? (pinned.mode === 'diff' ? '± ' : '') + shortName(pinned.path) : 'live'}
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
            title={t.snapshot ? `${t.path} — waypoint snapshot: the file as it was when the waypoint was dropped` : `${t.path} (read only)`}
            onClick={() => onSelect(t.key)}>
            {shortName(t.path)}{t.snapshot
              ? ' [snapshot]'
              : <> <span className="roBadge">read only</span></>}
            {t.snapshot && onOpenCurrent && (
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
      </div>
      {active === 'timeline' && timelinePath ? (
        timelineBody
      ) : userTab ? (
        userTab.snapshot ? (
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
          />
        )
      ) : pinned ? (
        <FileBody file={pinned} animate={animate} speed={speed} />
      ) : (
        <div className="emptyHint">files the agent reads will open here</div>
      )}
    </div>
  );
}
