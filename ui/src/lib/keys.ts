// The binding layer: components ask "what ACTION is this key event" and
// never switch on raw keys. Hardcoded defaults today; user-customizable
// bindings later mean swapping DEFAULT for stored config — nothing else.

export type Action =
  | 'up' | 'down' | 'left' | 'right'
  | 'extendUp' | 'extendDown' | 'extendLeft' | 'extendRight' | 'extendHome' | 'extendEnd' | 'select' | 'extendActivate'
  | 'pageUp' | 'pageDown' | 'home' | 'end' | 'docHome' | 'docEnd'
  | 'activate' | 'dismiss' | 'open' | 'comment'
  | 'visual' | 'visualLine' | 'wordNext' | 'wordPrev' | 'wordEnd' | 'find' | 'command'
  | 'yank' | 'copy'
  | 'panelUp' | 'panelDown' | 'panelLeft' | 'panelRight'
  | 'stepBack' | 'stepForward' | 'playPause' | 'playHome' | 'playEnd'
  | 'bufferPrev' | 'bufferNext' | 'paneNext' | 'panePrev'
  | 'tab1' | 'tab2' | 'tab3' | 'tab4' | 'tab5' | 'tab6' | 'tab7' | 'tab8' | 'tab9'
  | 'gotoTools' | 'gotoExplorer' | 'gotoGit' | 'gotoChat' | 'gotoLiveTerm'
  | 'gotoAgentTerm' | 'gotoData' | 'gotoWayfinder' | 'gotoReview' | 'gotoToolDetail'
  | 'openTimeline' | 'openReal' | 'grep' | 'findFile' | 'closeTab'
  | 'termFocus' | 'termNew' | 'termNext' | 'termPrev' | 'termKill';

// a chord is one key with exact modifiers; `capture: true` makes a chord
// match ANY printable key and hand the character to the action (f{char},
// marks, registers). A binding is one chord or a SEQUENCE of chords of any
// length (vim gg, or three-key maps), matched through a pending buffer.
export interface KeyChord { key?: string; ctrl?: boolean; shift?: boolean; alt?: boolean; capture?: true }
export type Binding = KeyChord | KeyChord[];

