import type { Message, RenderVerb, ResultRender, Step, Timeline } from '../types';

export function createTimeline(key: string, sessionId: string, provider: string): Timeline {
  return { key, sessionId, provider, steps: [], cursor: 0, mtime: 0, pending: new Map() };
}

// Appends messages in place (steps arrays are treated as append-only;
// components re-render off steps.length / pointer changes).
export function appendMessages(tl: Timeline, messages: Message[]): void {
  for (const m of messages) {
    for (const block of m.content) {
      switch (block.type) {
        case 'text':
          tl.steps.push({ kind: m.role === 'user' ? 'user' : 'assistant', text: block.text, ts: m.timestamp });
          break;
        case 'thinking':
          tl.steps.push({ kind: 'thinking', text: block.thought, ts: m.timestamp });
          break;
        case 'tool': {
          tl.steps.push({
            kind: 'tool',
            ts: m.timestamp,
            tool: block.tool,
            requestId: block.tool_request_id,
            call: block.extended?.render ?? { verb: 'other' },
            params: block.params,
          });
          tl.pending.set(block.tool_request_id, tl.steps.length - 1);
          break;
        }
        case 'tool_result': {
          const idx = tl.pending.get(block.tool_request_id);
          if (idx !== undefined) {
            // replace immutably: memoized components compare step identity
            tl.steps[idx] = {
              ...(tl.steps[idx] as Step & { kind: 'tool' }),
              result: block.extended?.render,
              resultData: block.result,
              isError: block.extended?.is_error,
            };
            tl.pending.delete(block.tool_request_id);
          }
          break;
        }
      }
    }
  }
}

// ---- folded view state at a pointer (pure; recomputed on jump/advance) ----

export interface FileView {
  path: string;
  mode: 'file' | 'diff' | 'image';
  render: ResultRender;
  touchedAt: number; // step index of last touch, drives active tab
}

export interface TermBlock {
  command: string;
  stdout: string;
  stderr: string;
  interrupted: boolean;
  at: number;
}

export interface DataView {
  title: string;
  table: NonNullable<ResultRender['table']>;
  touchedAt: number;
}

export interface ViewState {
  tabs: FileView[];
  activePath?: string;
  term: TermBlocks;
  data?: DataView;
  currentToolIndex: number; // last tool step at or before pointer, -1 if none
}

export type TermBlocks = TermBlock[];

export type Blame = (number | null)[]; // per-line: step index responsible, null = pre-history

export function applyPatch(
  content: string,
  hunks: NonNullable<ResultRender['hunks']>,
  blame?: Blame,
  stamp: number | null = null,
): { content: string; region: { start: number; end: number }; blame?: Blame } | null {
  if (!hunks.length) return null;
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(content);
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (trailingNewline) lines.pop();
  const stamps = blame ? [...blame] : undefined;
  let first = Infinity, last = 0, from = 0;

  for (const hunk of hunks) {
    const before = hunk.lines.filter((line) => !line.startsWith('+')).map((line) => line.slice(1));
    const after = hunk.lines.filter((line) => !line.startsWith('-')).map((line) => line.slice(1));
    let at = -1;
    for (let i = from; i <= lines.length - before.length; i++) {
      if (before.every((line, j) => lines[i + j] === line)) { at = i; break; }
    }
    if (at < 0) return null;
    lines.splice(at, before.length, ...after);
    if (stamps) {
      // walk the hunk keeping stamps aligned: kept lines inherit, added get stamped
      const next: Blame = [];
      let bi = at;
      for (const line of hunk.lines) {
        if (line.startsWith('+')) next.push(stamp);
        else if (line.startsWith('-')) bi++;
        else { next.push(stamps[bi] ?? null); bi++; }
      }
      stamps.splice(at, before.length, ...next);
    }
    let outputLine = at + 1;
    for (const line of hunk.lines) {
      if (line.startsWith('-')) {
        first = Math.min(first, outputLine);
        last = Math.max(last, outputLine);
      } else {
        if (line.startsWith('+')) {
          first = Math.min(first, outputLine);
          last = Math.max(last, outputLine);
        }
        outputLine++;
      }
    }
    from = at + after.length;
  }

  if (!Number.isFinite(first)) return null;
  const finalLine = Math.max(lines.length, 1);
  return {
    content: lines.join(newline) + (trailingNewline ? newline : ''),
    region: { start: Math.min(first, finalLine), end: Math.min(last, finalLine) },
    ...(stamps ? { blame: stamps } : {}),
  };
}

