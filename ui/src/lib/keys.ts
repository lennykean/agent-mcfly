// The binding layer: components ask "what ACTION is this key event" and
// never switch on raw keys. Hardcoded defaults today; user-customizable
// bindings later mean swapping DEFAULT for stored config — nothing else.

export type Action =
  | 'up' | 'down' | 'left' | 'right'
  | 'extendUp' | 'extendDown' | 'extendLeft' | 'extendRight' | 'extendHome' | 'extendEnd' | 'select' | 'extendActivate'
  | 'pageUp' | 'pageDown' | 'home' | 'end' | 'docHome' | 'docEnd'
  | 'activate' | 'dismiss' | 'open'
  | 'panelUp' | 'panelDown' | 'panelLeft' | 'panelRight'
  | 'stepBack' | 'stepForward' | 'playPause';

export interface KeyChord { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean }

const DEFAULT: Record<Action, KeyChord[]> = {
  up: [{ key: 'ArrowUp' }],
  down: [{ key: 'ArrowDown' }],
  left: [{ key: 'ArrowLeft' }],
  right: [{ key: 'ArrowRight' }],
  pageUp: [{ key: 'PageUp' }],
  pageDown: [{ key: 'PageDown' }],
  home: [{ key: 'Home' }],
  end: [{ key: 'End' }],
  docHome: [{ key: 'Home', ctrl: true }],
  docEnd: [{ key: 'End', ctrl: true }],
  extendUp: [{ key: 'ArrowUp', shift: true }],
  extendDown: [{ key: 'ArrowDown', shift: true }],
  extendLeft: [{ key: 'ArrowLeft', shift: true }],
  extendRight: [{ key: 'ArrowRight', shift: true }],
  extendHome: [{ key: 'Home', shift: true }],
  extendEnd: [{ key: 'End', shift: true }],
  select: [{ key: ' ' }, { key: 'Space' }],
  extendActivate: [{ key: 'Enter', shift: true }],
  activate: [{ key: 'Enter' }],
  dismiss: [{ key: 'Escape' }],
  // 'open' means GO INTO the thing under the cursor: the file opens and the
  // caret lands inside it — two chords, one binding
  open: [{ key: 'Enter' }, { key: 'ArrowRight' }],
  // plain arrows never cross a panel boundary: tabs within a panel, panels
  // between panels — a deliberate chord for a deliberate hop
  panelUp: [{ key: 'ArrowUp', ctrl: true }],
  panelDown: [{ key: 'ArrowDown', ctrl: true }],
  panelLeft: [{ key: 'ArrowLeft', ctrl: true }],
  panelRight: [{ key: 'ArrowRight', ctrl: true }],
  stepBack: [{ key: 'ArrowLeft' }],
  stepForward: [{ key: 'ArrowRight' }],
  playPause: [{ key: ' ' }, { key: 'Space' }],
};

// extend actions are their base movement plus "grow the selection": surfaces
// resolve the movement through this map and keep one movement implementation
export const EXTEND = { extendUp: 'up', extendDown: 'down', extendLeft: 'left', extendRight: 'right', extendHome: 'home', extendEnd: 'end' } as const;

const matches = (e: { key: string; code?: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, c: KeyChord) =>
  (e.key === c.key || e.code === c.key)
  && !!c.ctrl === e.ctrlKey && !!c.shift === e.shiftKey && !!c.alt === e.altKey;

// each surface consults only the actions it understands, in its own priority
// order — the same chord can mean different things in different contexts
export function actionOf(
  e: { key: string; code?: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  actions: Action[],
): Action | null {
  for (const a of actions) {
    if (DEFAULT[a].some((c) => matches(e, c))) return a;
  }
  return null;
}

// keyboard selection reuses the mouse semantics wholesale: a synthesized
// modified click on the row IS a shift-click or ctrl-click, so ranges,
// toggles, and workspace reporting need no second implementation
export function synthClick(el: HTMLElement, mods: { shiftKey?: boolean; ctrlKey?: boolean } = {}) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...mods }));
}

// after 'open', focus lands in the visible editor body so the caret is live
// in the file; the tab mounts async, so retry until the right body exists.
// pathHint (a file name is enough) keeps a slow fetch from focusing the
// PREVIOUS tab's body during the gap.
export function focusEditor(pathHint?: string, tries = 16) {
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
  const bodies = [...document.querySelectorAll('.editorPane .editorBody')]
    .filter((el): el is HTMLElement => el instanceof HTMLElement && el.offsetParent !== null);
  const hit = pathHint ? bodies.find((el) => norm(el.dataset.path ?? '').endsWith(norm(pathHint))) : bodies[0];
  if (hit) { hit.focus(); return; }
  if (tries > 0) window.setTimeout(() => focusEditor(pathHint, tries - 1), 60);
}
