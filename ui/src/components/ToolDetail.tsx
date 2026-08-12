import { useMemo } from 'react';
import type { Step } from '../types';
import { JsonView, LongText } from './JsonView';

// Bottom-pane tab: the current tool call's params and result, for every tool —
// including ones whose effects render elsewhere (editor/terminal).
export function ToolDetail({ step }: { step?: Step & { kind: 'tool' } }) {
  // string results that are themselves JSON (some MCP tools) still get the tree
  const parsed = useMemo(() => {
    const v = step?.resultData;
    if (typeof v !== 'string') return v;
    const t = v.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { return JSON.parse(t) as unknown; } catch { /* plain text */ }
    }
    return v;
  }, [step]);

  if (!step) return <div className="emptyHint">tool calls will show here as the playhead reaches them</div>;
  return (
    <div className="toolDetail">
      <div className="tdHead">
        <span className="logTool">{step.tool}</span>
        <span className="tdTitle">{step.call.title}</span>
        {step.isError && <span className="tdError">ERROR</span>}
      </div>
      <div className="dLabel">PARAMS</div>
      <JsonView value={step.params} />
      {step.resultData !== undefined && (
        <>
          <div className="dLabel">{step.isError ? 'ERROR' : 'RESULT'}</div>
          {typeof parsed === 'string' ? <LongText text={parsed || '(empty)'} /> : <JsonView value={parsed} />}
        </>
      )}
    </div>
  );
}