// un-applying a patch is applying it with additions and removals swapped
export const invertHunks = (hunks: NonNullable<ResultRender['hunks']>) =>
  hunks.map((h) => ({
    ...h,
    lines: h.lines.map((l) => (l.startsWith('+') ? '-' + l.slice(1) : l.startsWith('-') ? '+' + l.slice(1) : l)),
  }));

const isFullContent = (r: ResultRender): boolean =>
  r.content !== undefined
  && (r.start_line ?? 1) === 1
  && (r.total_lines === undefined || r.content.split(/\r?\n/).length >= r.total_lines);

// A patch with no prior content can still get a full file view if some FUTURE
// step reveals the file: take that content and un-apply every intervening
// patch, newest first, strictly while they un-apply clean. A write or an
// opaque patch in between severs the chain.
function backfillFromFuture(
  steps: Step[], at: number, path: string, hunksAtP: NonNullable<ResultRender['hunks']>,
): { content: string; region?: { start: number; end: number } } | null {
  const want = path.replace(/\//g, '\\').toLowerCase();
  const pending: NonNullable<ResultRender['hunks']>[] = [];
  for (let i = at + 1; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind !== 'tool' || !s.result) continue;
    const r = s.result;
    const p = r.path ?? s.call.path;
    if (!p || p.replace(/\//g, '\\').toLowerCase() !== want) continue;
    if (r.verb === 'write_file') return null;
    if (r.verb === 'read_file') {
      if (isFullContent(r)) return unwind(r.content!, pending, hunksAtP);
      continue; // slice read: no anchor, but no sever either
    }
    if (r.verb === 'patch_file') {
      if (!r.hunks) return null;
      if (r.content !== undefined) return unwind(r.content, [...pending, r.hunks], hunksAtP);
      pending.push(r.hunks);
    }
  }
  return null;
}

function unwind(
  future: string, pendingOldestFirst: NonNullable<ResultRender['hunks']>[],
  hunksAtP: NonNullable<ResultRender['hunks']>,
): { content: string; region?: { start: number; end: number } } | null {
  let content = future;
  for (let i = pendingOldestFirst.length - 1; i >= 0; i--) {
    const undone = applyPatch(content, invertHunks(pendingOldestFirst[i]));
    if (!undone) return null;
    content = undone.content;
  }
  // content should now be the state right after the patch at P; round-trip
  // P's own hunks to recover its changed region AND validate the chain — if
  // they don't fit, the anchor wasn't really this file's history
  const pre = applyPatch(content, invertHunks(hunksAtP));
  if (!pre) return null;
  const redo = applyPatch(pre.content, hunksAtP);
  if (!redo || redo.content !== content) return null;
  return { content, region: redo.region };
}

// ---- per-file timeline: every touch of a path, with state + blame where
// the patch chain applies (or un-applies) clean ----

export interface FileTouch { index: number; verb: RenderVerb; ts?: number }
export interface FileSnapshot {
  content?: string;
  start_line?: number;
  blame?: Blame;
  region?: { start: number; end: number };
  hunks?: NonNullable<ResultRender['hunks']>;
  image?: boolean;
}

const TOUCH_VERBS = new Set<RenderVerb>(['read_file', 'patch_file', 'write_file']);

// paths meet here from multiple sources (transcripts, explorer) with mixed
// separators and drive-letter casing; compare normalized
const normPath = (p: string) => p.replace(/\//g, '\\').toLowerCase();

export function fileChain(steps: Step[], path: string): { touches: FileTouch[]; snapshots: Map<number, FileSnapshot> } {
  const want = normPath(path);
  const touches: FileTouch[] = [];
  const snapshots = new Map<number, FileSnapshot>();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind !== 'tool' || !s.result) continue;
    const r = s.result;
    const p = r.path ?? s.call.path;
    if (!p || normPath(p) !== want || !TOUCH_VERBS.has(r.verb)) continue;
    touches.push({ index: i, verb: r.verb, ts: s.ts });
  }

  // forward pass: carry {content, blame} through clean applications
  let content: string | undefined;
  let blame: Blame | undefined;
  const freshBlame = (c: string, stamp: number | null) => c.split(/\r?\n/).map(() => stamp);
  const regionBlame = (c: string, region: FileSnapshot['region'], stamp: number) =>
    c.split(/\r?\n/).map((_, li) => (region && li + 1 >= region.start && li + 1 <= region.end ? stamp : null));

  for (const t of touches) {
    const r = (steps[t.index] as Step & { kind: 'tool' }).result!;
    if (r.verb === 'read_file') {
      if (r.image_src) { snapshots.set(t.index, { image: true }); continue; }
      if (isFullContent(r)) {
        // reads are ground truth: always adopt; keep accumulated blame only
        // when the read CONFIRMS the carried chain, reset it when it refutes
        const eol = (s: string) => s.replace(/\r\n/g, '\n');
        if (content === undefined || eol(content) !== eol(r.content!)) {
          blame = freshBlame(r.content!, null);
        }
        content = r.content!;
      }
      snapshots.set(t.index, content !== undefined
        ? { content, blame, region: r.region }
        : { content: r.content, start_line: r.start_line, region: r.region });
    } else if (r.verb === 'write_file') {
      const written = r.content ?? '';
      content = written;
      blame = freshBlame(written, t.index);
      snapshots.set(t.index, { content, blame });
    } else {
      if (content !== undefined && r.hunks) {
        const res = applyPatch(content, r.hunks, blame, t.index);
        if (res) {
          content = res.content;
          blame = res.blame ?? blame;
          snapshots.set(t.index, { content, blame, region: res.region, hunks: r.hunks });
          continue;
        }
      }
      if (r.content !== undefined) {
        // loader-reconstructed post state; blame only for its own region
        const post = r.content;
        content = post;
        blame = regionBlame(post, r.region, t.index);
        snapshots.set(t.index, { content, blame, region: r.region, hunks: r.hunks });
        continue;
      }
      // chain broken: keep the raw patch, forget carried state
      content = undefined;
      blame = undefined;
      snapshots.set(t.index, { hunks: r.hunks, region: r.region });
    }
  }

  // backward pass: content-less patches try reconstruction from the future
  for (const t of touches) {
    const snap = snapshots.get(t.index);
    if (t.verb !== 'patch_file' || !snap || snap.content !== undefined || !snap.hunks) continue;
    const back = backfillFromFuture(steps, t.index, path, snap.hunks);
    if (back) {
      snap.content = back.content;
      snap.region = back.region ?? snap.region;
      snap.blame = regionBlame(back.content, snap.region, t.index);
    }
  }

  return { touches, snapshots };
}

export function foldState(steps: Step[], pointer: number): ViewState {
  const byPath = new Map<string, FileView>();
  const term: TermBlock[] = [];
  let data: DataView | undefined;
  let currentToolIndex = -1;
  for (let i = 0; i <= pointer && i < steps.length; i++) {
    const s = steps[i];
    if (s.kind !== 'tool') continue;
    currentToolIndex = i;
    const r = s.result;
    switch (s.call.verb) {
      case 'read_file': {
        // image results carry no path of their own; the call side has it
        const path = r?.path ?? s.call.path;
        if (r?.verb === 'read_file' && path) {
          byPath.set(path, { path, mode: r.image_src ? 'image' : 'file', render: r, touchedAt: i });
        }
        if (s.call.command) term.push({ command: s.call.command, stdout: r?.stdout ?? '', stderr: r?.stderr ?? '', interrupted: !!r?.interrupted, at: i });
        break;
      }
      case 'patch_file': {
        if (r?.verb === 'patch_file' && r.path) {
          const prior = byPath.get(r.path)?.render.content;
          const applied = r.content === undefined && prior !== undefined && r.hunks ? applyPatch(prior, r.hunks) : null;
          const render = applied ? { ...r, ...applied, start_line: 1, total_lines: applied.content.split(/\r?\n/).length } : r;
          byPath.set(r.path, { path: r.path, mode: render.content === undefined ? 'diff' : 'file', render, touchedAt: i });
        }
        break;
      }
      case 'write_file': {
        if (r?.verb === 'write_file' && r.path) {
          byPath.set(r.path, { path: r.path, mode: 'file', render: r, touchedAt: i });
        }
        break;
      }
      case 'exec': {
        term.push({
          command: s.call.command ?? '',
          stdout: r?.stdout ?? '',
          stderr: r?.stderr ?? '',
          interrupted: !!r?.interrupted,
          at: i,
        });
        break;
      }
      case 'data': {
        term.push({
          command: s.call.command ?? r?.command ?? '', stdout: r?.stdout ?? '', stderr: r?.stderr ?? '',
          interrupted: !!r?.interrupted, at: i,
        });
        if (r?.verb === 'data' && r.table) data = { title: s.call.title ?? 'table', table: r.table, touchedAt: i };
        break;
      }
    }
  }
  // diff-only tabs: try reconstructing the full file backward from the future
  for (const t of byPath.values()) {
    if (t.mode !== 'diff' || t.render.content !== undefined || !t.render.hunks) continue;
    const back = backfillFromFuture(steps, t.touchedAt, t.path, t.render.hunks);
    if (back) {
      t.render = {
        ...t.render,
        content: back.content,
        region: back.region ?? t.render.region,
        start_line: 1,
        total_lines: back.content.split(/\r?\n/).length,
      };
      t.mode = 'file';
    }
  }
  const tabs = [...byPath.values()];
  let activePath: string | undefined;
  let latest = -1;
  for (const t of tabs) if (t.touchedAt > latest) { latest = t.touchedAt; activePath = t.path; }
  return { tabs, activePath, term, data, currentToolIndex };
}

// Edit typing rate at 1x playback, scaled by playback speed. Deliberately
// superhuman (~8x a fast typist) — agent edits are big and human WPM reads
// painfully slow in replay.
export const TYPE_CPS = 120;

export function regionChars(r: ResultRender): number {
  if (!r.region || r.content === undefined) return 0;
  const start = r.start_line ?? 1;
  const lines = r.content.split('\n');
  return lines
    .slice(Math.max(0, r.region.start - start), Math.min(lines.length, r.region.end - start + 1))
    .join('\n').length;
}

// Reading-speed duration for a step in ms (before speed division).
export function durationFor(step: Step): number {
  switch (step.kind) {
    case 'user':
    case 'assistant':
      return Math.min(500 + step.text.length * 12, 3500);
    case 'thinking':
      return Math.min(300 + step.text.length * 4, 2000);
    case 'tool':
      switch (step.call.verb) {
        case 'exec': {
          const out = (step.result?.stdout?.length ?? 0) + (step.result?.stderr?.length ?? 0);
          return Math.min(600 + (step.call.command?.length ?? 0) * 15 + out / 10, 3000);
        }
        case 'read_file':
          return 1800;
        case 'data':
          return 1800;
        case 'patch_file':
        case 'write_file': {
          // must cover the region typing animation plus a beat to see the result
          const chars = step.result ? regionChars(step.result) : 0;
          return chars ? (chars / TYPE_CPS) * 1000 + 600 : 1500;
        }
        case 'spawn_agent':
          return 1200;
        default:
          return 900;
      }
  }
}

// Seek helper: last step whose timestamp <= ts (for syncing agent playheads
// to the parent timeline's wall clock).
export function indexAtTime(steps: Step[], ts: number): number {
  let lo = 0, hi = steps.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((steps[mid].ts ?? 0) <= ts) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}
