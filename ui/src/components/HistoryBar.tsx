// The standard pane-history navigator: one text line, pinned to the top,
// painted like the transport. Walks the steps where THIS pane's content
// changed; every click is a real jump (time travel pauses playback).
export function HistoryBar({ positions, pointer, onJump }: {
  positions: number[]; // ascending step indices where the pane changed
  pointer: number;
  onJump: (index: number) => void;
}) {
  if (!positions.length) return null;
  let at = -1;
  for (let i = 0; i < positions.length; i++) {
    if (positions[i] <= pointer) at = i; else break;
  }
  const prev = at > 0 ? positions[at - 1] : null;
  const next = at < positions.length - 1 ? positions[at + 1] : null;
  return (
    <div className="histBar">
      <button disabled={at <= 0} onClick={() => onJump(positions[0])} title="First change">
        <span className="codicon codicon-debug-reverse-continue" />
      </button>
      <button disabled={prev === null} onClick={() => prev !== null && onJump(prev)} title="Previous change">
        <span className="codicon codicon-chevron-left" />
      </button>
      <span className="histCount">{at + 1}/{positions.length}</span>
      <button disabled={next === null} onClick={() => next !== null && onJump(next)} title="Next change">
        <span className="codicon codicon-chevron-right" />
      </button>
      <button disabled={at === positions.length - 1} onClick={() => onJump(positions.at(-1)!)} title="Last change">
        <span className="codicon codicon-debug-continue" />
      </button>
    </div>
  );
}
