import { actionOf } from '../lib/keys';
import { useRowWalk } from '../lib/rowwalk';
import type { Review, ReviewComment } from '../types';

const timeOf = (ts: number) => new Date(ts).toLocaleTimeString();
const shortName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const teaser = (n: string) => n.replace(/[#*`>~]/g, '').replace(/\s+/g, ' ').trim();

const StateChip = ({ state }: { state: ReviewComment['state'] }) => (
  <span className={`rvChip rv-${state}`}>{state}</span>
);

// HUMAN REVIEW (bottom panel): the human's red pen. One open review per
// session; comments are threads the agent answers through the MCP.
export function HumanReview({ active, sessionLoaded, onCreate, onClose, onOpenComment, onEscapeTop }: {
  active: Review | null;
  sessionLoaded: boolean;
  onCreate: () => void;
  onClose: () => void;
  onOpenComment: (review: Review, comment: ReviewComment) => void;
  onEscapeTop?: () => void;
}) {
  const walk = useRowWalk('.rvThread', onEscapeTop);
  // no active review: Enter IS the "start review" button
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!active && actionOf(e, ['activate'])) {
      e.preventDefault();
      e.stopPropagation();
      if (sessionLoaded) onCreate();
      return;
    }
    walk.onKeyDown(e);
  };
  const rows = (review: Review) => review.comments.map((c) => (
    <div key={c.id} className="rvThread" onClick={() => onOpenComment(review, c)}>
      <div className="rvRow">
        <StateChip state={c.state} />
        <span className="rvFile">{shortName(c.path)}:{c.line}{c.line_end && c.line_end !== c.line ? `-${c.line_end}` : ''}</span>
        <span className="rvTeaser">{teaser(c.body)}</span>
        <span className="rvTime">{timeOf(c.ts)}</span>
      </div>
      {c.replies.map((rep, i) => (
        <div key={i} className="rvSubRow">
          <span className={`rvSubAuthor ${rep.author === 'human' ? '' : 'rvSubAgent'}`}>↳ {rep.author}</span>
          <span className="rvTeaser">{teaser(rep.body)}</span>
        </div>
      ))}
    </div>
  ));

  return (
    <div className="humanReview">
      <div className="rvBar">
        {active ? (
          <>
            <span className="rvTitle">review {active.id} · {active.comments.length} comments</span>
            <span className="rvHint">click a line number in a file to comment</span>
            <button onClick={onClose}>close review</button>
          </>
        ) : (
          <>
            <span className="rvTitle">no active review</span>
            {sessionLoaded
              ? <button onClick={onCreate} title="Start a review for this session">start review</button>
              : <span className="rvHint">open a session to start a review</span>}
          </>
        )}
      </div>
      <div className="rvList" ref={walk.boxRef} tabIndex={-1} onKeyDown={onKeyDown} onMouseDown={walk.onMouseDown}>
        <div className="expCursor" ref={walk.barRef} style={{ display: 'none' }} />
        {active && rows(active)}
        {active && active.comments.length === 0 && (
          <div className="emptyHint">no comments yet — click a line number in any file</div>
        )}
        {!active && <div className="emptyHint">no open review for this session</div>}
      </div>
    </div>
  );
}
