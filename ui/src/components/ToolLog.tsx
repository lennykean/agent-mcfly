import { memo, useEffect, useRef } from 'react';
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

export function ToolLog({
  steps, pointer, currentToolIndex, seekTick = 0, onJump, visible = true,
}: {
  steps: Step[]; pointer: number; currentToolIndex: number; seekTick?: number;
  onJump: (i: number) => void; visible?: boolean;
}) {
  const currentRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const wasVisible = useRef(false);
  const engaged = useRef(true); // false after a manual scroll, until time travel/reveal
  const programmatic = useRef(false);

  // a manual scroll disengages following; our own scrollIntoView must not
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => { if (!programmatic.current) engaged.current = false; };
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
    programmatic.current = true;
    currentRef.current?.scrollIntoView({ block: wasVisible.current ? 'nearest' : 'center' });
    setTimeout(() => { programmatic.current = false; }, 150);
    wasVisible.current = visible;
  }, [currentToolIndex, visible, seekTick]);

  return (
    <div className="toolLog" ref={listRef}>
      {steps.map((step, i) => {
        // the log folds to the playhead like every other pane: no future rows
        if (step.kind !== 'tool' || i > pointer) return null;
        const isCurrent = i === currentToolIndex;
        return (
          <div key={i} ref={isCurrent ? currentRef : undefined}>
            <Row step={step} index={i} current={isCurrent} onJump={onJump} />
          </div>
        );
      })}
    </div>
  );
}
