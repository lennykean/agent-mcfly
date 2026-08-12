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

  const busy = useRef(new WeakSet<Timeline>());

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
          setTick((t) => t + 1);
        }
        if (data.cursor >= data.size || !data.messages.length) break;
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

  const jump = useCallback((index: number) => {
    setAnimate(null);
    setPointers((prev) => ({ ...prev, [viewKey]: index }));
    if (index < head) setFollow(false);
  }, [viewKey, head]);

  // moving the pointer never exits play mode — only the pause button does
  const stepBy = useCallback((delta: number) => {
    setAnimate(null);
    setFollow(false);
    setPointers((prev) => {
      const cur = Math.min(prev[viewKey] ?? head, head);
      return { ...prev, [viewKey]: Math.max(0, Math.min(head, cur + delta)) };
    });
  }, [viewKey, head]);

  const goLive = useCallback(() => {
    setAnimate(null);
    setPointers((prev) => ({ ...prev, [viewKey]: head }));
    setFollow(true);
    setPlaying(true);
  }, [viewKey, head]);

  const switchView = useCallback((key: string, childSessionId?: string) => {
    if (!timelines.current.has(key)) {
      if (!childSessionId || !session) return;
      timelines.current.set(key, createTimeline(key, childSessionId, session.provider));
      void tailOnce(key);
    }
    setAnimate(null);
    setPlaying(false);
    setViewKey(key);
    // no pointer entry: new timelines open at their head
  }, [session, tailOnce]);

  // Seek the current (agent) view to the main timeline's current wall-clock time.
  const syncToMain = useCallback(() => {
    const main = timelines.current.get('main');
    if (!main || viewKey === 'main') return;
    const mainPtr = Math.min(pointers.main ?? 0, main.steps.length - 1);
    const ts = main.steps[mainPtr]?.ts;
    if (ts) jump(indexAtTime(steps, ts));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, pointers, jump, tick]);

  const view = useMemo(() => foldState(steps, pointer), [steps, pointer, tick]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const animateIndex = animate?.key === viewKey ? animate.index : -1;

  return {
    session, selectSession, clearSession,
    viewKey, switchView, syncToMain, agents,
    steps, pointer, head, view, animateIndex, follow,
    playing, togglePlay, speed, setSpeed,
    jump, stepBy, goLive,
  };
}

export type Replay = ReturnType<typeof useReplay>;
