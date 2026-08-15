import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import hljs from 'highlight.js/lib/common';
import powershell from 'highlight.js/lib/languages/powershell';
import 'highlight.js/styles/vs2015.css';
import { TYPE_CPS, normPath, resolveWaypoint, type FileView, type WaypointEntry } from '../lib/timeline';
import { Md } from './ChatPane';
import { editorSelFor, reportEditorSelection, updateSnapshot } from '../lib/workspace';
import { EXTEND, actionOf, focusEditor, notify, resolve } from '../lib/keys';
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

// tab-aware column math shared by every caret surface (tab stop = 8)
const expand = (s: string, col: number) => {
  let x = 0;
  for (let i = 0; i < col && i < s.length; i++) x = s[i] === '\t' ? (Math.floor(x / 8) + 1) * 8 : x + 1;
  return x;
};
// a block cursor sits ON a character, never past the end of the line
const maxCol = (s: string) => Math.max(0, s.length - 1);

// the find drive: EditorPane's status bar owns the query, the active view
// matches/highlights/cycles. Smart case like vim: capitals make it sensitive.
export interface FindDrive {
  query: string;
  tick: number; // Enter bumps it; the view advances the current match
  dir: 1 | -1;
  onState: (cur: number, total: number) => void;
}
const makeFindRe = (q: string) => {
  try { return new RegExp(q, /[A-Z]/.test(q) ? 'g' : 'gi'); } catch { return null; }
};
const FIND_CAP = 2000;
// motions that a count (vim 5j) repeats; everything else ignores counts
const COUNTABLE = new Set(['up', 'down', 'left', 'right', 'pageUp', 'pageDown', 'wordNext', 'wordPrev', 'wordEnd']);

// vim word motions over an abstract list of text units (lines, or a diff's
// content rows). Three character classes like vim: whitespace, word, other.
const CLS = (ch: string | undefined) => (ch === undefined || /\s/.test(ch) ? 0 : /\w/.test(ch) ? 1 : 2);
function wordMove(kind: 'w' | 'b' | 'e', texts: string[], u: number, col: number): { u: number; col: number } {
  const textAt = (i: number) => texts[i] ?? '';
  const maxU = texts.length - 1;
  const p = { u, col };
  const at = () => CLS(textAt(p.u)[p.col]);
  const adv = () => {
    if (p.col < maxCol(textAt(p.u)) ) { p.col++; return true; }
    if (p.u < maxU) { p.u++; p.col = 0; return true; }
    return false;
  };
  const back = () => {
    if (p.col > 0) { p.col--; return true; }
    if (p.u > 0) { p.u--; p.col = maxCol(textAt(p.u)); return true; }
    return false;
  };
  if (kind === 'w') {
    const c0 = at();
    if (c0 !== 0) { do { if (!adv()) return p; } while (at() === c0); }
    while (at() === 0) { if (!adv()) return p; }
    return p;
  }
  if (kind === 'b') {
    if (!back()) return p;
    while (at() === 0) { if (!back()) return p; }
    const c1 = at();
    while (p.col > 0 && CLS(textAt(p.u)[p.col - 1]) === c1) p.col--;
    return p;
  }
  // 'e': end of the next word
  if (!adv()) return p;
  while (at() === 0) { if (!adv()) return p; }
  const c2 = at();
  while (CLS(textAt(p.u)[p.col + 1]) === c2) p.col++;
  return p;
}
const colFromX = (s: string, xChars: number) => {
  let x = 0;
  for (let i = 0; i < s.length; i++) {
    const nx = s[i] === '\t' ? (Math.floor(x / 8) + 1) * 8 : x + 1;
    if (nx > xChars) return i;
    x = nx;
  }
  return maxCol(s);
};

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

