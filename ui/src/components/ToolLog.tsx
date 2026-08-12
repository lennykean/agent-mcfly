import { memo, useEffect, useRef } from 'react';
import type { Step } from '../types';

const ICONS: Record<string, string> = {
  read_file: 'file', patch_file: 'edit', write_file: 'new-file', exec: 'terminal', data: 'table', spawn_agent: 'hubot', other: 'gear',
};

// History rows only — params/results live in the bottom TOOL CALL tab.
const Row = memo(function Row({
  step, index, future, current, onJump,
}: {
  step: Step & { kind: 'tool' };
  index: number;
  future: boolean;
  current: boolean;
  onJump: (i: number) => void;
}) {
  return (
    <div
      className={[
        'logRow',
        future ? 'future' : '',
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
  steps, pointer, currentToolIndex, onJump, visible = true,
}: {
  steps: Step[]; pointer: number; currentToolIndex: number; onJump: (i: number) => void; visible?: boolean;
}) {
  const currentRef = useRef<HTMLDivElement>(null);
  const wasVisible = useRef(false);

  // scrolls while display:none are no-ops, so re-snap on reveal (centered);
  // in-view updates keep the gentler 'nearest'
  useEffect(() => {
    if (visible) currentRef.current?.scrollIntoView({ block: wasVisible.current ? 'nearest' : 'center' });
    wasVisible.current = visible;
  }, [currentToolIndex, visible]);

  return (
    <div className="toolLog">
      {steps.map((step, i) => {
        if (step.kind !== 'tool') return null;
        const isCurrent = i === currentToolIndex;
        return (
          <div key={i} ref={isCurrent ? currentRef : undefined}>
            <Row step={step} index={i} future={i > pointer} current={isCurrent} onJump={onJump} />
          </div>
        );
      })}
    </div>
  );
}
