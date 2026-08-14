import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { appendMessages, createTimeline, durationFor, foldState, indexAtTime } from '../lib/timeline';
import type { SessionMeta, Step, TailResponse, Timeline } from '../types';

const POLL_MS = 2500;

export interface AgentNode {
  key: string; // timeline key ('main' or child session id)
  parentKey: string | null;
  label: string;
  agentType?: string;
}

export function useReplay() {
  const [session, setSession] = useState<SessionMeta | null>(null);
  const timelines = useRef(new Map<string, Timeline>());
  const [viewKey, setViewKey] = useState('main');
  const [pointers, setPointers] = useState<Record<string, number>>({});
  const [tick, setTick] = useState(0); // bumped when any timeline grows
  const [playing, setPlaying] = useState(false);
  const [follow, setFollow] = useState(false);
  const [speed, setSpeed] = useState(1);
  // step index (within viewKey) revealed by playback → gets entry animations
  const [animate, setAnimate] = useState<{ key: string; index: number } | null>(null);
  // bumped on every USER-initiated seek (jump/step/scrub/session switch) —
  // distinguishes time travel from playback advance for sticky scrolling
  const [seekTick, setSeekTick] = useState(0);

  const busy = useRef(new WeakSet<Timeline>());
  // a wall-clock landing for a timeline still loading when it was entered
  const pendingAlign = useRef<{ key: string; ts: number } | null>(null);

  const tailOnce = useCallback(async (key: string) => {
    const tl = timelines.current.get(key);
    if (!tl) return;
    // overlapping tails of one timeline would double-append from the same cursor
    if (busy.current.has(tl)) return;
    busy.current.add(tl);
    try {
      const initial = tl.cursor === 0;
      // large sessions arrive in server-capped chunks; drain them back to back
      for (;;) {
        const res = await fetch(
          `/api/session?provider=${encodeURIComponent(tl.provider)}&id=${encodeURIComponent(tl.sessionId)}&cursor=${tl.cursor}`,
        );
        if (!res.ok) return; // agent transcript may not exist yet
        const data: TailResponse = await res.json();
        // session switched while this fetch was in flight — discard
        if (timelines.current.get(key) !== tl) return;
        tl.mtime = data.mtime;
        tl.cursor = data.cursor;
        if (data.messages.length) {
          appendMessages(tl, data.messages);
          // the initial drain paints ONCE at the true head, after the loop:
          // per-chunk paints read as a visible fast-forward through history
          if (!initial) setTick((t) => t + 1);
        }
        if (data.cursor >= data.size || !data.messages.length) break;
      }
      if (initial) setTick((t) => t + 1);
      // a time alignment deferred from switchView: the timeline was empty
      // when the user descended into it — land at the intended moment now
      if (initial && pendingAlign.current?.key === key && tl.steps.length) {
        const ts = pendingAlign.current.ts;
        pendingAlign.current = null;
        setPointers((prev) => ({ ...prev, [key]: indexAtTime(tl.steps, ts) }));
      }
      // a freshly loaded session starts AT the head IN play mode: pin the
      // pointer so incoming live events animate instead of snapping
      if (initial && key === 'main') {
        setPointers((prev) => (key in prev ? prev : { ...prev, [key]: Math.max(0, tl.steps.length - 1) }));
        setPlaying(true);
        setFollow(true);
      }
    } catch {
      /* server briefly unavailable; next poll retries */
    } finally {
      busy.current.delete(tl);
    }
  }, []);

  // folder-only mode: scoped to a pwd with no session loaded
  const clearSession = useCallback(() => {
    timelines.current = new Map();
    setSession(null);
    setViewKey('main');
    setPointers({});
    setPlaying(false);
    setFollow(false);
    setAnimate(null);
    setTick((t) => t + 1);
  }, []);

  const selectSession = useCallback((s: SessionMeta) => {
    timelines.current = new Map([['main', createTimeline('main', s.id, s.provider)]]);
    setSession(s);
    setViewKey('main');
    setPointers({}); // no explicit pointer = glued to head until the user seeks
    setPlaying(false);
    setFollow(false);
    setAnimate(null);
    setSeekTick((t) => t + 1);
    setTick((t) => t + 1);
    void tailOnce('main');
  }, [tailOnce]);

  useEffect(() => {
    if (!session) return;
    const id = setInterval(() => {
      void tailOnce('main');
      if (viewKey !== 'main') void tailOnce(viewKey);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [session, viewKey, tailOnce]);

  const steps: Step[] = timelines.current.get(viewKey)?.steps ?? [];
  const head = Math.max(0, steps.length - 1);
  // default is the head — you can always rewind; an unseeked timeline stays
  // glued to the head as new events arrive
  const pointer = Math.min(pointers[viewKey] ?? head, head);

  // Playback loop: each newly revealed step stays on screen for its
  // reading-speed duration, then the pointer advances. At the head we idle;
  // tick growth (live tail) re-fires the effect and playback resumes.
  // The reveal deadline lives in a ref so live appends (tick/head changes)
  // reschedule only the REMAINING time instead of restarting the step.
  // A mid-step speed change rescales the remaining time.
  const deadline = useRef<{ key: string; index: number; at: number; speed: number } | null>(null);
  useEffect(() => {
    if (!playing) return;
    if (pointer >= head) return;
    const midDisplay = animate?.key === viewKey && animate.index === pointer;
    let delay: number;
    if (!midDisplay) {
      delay = 150 / speed;
    } else if (deadline.current?.key === viewKey && deadline.current.index === pointer) {
      const d = deadline.current;
      if (d.speed !== speed) {
        d.at = Date.now() + Math.max(0, d.at - Date.now()) * (d.speed / speed);
        d.speed = speed;
      }
      delay = Math.max(0, d.at - Date.now());
    } else {
      delay = durationFor(steps[pointer]) / speed;
      deadline.current = { key: viewKey, index: pointer, at: Date.now() + delay, speed };
    }
    const t = setTimeout(() => {
      setAnimate({ key: viewKey, index: pointer + 1 });
      setPointers((prev) => ({ ...prev, [viewKey]: pointer + 1 }));
    }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, pointer, head, viewKey, speed, tick]);

  const togglePlay = useCallback(() => {
    // both directions pin the pointer: pause = stop riding the head,
    // play = animate forward from exactly here (a head-glued pointer would
    // otherwise snap along with live appends and never animate)
    setPointers((prev) => {
      const tl = timelines.current.get(viewKey);
      const h = Math.max(0, (tl?.steps.length ?? 1) - 1);
      return { ...prev, [viewKey]: Math.min(prev[viewKey] ?? h, h) };
    });
    setPlaying((p) => {
      if (p) {
        setFollow(false); // pausing means stop, including live follow
        setAnimate(null); // halt in-flight animations: show the step's end state
      }
      return !p;
    });
  }, [viewKey]);

  // time travel of any kind — jump, step, scrub — drops both live-follow
  // and play: you moved the playhead, so the playhead stops moving itself
  const jump = useCallback((index: number) => {
    setAnimate(null);
    setSeekTick((t) => t + 1);
    setPointers((prev) => ({ ...prev, [viewKey]: index }));
    setFollow(false);
    setPlaying(false);
  }, [viewKey]);

  const stepBy = useCallback((delta: number) => {
    setAnimate(null);
    setSeekTick((t) => t + 1);
    setFollow(false);
    setPlaying(false);
    setPointers((prev) => {
      const cur = Math.min(prev[viewKey] ?? head, head);
      return { ...prev, [viewKey]: Math.max(0, Math.min(head, cur + delta)) };
    });
  }, [viewKey, head]);

  const goLive = useCallback(() => {
    setAnimate(null);
    setSeekTick((t) => t + 1);
    setPointers((prev) => ({ ...prev, [viewKey]: head }));
    setFollow(true);
    setPlaying(true);
  }, [viewKey, head]);

  const stopLive = useCallback(() => {
    setFollow(false);
    setPlaying(false);
  }, []);

  // All agents discovered across loaded timelines (full file, not pointer-limited).
  const agents = useMemo<AgentNode[]>(() => {
    const nodes: AgentNode[] = [{ key: 'main', parentKey: null, label: session?.label ?? 'main' }];
    for (const tl of timelines.current.values()) {
      for (const s of tl.steps) {
        if (s.kind === 'tool' && s.result?.verb === 'spawn_agent' && s.result.child_session_id) {
          nodes.push({
            key: s.result.child_session_id,
            parentKey: tl.key,
            label: s.call.title ?? s.result.agent_id ?? 'agent',
            agentType: s.result.agent_type ?? s.call.agent_type,
          });
        }
      }
    }
    return nodes;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, session]);

  const switchView = useCallback((key: string, childSessionId?: string) => {
    if (!timelines.current.has(key)) {
      if (!childSessionId || !session) return;
      timelines.current.set(key, createTimeline(key, childSessionId, session.provider));
      void tailOnce(key);
    }
    setAnimate(null);
    setSeekTick((t) => t + 1);
    // play state survives the switch: a view at its head just idles until
    // steps arrive, and a live child animating in is exactly the point.
    //
    // Time alignment: descending while scrubbed back lands the target at the
    // same wall-clock moment (clamped to its own timeline). A head-riding
    // source means "now", so the target opens at its head. Ascending back
    // out restores the outer view's own position untouched.
    const jumpingOut = (() => {
      for (let k: string | null = viewKey; k; ) {
        const n = agents.find((a) => a.key === k);
        if (!n) return false;
        if (n.parentKey === key) return true;
        k = n.parentKey;
      }
      return false;
    })();
    const curTl = timelines.current.get(viewKey);
    const curHead = Math.max(0, (curTl?.steps.length ?? 1) - 1);
    const curPtr = Math.min(pointers[viewKey] ?? curHead, curHead);
    pendingAlign.current = null;
    setPointers((prev) => {
      const next = { ...prev };
      // leaving a view at its head keeps it glued there: head means "the
      // end", including everything that arrives while you are away
      if (curPtr >= curHead) delete next[viewKey];
      if (!jumpingOut) {
        const ts = curPtr < curHead ? curTl?.steps[curPtr]?.ts : undefined;
        const tgt = timelines.current.get(key);
        if (ts && tgt?.steps.length) next[key] = indexAtTime(tgt.steps, ts);
        else {
          // a freshly created timeline has nothing to search yet: align it
          // once its initial load lands
          if (ts && tgt && !tgt.steps.length) pendingAlign.current = { key, ts };
          delete next[key];
        }
      }
      return next;
    });
    setViewKey(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, tailOnce, viewKey, pointers, agents]);

  const view = useMemo(() => foldState(steps, pointer), [steps, pointer, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const animateIndex = animate?.key === viewKey ? animate.index : -1;

  return {
    session, selectSession, clearSession,
    viewKey, switchView, agents,
    steps, pointer, head, view, animateIndex, follow, seekTick,
    playing, togglePlay, speed, setSpeed,
    jump, stepBy, goLive, stopLive,
  };
}

export type Replay = ReturnType<typeof useReplay>;
