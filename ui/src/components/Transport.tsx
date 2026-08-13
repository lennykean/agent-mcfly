import { useEffect, useRef, useState } from 'react';
import type { Replay } from '../hooks/useReplay';

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 88];

export function Transport({ r }: { r: Replay }) {
  const ts = r.steps[r.pointer]?.ts;
  const pct = r.head ? (r.pointer / r.head) * 100 : 0;
  const mph88 = r.speed === 88;

  // flames only while the playhead is actually moving; fade when it stops
  const [moving, setMoving] = useState(false);
  const stopTimer = useRef<number>(undefined);
  useEffect(() => {
    if (!mph88) return;
    setMoving(true);
    clearTimeout(stopTimer.current);
    stopTimer.current = window.setTimeout(() => setMoving(false), 700);
    return () => clearTimeout(stopTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.pointer, mph88]);
  return (
    <div className={`transport ${mph88 ? 'mph88' : ''}`}>
      <button title="Start" onClick={() => r.jump(0)}>⏮</button>
      <button title="Step back (←)" onClick={() => r.stepBy(-1)}>◀</button>
      <button title="Play/pause (space)" className={r.playing ? 'on' : ''} onClick={r.togglePlay}>
        {r.playing ? '⏸' : '▶'}
      </button>
      <button title="Step forward (→)" onClick={() => r.stepBy(1)}>▶|</button>
      <button title="Go to head + follow live" className={r.follow ? 'on' : ''} onClick={r.goLive}>⏭</button>
      <select value={r.speed} onChange={(e) => r.setSpeed(Number(e.target.value))}>
        {SPEEDS.map((s) => (
          <option key={s} value={s} title={s === 88 ? 'when this baby hits 88 miles per hour…' : undefined}>
            {s === 88 ? '88mph' : `${s}×`}
          </option>
        ))}
      </select>
      <span className={`scrubWrap ${moving ? 'moving' : ''}`} style={{ ['--fill' as never]: `${pct}%` }}>
        <input type="range" className="scrub" min={0} max={r.head} value={r.pointer}
          onChange={(e) => r.jump(Number(e.target.value))} />
        {mph88 && (
          <>
            <span className="fireTrail" />
            {(['b1', 'b2', 'b3'] as const).map((c) => (
              <svg key={c} className={`bolt ${c}`} viewBox="0 0 10 16" aria-hidden>
                <path d="M6 0 L2 8 H5 L3 16 L9 6 H6 Z" fill="currentColor" />
              </svg>
            ))}
          </>
        )}
      </span>
      <span className="pos">
        {r.pointer + 1}/{r.head + 1}
        {ts ? ` · ${new Date(ts).toLocaleTimeString()}` : ''}
      </span>
    </div>
  );
}
