// One selection gesture language for every multiselect surface: plain click
// selects one (re-clicking the sole selection clears), ctrl/meta toggles
// membership, shift ranges from the anchor over the visible flat order.

export type ClickMode = 'plain' | 'ctrl' | 'shift';

export const clickMode = (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): ClickMode =>
  (e.shiftKey ? 'shift' : (e.ctrlKey || e.metaKey) ? 'ctrl' : 'plain');

export function applySelect(
  flat: string[], sel: string[], anchor: string | null, clicked: string, mode: ClickMode,
): { sel: string[]; anchor: string } {
  if (mode === 'shift' && anchor !== null) {
    const a = flat.indexOf(anchor);
    const b = flat.indexOf(clicked);
    if (a >= 0 && b >= 0) return { sel: flat.slice(Math.min(a, b), Math.max(a, b) + 1), anchor };
  }
  if (mode === 'ctrl') {
    return {
      sel: sel.includes(clicked) ? sel.filter((s) => s !== clicked) : [...sel, clicked],
      anchor: clicked,
    };
  }
  return { sel: sel.includes(clicked) && sel.length === 1 ? [] : [clicked], anchor: clicked };
}
