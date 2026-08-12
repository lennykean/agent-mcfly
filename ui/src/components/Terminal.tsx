import { useEffect, useRef, useState } from 'react';
import type { TermBlock, TermBlocks } from '../lib/timeline';
import { TypeText } from './TypeText';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*(\x07|\x1b\\)/g;
const clean = (s: string) => s.replace(ANSI, '');

function Output({ b }: { b: TermBlock }) {
  return (
    <>
      {b.stdout && <div className="tOut">{clean(b.stdout)}</div>}
      {b.stderr && <div className="tErr">{clean(b.stderr)}</div>}
      {b.interrupted && <div className="tErr">^C interrupted</div>}
    </>
  );
}

// Animated block: output mounts only after the command finishes typing.
function FreshBlock({ b, speed, onGrow }: { b: TermBlock; speed: number; onGrow: () => void }) {
  const [typed, setTyped] = useState(false);
  useEffect(() => {
    if (typed) onGrow();
  }, [typed, onGrow]);
  return (
    <div className="tBlock fresh">
      <div className="tCmd">
        <TypeText
          text={b.command}
          duration={Math.min(b.command.length * 15, 900) / speed}
          animate
          onDone={() => setTyped(true)}
        />
      </div>
      {typed && <Output b={b} />}
    </div>
  );
}

export function Terminal({ blocks, animatedAt, speed, visible = true }: {
  blocks: TermBlocks; animatedAt: number; speed: number; visible?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scrollBottom = () => ref.current?.scrollTo({ top: ref.current.scrollHeight });

  // also re-snap when the pane is revealed — scrolls while display:none are no-ops
  useEffect(() => {
    if (visible) scrollBottom();
  }, [blocks.length, animatedAt, visible]); // eslint-disable-line react-hooks/exhaustive-deps

  // ponytail: render last 60 blocks only; full scrollback when someone asks
  const shown = blocks.slice(-60);

  return (
    <div className="termPane">
      <div className="term" ref={ref}>
        {shown.map((b) =>
          b.at === animatedAt
            ? <FreshBlock key={b.at} b={b} speed={speed} onGrow={scrollBottom} />
            : (
              <div key={b.at} className="tBlock">
                <div className="tCmd">{b.command}</div>
                <Output b={b} />
              </div>
            ),
        )}
      </div>
    </div>
  );
}
