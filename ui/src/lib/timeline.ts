import type { Message, ResultRender, Step, Timeline } from '../types';

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

export function applyPatch(content: string, hunks: NonNullable<ResultRender['hunks']>): { content: string; region: { start: number; end: number } } | null {
  if (!hunks.length) return null;
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(content);
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (trailingNewline) lines.pop();
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
  };
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
