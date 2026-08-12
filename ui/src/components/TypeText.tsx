import { useEffect, useRef, useState } from 'react';

// Reveals text progressively over `duration` ms when `animate` is set;
// renders instantly otherwise (jumps, history). onDone fires when the reveal
// finishes (immediately when not animating).
export function TypeText({
  text, duration, animate, onDone,
}: {
  text: string; duration: number; animate: boolean; onDone?: () => void;
}) {
  const [shown, setShown] = useState(animate ? 0 : text.length);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (!animate) {
      setShown(text.length);
      onDoneRef.current?.();
      return;
    }
    setShown(0);
    const stepMs = 30;
    const chunk = Math.max(1, Math.ceil(text.length / Math.max(1, duration / stepMs)));
    const id = setInterval(() => {
      setShown((n) => {
        const next = n + chunk;
        if (next >= text.length) {
          clearInterval(id);
          onDoneRef.current?.();
        }
        return Math.min(next, text.length);
      });
    }, stepMs);
    return () => clearInterval(id);
  }, [text, duration, animate]);

  return <>{text.slice(0, shown)}</>;
}
