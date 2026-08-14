import { useRowWalk } from '../lib/rowwalk';
import type { WaypointEntry } from '../lib/timeline';

const timeOf = (ts?: number) => (ts ? new Date(ts).toLocaleTimeString() : '');
const shortName = (p: string) => p.split(/[\\/]/).pop() ?? p;
// one flat line for the list; the full note lives in the editor card
const teaser = (n: string) => n.replace(/[#*`>~]/g, '').replace(/\s+/g, ' ').trim();

// WAYFINDER (bottom panel): waypoints the agent dropped, one truncated row
// each. Selecting one resolves it against the file on disk NOW and opens it
// in the editor — at the (possibly moved) line, or as a faded snapshot tab
// when the context no longer exists.
export function Wayfinder({ waypoints, onSelect, onEscapeTop }: {
  waypoints: WaypointEntry[];
  onSelect: (wp: WaypointEntry) => void;
  onEscapeTop?: () => void;
}) {
  const walk = useRowWalk('.wfRow', onEscapeTop);
  return (
    <div className="wayfinder">
      <div className="wfList" ref={walk.boxRef} tabIndex={-1} onKeyDown={walk.onKeyDown} onMouseDown={walk.onMouseDown}>
        <div className="expCursor" ref={walk.barRef} style={{ display: 'none' }} />
        {waypoints.map((w) => (
          <div key={w.touchedAt} className="wfRow" onClick={() => onSelect(w)}>
            <span className="codicon codicon-location wfIcon" />
            <span className="wfFile">{shortName(w.path)}:{w.line}</span>
            <span className="wfTeaser">{teaser(w.note)}</span>
            <span className="wfTime">{timeOf(w.ts)}</span>
          </div>
        ))}
        {!waypoints.length && <div className="emptyHint">no waypoints yet</div>}
      </div>
    </div>
  );
}
