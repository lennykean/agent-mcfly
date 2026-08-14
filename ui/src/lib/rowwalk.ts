import { useRef } from 'react';
import { actionOf } from './keys';

// The standard list walker: a soft cursor over rows, Enter clicks the row,
// Escape dismisses, up past the top escalates to the tab strip. One
// implementation for the simple list panes (wayfinder, review); the trees
// (explorer, git) keep their bespoke walkers with expand/collapse semantics.
// Consumer renders <div className="expCursor" ref={barRef} .../> inside the
// scrolling box so the bar scrolls with the rows.
export function useRowWalk(rowSel: string, onEscapeTop?: () => void) {
  const boxRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const cursor = useRef(-1);
  const rowsNow = () => [...(boxRef.current?.querySelectorAll(rowSel) ?? [])] as HTMLElement[];
  const paintBar = () => {
    const bar = barRef.current;
    const row = rowsNow()[cursor.current];
    if (!bar) return;
    if (!row) { bar.style.display = 'none'; return; }
    bar.style.display = 'block';
    bar.style.top = `${row.offsetTop}px`;
    bar.style.height = `${row.offsetHeight}px`;
    row.scrollIntoView({ block: 'nearest' });
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const rows = rowsNow();
    const action = actionOf(e, ['up', 'down', 'home', 'end', 'activate', 'dismiss']);
    if (!action) return;
    if (!rows.length) {
      // an empty list is not a trap: up still climbs to the strip
      if (action === 'up' && onEscapeTop) {
        e.preventDefault();
        e.stopPropagation();
        onEscapeTop();
      } else if (action === 'dismiss') (e.target as HTMLElement).blur();
      return;
    }
    let i = Math.max(0, Math.min(cursor.current, rows.length - 1));
    switch (action) {
      case 'up':
        if (i === 0 && onEscapeTop) {
          e.preventDefault();
          e.stopPropagation();
          cursor.current = -1;
          paintBar();
          onEscapeTop();
          return;
        }
        i = Math.max(0, i - 1);
        break;
      case 'down': i = Math.min(rows.length - 1, cursor.current < 0 ? 0 : i + 1); break;
      case 'home': i = 0; break;
      case 'end': i = rows.length - 1; break;
      case 'activate': rows[i]?.click(); break;
      case 'dismiss': (e.target as HTMLElement).blur(); cursor.current = -1; paintBar(); break;
    }
    e.preventDefault();
    e.stopPropagation();
    if (action !== 'dismiss') {
      cursor.current = i;
      requestAnimationFrame(paintBar);
    }
  };
  const onMouseDown = (e: React.MouseEvent) => {
    const row = (e.target as Element).closest?.(rowSel) as HTMLElement | null;
    if (!row) return;
    // preventDefault: the browser's default would move focus to <body>;
    // focus AFTER the mousedown sequence (Chromium reverts an in-handler focus)
    e.preventDefault();
    const idx = rowsNow().indexOf(row);
    if (idx >= 0) cursor.current = idx;
    requestAnimationFrame(() => {
      boxRef.current?.focus();
      paintBar();
    });
  };
  return { boxRef, barRef, onKeyDown, onMouseDown };
}
