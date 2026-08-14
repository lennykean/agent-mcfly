import { memo, useEffect, useRef } from 'react';
import { actionOf } from '../lib/keys';
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

// upper-right rewind on every message: jump the whole session to that moment
const JumpBtn = ({ onClick }: { onClick: () => void }) => (
  <span className="msgJump codicon codicon-history" title="Rewind to this point" onClick={onClick} />
);

const Bubble = memo(function Bubble({ step, onJump, onOpenAgent }: {
  step: Step; onJump: () => void; onOpenAgent: (key: string) => void;
}) {
  if (step.kind === 'tool') {
    // only spawn_agent tools surface in chat; the rest live in the tool log
    if (step.call.verb !== 'spawn_agent') return null;
    const r = step.result;
    return (
      <div className="msg agentcard">
        <JumpBtn onClick={onJump} />
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
        <JumpBtn onClick={onJump} />
        <summary>thinking…</summary>
        <Md text={step.text} />
      </details>
    );
  }
  return (
    <div className={`msg ${step.kind}`}>
      <JumpBtn onClick={onJump} />
      <Md text={step.text} />
    </div>
  );
});

// memo: the chat maps every step — unrelated app renders must not pay it
export const ChatPane = memo(function ChatPane({
  steps, pointer, animateIndex, seekTick, onJump, onOpenAgent, visible = true, onEscapeTop,
}: {
  steps: Step[]; pointer: number; animateIndex: number; seekTick: number;
  onJump: (i: number) => void; onOpenAgent: (key: string) => void; visible?: boolean;
  onEscapeTop?: () => void;
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

  // keyboard: plain arrows scroll (native, no caret); shift+arrows walk the
  // messages as a soft selection, Enter rewinds to the selected bubble —
  // the same jump as its little history icon
  const kbIdx = useRef(-1);
  const paintKb = () => {
    const msgs = [...(ref.current?.querySelectorAll('.msg') ?? [])] as HTMLElement[];
    msgs.forEach((m, i) => m.classList.toggle('kbSel', i === kbIdx.current));
    msgs[kbIdx.current]?.scrollIntoView({ block: 'nearest' });
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const msgs = ref.current?.querySelectorAll('.msg') ?? { length: 0 };
    if (!msgs.length) return;
    const action = actionOf(e, ['extendUp', 'extendDown', 'activate', 'dismiss', 'up']);
    if (!action) return; // plain arrows and page keys: native scroll
    if (action === 'up') {
      // scrolled to the very top, up once more climbs to the tab strip
      if (ref.current?.scrollTop === 0 && onEscapeTop) {
        e.preventDefault();
        e.stopPropagation();
        onEscapeTop();
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (action === 'extendUp') kbIdx.current = kbIdx.current < 0 ? msgs.length - 1 : Math.max(0, kbIdx.current - 1);
    else if (action === 'extendDown') kbIdx.current = kbIdx.current < 0 ? msgs.length - 1 : Math.min(msgs.length - 1, kbIdx.current + 1);
    else if (action === 'activate') {
      ((msgs as NodeListOf<HTMLElement>)[kbIdx.current]?.querySelector('.msgJump') as HTMLElement | null)?.click();
      return;
    } else if (action === 'dismiss') {
      kbIdx.current = -1;
      paintKb();
      (e.target as HTMLElement).blur();
      return;
    }
    paintKb();
  };

  return (
    <div className="chatPane">
      <div className="chat" ref={ref} tabIndex={-1} onKeyDown={onKeyDown}>
        {steps.slice(0, pointer + 1).map((step, i) => {
          if (i === animateIndex && (step.kind === 'user' || step.kind === 'assistant')) {
            return (
              <div key={i} className={`msg ${step.kind}`}>
                <TypeText text={step.text} duration={durationFor(step)} animate />
              </div>
            );
          }
          return <Bubble key={i} step={step} onJump={() => onJump(i)} onOpenAgent={onOpenAgent} />;
        })}
      </div>
    </div>
  );
});
