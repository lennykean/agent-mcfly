import type { Replay } from '../hooks/useReplay';

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

export function Transport({ r }: { r: Replay }) {
  const ts = r.steps[r.pointer]?.ts;
  return (
    <div className="transport">
      <button title="Start" onClick={() => r.jump(0)}>⏮</button>
      <button title="Step back (←)" onClick={() => r.stepBy(-1)}>◀</button>
      <button title="Play/pause (space)" className={r.playing ? 'on' : ''} onClick={r.togglePlay}>
        {r.playing ? '⏸' : '▶'}
      </button>
      <button title="Step forward (→)" onClick={() => r.stepBy(1)}>▶|</button>
      <button title="Go to head + follow live" className={r.follow ? 'on' : ''} onClick={r.goLive}>⏭</button>
      <select value={r.speed} onChange={(e) => r.setSpeed(Number(e.target.value))}>
        {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
      </select>
      <input type="range" className="scrub" min={0} max={r.head} value={r.pointer}
        onChange={(e) => r.jump(Number(e.target.value))} />
      <span className="pos">
        {r.pointer + 1}/{r.head + 1}
        {ts ? ` · ${new Date(ts).toLocaleTimeString()}` : ''}
      </span>
    </div>
  );
}
