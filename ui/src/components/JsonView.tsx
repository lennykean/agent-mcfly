import { useState } from 'react';

// Chrome-devtools-style JSON tree: root expanded, nested objects collapsed by
// default (one row each — no huge render until you ask). Long strings are
// collapsed nodes too: a preview row with a size hint, expand for the full text.

const LONG_STR = 300;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const sizeOf = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} chars`);

function LongStrNode({ k, s, depth }: { k?: string; s: string; depth: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="jRow jToggle" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setOpen(!open)}>
        <span className="jChev">{open ? '▾' : '▸'}</span>
        {k !== undefined && <span className="jKey">{k}: </span>}
        {!open && <span className="jStr">"{s.split('\n')[0].slice(0, 80)}…"</span>}
        <span className="jPreview"> ({sizeOf(s.length)})</span>
      </div>
      {open && <div className="jStrBlock" style={{ marginLeft: 8 + (depth + 1) * 14 }}>{s}</div>}
    </>
  );
}

function Prim({ v }: { v: unknown }) {
  if (typeof v === 'string') return <span className="jStr">"{v}"</span>;
  if (typeof v === 'number') return <span className="jNum">{String(v)}</span>;
  if (typeof v === 'boolean' || v === null) return <span className="jBool">{String(v)}</span>;
  return <span>{String(v)}</span>;
}

function previewOf(v: unknown): string {
  if (Array.isArray(v)) return `Array(${v.length})`;
  if (isObj(v)) {
    const keys = Object.keys(v);
    return `{${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''}}`;
  }
  return '';
}

function Node({ k, v, depth }: { k?: string; v: unknown; depth: number }) {
  const [open, setOpen] = useState(depth === 0);
  const pad = { paddingLeft: 8 + depth * 14 };
  if (typeof v === 'string' && v.length > LONG_STR) return <LongStrNode k={k} s={v} depth={depth} />;
  if (!isObj(v)) {
    return (
      <div className="jRow" style={pad}>
        {k !== undefined && <span className="jKey">{k}: </span>}
        <Prim v={v} />
      </div>
    );
  }
  const entries = Array.isArray(v)
    ? v.map((x, i) => [String(i), x] as const)
    : Object.entries(v);
  return (
    <>
      <div className="jRow jToggle" style={pad} onClick={() => setOpen(!open)}>
        <span className="jChev">{open ? '▾' : '▸'}</span>
        {k !== undefined && <span className="jKey">{k}: </span>}
        <span className="jPreview">{open ? (Array.isArray(v) ? '[' : '{') : previewOf(v)}</span>
      </div>
      {open && entries.map(([ck, cv]) => <Node key={ck} k={ck} v={cv} depth={depth + 1} />)}
      {open && <div className="jRow jPreview" style={pad}>{Array.isArray(v) ? ']' : '}'}</div>}
    </>
  );
}

export function JsonView({ value }: { value: unknown }) {
  return <div className="jsonView"><Node v={value} depth={0} /></div>;
}

// Plain-text results: short text renders inline; long text is a collapsed node.
export function LongText({ text }: { text: string }) {
  if (text.length <= LONG_STR) return <pre className="jsonView jStrBlock">{text}</pre>;
  return <div className="jsonView"><LongStrNode s={text} depth={0} /></div>;
}
