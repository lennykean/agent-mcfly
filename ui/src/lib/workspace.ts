// Workspace reporting: the UI tells the server what the user has open,
// focused, and selected, so agents can query it via the workspace_state MCP
// tool. Parts of the app push partial snapshots and events here; posts are
// debounced and throttled.

type Ev = Record<string, unknown> & { kind: string };

const snapshot: Record<string, unknown> = {};
let events: (Ev & { ts: number })[] = [];
let timer: number | undefined;
let lastFlush = 0;

// every selection slot persists until replaced, so recency is the tie-breaker
// for "this": selected_at maps each kind to when it last changed, and the
// newest entry is what the user means. Stamped here, centrally, because the
// App-side effects re-send unchanged selections on unrelated re-renders.
const SEL_KINDS: [kind: string, root: string, get: (v: unknown) => unknown][] = [
  ['text', 'text_selections', (v) => v],
  ['terminal', 'terminal_selection', (v) => v],
  ['data', 'data_selection', (v) => v],
  ['git_files', 'git', (v) => (v as { selection?: unknown } | null)?.selection],
  ['git_commits', 'git', (v) => (v as { commits?: unknown } | null)?.commits],
  ['explorer', 'explorer', (v) => (v as { selection?: unknown } | null)?.selection],
  ['cursor', 'cursor', (v) => v],
];

export function updateSnapshot(part: Record<string, unknown>) {
  const at = (snapshot.selected_at ??= {}) as Record<string, string>;
  for (const [kind, root, get] of SEL_KINDS) {
    if (!(root in part)) continue;
    const next = get(part[root]);
    if (JSON.stringify(next ?? null) === JSON.stringify(get(snapshot[root]) ?? null)) continue;
    const empty = next == null || (Array.isArray(next) && next.length === 0);
    if (empty) { delete at[kind]; continue; }
    // text entries carry their own stamps: shrinking the list must not make
    // a leftover selection look fresher than it is
    const own = kind === 'text' && Array.isArray(next) ? (next.at(-1) as { at?: string })?.at : undefined;
    at[kind] = own ?? new Date().toISOString();
  }
  Object.assign(snapshot, part);
  queue();
}

export function emit(ev: Ev) {
  events.push({ ts: Date.now(), ...ev });
  queue();
}

function queue() {
  clearTimeout(timer);
  const wait = Math.max(400, 1000 - (Date.now() - lastFlush));
  timer = window.setTimeout(flush, wait);
}

function flush() {
  lastFlush = Date.now();
  // visible lines are pulled at flush time — cheaper than scroll listeners
  const body = document.querySelector('.editorPane .editorBody');
  if (body) {
    const start = Number(body.getAttribute('data-start-line') ?? 1);
    const top = Math.floor(body.scrollTop / 18) + start;
    snapshot.visible_lines = [top, top + Math.ceil(body.clientHeight / 18)];
  }
  const payload = JSON.stringify({ snapshot, events });
  events = [];
  void fetch('/api/workspace-events', { method: 'POST', body: payload }).catch(() => { /* best effort */ });
}

// ---- selection capture: editor (path + lines + text) and terminal (text) ----

const SELECT_CAP = 2000;
let selTimer: number | undefined;

// the persistent editor selections: they survive clicks OUTSIDE the editor
// (terminal, panels); a click back inside a file's editor body clears only
// that file's entry. One entry per path (a new drag in a file replaces its
// old one), newest last, so selections in DIFFERENT files accumulate and an
// agent can resolve "these two functions". rects are the selection's exact
// fragments, in content coordinates, so the visual survives char-precise
// after the native selection dies.
export interface EditorSel { path: string; lines?: number[]; text: string; at: string; rects: { x: number; y: number; w: number; h: number }[] }
const SEL_MAX = 8;
let editorSels: EditorSel[] = [];
let editorSelCb: ((sels: EditorSel[]) => void) | undefined;
export function onEditorSelection(cb: typeof editorSelCb) { editorSelCb = cb; }
let lastDownEditorPath: string | null | false = false; // false = outside any editor

