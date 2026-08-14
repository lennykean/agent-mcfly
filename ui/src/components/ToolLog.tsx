import { memo, useEffect, useRef, useState } from 'react';
import { actionOf } from '../lib/keys';
import type { Step } from '../types';

const ICONS: Record<string, string> = {
  read_file: 'file', patch_file: 'edit', write_file: 'new-file', exec: 'terminal', data: 'table', spawn_agent: 'hubot', other: 'gear',
};

// History rows only — params/results live in the bottom TOOL CALL tab.
const Row = memo(function Row({
  step, index, current, onJump,
}: {
  step: Step & { kind: 'tool' };
  index: number;
  current: boolean;
  onJump: (i: number) => void;
}) {
  return (
    <div
      className={[
        'logRow',
        current ? 'current' : '',
        step.isError ? 'error' : '',
      ].join(' ')}
      onClick={() => onJump(index)}
    >
      <span className={`logIcon codicon codicon-${ICONS[step.call.verb] ?? 'gear'}`} />
      <span className="logTool">{step.tool}</span>
      <span className="logTitle">{step.call.title}</span>
    </div>
  );
});

const FADE_MS = 240;

// memo: the log maps EVERY step (thousands in long sessions) — unrelated
// app renders (splitter drags, selections) must not pay that reconciliation
export const ToolLog = memo(function ToolLog({
  steps, pointer, currentToolIndex, seekTick = 0, onJump, visible = true, onEscapeTop,
}: {
  steps: Step[]; pointer: number; currentToolIndex: number; seekTick?: number;
  onJump: (i: number) => void; visible?: boolean;
  onEscapeTop?: () => void; // 'up' beyond the first row: focus climbs to the tab strip
}) {
  const currentRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const wasVisible = useRef(false);
  const engaged = useRef(true);

  // a backward jump folds the future rows away; fading them first SHOWS the
  // fold instead of teleporting — the actual time travel fires after the fade
  const [fadeTarget, setFadeTarget] = useState<number | null>(null);
  const fading = useRef(false);
  const jump = (i: number) => {
    if (fading.current) return;
    const hasBelow = steps.some((s, j) => j > i && j <= pointer && s.kind === 'tool');
    if (i >= pointer || !hasBelow) { onJump(i); return; }
    fading.current = true;
    setFadeTarget(i);
    window.setTimeout(() => {
      fading.current = false;
      setFadeTarget(null);
      onJump(i);
    }, FADE_MS);
  };

  // keyboard: down/up walk the rows (soft select), Enter time-travels
  const barRef = useRef<HTMLDivElement>(null);
  const cursor = useRef(-1);
  const rowsNow = () => [...(listRef.current?.querySelectorAll('.logRow') ?? [])] as HTMLElement[];
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
    if (!rows.length) return;
    const action = actionOf(e, ['up', 'down', 'home', 'end', 'activate', 'dismiss']);
    if (!action) return;
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
    const row = (e.target as Element).closest?.('.logRow') as HTMLElement | null;
    if (!row) return;
    // preventDefault: the browser's default would move focus to <body>
    e.preventDefault();
    const idx = rowsNow().indexOf(row);
    if (idx >= 0) cursor.current = idx;
    // focus AFTER the mousedown sequence (Chromium reverts an in-handler focus)
    requestAnimationFrame(() => {
      listRef.current?.focus();
      paintBar();
    });
  };

  // terminal-style stickiness, derived from position alone: at the bottom
  // means follow, anywhere else means stay put. Our own scrollIntoView ends
  // near the bottom (future rows are folded away), so it keeps itself engaged
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => { engaged.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // time travel or reveal re-engages
  useEffect(() => { engaged.current = true; }, [seekTick, visible]);

  useEffect(() => {
    if (!visible || !engaged.current) {
      wasVisible.current = visible;
      return;
    }
    currentRef.current?.scrollIntoView({ block: wasVisible.current ? 'nearest' : 'center' });
    wasVisible.current = visible;
  }, [currentToolIndex, visible, seekTick]);

  return (
    <div className="toolLog" ref={listRef} tabIndex={-1} onKeyDown={onKeyDown} onMouseDown={onMouseDown}>
      <div className="expCursor" ref={barRef} style={{ display: 'none' }} />
      {steps.map((step, i) => {
        // the log folds to the playhead like every other pane: no future rows
        if (step.kind !== 'tool' || i > pointer) return null;
        const isCurrent = i === currentToolIndex;
        return (
          <div key={i} ref={isCurrent ? currentRef : undefined} className={fadeTarget !== null && i > fadeTarget ? 'logFadeOut' : undefined}>
            <Row step={step} index={i} current={isCurrent} onJump={jump} />
          </div>
        );
      })}
    </div>
  );
});
