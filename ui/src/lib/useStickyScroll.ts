import { useEffect, useRef, type RefObject } from 'react';

const NEAR_BOTTOM = 40;

// Pin-to-bottom scrolling: content growth keeps the pane at the bottom until
// the user scrolls up; scrolling back near the bottom re-engages, as does a
// reset (time travel / pane reveal). Returns the stuck ref for callers with
// extra scroll triggers (streaming intervals).
export function useStickyScroll(
  ref: RefObject<HTMLElement | null>,
  contentSignal: unknown[],
  resetSignal: unknown,
  enabled = true,
) {
  const stuck = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [ref]);

  // time travel or reveal: re-engage and snap
  useEffect(() => {
    stuck.current = true;
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  // content growth: follow only while stuck
  useEffect(() => {
    if (enabled && stuck.current) ref.current?.scrollTo({ top: ref.current.scrollHeight });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, contentSignal);

  return stuck;
}