export function watchSelections() {
  document.addEventListener('mousedown', (e) => {
    const body = e.target instanceof Element ? e.target.closest('.editorBody') : null;
    lastDownEditorPath = body ? body.getAttribute('data-path') : false;
  }, true);
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer);
    selTimer = window.setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        // a collapsed selection only counts as "cleared" when the user
        // clicked back inside an editor, and it clears only THAT file's
        // entry; the terminal must not steal it
        if (lastDownEditorPath !== false) {
          editorSels = lastDownEditorPath
            ? editorSels.filter((s) => s.path !== lastDownEditorPath)
            : [];
          postSels();
        }
        return;
      }
      const text = sel.toString();
      if (!text.trim()) return;
      const node = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
      // a waypoint note card floats OVER code: its text is not on any line
      if (node?.closest('.wpCard')) {
        emit({ kind: 'select', where: 'waypoint-note', text: text.slice(0, SELECT_CAP) });
        return;
      }
      const editorBody = node?.closest('.editorBody');
      if (!editorBody) return; // terminal selections come from xterm's own event
      const path = editorBody.getAttribute('data-path');
      if (!path) return;
      const wrap = editorBody.querySelector('.codewrap, .diffwrap');
      const ev: Ev = { kind: 'select', where: 'editor', path, text: text.slice(0, SELECT_CAP) };
      let rects: EditorSel['rects'] = [];
      if (wrap) {
        const range = sel.getRangeAt(0);
        const r = range.getBoundingClientRect();
        const w = wrap.getBoundingClientRect();
        if (wrap.classList.contains('diffwrap')) {
          // a diff view: the TRUE file lines live in the row gutters — the
          // new side is the on-disk file; red-only selections report old
          ev.view = 'diff';
          const rowOf = (n: Node | null) => (n instanceof Element ? n : n?.parentElement)?.closest('.codeline');
          const numsOf = (row: Element | null | undefined) => {
            const d = row?.querySelectorAll('.dln');
            const num = (el?: Element) => { const t = el?.textContent?.trim(); return t ? Number(t) : null; };
            return { oldNo: num(d?.[0]), newNo: num(d?.[1]) };
          };
          const a = numsOf(rowOf(range.startContainer));
          const b = numsOf(rowOf(range.endContainer));
          if (a.newNo !== null && b.newNo !== null) ev.lines = [a.newNo, b.newNo];
          if (a.oldNo !== null && b.oldNo !== null) ev.old_lines = [a.oldNo, b.oldNo];
        } else {
          const start = Number(editorBody.getAttribute('data-start-line') ?? 1);
          ev.lines = [
            Math.max(start, Math.floor((r.top - w.top) / 18) + start),
            Math.floor((r.bottom - w.top - 1) / 18) + start,
          ];
        }
        rects = [...range.getClientRects()].slice(0, 300)
          .map((rc) => ({ x: rc.left - w.left, y: rc.top - w.top, w: rc.width, h: rc.height }))
          .filter((rc) => rc.w > 1);
      }
      emit(ev);
      const entry: EditorSel & Record<string, unknown> = {
        path: String(ev.path), lines: ev.lines as number[] | undefined, text: String(ev.text),
        at: new Date().toISOString(), rects,
        ...(ev.view === 'diff' ? { view: 'diff', old_lines: ev.old_lines ?? null } : {}),
      };
      editorSels = [...editorSels.filter((s) => s.path !== entry.path), entry].slice(-SEL_MAX);
      postSels();
    }, 600);
  });
}

// keyboard-built selections (shift+arrows from the caret) report through the
// same pipeline as mouse drags: same entries, same recency, same bands
export function reportEditorSelection(
  sel: { path: string; clear: true } | { path: string; lines?: number[]; old_lines?: number[]; view?: 'diff'; text: string; rects: EditorSel['rects'] },
) {
  if ('clear' in sel) {
    if (!editorSels.some((s) => s.path === sel.path)) return;
    editorSels = editorSels.filter((s) => s.path !== sel.path);
    postSels();
    return;
  }
  if (!sel.text.trim()) return;
  const entry: EditorSel & Record<string, unknown> = {
    path: sel.path, lines: sel.lines, text: sel.text.slice(0, SELECT_CAP), at: new Date().toISOString(), rects: sel.rects,
    ...(sel.view === 'diff' ? { view: 'diff', old_lines: sel.old_lines ?? null } : {}),
  };
  editorSels = [...editorSels.filter((s) => s.path !== entry.path), entry].slice(-SEL_MAX);
  postSels();
}

// agents get the list without rects (view geometry is noise to them) plus a
// text_selection alias for the newest entry; the UI callback gets rects
function postSels() {
  const wire = editorSels.map(({ rects: _r, ...s }) => s);
  updateSnapshot({ text_selections: wire.length ? wire : null, text_selection: wire.at(-1) ?? null });
  editorSelCb?.(editorSels);
}

export function emitTerminalSelection(tool: string, text: string) {
  if (!text.trim()) return;
  emit({ kind: 'select', where: 'terminal', tool, text: text.slice(0, SELECT_CAP) });
  // terminal selections persist in the snapshot too, until replaced
  updateSnapshot({ terminal_selection: { tool, text: text.slice(0, SELECT_CAP) } });
}
