import { useRef } from 'react';

// Drag handle: reports pointer deltas; the parent owns the size state.
export function Splitter({ dir, onDrag }: { dir: 'col' | 'row'; onDrag: (delta: number) => void }) {
  const last = useRef(0);
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
        onDrag(pos - last.current);
        last.current = pos;
      }}
    />
  );
}