const DEFAULT: Record<Action, Binding[]> = {
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
  // in a read-only buffer with a review active: comment on the highlighted
  // lines (or the caret line) — plain c, the buffers take no typed input
  comment: [{ key: 'c' }, { key: 'KeyC' }],
  // vim-only actions carry no BASE bindings: the vim overlay supplies them
  visual: [],
  visualLine: [],
  wordNext: [],
  wordPrev: [],
  wordEnd: [],
  yank: [],
  command: [],
  // find in the editor's status bar: regex, highlights, Enter cycles
  find: [{ key: 'f', ctrl: true }, { key: 'KeyF', ctrl: true }],
  // ctrl+c copies the selection, native copy when there is none
  copy: [{ key: 'c', ctrl: true }, { key: 'KeyC', ctrl: true }],
  // plain arrows never cross a panel boundary: tabs within a panel, panels
  // between panels — a deliberate chord for a deliberate hop
  panelUp: [{ key: 'ArrowUp', ctrl: true }],
  panelDown: [{ key: 'ArrowDown', ctrl: true }],
  panelLeft: [{ key: 'ArrowLeft', ctrl: true }],
  panelRight: [{ key: 'ArrowRight', ctrl: true }],
  stepBack: [{ key: 'ArrowLeft' }],
  stepForward: [{ key: 'ArrowRight' }],
  playPause: [{ key: ' ' }, { key: 'Space' }],
  playHome: [{ key: 'Home', ctrl: true, shift: true }],
  playEnd: [{ key: 'End', ctrl: true, shift: true }],
  // buffers: cycle the editor tab strip; alt+digit picks by position
  // (ctrl+digit and ctrl+PageUp/Down belong to the browser — do not bind)
  bufferPrev: [{ key: 'PageUp', alt: true }],
  bufferNext: [{ key: 'PageDown', alt: true }],
  // cycle the tabs of WHATEVER panel holds focus. ctrl+Tab reaches the page
  // in an installed-app window; a regular Chrome tab may keep it for its own
  // tab switching — alt+` is the sibling chord that always lands
  paneNext: [{ key: 'Tab', ctrl: true }, { key: 'Backquote', alt: true }],
  panePrev: [{ key: 'Tab', ctrl: true, shift: true }, { key: 'Backquote', alt: true, shift: true }],
  tab1: [{ key: 'Digit1', alt: true }],
  tab2: [{ key: 'Digit2', alt: true }],
  tab3: [{ key: 'Digit3', alt: true }],
  tab4: [{ key: 'Digit4', alt: true }],
  tab5: [{ key: 'Digit5', alt: true }],
  tab6: [{ key: 'Digit6', alt: true }],
  tab7: [{ key: 'Digit7', alt: true }],
  tab8: [{ key: 'Digit8', alt: true }],
  tab9: [{ key: 'Digit9', alt: true }],
  // every tab has a direct chord: alt+shift+letter (plain alt+letter would
  // collide with browser menus — alt+D is Chrome's address bar)
  gotoTools: [{ key: 'KeyL', alt: true, shift: true }],
  gotoExplorer: [{ key: 'KeyE', alt: true, shift: true }],
  gotoGit: [{ key: 'KeyG', alt: true, shift: true }],
  gotoChat: [{ key: 'KeyC', alt: true, shift: true }],
  gotoLiveTerm: [{ key: 'KeyV', alt: true, shift: true }],
  gotoAgentTerm: [{ key: 'KeyA', alt: true, shift: true }],
  // Dark Reader ships claiming shift+alt+D — S (spreadsheet) also answers
  gotoData: [{ key: 'KeyD', alt: true, shift: true }, { key: 'KeyS', alt: true, shift: true }],
  gotoWayfinder: [{ key: 'KeyW', alt: true, shift: true }],
  // R gets stolen by extensions/recorders on some machines — U also answers
  gotoReview: [{ key: 'KeyR', alt: true, shift: true }, { key: 'KeyU', alt: true, shift: true }],
  // alt+shift+T belongs to Chrome on Windows (focus toolbar) — I as in inspect
  gotoToolDetail: [{ key: 'KeyI', alt: true, shift: true }],
  openTimeline: [{ key: 'KeyH', alt: true, shift: true }],
  openReal: [{ key: 'KeyO', alt: true, shift: true }],
  // quick pickers: grep the repo, find a file by name (VS Code muscle
  // memory; ctrl+w belongs to the browser so closing is ctrl+F4)
  grep: [{ key: 'F', ctrl: true, shift: true }, { key: 'KeyF', ctrl: true, shift: true }],
  findFile: [{ key: 'p', ctrl: true }, { key: 'KeyP', ctrl: true }],
  closeTab: [{ key: 'F4', ctrl: true }],
  // VS Code muscle memory: ctrl+` focuses/cycles terminals, ctrl+shift+` news;
  // ctrl+\ is the same jump (in a shell this outbids SIGQUIT — deliberate)
  termFocus: [{ key: 'Backquote', ctrl: true }, { key: 'Backslash', ctrl: true }],
  termNew: [{ key: 'Backquote', ctrl: true, shift: true }],
  // cycling/kill actions carry no BASE bindings: tmux mode supplies the prefix
  termNext: [],
  termPrev: [],
  termKill: [],
};

