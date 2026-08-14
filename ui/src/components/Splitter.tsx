import { useRef } from 'react';

// Drag handle: reports pointer deltas; the parent owns the size state.
// Deltas are ACCUMULATED and flushed once per animation frame — a drag can
// fire hundreds of pointermoves a second, and each report costs a render.
export function Splitter({ dir, onDrag }: { dir: 'col' | 'row'; onDrag: (delta: number) => void }) {
  const last = useRef(0);
  const acc = useRef(0);
  const raf = useRef(0);
  const cb = useRef(onDrag);
  cb.current = onDrag;
  return (
    <div
      className={`splitter splitter-${dir}`}
      onPointerDown={(e) => {
        last.current = dir === 'col' ? e.clientX : e.clientY;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        const pos = dir === 'col' ? e.clientX : e.clientY;
        acc.current += pos - last.current;
        last.current = pos;
        if (!raf.current) {
          raf.current = requestAnimationFrame(() => {
            raf.current = 0;
            const d = acc.current;
            acc.current = 0;
            if (d) cb.current(d);
          });
        }
      }}
    />
  );
}
