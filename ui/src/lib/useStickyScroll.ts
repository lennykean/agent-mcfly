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
    // scroll position can only RE-engage: big content mounting fires reflow
    // scroll events that briefly measure far-from-bottom, and those must
    // never break the pin. Only user intent disengages: wheeling up, or
    // grabbing the scrollbar.
    const onScroll = () => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM) stuck.current = true;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) stuck.current = false;
    };
    const onDown = (e: MouseEvent) => {
      if (e.offsetX >= el.clientWidth) stuck.current = false; // the scrollbar
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('mousedown', onDown);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('mousedown', onDown);
    };
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
