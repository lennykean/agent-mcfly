import { useMemo, useState } from 'react';
import { fileChain } from '../lib/timeline';
import { CodeView, DiffView, type BlameMark } from './EditorPane';
import type { Step } from '../types';

const VERB_ICONS: Record<string, string> = { read_file: 'file', patch_file: 'edit', write_file: 'new-file' };

const timeOf = (ts?: number) => (ts ? new Date(ts).toLocaleTimeString() : '');

// A file's history within the session: a floating debug-style pager (first /
// prev / a 3-chip window / next / last) over the body, which shows
// reconstructed state (with blame) where the chain is clean, or the raw patch
// where it isn't. Selection is a PROJECTION of the global playhead: navigating
// here seeks the whole session (log, terminal, chat follow).
export function FileTimeline({ steps, pointer, path, speed, onJump }: {
  steps: Step[]; pointer: number; path: string; speed: number; onJump: (index: number) => void;
}) {
  // steps mutates in place; length grows on append, and a pending tool step is
  // replaced in place when its result arrives — count resolved results so a
  // live session's final touch can't go stale
  const resolvedCount = steps.reduce((n, s) => n + (s.kind === 'tool' && s.result ? 1 : 0), 0);
  const { touches, snapshots } = useMemo(
    () => fileChain(steps, path),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [steps, steps.length, resolvedCount, path],
  );

  const selected = useMemo(() => {
    let sel: number | null = null;
    for (const t of touches) { if (t.index <= pointer) sel = t.index; else break; }
    return sel;
  }, [touches, pointer]);

  const ordinal = useMemo(() => new Map(touches.map((t, i) => [t.index, i + 1])), [touches]);

  const at = selected === null ? -1 : touches.findIndex((t) => t.index === selected);
  const prev = at > 0 ? touches[at - 1] : null;
  const next = at >= 0 && at < touches.length - 1 ? touches[at + 1] : (at < 0 && touches.length ? touches[0] : null);

  const snap = selected === null ? null : snapshots.get(selected);
  const step = selected === null ? null : steps[selected];
  const verb = step?.kind === 'tool' ? step.result?.verb ?? step.call.verb : undefined;

  const [blameCompact, setBlameCompact] = useState(false);

  const blameMarks: (BlameMark | null)[] | null = useMemo(() => {
    if (!snap?.blame) return null;
    return snap.blame.map((s) => {
      if (s === null) return null;
      const t = touches.find((x) => x.index === s);
      const st = steps[s]?.kind === 'tool' ? (steps[s] as Step & { kind: 'tool' }) : null;
      return {
        step: s,
        text: !blameCompact && st ? `${st.tool} ${st.call.title ?? ''}`.trim() : `#${ordinal.get(s) ?? '?'}`,
        title: `#${ordinal.get(s) ?? '?'} · step ${s} · ${st?.tool ?? ''} · ${timeOf(t?.ts)}`,
      };
    });
  }, [snap, touches, ordinal, steps, blameCompact]);

  const winStart = at < 0 ? 0 : Math.max(0, Math.min(at - 1, touches.length - 3));
  const win = touches.slice(winStart, winStart + 3);

  return (
    <div className="fileTimeline">
      {touches.length > 0 && (
        <div className="ftPager">
          <button disabled={at === 0} onClick={() => onJump(touches[0].index)} title="First touch">
            <span className="codicon codicon-debug-reverse-continue" />
          </button>
          <button disabled={!prev} onClick={() => prev && onJump(prev.index)} title="Previous touch">
            <span className="codicon codicon-chevron-left" />
          </button>
          {win.map((t) => (
            <span
              key={t.index}
              className={`ftChip ${t.index === selected ? 'active' : ''} ${snapshots.get(t.index)?.content === undefined && t.verb === 'patch_file' ? 'raw' : ''}`}
              title={`step ${t.index} · ${timeOf(t.ts)}`}
              onClick={() => onJump(t.index)}
            >
              <span className={`codicon codicon-${VERB_ICONS[t.verb] ?? 'gear'}`} />
              #{ordinal.get(t.index)}
            </span>
          ))}
          <span className="ftCount">{at < 0 ? 0 : at + 1}/{touches.length}</span>
          <button disabled={!next} onClick={() => next && onJump(next.index)} title="Next touch">
            <span className="codicon codicon-chevron-right" />
          </button>
          <button disabled={at === touches.length - 1} onClick={() => onJump(touches.at(-1)!.index)} title="Last touch">
            <span className="codicon codicon-debug-continue" />
          </button>
        </div>
      )}

      {!touches.length ? (
        <div className="emptyHint">no touches of this file in the session</div>
      ) : selected === null ? (
        <div className="emptyHint">the playhead is before this file's first touch</div>
      ) : snap?.image ? (
        <div className="emptyHint">image read — see the pinned tab at this step</div>
      ) : snap?.content !== undefined ? (
        <CodeView
          key={selected}
          file={{
            path,
            mode: 'file',
            render: { verb: verb ?? 'read_file', content: snap.content, start_line: snap.start_line ?? 1, region: snap.region },
            touchedAt: selected,
          }}
          animate={!!snap.region}
          flashOnly
          speed={speed}
          blame={blameMarks ? { marks: blameMarks, compact: blameCompact, onJump, onToggle: () => setBlameCompact((c) => !c) } : undefined}
        />
      ) : snap?.hunks ? (
        <DiffView
          key={selected}
          file={{ path, mode: 'diff', render: { verb: 'patch_file', hunks: snap.hunks }, touchedAt: selected }}
          animate={false}
        />
      ) : (
        <div className="emptyHint">no renderable state at this step</div>
      )}
    </div>
  );
}
