import { memo, useEffect, useRef } from 'react';
import { useStickyScroll } from '../lib/useStickyScroll';
import type { Step } from '../types';
import { durationFor } from '../lib/timeline';
import { TypeText } from './TypeText';

// Minimal markdown: fenced code blocks, inline code, **bold**. Everything
// else is plain text (React-escaped).
function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/).map((seg, j) => {
        if (seg.startsWith('`') && seg.endsWith('`')) return <code key={j}>{seg.slice(1, -1)}</code>;
        if (seg.startsWith('**') && seg.endsWith('**')) return <strong key={j}>{seg.slice(2, -2)}</strong>;
        return seg;
      })}
    </>
  );
}

export function Md({ text }: { text: string }) {
  const parts = text.split(/```(?:\w*\n)?/);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? <pre key={i}>{part}</pre> : <span key={i}><Inline text={part} /></span>,
      )}
    </>
  );
}

const Bubble = memo(function Bubble({ step, onOpenAgent }: { step: Step; onOpenAgent: (key: string) => void }) {
  if (step.kind === 'tool') {
    // only spawn_agent tools surface in chat; the rest live in the tool log
    if (step.call.verb !== 'spawn_agent') return null;
    const r = step.result;
    return (
      <div className="msg agentcard">
        <div><span className="codicon codicon-hubot agentIcon" /> <strong>{step.call.agent_type ?? r?.agent_type ?? 'agent'}</strong> — {step.call.title}</div>
        {r?.summary && <div className="agentSummary">{r.summary.slice(0, 300)}</div>}
        {r?.child_session_id && (
          <button onClick={() => onOpenAgent(r.child_session_id!)}>open timeline</button>
        )}
      </div>
    );
  }
  if (step.kind === 'thinking') {
    return (
      <details className="msg thinking">
        <summary>thinking…</summary>
        <Md text={step.text} />
      </details>
    );
  }
  return (
    <div className={`msg ${step.kind}`}>
      <Md text={step.text} />
    </div>
  );
});

export function ChatPane({
  steps, pointer, animateIndex, seekTick, onOpenAgent, visible = true,
}: {
  steps: Step[]; pointer: number; animateIndex: number; seekTick: number;
  onOpenAgent: (key: string) => void; visible?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // pin to bottom; user scrolling up holds position until they return or time travel
  const stuck = useStickyScroll(ref, [pointer], `${seekTick}:${visible}`, visible);

  // keep the streaming bubble in view while TypeText grows it
  useEffect(() => {
    if (animateIndex < 0) return;
    const id = setInterval(() => {
      if (stuck.current) ref.current?.scrollTo({ top: ref.current.scrollHeight });
    }, 300);
    return () => clearInterval(id);
  }, [animateIndex, stuck]);

  return (
    <div className="chatPane">
      <div className="chat" ref={ref}>
        {steps.slice(0, pointer + 1).map((step, i) => {
          if (i === animateIndex && (step.kind === 'user' || step.kind === 'assistant')) {
            return (
              <div key={i} className={`msg ${step.kind}`}>
                <TypeText text={step.text} duration={durationFor(step)} animate />
              </div>
            );
          }
          return <Bubble key={i} step={step} onOpenAgent={onOpenAgent} />;
        })}
      </div>
    </div>
  );
}
