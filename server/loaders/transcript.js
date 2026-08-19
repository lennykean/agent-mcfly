// Plumbing shared by the transcript loaders: session-id/path helpers, the
// chunked tail read, and an mtime-keyed memo. Transcript SEMANTICS stay in the
// per-provider loaders; only the mechanics live here.
import fs from 'node:fs';
import path from 'node:path';

// Complete lines only from byte offset `cursor`, so tailing a mid-write file is
// safe. At most ~2MB per call (grown if a single line exceeds that); the client
// keeps calling while cursor < size.
export const MAX_CHUNK = 2 * 1024 * 1024;

export function readTail(file, cursor = 0) {
  const st = fs.statSync(file);
  if (st.size <= cursor) return { st, buf: Buffer.alloc(0) };
  const fd = fs.openSync(file, 'r');
  try {
    let want = Math.min(st.size - cursor, MAX_CHUNK);
    for (;;) {
      const buf = Buffer.alloc(want);
      fs.readSync(fd, buf, 0, want, cursor);
      if (buf.lastIndexOf(10) >= 0 || want >= st.size - cursor) return { st, buf };
      want = Math.min(want * 2, st.size - cursor); // single line bigger than chunk
    }
  } finally {
    fs.closeSync(fd);
  }
}

// A provider's session ids are paths relative to its root; resolving one must
// never escape that root.
export function idsFor(root) {
  const resolveId = (id) => {
    const p = path.resolve(root, id);
    if (!p.startsWith(root + path.sep)) throw new Error('session id outside root');
    return p;
  };
  return {
    resolveId,
    rel: (p) => path.relative(root, p).split(path.sep).join('/'),
    // last-activity probe for the agent tree: a stat, no parsing. Transcripts
    // are append-only, so once a tip falls behind the playhead the client can
    // freeze it and never ask again.
    tip: (id) => {
      const st = fs.statSync(resolveId(id));
      return { updated_at: st.mtimeMs, size: st.size };
    },
  };
}

// Memo whose entries expire by content stamp (an mtime, a size, a deadline)
// rather than by count: recomputing is what the stamp changing means.
// ponytail: no eviction; entries are small and keyed by file path.
export function memoByStamp() {
  const cache = new Map();
  return (key, stamp, compute) => {
    const hit = cache.get(key);
    if (hit && hit.stamp === stamp) return hit.value;
    const value = compute();
    cache.set(key, { stamp, value });
    return value;
  };
}

export const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : (s ?? ''));
