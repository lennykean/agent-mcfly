import { memo, useEffect, useMemo, useRef, useState } from 'react';
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
const LH = 22; // .logRow fixed height (containment CSS pins it)
const OVERSCAN = 12;

// memo: unrelated app renders (splitter drags, selections) must not pay the
// log's reconciliation. The list is VIRTUALIZED: long sessions hold tens of
// thousands of rows, and rendering only the window keeps resize drags and
// scrolling flat no matter the session size. Rows are fixed-height, so the
// cursor bar, stickiness, and scrolling are pure index math — no DOM walks.
export const ToolLog = memo(function ToolLog({
  steps, pointer, currentToolIndex, seekTick = 0, onJump, visible = true, onEscapeTop,
}: {
  steps: Step[]; pointer: number; currentToolIndex: number; seekTick?: number;
  onJump: (i: number) => void; visible?: boolean;
  onEscapeTop?: () => void; // 'up' beyond the first row: focus climbs to the tab strip
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const wasVisible = useRef(false);
  const engaged = useRef(true);

  // the log folds to the playhead like every other pane: no future rows.
  // steps is appended IN PLACE by the tailer — length is the real dep.
  const items = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i <= pointer && i < steps.length; i++) {
      if (steps[i].kind === 'tool') out.push(i);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, steps.length, pointer]);

  // ---- the window: scrollTop + viewport height drive the rendered slice ----
  const [scrollTop, setScrollTop] = useState(0);
  const [vh, setVh] = useState(600);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      // terminal-style stickiness, from position alone: at the bottom means
      // follow, anywhere else means stay put
      engaged.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; setScrollTop(el.scrollTop); });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => setVh(el.clientHeight || 0));
    ro.observe(el);
    setVh(el.clientHeight || 0);
    return () => { el.removeEventListener('scroll', onScroll); ro.disconnect(); cancelAnimationFrame(raf); };
  }, []);
  const start = Math.max(0, Math.floor(scrollTop / LH) - OVERSCAN);
  const end = Math.min(items.length, Math.ceil((scrollTop + vh) / LH) + OVERSCAN);

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

  // keyboard: down/up walk the rows (soft select), Enter time-travels.
  // cursor is a LOGICAL position in items — rows off-window still walk.
  const barRef = useRef<HTMLDivElement>(null);
  const cursor = useRef(-1);
  const seeRow = (i: number) => {
    const el = listRef.current;
    if (!el) return;
    const y = i * LH;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + LH > el.scrollTop + el.clientHeight) el.scrollTop = y + LH - el.clientHeight;
  };
  const paintBar = () => {
    const bar = barRef.current;
    if (!bar) return;
    const i = cursor.current;
    if (i < 0 || i >= items.length) { bar.style.display = 'none'; return; }
    bar.style.display = 'block';
    bar.style.top = `${i * LH}px`;
    bar.style.height = `${LH}px`;
    seeRow(i);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!items.length) return;
    const action = actionOf(e, ['up', 'down', 'home', 'end', 'activate', 'dismiss']);
    if (!action) return;
    let i = Math.max(0, Math.min(cursor.current, items.length - 1));
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
      case 'down': i = Math.min(items.length - 1, cursor.current < 0 ? 0 : i + 1); break;
      case 'home': i = 0; break;
      case 'end': i = items.length - 1; break;
      case 'activate': jump(items[i]); break;
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
    const li = Number((row.parentElement as HTMLElement | null)?.dataset.li ?? -1);
    if (li >= 0) cursor.current = li;
    // focus AFTER the mousedown sequence (Chromium reverts an in-handler focus)
    requestAnimationFrame(() => {
      listRef.current?.focus();
      paintBar();
    });
  };

  // time travel or reveal re-engages
  useEffect(() => { engaged.current = true; }, [seekTick, visible]);

  useEffect(() => {
    if (!visible || !engaged.current) {
      wasVisible.current = visible;
      return;
    }
    const el = listRef.current;
    const li = items.indexOf(currentToolIndex);
    if (el && li >= 0) {
      const y = li * LH;
      if (!wasVisible.current) el.scrollTop = y - el.clientHeight / 2; // reveal: center
      else seeRow(li); // follow: nearest
    }
    wasVisible.current = visible;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentToolIndex, visible, seekTick, items]);

  return (
    <div className="toolLog" ref={listRef} tabIndex={-1} onKeyDown={onKeyDown} onMouseDown={onMouseDown}>
      <div className="expCursor" ref={barRef} style={{ display: 'none' }} />
      <div style={{ height: items.length * LH, position: 'relative' }}>
        {items.slice(start, end).map((stepIdx, k) => {
          const li = start + k;
          const isCurrent = stepIdx === currentToolIndex;
          return (
            <div
              key={stepIdx}
              data-li={li}
              style={{ position: 'absolute', top: li * LH, left: 0, right: 0 }}
              className={fadeTarget !== null && stepIdx > fadeTarget ? 'logFadeOut' : undefined}
            >
              <Row step={steps[stepIdx] as Step & { kind: 'tool' }} index={stepIdx} current={isCurrent} onJump={jump} />
            </div>
          );
        })}
      </div>
    </div>
  );
});