export function CodeView({ file, animate, speed, flashOnly, blame, waypoint, marks, onCompose, composer, reviewMarks, thread, scrollTo, textBand, find, onVisualMode }: {
  file: FileView; animate: boolean; speed: number;
  flashOnly?: boolean;
  find?: FindDrive;
  onVisualMode?: (m: null | 'char' | 'line' | 'normal') => void;
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

  // ---- read-only caret: click places it, arrows move it, the view follows.
  // While the editor holds focus the arrows are the caret's; the playhead
  // gets them back on blur. Fully imperative — a keypress must not cause a
  // React render, or the cursor drags. No editing: a pointer, not a pen. ----
  const caretRef = useRef<{ line: number; col: number } | null>(null);
  const caretEl = useRef<HTMLDivElement>(null);
  const wishCol = useRef(0); // sticky column across short lines
  const preRef = useRef<HTMLPreElement>(null);
  // CRLF files: the \r is not a column — it would give the caret a phantom
  // cell at line end and leak into reported selection text
  const contentLines = useMemo(() => content.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)), [content]);
  const blinkTimer = useRef<number>(undefined);
  const paintCaret = () => {
    const el = caretEl.current;
    const c = caretRef.current;
    if (!el) return;
    if (!c || !preRef.current) { el.style.display = 'none'; return; }
    const text = contentLines[c.line - startLine] ?? '';
    el.style.display = 'block';
    el.style.top = `${(c.line - startLine) * LH}px`;
    el.style.left = `${preRef.current.offsetLeft + expand(text, c.col) * charWidth()}px`;
    el.style.width = `${Math.max(charWidth(), text[c.col] === '\t' ? charWidth() * 2 : charWidth())}px`;
    // solid while moving; the blink resumes once the caret settles
    el.style.animationName = 'none';
    clearTimeout(blinkTimer.current);
    blinkTimer.current = window.setTimeout(() => { el.style.animationName = ''; }, 350);
    updateSnapshot({ cursor: { path: file.path, line: c.line, col: c.col } });
  };
  const caretSeeVisible = (line: number) => {
    const el = ref.current;
    if (!el) return;
    const y = (line - startLine) * LH;
    if (y < el.scrollTop + LH) el.scrollTop = Math.max(0, y - LH);
    else if (y > el.scrollTop + el.clientHeight - 2 * LH) el.scrollTop = y - el.clientHeight + 2 * LH;
  };
  const placeCaret = (e: React.MouseEvent) => {
    if (!window.getSelection()?.isCollapsed) return; // a drag-select is not a click
    const pre = preRef.current;
    if (!pre) return;
    const rect = pre.getBoundingClientRect();
    const line = Math.max(startLine, Math.min(startLine + total - 1, Math.floor((e.clientY - rect.top) / LH) + startLine));
    const text = contentLines[line - startLine] ?? '';
    const col = colFromX(text, Math.round((e.clientX - rect.left) / charWidth()));
    wishCol.current = expand(text, col);
    caretRef.current = { line, col };
    selAnchor.current = null;
    setVisual(null); // a click is normal mode
    // keyboard selections are synthetic — no selectionchange fires to clear
    // them, so the click-clears-this-file contract is enforced here
    clearKbLocal();
    reportEditorSelection({ path: file.path, clear: true });
    paintCaret();
    ref.current?.focus();
  };
  // shift+arrows select from the caret, through the SAME reporting pipeline
  // as a mouse drag: bands, snapshot entry, recency. The anchor is where the
  // extension started; a plain (unshifted) move collapses it.
  const selAnchor = useRef<{ line: number; col: number } | null>(null);
  const visual = useRef<null | 'char' | 'line'>(null); // vim visual mode: sticky shift
  // reported mode: with a live caret, "no visual mode" is NORMAL mode
  const setVisual = (m: null | 'char' | 'line') => {
    visual.current = m;
    onVisualMode?.(m ?? (caretRef.current ? 'normal' : null));
  };
  useEffect(() => () => onVisualMode?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- find: match, highlight, cycle ----
  const [findCur, setFindCur] = useState(-1);
  const findMatches = useMemo(() => {
    const re = find?.query ? makeFindRe(find.query) : null;
    if (!re) return [];
    const out: { line: number; c0: number; c1: number }[] = [];
    for (let i = 0; i < contentLines.length && out.length < FIND_CAP; i++) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(contentLines[i])) && out.length < FIND_CAP) {
        out.push({ line: i + startLine, c0: m.index, c1: m.index + Math.max(1, m[0].length) });
        if (!m[0].length) re.lastIndex++;
      }
    }
    return out;
  }, [find?.query, contentLines, startLine]);
  useEffect(() => { setFindCur(-1); }, [find?.query]);
  useEffect(() => { find?.onState(findCur >= 0 ? findCur + 1 : 0, findMatches.length); }, [findMatches.length, findCur]); // eslint-disable-line react-hooks/exhaustive-deps
  const findLastTick = useRef<number | null>(null);
  useEffect(() => {
    if (!find) { findLastTick.current = null; return; }
    if (findLastTick.current === null) { findLastTick.current = find.tick; return; } // arm on open
    if (find.tick === findLastTick.current) return;
    findLastTick.current = find.tick;
    if (!findMatches.length) return;
    // advance from the caret position (wrapping), vim-style
    const c = caretRef.current;
    let idx: number;
    if (find.dir === 1) {
      idx = findMatches.findIndex((m) => !c || m.line > c.line || (m.line === c.line && m.c0 > c.col));
      if (idx < 0) idx = 0;
    } else {
      const ri = [...findMatches].reverse().findIndex((m) => !c || m.line < c.line || (m.line === c.line && m.c0 < c.col));
      idx = ri < 0 ? findMatches.length - 1 : findMatches.length - 1 - ri;
    }
    const m = findMatches[idx];
    const text = contentLines[m.line - startLine] ?? '';
    wishCol.current = expand(text, m.c0);
    caretRef.current = { line: m.line, col: Math.min(m.c0, maxCol(text)) };
    paintCaret();
    caretSeeVisible(m.line);
    setFindCur(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find?.tick]);
  // :N (command bar) goes to a line in the VISIBLE view
  useEffect(() => {
    const on = (ev: Event) => {
      if (!ref.current || ref.current.offsetParent === null) return; // hidden view
      const n = (ev as CustomEvent).detail as number;
      const line = Math.max(startLine, Math.min(startLine + total - 1, n));
      wishCol.current = 0;
      caretRef.current = { line, col: 0 };
      paintCaret();
      caretSeeVisible(line);
      ref.current.focus();
    };
    window.addEventListener('mcfly:goline', on);
    return () => window.removeEventListener('mcfly:goline', on);
  });
  // extension paints bands IMPERATIVELY per keystroke (reporting through app
  // state on every press is what made visual mode laggy) and debounces the
  // real report until the movement rests
  const kbBandsEl = useRef<HTMLDivElement>(null);
  const kbTimer = useRef<number>(undefined);
  const kbFlush = useRef<(() => void) | null>(null);
  const flushKbSel = () => { clearTimeout(kbTimer.current); const f = kbFlush.current; kbFlush.current = null; f?.(); };
  const clearKbLocal = () => {
    clearTimeout(kbTimer.current);
    kbFlush.current = null;
    if (kbBandsEl.current) kbBandsEl.current.innerHTML = '';
  };
  const reportKbSel = () => {
    const a = selAnchor.current;
    const c = caretRef.current;
    const pre = preRef.current;
    if (!a || !c || !pre) return;
    const fwd = a.line < c.line || (a.line === c.line && a.col <= c.col);
    const [s, e2] = fwd ? [a, c] : [c, a];
    const cw = charWidth();
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    const parts: string[] = [];
    let textLen = 0;
    for (let L = s.line; L <= e2.line; L++) {
      const text = contentLines[L - startLine] ?? '';
      // visual-line mode takes whole lines; the block caret sits ON a
      // character, so the far end's char is included
      const c0 = visual.current === 'line' ? 0 : L === s.line ? s.col : 0;
      const c1 = visual.current === 'line' ? text.length
        : L === e2.line ? Math.min(text.length, e2.col + 1) : text.length;
      if (textLen < 2100) { const p = text.slice(c0, c1); parts.push(p); textLen += p.length + 1; }
      if (rects.length >= 300) continue; // band cap, like the mouse path
      rects.push({
        x: pre.offsetLeft + expand(text, c0) * cw,
        y: (L - startLine) * LH,
        w: Math.max(cw / 2, (expand(text, c1) - expand(text, c0)) * cw),
        h: LH,
      });
    }
    const host = kbBandsEl.current;
    if (host) {
      host.innerHTML = '';
      for (const rc of rects) {
        const d = document.createElement('div');
        d.className = 'textSelBand';
        d.style.cssText = `left:${rc.x}px;top:${rc.y}px;width:${rc.w}px;height:${rc.h}px`;
        host.appendChild(d);
      }
    }
    kbFlush.current = () => {
      if (kbBandsEl.current) kbBandsEl.current.innerHTML = ''; // the reported band takes over
      reportEditorSelection({ path: file.path, lines: [s.line, e2.line], text: parts.join('\n'), rects });
    };
    clearTimeout(kbTimer.current);
    kbTimer.current = window.setTimeout(flushKbSel, 150);
  };
  const moveCaret = (e: React.KeyboardEvent) => {
    // cards floating over the code (composer, thread) own their keystrokes
    if ((e.target as Element).closest?.('.wpCard, textarea, input, button')) return;
    // comment on the highlighted lines (or the caret line) in the review
    if (onCompose && actionOf(e, ['comment'])) {
      flushKbSel(); // a debounced visual selection must land before we read it
      const sel = editorSelFor(file.path);
      const c0 = caretRef.current;
      const range = sel?.lines?.length ? [Math.min(...sel.lines), Math.max(...sel.lines)]
        : c0 ? [c0.line, c0.line] : null;
      if (range) {
        e.preventDefault();
        e.stopPropagation();
        onCompose(range[0], range[1]);
        return;
      }
    }
    const c = caretRef.current;
    if (!c) {
      // a focused body must always have a pointer: the first key places it
      if (!actionOf(e, ['up', 'down', 'left', 'right', 'pageUp', 'pageDown', 'home', 'end'])) return;
      wishCol.current = 0;
      caretRef.current = { line: startLine, col: 0 };
      paintCaret();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const res = resolve(e, ['extendUp', 'extendDown', 'extendLeft', 'extendRight', 'extendHome', 'extendEnd', 'visual', 'visualLine', 'wordNext', 'wordPrev', 'wordEnd', 'yank', 'copy', 'docHome', 'docEnd', 'up', 'down', 'left', 'right', 'pageUp', 'pageDown', 'home', 'end', 'dismiss']);
    const raw = res?.action;
    if (!raw) return;
    if (raw === 'copy') {
      flushKbSel(); // a debounced visual selection must land before we read it
      const sel = editorSelFor(file.path);
      if (!sel?.text) return; // no entry: native copy proceeds
      e.preventDefault();
      e.stopPropagation();
      void navigator.clipboard.writeText(sel.text);
      notify(`copied ${sel.text.length} chars`);
      return;
    }
    if (raw === 'yank') {
      const text = contentLines[c.line - startLine] ?? '';
      e.preventDefault();
      e.stopPropagation();
      void navigator.clipboard.writeText(`${text}\n`);
      notify('yanked line');
      return;
    }
    // visual mode is a sticky shift: every plain movement extends
    const extending = raw in EXTEND || (visual.current !== null && raw !== 'dismiss');
    const action = raw in EXTEND ? EXTEND[raw as keyof typeof EXTEND] : raw;
    if (extending && !selAnchor.current) selAnchor.current = { ...c };
    const el = ref.current;
    const pageLines = el ? Math.max(4, Math.floor(el.clientHeight / LH) - 2) : 20;
    const last = startLine + total - 1;
    let { line, col } = c;
    const lineText = () => contentLines[line - startLine] ?? '';
    let vertical = false;
    const times = COUNTABLE.has(action) ? (res?.count ?? 1) : 1;
    for (let rep = 0; rep < times; rep++) {
    switch (action) {
      case 'visual':
      case 'visualLine': {
        const mode = action === 'visual' ? 'char' : 'line';
        if (visual.current === mode) setVisual(null); // toggle off, selection persists
        else {
          setVisual(mode);
          selAnchor.current = { line, col };
          reportKbSel(); // the caret's char (or line) highlights immediately
        }
        break;
      }
      case 'wordNext':
      case 'wordPrev':
      case 'wordEnd': {
        const m = wordMove(action === 'wordNext' ? 'w' : action === 'wordPrev' ? 'b' : 'e', contentLines, line - startLine, col);
        line = m.u + startLine;
        col = m.col;
        break;
      }
      case 'up': line = Math.max(startLine, line - 1); vertical = true; break;
      case 'down': line = Math.min(last, line + 1); vertical = true; break;
      case 'pageUp': line = Math.max(startLine, line - pageLines); vertical = true; break;
      case 'pageDown': line = Math.min(last, line + pageLines); vertical = true; break;
      case 'left':
        if (col > 0) col -= 1;
        else if (line > startLine) { line -= 1; col = maxCol(lineText()); }
        break;
      case 'right':
        if (col < maxCol(lineText())) col += 1;
        else if (line < last) { line += 1; col = 0; }
        break;
      case 'home': col = 0; break;
      case 'end': col = maxCol(lineText()); break;
      case 'docHome': line = startLine; col = 0; break;
      case 'docEnd': line = last; col = maxCol(contentLines[last - startLine] ?? ''); break;
      case 'dismiss':
        // the escape ladder: leave visual mode, then clear this file's
        // selection, then NOTHING — escape never dumps you back to scroll
        e.preventDefault();
        e.stopPropagation();
        if (visual.current) { setVisual(null); flushKbSel(); }
        else if (editorSelFor(file.path)) {
          clearKbLocal();
          selAnchor.current = null;
          reportEditorSelection({ path: file.path, clear: true });
        }
        return;
    }
    }
    e.preventDefault();
    e.stopPropagation();
    const text = contentLines[line - startLine] ?? '';
    if (vertical) col = colFromX(text, wishCol.current);
    col = Math.min(col, maxCol(text));
    if (!vertical) wishCol.current = expand(text, col);
    caretRef.current = { line, col };
    // a plain move drops the ANCHOR (the next shift starts fresh) but the
    // selection itself persists, exactly like mouse bands do. Re-checked
    // AFTER the switch: the visual cases toggle the mode itself.
    if (raw in EXTEND || visual.current !== null) reportKbSel();
    else selAnchor.current = null;
    paintCaret();
    caretSeeVisible(line);
  };
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
    <div
      className="editorBody" ref={ref} data-path={file.path} data-start-line={startLine} tabIndex={-1} onKeyDown={moveCaret}
      onFocus={() => {
        // keyboard entry ('open' or panel hop): a caret must exist to move;
        // a caret already placed is WHERE YOU WERE — keep it
        if (!caretRef.current) {
          wishCol.current = 0;
          caretRef.current = { line: startLine, col: 0 };
          paintCaret();
        }
        setVisual(visual.current); // re-announce the mode to the status bar
      }}
    >
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
        <pre className="code hljs" ref={preRef} dangerouslySetInnerHTML={html} onClick={placeCaret} />
        <div className="userCaret" ref={caretEl} style={{ display: 'none' }} />
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
        <div ref={kbBandsEl} />
        {find && findMatches.map((m, i) => {
          const text = contentLines[m.line - startLine] ?? '';
          const cw = charWidth();
          const x = (preRef.current?.offsetLeft ?? 0) + expand(text, m.c0) * cw;
          return (
            <div
              key={`f${i}`} className={`findBand${i === findCur ? ' cur' : ''}`}
              style={{ left: x, top: (m.line - startLine) * LH, width: Math.max(3, (expand(text, m.c1) - expand(text, m.c0)) * cw), height: LH }}
            />
          );
        })}
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

export function DiffView({ file, animate, onComment, fileLines, textBand, find, onVisualMode, reviewMarks, thread }: {
  find?: FindDrive;
  onVisualMode?: (m: null | 'char' | 'line' | 'normal') => void;
  file: FileView; animate: boolean;
  // present = review mode: lines that exist on disk (green + context) take comments
  onComment?: (c: DiffComment) => void;
  // present = the on-disk file: hunk gaps become expandable context
  fileLines?: string[];
  // the persistent text selection fragments, same as CodeView
  textBand?: { rects: { x: number; y: number; w: number; h: number }[] };
  // existing review threads, anchored by NEW-side line numbers — the same
  // contract CodeView has, so commented lines are marked in diffs too
  reviewMarks?: { id: string; line: number; lineEnd: number; state: ReviewComment['state']; onClick: () => void }[];
  thread?: {
    comment: ReviewComment; line: number; stale: boolean;
    onReply: (body: string) => void; onResolve: () => void;
    onViewOriginal: () => void; onClose: () => void;
  };
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

  // ---- the read-only caret, diff edition: walks content rows (gaps and
  // hunk headers are skipped), same imperative zero-render machinery ----
  const dCaret = useRef<{ row: number; col: number } | null>(null);
  const dCaretEl = useRef<HTMLDivElement>(null);
  const dWish = useRef(0);
  const dBlink = useRef<number>(undefined);
  const wrapRef = useRef<HTMLDivElement>(null);
  const isContent = (i: number) => rows[i] && rows[i].kind !== 'hunk' && rows[i].kind !== 'gap';
  // the caret STOPS on collapsed gaps (soft select; right expands) — only
  // hunk headers are skipped over
  const isStop = (i: number) => !!rows[i] && rows[i].kind !== 'hunk';
  const rowText = (i: number) => (isContent(i) ? (rows[i] as DiffRow).text : '');
  const paintDCaret = () => {
    const el = dCaretEl.current;
    const c = dCaret.current;
    const wrap = wrapRef.current;
    if (!el || !wrap) return;
    if (!c) { el.style.display = 'none'; return; }
    if (rows[c.row]?.kind === 'gap') {
      // a collapsed region: soft-select the whole row instead of a block char
      el.classList.add('rowSel');
      el.style.display = 'block';
      el.style.top = `${c.row * LH}px`;
      el.style.left = '0px';
      el.style.width = `${wrap.clientWidth}px`;
      return;
    }
    el.classList.remove('rowSel');
    const rowEl = wrap.children[c.row] as HTMLElement | undefined;
    const lc = rowEl?.querySelector('.lc') as HTMLElement | null;
    if (!lc) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.style.top = `${c.row * LH}px`;
    el.style.left = `${lc.offsetLeft + expand(rowText(c.row), c.col) * charWidth()}px`;
    el.style.width = `${charWidth()}px`;
    el.style.animationName = 'none';
    clearTimeout(dBlink.current);
    dBlink.current = window.setTimeout(() => { el.style.animationName = ''; }, 350);
    const r2 = rows[c.row] as DiffRow;
    updateSnapshot({ cursor: { path: file.path, line: r2.newNo ?? null, oldLine: r2.oldNo ?? null, col: c.col, in: 'diff' } });
  };
  const dSeeVisible = (rowIdx: number) => {
    const el = ref.current;
    if (!el) return;
    const y = rowIdx * LH;
    if (y < el.scrollTop + LH) el.scrollTop = Math.max(0, y - LH);
    else if (y > el.scrollTop + el.clientHeight - 2 * LH) el.scrollTop = y - el.clientHeight + 2 * LH;
  };
  const dPlaceCaret = (e: React.MouseEvent) => {
    if (!window.getSelection()?.isCollapsed) return;
    const rowEl = (e.target as Element).closest?.('.codeline') as HTMLElement | null;
    const wrap = wrapRef.current;
    if (!rowEl || !wrap) return;
    const idx = [...wrap.children].indexOf(rowEl);
    if (!isContent(idx)) return;
    const lc = rowEl.querySelector('.lc') as HTMLElement | null;
    if (!lc) return;
    const col = colFromX(rowText(idx), Math.round((e.clientX - lc.getBoundingClientRect().left) / charWidth()));
    dWish.current = expand(rowText(idx), col);
    dCaret.current = { row: idx, col };
    dAnchor.current = null;
    setDVisual(null); // a click is normal mode
    // keyboard selections are synthetic — no selectionchange fires to clear
    // them, so the click-clears-this-file contract is enforced here
    clearKbLocal();
    reportEditorSelection({ path: file.path, clear: true });
    paintDCaret();
    ref.current?.focus();
  };
  const dNextContent = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < rows.length; i += dir) {
      if (isStop(i)) return i;
    }
    return from;
  };
  // rows change under the caret (gap expansion): repaint in place — the
  // caret lands on the first revealed line, same index
  useEffect(() => { if (dCaret.current) paintDCaret(); }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const dInitCaret = () => {
    const first = rows.findIndex((_, i2) => isContent(i2));
    if (first < 0) return;
    dWish.current = 0;
    dCaret.current = { row: first, col: 0 };
    paintDCaret();
    setDVisual(dVisual.current); // announce NORMAL to the status bar
  };
  // shift+arrows select from the diff caret, same pipeline as a mouse drag;
  // gap and hunk rows contribute no text and no band
  const dAnchor = useRef<{ row: number; col: number } | null>(null);
  const dVisual = useRef<null | 'char' | 'line'>(null); // vim visual mode: sticky shift
  // reported mode: with a live caret, "no visual mode" is NORMAL mode
  const setDVisual = (m: null | 'char' | 'line') => {
    dVisual.current = m;
    onVisualMode?.(m ?? (dCaret.current ? 'normal' : null));
  };
  useEffect(() => () => onVisualMode?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- find over the CONTENT rows ----
  const [findCur, setFindCur] = useState(-1);
  const findMatches = useMemo(() => {
    const re = find?.query ? makeFindRe(find.query) : null;
    if (!re) return [];
    const out: { row: number; c0: number; c1: number }[] = [];
    rows.forEach((r2, i) => {
      if (r2.kind === 'hunk' || r2.kind === 'gap' || out.length >= FIND_CAP) return;
      const t = (r2 as DiffRow).text;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(t)) && out.length < FIND_CAP) {
        out.push({ row: i, c0: m.index, c1: m.index + Math.max(1, m[0].length) });
        if (!m[0].length) re.lastIndex++;
      }
    });
    return out;
  }, [find?.query, rows]);
  useEffect(() => { setFindCur(-1); }, [find?.query]);
  useEffect(() => { find?.onState(findCur >= 0 ? findCur + 1 : 0, findMatches.length); }, [findMatches.length, findCur]); // eslint-disable-line react-hooks/exhaustive-deps
  const findLastTick = useRef<number | null>(null);
  useEffect(() => {
    if (!find) { findLastTick.current = null; return; }
    if (findLastTick.current === null) { findLastTick.current = find.tick; return; } // arm on open
    if (find.tick === findLastTick.current) return;
    findLastTick.current = find.tick;
    if (!findMatches.length) return;
    const c = dCaret.current;
    let idx: number;
    if (find.dir === 1) {
      idx = findMatches.findIndex((m) => !c || m.row > c.row || (m.row === c.row && m.c0 > c.col));
      if (idx < 0) idx = 0;
    } else {
      const ri = [...findMatches].reverse().findIndex((m) => !c || m.row < c.row || (m.row === c.row && m.c0 < c.col));
      idx = ri < 0 ? findMatches.length - 1 : findMatches.length - 1 - ri;
    }
    const m = findMatches[idx];
    dWish.current = expand(rowText(m.row), m.c0);
    dCaret.current = { row: m.row, col: Math.min(m.c0, maxCol(rowText(m.row))) };
    paintDCaret();
    dSeeVisible(m.row);
    setFindCur(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find?.tick]);
  // :N (command bar): land on the row carrying that new-side line
  useEffect(() => {
    const on = (ev: Event) => {
      if (!ref.current || ref.current.offsetParent === null) return; // hidden view
      const n = (ev as CustomEvent).detail as number;
      let target = -1;
      for (let i = 0; i < rows.length; i++) {
        if (!isContent(i)) continue;
        target = i;
        const no = (rows[i] as DiffRow).newNo;
        if (no !== undefined && no >= n) break;
      }
      if (target < 0) return;
      dWish.current = 0;
      dCaret.current = { row: target, col: 0 };
      paintDCaret();
      dSeeVisible(target);
      ref.current.focus();
    };
    window.addEventListener('mcfly:goline', on);
    return () => window.removeEventListener('mcfly:goline', on);
  });
  // same anti-lag scheme as CodeView: paint now, report when movement rests
  const kbBandsEl = useRef<HTMLDivElement>(null);
  const kbTimer = useRef<number>(undefined);
  const kbFlush = useRef<(() => void) | null>(null);
  const flushKbSel = () => { clearTimeout(kbTimer.current); const f = kbFlush.current; kbFlush.current = null; f?.(); };
  const clearKbLocal = () => {
    clearTimeout(kbTimer.current);
    kbFlush.current = null;
    if (kbBandsEl.current) kbBandsEl.current.innerHTML = '';
  };
  const reportDKbSel = () => {
    const a = dAnchor.current;
    const c = dCaret.current;
    const wrap = wrapRef.current;
    if (!a || !c || !wrap) return;
    const fwd = a.row < c.row || (a.row === c.row && a.col <= c.col);
    const [s, e2] = fwd ? [a, c] : [c, a];
    const cw = charWidth();
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    const parts: string[] = [];
    let textLen = 0;
    let first: DiffRow | null = null;
    let last: DiffRow | null = null;
    for (let R = s.row; R <= e2.row; R++) {
      if (!isContent(R)) continue;
      const text = rowText(R);
      // visual-line mode takes whole rows; the block caret sits ON a
      // character, so the far end's char is included
      const c0 = dVisual.current === 'line' ? 0 : R === s.row ? s.col : 0;
      const c1 = dVisual.current === 'line' ? text.length
        : R === e2.row ? Math.min(text.length, e2.col + 1) : text.length;
      if (textLen < 2100) { const p = text.slice(c0, c1); parts.push(p); textLen += p.length + 1; }
      if (rects.length < 300) {
        const lc = (wrap.children[R] as HTMLElement | undefined)?.querySelector('.lc') as HTMLElement | null;
        rects.push({
          x: (lc?.offsetLeft ?? 0) + expand(text, c0) * cw,
          y: R * LH,
          w: Math.max(cw / 2, (expand(text, c1) - expand(text, c0)) * cw),
          h: LH,
        });
      }
      first ??= rows[R] as DiffRow;
      last = rows[R] as DiffRow;
    }
    const host = kbBandsEl.current;
    if (host) {
      host.innerHTML = '';
      for (const rc of rects) {
        const d = document.createElement('div');
        d.className = 'textSelBand';
        d.style.cssText = `left:${rc.x}px;top:${rc.y}px;width:${rc.w}px;height:${rc.h}px`;
        host.appendChild(d);
      }
    }
    kbFlush.current = () => {
      if (kbBandsEl.current) kbBandsEl.current.innerHTML = '';
      reportEditorSelection({
        path: file.path,
        lines: first?.newNo !== undefined && last?.newNo !== undefined ? [first.newNo, last.newNo] : undefined,
        old_lines: first?.oldNo !== undefined && last?.oldNo !== undefined ? [first.oldNo, last.oldNo] : undefined,
        view: 'diff',
        text: parts.join('\n'),
        rects,
      });
    };
    clearTimeout(kbTimer.current);
    kbTimer.current = window.setTimeout(flushKbSel, 150);
  };
  const dMoveCaret = (e: React.KeyboardEvent) => {
    // cards floating over the diff (composer, thread) own their keystrokes
    if ((e.target as Element).closest?.('.wpCard, textarea, input, button')) return;
    // comment on the highlighted new-side lines (or the caret row's line)
    if (onComment && actionOf(e, ['comment'])) {
      flushKbSel(); // a debounced visual selection must land before we read it
      const sel = editorSelFor(file.path);
      let a: number | undefined;
      let b: number | undefined;
      if (sel?.lines?.length) { a = Math.min(...sel.lines); b = Math.max(...sel.lines); }
      else {
        const c0 = dCaret.current;
        const row = c0 ? rows[c0.row] : undefined;
        const n = row && row.kind !== 'hunk' && row.kind !== 'gap' ? (row as DiffRow).newNo : undefined;
        if (n !== undefined) { a = n; b = n; }
      }
      const rowA = a !== undefined
        ? rows.find((r2) => r2.kind !== 'hunk' && r2.kind !== 'gap' && (r2 as DiffRow).newNo === a)
        : undefined;
      if (rowA && a !== undefined && b !== undefined) {
        // comments anchor within one hunk: clamp the far end to it
        const maxNew = Math.max(...rows
          .filter((r2) => r2.kind !== 'hunk' && r2.kind !== 'gap' && r2.hunk === rowA.hunk)
          .map((r2) => (r2 as DiffRow).newNo ?? -1));
        e.preventDefault();
        e.stopPropagation();
        setCompose({ hunk: rowA.hunk, line: a, lineEnd: Math.min(b, maxNew) });
        return;
      }
    }
    const c = dCaret.current;
    if (!c) {
      // a focused body must always have a pointer: the first key places it
      if (!actionOf(e, ['up', 'down', 'left', 'right', 'pageUp', 'pageDown', 'home', 'end'])) return;
      dInitCaret();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const res = resolve(e, ['extendUp', 'extendDown', 'extendLeft', 'extendRight', 'extendHome', 'extendEnd', 'visual', 'visualLine', 'wordNext', 'wordPrev', 'wordEnd', 'yank', 'copy', 'docHome', 'docEnd', 'up', 'down', 'left', 'right', 'pageUp', 'pageDown', 'home', 'end', 'dismiss']);
    const raw = res?.action;
    if (!raw) return;
    if (raw === 'copy') {
      flushKbSel(); // a debounced visual selection must land before we read it
      const sel = editorSelFor(file.path);
      if (!sel?.text) return; // no entry: native copy proceeds
      e.preventDefault();
      e.stopPropagation();
      void navigator.clipboard.writeText(sel.text);
      notify(`copied ${sel.text.length} chars`);
      return;
    }
    if (raw === 'yank') {
      e.preventDefault();
      e.stopPropagation();
      void navigator.clipboard.writeText(`${rowText(c.row)}\n`);
      notify('yanked line');
      return;
    }
    // soft-selected collapsed region: the expand action (right) opens it in
    // place — the caret lands on the first revealed line
    const gapRow = rows[c.row];
    if (gapRow?.kind === 'gap' && (raw === 'right' || raw === 'end')) {
      e.preventDefault();
      e.stopPropagation();
      setExpanded((prev) => new Set(prev).add(gapRow.id));
      return;
    }
    // visual mode is a sticky shift: every plain movement extends
    const extending = raw in EXTEND || (dVisual.current !== null && raw !== 'dismiss');
    const action = raw in EXTEND ? EXTEND[raw as keyof typeof EXTEND] : raw;
    if (extending && !dAnchor.current) dAnchor.current = { ...c };
    const el = ref.current;
    const pageLines = el ? Math.max(4, Math.floor(el.clientHeight / LH) - 2) : 20;
    let { row, col } = c;
    let vertical = false;
    const times = COUNTABLE.has(action) ? (res?.count ?? 1) : 1;
    for (let rep = 0; rep < times; rep++) {
    switch (action) {
      case 'visual':
      case 'visualLine': {
        const mode = action === 'visual' ? 'char' : 'line';
        if (dVisual.current === mode) setDVisual(null); // toggle off, selection persists
        else {
          setDVisual(mode);
          dAnchor.current = { row, col };
          reportDKbSel();
        }
        break;
      }
      case 'wordNext':
      case 'wordPrev':
      case 'wordEnd': {
        // word motion over the CONTENT rows only (hunks/gaps are not text)
        const content = rows.map((_, i2) => i2).filter((i2) => isContent(i2));
        const u = content.indexOf(row);
        if (u >= 0) {
          const m = wordMove(action === 'wordNext' ? 'w' : action === 'wordPrev' ? 'b' : 'e', content.map((i2) => rowText(i2)), u, col);
          row = content[m.u];
          col = m.col;
        }
        break;
      }
      case 'up': row = dNextContent(row, -1); vertical = true; break;
      case 'down': row = dNextContent(row, 1); vertical = true; break;
      case 'pageUp': for (let n = 0; n < pageLines; n++) row = dNextContent(row, -1); vertical = true; break;
      case 'pageDown': for (let n = 0; n < pageLines; n++) row = dNextContent(row, 1); vertical = true; break;
      case 'left':
        if (col > 0) col -= 1;
        else { const p = dNextContent(row, -1); if (p !== row) { row = p; col = maxCol(rowText(row)); } }
        break;
      case 'right':
        if (col < maxCol(rowText(row))) col += 1;
        else { const n = dNextContent(row, 1); if (n !== row) { row = n; col = 0; } }
        break;
      case 'home': col = 0; break;
      case 'end': col = maxCol(rowText(row)); break;
      case 'docHome': {
        const first = rows.findIndex((_, i2) => isContent(i2));
        if (first >= 0) { row = first; col = 0; }
        break;
      }
      case 'docEnd': {
        for (let i2 = rows.length - 1; i2 >= 0; i2--) {
          if (isContent(i2)) { row = i2; break; }
        }
        col = maxCol(rowText(row));
        break;
      }
      case 'dismiss':
        // the escape ladder: leave visual mode, then clear this file's
        // selection, then NOTHING — escape never dumps you back to scroll
        e.preventDefault();
        e.stopPropagation();
        if (dVisual.current) { setDVisual(null); flushKbSel(); }
        else if (editorSelFor(file.path)) {
          clearKbLocal();
          dAnchor.current = null;
          reportEditorSelection({ path: file.path, clear: true });
        }
        return;
    }
    }
    e.preventDefault();
    e.stopPropagation();
    if (vertical) col = colFromX(rowText(row), dWish.current);
    col = Math.min(col, maxCol(rowText(row)));
    if (!vertical) dWish.current = expand(rowText(row), col);
    dCaret.current = { row, col };
    // a plain move drops the ANCHOR (the next shift starts fresh) but the
    // selection itself persists, exactly like mouse bands do. Re-checked
    // AFTER the switch: the visual cases toggle the mode itself.
    if (raw in EXTEND || dVisual.current !== null) reportDKbSel();
    else dAnchor.current = null;
    paintDCaret();
    dSeeVisible(row);
  };
  useEffect(() => {
    dCaret.current = null;
    dAnchor.current = null;
    setDVisual(null);
    if (dCaretEl.current) dCaretEl.current.style.display = 'none';
    // an open-into-diff can land focus BEFORE the rows settle: this reset
    // must not leave a focused body with no pointer — re-place the caret
    if (ref.current && ref.current === document.activeElement) dInitCaret();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path, file.touchedAt, rows]);

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

  // review thread marks by NEW-side line number, hunk-agnostic (a commented
  // line outside the visible hunks simply has no row to mark)
  const rowOfNew = (n: number) => rows.findIndex((r2) => r2.kind !== 'hunk' && r2.kind !== 'gap' && r2.newNo === n);
  const threadEndRow = thread
    ? (() => {
      const end = thread.line + ((thread.comment.line_end ?? thread.comment.line) - thread.comment.line);
      const r2 = rowOfNew(end);
      return r2 >= 0 ? r2 : rowOfNew(thread.line);
    })()
    : -1;

  return (
    <div
      className={`editorBody ${animate ? 'diffFlash' : ''}`} ref={ref} tabIndex={-1} onKeyDown={dMoveCaret} data-path={file.path} data-start-line={1}
      onFocus={() => { if (!dCaret.current) dInitCaret(); else setDVisual(dVisual.current); }}
    >
      <div className="diffwrap" ref={wrapRef} onMouseDown={onMouseDown} onMouseOver={onMouseOver} onClick={(e) => { onClick(e); dPlaceCaret(e); }}>
        {body}
        {textBand?.rects.map((rc, i) => (
          <div key={`ts${i}`} className="textSelBand" style={{ left: rc.x, top: rc.y, width: rc.w, height: rc.h }} />
        ))}
        <div ref={kbBandsEl} />
        {find && findMatches.map((m, i) => {
          const text = rowText(m.row);
          const cw = charWidth();
          const lc = (wrapRef.current?.children[m.row] as HTMLElement | undefined)?.querySelector('.lc') as HTMLElement | null;
          return (
            <div
              key={`f${i}`} className={`findBand${i === findCur ? ' cur' : ''}`}
              style={{ left: (lc?.offsetLeft ?? 0) + expand(text, m.c0) * cw, top: m.row * LH, width: Math.max(3, (expand(text, m.c1) - expand(text, m.c0)) * cw), height: LH }}
            />
          );
        })}
        <div className="userCaret" ref={dCaretEl} style={{ display: 'none' }} />
        {band && <div className="rvBand" style={{ top: band.top, height: band.height }} />}
        {reviewMarks?.map((m) => {
          const r2 = rowOfNew(m.line);
          if (r2 < 0) return null;
          return (
            <div
              key={`rm-${m.id}`}
              className={`rvMark dRvMark codicon codicon-comment rv-${m.state}`}
              style={{ top: r2 * LH }}
              title={`review comment (${m.state})`}
              onClick={(e) => { e.stopPropagation(); m.onClick(); }}
            />
          );
        })}
        {reviewMarks?.filter((m) => m.lineEnd > m.line).map((m) => {
          const a = rowOfNew(m.line);
          const b = rowOfNew(m.lineEnd);
          if (a < 0 || b < 0) return null;
          return <div key={`rb-${m.id}`} className="rvBand" style={{ top: a * LH, height: (b - a + 1) * LH }} />;
        })}
        {compose && (
          <div className="wpOverlayWrap" style={{ top: composerTop, transform: 'none' }}>
            <ComposerCard onSubmit={submit} onCancel={() => setCompose(null)} />
          </div>
        )}
        {thread && threadEndRow >= 0 && (
          <div className="wpOverlayWrap" style={{ top: (threadEndRow + 1) * LH + 4, transform: 'none' }}>
            <ThreadCard {...thread} />
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
  diff?: { hunks: NonNullable<FileView['render']['hunks']>; area: 'staged' | 'changed' | 'review'; fileLines?: string[] };
}

// a keyboard exit hands focus back to the editor body under the card, so
// the caret keeps working after the card unmounts
const refocusEditor = (e: { currentTarget: EventTarget }) =>
  ((e.currentTarget as HTMLElement).closest('.editorBody') as HTMLElement | null)?.focus();

function ComposerCard({ onSubmit, onCancel }: { onSubmit: (body: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState('');
  return (
    <div className="wpCard rvCard" onKeyDown={(e) => { if (actionOf(e, ['dismiss'])) { e.stopPropagation(); refocusEditor(e); onCancel(); } }}>
      <div className="wpCardHead"><span className="codicon codicon-comment" /> new review comment</div>
      <textarea
        className="rvInput" autoFocus rows={3} value={body} placeholder="What should change here?"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey && body.trim()) { refocusEditor(e); onSubmit(body.trim()); } }}
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
    <div className="wpCard rvCard" onKeyDown={(e) => { if (actionOf(e, ['dismiss'])) { e.stopPropagation(); refocusEditor(e); onClose(); } }}>
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

function FileBody({ file, animate, speed, onCompose, composer, waypoint, reviewMarks, thread, scrollTo, textBand, find, onVisualMode }: {
  file: FileView; animate: boolean; speed: number;
  onCompose?: (line: number, lineEnd: number) => void;
  composer?: { line: number; lineEnd: number; onSubmit: (body: string) => void; onCancel: () => void };
  waypoint?: { line: number; note: string; open: boolean; onToggle: () => void };
  reviewMarks?: ComponentProps<typeof CodeView>['reviewMarks'];
  thread?: ComponentProps<typeof CodeView>['thread'];
  scrollTo?: { line: number; nonce: number };
  textBand?: { rects: { x: number; y: number; w: number; h: number }[] };
  find?: FindDrive;
  onVisualMode?: (m: null | 'char' | 'line' | 'normal') => void;
}) {
  return file.mode === 'diff'
    ? <DiffView key={`${file.path}:${file.touchedAt}`} file={file} animate={animate} textBand={textBand} find={find} onVisualMode={onVisualMode} />
    : file.mode === 'image'
      ? <ImageView key={`${file.path}:${file.touchedAt}`} file={file} animate={animate} />
      : <CodeView key={`${file.path}:${file.touchedAt}`} file={file} animate={animate} speed={speed} onCompose={onCompose} composer={composer} waypoint={waypoint} reviewMarks={reviewMarks} thread={thread} scrollTo={scrollTo} textBand={textBand} find={find} onVisualMode={onVisualMode} />;
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
  vim = false,
}: {
  pinned?: FileView; animate: boolean; speed: number; pointer?: number;
  vim?: boolean; // vim mode: vim keys active, status bar always on, : commands
  // the active view shows a file inside a linked worktree: say so, in orange
  worktreeBanner?: { label: string; onOpen?: () => void };
  onCloseAll?: () => void;
  // the persistent text selection: char-precise fragments that outlive focus
  textSel?: { path: string; rects: { x: number; y: number; w: number; h: number }[] }[];
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
  // ---- the vim status bar: mode indicator, and the find prompt (regex,
  // highlights, Enter cycles). The bar is a generic prompt slot — the next
  // keymap plugs into it the same way. ----
  const [visualMode, setVisualMode] = useState<null | 'char' | 'line' | 'normal'>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findDrive, setFindDrive] = useState<{ tick: number; dir: 1 | -1 }>({ tick: 0, dir: 1 });
  const [findState, setFindState] = useState({ cur: 0, total: 0 });
  const findInputRef = useRef<HTMLInputElement>(null);
  const findBad = useMemo(() => {
    if (!findQuery) return false;
    try { new RegExp(findQuery); return false; } catch { return true; }
  }, [findQuery]);
  const find: FindDrive | undefined = findOpen && findQuery ? {
    query: findQuery,
    tick: findDrive.tick,
    dir: findDrive.dir,
    onState: (cur, total) => setFindState((s) => (s.cur === cur && s.total === total ? s : { cur, total })),
  } : undefined;
  // the : command bar (vim mode): numbers go to a line; everything else is
  // not a command yet
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdText, setCmdText] = useState('');
  const cmdInputRef = useRef<HTMLInputElement>(null);
  const runCmd = () => {
    const s = cmdText.trim();
    setCmdOpen(false);
    setCmdText('');
    focusEditor();
    if (/^\d+$/.test(s)) window.dispatchEvent(new CustomEvent('mcfly:goline', { detail: Number(s) }));
    else if (s) notify(`not a command: ${s}`);
  };

  const paneKeys = (e: React.KeyboardEvent) => {
    const a = actionOf(e, ['find', 'command']);
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    if (a === 'find') {
      setCmdOpen(false);
      setFindOpen(true);
      requestAnimationFrame(() => findInputRef.current?.focus());
    } else {
      setFindOpen(false);
      setCmdOpen(true);
      requestAnimationFrame(() => cmdInputRef.current?.focus());
    }
  };

  // transient feedback (yanked line, copied N chars) over the mode text
  const [sbNotice, setSbNotice] = useState<string | null>(null);
  useEffect(() => {
    let t: number;
    const on = (e: Event) => {
      setSbNotice((e as CustomEvent).detail);
      clearTimeout(t);
      t = window.setTimeout(() => setSbNotice(null), 1500);
    };
    window.addEventListener('mcfly:notice', on);
    return () => { window.removeEventListener('mcfly:notice', on); clearTimeout(t); };
  }, []);

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

  // comments in review DIFF tabs: anchored by new-side (on-disk) lines,
  // re-resolved against the file as it is now
  const diffReview = userTab && userTab.diff && activeReview
    ? activeReview.comments
      .filter((c) => normPath(c.path) === normPath(userTab.path))
      .map((c) => {
        const content = userTab.diff!.fileLines?.join('\n');
        const found = content !== undefined
          ? resolveWaypoint(content, { path: c.path, line: c.line, note: '', before: c.before, anchor: c.anchor, after: c.after })
          : null;
        const line = found ?? c.line;
        return { comment: c, line, lineEnd: line + ((c.line_end ?? c.line) - c.line), stale: found === null };
      })
    : [];
  const diffThread = diffReview.find((t) => t.comment.id === openThreadId);

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

  const textBandFor = (path: string) => {
    const s = textSel?.find((t) => t.rects.length && normPath(t.path) === normPath(path));
    return s ? { rects: s.rects } : undefined;
  };

  // (the read-only caret lives inside CodeView itself)

  const historyAction = (path: string) => onOpenTimeline && (
    <span
      className="codicon codicon-history tabAction"
      title="File timeline: every touch of this file in the session"
      onClick={(e) => { e.stopPropagation(); onOpenTimeline(path); }}
    />
  );

  return (
    <div className="editorPane" onKeyDown={paneKeys}>
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
                ? <> <span className="roBadge">{t.diff.area === 'staged' ? 'staged' : t.diff.area === 'review' ? 'review' : 'changes'}</span></>
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
              textBand={textBandFor(userTab.path)}
              find={find}
              onVisualMode={setVisualMode}
              onComment={reviewing ? (c) => onReviewComment!({
                path: userTab.path, line: c.line,
                ...(c.lineEnd > c.line ? { line_end: c.lineEnd } : {}),
                before: c.before, anchor: c.anchor, after: c.after, body: c.body,
              }) : undefined}
              reviewMarks={diffReview.map((t) => ({
                id: t.comment.id, line: t.line, lineEnd: t.lineEnd, state: t.comment.state,
                onClick: () => setOpenThreadId((cur) => (cur === t.comment.id ? undefined : t.comment.id)),
              }))}
              thread={diffThread && onReviewReply && onReviewResolve && onReviewViewOriginal ? {
                comment: diffThread.comment, line: diffThread.line, stale: diffThread.stale,
                onReply: (body) => onReviewReply(diffThread.comment.id, body),
                onResolve: () => onReviewResolve(diffThread.comment.id),
                onViewOriginal: () => onReviewViewOriginal(diffThread.comment),
                onClose: () => setOpenThreadId(undefined),
              } : undefined}
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
            find={find}
            onVisualMode={setVisualMode}
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
          find={find}
          onVisualMode={setVisualMode}
        />
      ) : (
        <div className="emptyHint">files the agent reads will open here</div>
      )}
      {(vim || findOpen || cmdOpen) && (
        <div className="statusBar">
          {cmdOpen ? (
            <span className="sbFind">
              <span className="sbSlash">:</span>
              <input
                ref={cmdInputRef}
                className="sbInput"
                value={cmdText}
                placeholder="line number"
                onChange={(e) => setCmdText(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') runCmd();
                  else if (actionOf(e, ['dismiss'])) {
                    setCmdOpen(false);
                    setCmdText('');
                    focusEditor();
                  }
                }}
              />
            </span>
          ) : findOpen ? (
            <span className="sbFind">
              <span className="sbSlash">/</span>
              <input
                ref={findInputRef}
                className={`sbInput${findBad ? ' bad' : ''}`}
                value={findQuery}
                placeholder="regex"
                onChange={(e) => setFindQuery(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') setFindDrive((d) => ({ tick: d.tick + 1, dir: e.shiftKey ? -1 : 1 }));
                  else if (actionOf(e, ['dismiss'])) {
                    setFindOpen(false);
                    focusEditor(); // back to the caret, not scroll mode
                  }
                }}
              />
              <span className="sbCount">
                {findState.total
                  ? findState.cur ? `${findState.cur}/${findState.total}` : `${findState.total} matches`
                  : findQuery && !findBad ? 'no matches' : ''}
              </span>
            </span>
          ) : (
            <span className="sbMode">
              {sbNotice ?? (visualMode === 'char' ? '-- VISUAL --' : visualMode === 'line' ? '-- VISUAL LINE --' : visualMode === 'normal' ? '-- NORMAL --' : '')}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
