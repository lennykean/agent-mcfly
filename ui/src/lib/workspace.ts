// Workspace reporting: the UI tells the server what the user has open,
// focused, and selected, so agents can query it via the workspace_state MCP
// tool. Parts of the app push partial snapshots and events here; posts are
// debounced and throttled.

type Ev = Record<string, unknown> & { kind: string };

const snapshot: Record<string, unknown> = {};
let events: (Ev & { ts: number })[] = [];
let timer: number | undefined;
let lastFlush = 0;

export function updateSnapshot(part: Record<string, unknown>) {
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

// the persistent editor selection: it survives clicks OUTSIDE the editor
// (terminal, panels) and only clears on a click back inside an editor body.
// rects are the selection's exact fragments, in content coordinates, so the
// visual survives char-precise after the native selection dies.
export interface EditorSel { path: string; lines?: number[]; text: string; rects: { x: number; y: number; w: number; h: number }[] }
let editorSelCb: ((sel: EditorSel | null) => void) | undefined;
export function onEditorSelection(cb: typeof editorSelCb) { editorSelCb = cb; }
let lastDownInEditor = false;

export function watchSelections() {
  document.addEventListener('mousedown', (e) => {
    lastDownInEditor = e.target instanceof Element && !!e.target.closest('.editorBody');
  }, true);
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer);
    selTimer = window.setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        // a collapsed selection only counts as "cleared" when the user
        // clicked back inside an editor; the terminal must not steal it
        if (lastDownInEditor) {
          updateSnapshot({ text_selection: null });
          editorSelCb?.(null);
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
      const wrap = editorBody.querySelector('.codewrap');
      const ev: Ev = { kind: 'select', where: 'editor', path, text: text.slice(0, SELECT_CAP) };
      let rects: EditorSel['rects'] = [];
      if (wrap) {
        const range = sel.getRangeAt(0);
        const r = range.getBoundingClientRect();
        const w = wrap.getBoundingClientRect();
        const start = Number(editorBody.getAttribute('data-start-line') ?? 1);
        ev.lines = [
          Math.max(start, Math.floor((r.top - w.top) / 18) + start),
          Math.floor((r.bottom - w.top - 1) / 18) + start,
        ];
        rects = [...range.getClientRects()].slice(0, 300)
          .map((rc) => ({ x: rc.left - w.left, y: rc.top - w.top, w: rc.width, h: rc.height }))
          .filter((rc) => rc.w > 1);
      }
      emit(ev);
      updateSnapshot({ text_selection: { path: ev.path, lines: ev.lines ?? null, text: ev.text } });
      editorSelCb?.({ path: String(ev.path), lines: ev.lines as number[] | undefined, text: String(ev.text), rects });
    }, 600);
  });
}

export function emitTerminalSelection(tool: string, text: string) {
  if (!text.trim()) return;
  emit({ kind: 'select', where: 'terminal', tool, text: text.slice(0, SELECT_CAP) });
  // terminal selections persist in the snapshot too, until replaced
  updateSnapshot({ terminal_selection: { tool, text: text.slice(0, SELECT_CAP) } });
}