// the chords the app claims EVERYWHERE, including from inside a live
// terminal — xterm declines these so they bubble to the window handler.
// panel hops are absent on purpose: ctrl+arrows are shell word-jumps.
export const APP_CHORDS: Action[] = [
  'termFocus', 'termNew', 'termNext', 'termPrev', 'termKill',
  'gotoTools', 'gotoExplorer', 'gotoGit', 'gotoChat', 'gotoLiveTerm',
  'gotoAgentTerm', 'gotoData', 'gotoWayfinder', 'gotoReview', 'gotoToolDetail',
  'bufferPrev', 'bufferNext', 'paneNext', 'panePrev',
  'tab1', 'tab2', 'tab3', 'tab4', 'tab5', 'tab6', 'tab7', 'tab8', 'tab9',
  'openTimeline', 'openReal', 'grep', 'findFile', 'closeTab', 'playHome', 'playEnd',
];
export const appChord = (e: { key: string; code?: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) =>
  actionOf(e, APP_CHORDS) !== null;

// what a live terminal gives up: the app chords, plus the two panel hops
// that actually LEAVE it (left -> editor, down -> bottom pane). ctrl+right
// and ctrl+up still reach the shell (word-jump, scrollback) — and ctrl+
// LETTER chords always stay with the shell (^H backspace, ^J newline),
// so vim's ctrl+hjkl hops don't apply inside a terminal.
export const termReleasedChord = (e: { key: string; code?: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) => {
  if (tmuxOn) {
    // the tmux prefix leaves the shell, and so does the key right after it
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyB') return true;
    if (seqPending && Date.now() - seqPending.at < SEQ_MS) {
      const f = seqPending.chords[0];
      if (f.ctrlKey && f.code === 'KeyB') return true;
    }
  }
  if (appChord(e)) return true;
  if (e.ctrlKey && (e.code ?? '').startsWith('Key')) return false;
  return actionOf(e, ['panelLeft', 'panelDown']) !== null;
};

// extend actions are their base movement plus "grow the selection": surfaces
// resolve the movement through this map and keep one movement implementation
export const EXTEND = { extendUp: 'up', extendDown: 'down', extendLeft: 'left', extendRight: 'right', extendHome: 'home', extendEnd: 'end' } as const;

const matches = (e: { key: string; code?: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, c: KeyChord) => {
  if (c.capture) return e.key.length === 1 && !e.ctrlKey && !e.altKey; // any printable key
  return (e.key === c.key || e.code === c.key)
    && !!c.ctrl === e.ctrlKey && !!c.shift === e.shiftKey && !!c.alt === e.altKey;
};

// ---- vim-style key notation, for user keymaps written as text ----
// "gg" -> two-chord sequence; "<C-f>" -> ctrl chord; "<S-A-g>" -> shift+alt;
// "f<char>" -> chord + capture step; named keys: <CR> <Esc> <Space> <Tab>
// <Up> <Down> <Left> <Right> <Home> <End> <PageUp> <PageDown> <BS>.
// Letters bind by PHYSICAL key (KeyX) so caps lock and layouts hold;
// uppercase letters imply shift. US-layout shift is assumed for punctuation.
const NAMED: Record<string, string> = {
  cr: 'Enter', enter: 'Enter', esc: 'Escape', space: ' ', tab: 'Tab', bs: 'Backspace',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
};
const SHIFT_PUNCT = '~!@#$%^&*()_+{}|:"<>?';
function charChord(ch: string): KeyChord {
  if (/[a-z]/.test(ch)) return { key: `Key${ch.toUpperCase()}` };
  if (/[A-Z]/.test(ch)) return { key: `Key${ch}`, shift: true };
  if (/[0-9]/.test(ch)) return { key: `Digit${ch}` };
  return SHIFT_PUNCT.includes(ch) ? { key: ch, shift: true } : { key: ch };
}
export function parseKeys(s: string): Binding | null {
  const chords: KeyChord[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '<') {
      const j = s.indexOf('>', i);
      if (j < 0) return null;
      const parts = s.slice(i + 1, j).split('-');
      const keyRaw = parts.pop() ?? '';
      const c: KeyChord = {};
      for (const m of parts) {
        const lm = m.toLowerCase();
        if (lm === 'c') c.ctrl = true;
        else if (lm === 's') c.shift = true;
        else if (lm === 'a' || lm === 'm') c.alt = true;
        else return null;
      }
      const lk = keyRaw.toLowerCase();
      if (lk === 'char') c.capture = true;
      else if (NAMED[lk]) c.key = NAMED[lk];
      else if (keyRaw.length === 1) Object.assign(c, { ...charChord(keyRaw), ...c });
      else c.key = keyRaw; // raw code name (Backquote, F5, ...)
      chords.push(c);
      i = j + 1;
    } else {
      chords.push(charChord(s[i]));
      i++;
    }
  }
  if (!chords.length) return null;
  return chords.length === 1 ? chords[0] : chords;
}

// ---- the VIM overlay: enabled by the vim-mode setting, swapped over the
// base table wholesale. Physical-key chords so caps lock and layouts hold.
const VIM: Partial<Record<Action, Binding[]>> = {
  // hjkl are canonical motions (arrows still work)
  up: [{ key: 'ArrowUp' }, { key: 'KeyK' }],
  down: [{ key: 'ArrowDown' }, { key: 'KeyJ' }],
  left: [{ key: 'ArrowLeft' }, { key: 'KeyH' }],
  right: [{ key: 'ArrowRight' }, { key: 'KeyL' }],
  home: [{ key: 'Home' }, { key: '0' }, { key: 'Digit0' }],
  end: [{ key: 'End' }, { key: '$', shift: true }],
  docHome: [{ key: 'Home', ctrl: true }, [{ key: 'KeyG' }, { key: 'KeyG' }]],
  docEnd: [{ key: 'End', ctrl: true }, { key: 'KeyG', shift: true }],
  visual: [{ key: 'KeyV' }],
  visualLine: [{ key: 'KeyV', shift: true }],
  wordNext: [{ key: 'KeyW' }],
  wordPrev: [{ key: 'KeyB' }],
  wordEnd: [{ key: 'KeyE' }],
  yank: [[{ key: 'KeyY' }, { key: 'KeyY' }]],
  find: [{ key: 'f', ctrl: true }, { key: 'KeyF', ctrl: true }, { key: '/' }],
  command: [{ key: ':', shift: true }],
  // vim window nav: ctrl+hjkl hop panels (ctrl+arrows still work)
  panelLeft: [{ key: 'ArrowLeft', ctrl: true }, { key: 'KeyH', ctrl: true }],
  panelDown: [{ key: 'ArrowDown', ctrl: true }, { key: 'KeyJ', ctrl: true }],
  panelUp: [{ key: 'ArrowUp', ctrl: true }, { key: 'KeyK', ctrl: true }],
  panelRight: [{ key: 'ArrowRight', ctrl: true }, { key: 'KeyL', ctrl: true }],
  // SPACE IS THE LEADER in vim mode: space / grep, space f f find file,
  // space q close tab. The cost: space alone no longer play/pauses in vim
  // mode (a leader must consume its key while waiting).
  grep: [{ key: 'F', ctrl: true, shift: true }, { key: 'KeyF', ctrl: true, shift: true }, [{ key: ' ' }, { key: '/' }]],
  findFile: [{ key: 'p', ctrl: true }, { key: 'KeyP', ctrl: true }, [{ key: ' ' }, { key: 'KeyF' }, { key: 'KeyF' }]],
  closeTab: [{ key: 'F4', ctrl: true }, [{ key: ' ' }, { key: 'KeyQ' }]],
};

// ---- the TMUX overlay: prefix chords for terminal management. The prefix
// works INSIDE a live terminal too (the shell gives up ctrl+b — that is
// the tmux trade, which is why it's a mode).
const TMUX: Partial<Record<Action, Binding[]>> = {
  termNew: [{ key: 'Backquote', ctrl: true, shift: true }, [{ key: 'KeyB', ctrl: true }, { key: 'KeyC' }]],
  termNext: [[{ key: 'KeyB', ctrl: true }, { key: 'KeyN' }]],
  termPrev: [[{ key: 'KeyB', ctrl: true }, { key: 'KeyP' }]],
  termKill: [[{ key: 'KeyB', ctrl: true }, { key: 'KeyX' }]],
};

// ---- table assembly: base, plus the mode overlays when on, plus user
// keymap overrides (notation strings) on top ----
let TABLE: Record<Action, Binding[]> = { ...DEFAULT };
let vimOn = false;
let tmuxOn = false;
let userOverrides: Partial<Record<string, string[] | null>> = {};
function rebuild() {
  TABLE = { ...DEFAULT, ...(vimOn ? VIM : {}), ...(tmuxOn ? TMUX : {}) };
  for (const [a, seqs] of Object.entries(userOverrides)) {
    if (!(a in DEFAULT) || !seqs?.length) continue;
    const parsed = seqs.map(parseKeys).filter((b): b is Binding => b !== null);
    if (parsed.length) TABLE[a as Action] = parsed;
  }
}
export function applyKeymap(overrides: Partial<Record<string, string[] | null>>) {
  userOverrides = overrides;
  rebuild();
}
export function setVimMode(on: boolean) {
  vimOn = on;
  try { localStorage.setItem('mcfly.vimMode', on ? '1' : '0'); } catch { /* private mode */ }
  rebuild();
}
export const isVimMode = () => vimOn;
export function setTmuxMode(on: boolean) {
  tmuxOn = on;
  try { localStorage.setItem('mcfly.tmuxMode', on ? '1' : '0'); } catch { /* private mode */ }
  rebuild();
}
export const isTmuxMode = () => tmuxOn;
try {
  vimOn = localStorage.getItem('mcfly.vimMode') === '1';
  tmuxOn = localStorage.getItem('mcfly.tmuxMode') === '1';
  const raw = localStorage.getItem('mcfly.keymap');
  if (raw) userOverrides = JSON.parse(raw);
} catch { /* a bad keymap must never brick the keyboard: defaults stand */ }
rebuild();

// ---- the resolver ----
// One pending buffer serves the whole app (keyboards are serial):
// - sequences of any length progress chord by chord, with a timeout
// - a chord with `capture` swallows any printable key and hands it over
// - bare digits accumulate a COUNT for the next action (vim 5j); a leading
//   0 stays a binding (vim's 0 = line start)
// - probe misses (handlers consult narrow lists) never disturb pending
//   state for the same keystroke; state dies on a real match or timeout
type ChordEvent = { key: string; code?: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; timeStamp?: number };
let seqPending: { chords: ChordEvent[]; at: number; stamp: number } | null = null;
let countPending: { n: number; at: number; stamp: number } | null = null;
const SEQ_MS = 800;
const COUNT_MS = 3000;

export interface Resolved { action: Action; count: number; capture?: string }

export function resolve(e: ChordEvent, actions: Action[]): Resolved | null {
  const now = Date.now();
  const stamp = e.timeStamp ?? now;
  const prev = seqPending && now - seqPending.at < SEQ_MS ? seqPending.chords : [];
  const cp = countPending && now - countPending.at < COUNT_MS ? countPending : null;
  const takeCount = () => {
    const n = cp?.n ?? 1;
    countPending = null;
    return Math.max(1, n);
  };
  const bareDigit = !e.ctrlKey && !e.altKey && !e.shiftKey && /^[0-9]$/.test(e.key);
  // an in-progress count claims every bare digit, 0 included (vim "10j")
  if (bareDigit && cp) {
    if (cp.stamp !== stamp) countPending = { n: cp.n * 10 + Number(e.key), at: now, stamp };
    return null;
  }
  const matchSeqs = (attempt: ChordEvent[]): Resolved | 'prefix' | null => {
    let isPrefix = false;
    for (const a of actions) {
      for (const b of TABLE[a]) {
        if (!Array.isArray(b)) continue;
        if (b.length === attempt.length && attempt.every((ev, i) => matches(ev, b[i]))) {
          seqPending = null;
          const capIdx = b.findIndex((c) => c.capture);
          return { action: a, count: takeCount(), ...(capIdx >= 0 ? { capture: attempt[capIdx].key } : {}) };
        }
        if (b.length > attempt.length && attempt.every((ev, i) => matches(ev, b[i]))) isPrefix = true;
      }
    }
    return isPrefix ? 'prefix' : null;
  };
  const arm = (attempt: ChordEvent[]) => {
    seqPending = {
      chords: attempt.map((ev) => ({ key: ev.key, code: ev.code, ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, altKey: ev.altKey })),
      at: now,
      stamp,
    };
  };
  // extend a pending sequence; a dead end falls through to fresh matching
  // WITHOUT clearing pending (another consult may still complete it)
  if (prev.length) {
    const r = matchSeqs([...prev, e]);
    if (r === 'prefix') { arm([...prev, e]); return null; }
    if (r) return r;
    // this key belongs to a sequence SOMEWHERE in the table (a leader chord
    // completing in another handler): reserve it — no single may steal it
    const attempt = [...prev, e];
    for (const a of Object.keys(TABLE) as Action[]) {
      for (const b of TABLE[a]) {
        if (Array.isArray(b) && b.length >= attempt.length && attempt.every((ev, i) => matches(ev, b[i]))) return null;
      }
    }
  }
  // single chords — a real match retires any pending state
  for (const a of actions) {
    for (const b of TABLE[a]) {
      if (!Array.isArray(b) && matches(e, b)) {
        seqPending = null;
        return { action: a, count: takeCount() };
      }
    }
  }
  // a fresh sequence start
  const r2 = matchSeqs([e]);
  if (r2 === 'prefix') { arm([e]); return null; }
  if (r2) return r2;
  // a fresh bare digit (1-9) starts a count
  if (bareDigit && e.key !== '0') {
    countPending = { n: Number(e.key), at: now, stamp };
    return null;
  }
  return null;
}

// every bindable action, for the settings panel's keymap editor
export const ACTIONS = Object.keys(DEFAULT) as Action[];

// the classic API: surfaces that don't care about counts or captures
export function actionOf(e: ChordEvent, actions: Action[]): Action | null {
  return resolve(e, actions)?.action ?? null;
}

// did THIS keystroke arm (or extend) a pending sequence? The handler that
// owns the keystroke uses this to consume a leader key silently instead of
// letting it fall through (space must not also play/pause).
export const justArmed = (e: { timeStamp?: number }) =>
  seqPending !== null && e.timeStamp !== undefined && seqPending.stamp === e.timeStamp;

// keyboard selection reuses the mouse semantics wholesale: a synthesized
// modified click on the row IS a shift-click or ctrl-click, so ranges,
// toggles, and workspace reporting need no second implementation
export function synthClick(el: HTMLElement, mods: { shiftKey?: boolean; ctrlKey?: boolean } = {}) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...mods }));
}

// transient status-bar feedback (yanks, copies) — the editor's status bar
// listens and shows it for a moment
export const notify = (msg: string) => window.dispatchEvent(new CustomEvent('mcfly:notice', { detail: msg }));

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
