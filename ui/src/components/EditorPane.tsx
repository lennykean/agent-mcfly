import { useEffect, useMemo, useRef, useState } from 'react';
import hljs from 'highlight.js/lib/common';
import powershell from 'highlight.js/lib/languages/powershell';
import 'highlight.js/styles/vs2015.css';
import { TYPE_CPS, type FileView } from '../lib/timeline';

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

export function CodeView({ file, animate, speed, flashOnly, blame }: {
  file: FileView; animate: boolean; speed: number;
  flashOnly?: boolean;
  blame?: { marks: (BlameMark | null)[]; onJump: (step: number) => void };
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
      el.scrollTo({ top: region ? Math.max(0, (region.start - startLine) * LH - 60) : 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path, file.touchedAt, typedDone, caretY]);

  const regionTop = region ? (region.start - startLine) * LH : 0;
  const regionH = region ? (region.end - region.start + 1) * LH : 0;
  const maskBH = regionBottomY - (caretY + LH);

  return (
    <div className="editorBody" ref={ref}>
      <div className="codewrap" style={{ minHeight: total * LH }}>
        <div className="gutter">
          {Array.from({ length: total }, (_, i) => <div key={i}>{startLine + i}</div>)}
        </div>
        {blame && (
          <div className="blameGutter">
            {Array.from({ length: total }, (_, i) => {
              const m = blame.marks[i] ?? null;
              return m ? (
                <div key={i} className="blameStamp" title={m.title} onClick={() => blame.onJump(m.step)}>{m.text}</div>
              ) : (
                <div key={i} className="blameNone">·</div>
              );
            })}
          </div>
        )}
        <pre className="code hljs" dangerouslySetInnerHTML={{ __html: html }} />
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
            <span>{`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`}</span>
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

export interface UserTab { path: string; content?: string; image_src?: string; error?: string }

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
  timelinePath, onOpenTimeline, onCloseTimeline, timelineBody,
}: {
  pinned?: FileView; animate: boolean; speed: number;
  userTabs: UserTab[]; active: string; // 'pinned' | 'timeline' | user tab path
  onSelect: (key: string) => void; onClose: (path: string) => void;
  onOpenCurrent?: (path: string) => void;
  timelinePath?: string;
  onOpenTimeline?: (path: string) => void;
  onCloseTimeline?: () => void;
  timelineBody?: React.ReactNode;
}) {
  const activeTabRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  const userTab = active !== 'pinned' && active !== 'timeline' ? userTabs.find((t) => t.path === active) : undefined;

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
          <div key={t.path}
            ref={t.path === active ? activeTabRef : undefined}
            className={`tab ${t.path === active ? 'active' : ''}`}
            title={`${t.path} (read only)`}
            onClick={() => onSelect(t.path)}>
            {shortName(t.path)} <span className="roBadge">read only</span>
            {historyAction(t.path)}
            <span className="tabClose" onClick={(e) => { e.stopPropagation(); onClose(t.path); }}>✕</span>
          </div>
        ))}
      </div>
      {active === 'timeline' && timelinePath ? (
        timelineBody
      ) : userTab ? (
        userTab.error ? (
          <div className="emptyHint">{userTab.error}</div>
        ) : userTab.image_src ? (
          <div className="editorBody imageView"><img src={userTab.image_src} alt={userTab.path} /></div>
        ) : (
          <CodeView
            key={userTab.path}
            file={{ path: userTab.path, mode: 'file', render: { verb: 'read_file', content: userTab.content ?? '' }, touchedAt: 0 }}
            animate={false}
            speed={speed}
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
