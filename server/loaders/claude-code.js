// Claude Code session loader. Reads ~/.claude/projects JSONL transcripts and
// converts them to simulacra-shaped normalized messages (see DESIGN.md "Wire
// format"). Designed to the @simulacra-ai/session SessionStore contract
// (read-only, plus tail() for live follow) so it can be upstreamed later.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { highlightCall, highlightResult, isHighlightTool, isTableTool, isWaypointRemoveTool, isWaypointTool, tableCall, tableResult, waypointCall, waypointRemoveCall, waypointRemoveResult, waypointResult } from '../mcfly-data.js';

const ROOT = path.resolve(os.homedir(), '.claude', 'projects');

// tool_request_id -> tool name, so result lines can be tagged with their verb
// even when the call arrived in an earlier tail() chunk.
// ponytail: unbounded cache; fine for a local tool's process lifetime.
const toolNameById = new Map();
const inferredReadById = new Map();

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function resolveId(id) {
  const p = path.resolve(ROOT, id);
  if (!p.startsWith(ROOT + path.sep)) throw new Error('session id outside root');
  return p;
}

// Claude Code stores per-project sessions in a directory whose name is the
// slugified cwd (C:\Users\X\proj -> C--Users-X-proj, drive case varies).
const slug = (p) => p.replace(/[:\\/.]/g, '-');

export function listForCwd(cwd) {
  const want = slug(cwd).toLowerCase();
  let projects = [];
  try { projects = fs.readdirSync(ROOT, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const proj of projects) {
    if (!proj.isDirectory() || proj.name.toLowerCase() !== want) continue;
    out.push(...listDir(path.join(ROOT, proj.name), proj.name));
  }
  out.sort((a, b) => b.updated_at - a.updated_at);
  return out;
}

export function list() {
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(ROOT, { withFileTypes: true }); } catch { return out; }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    out.push(...listDir(path.join(ROOT, proj.name), proj.name));
  }
  out.sort((a, b) => b.updated_at - a.updated_at);
  return out;
}

function listDir(dir, projName) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const f of files) {
    if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
    const full = path.join(dir, f.name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    const head = scanHead(full);
    out.push({
      id: rel(full),
      provider: 'claude-code',
      project: projName,
      label: head.title ?? f.name.replace(/\.jsonl$/, '').slice(0, 8),
      cwd: head.cwd,
      updated_at: st.mtimeMs,
      size: st.size,
    });
  }
  return out;
}

// The cwd lives near the head; current Claude versions repeat custom titles
// near the tail after a session is renamed. Sessions without a custom title
// fall back to a derived name: the stored summary, else the first real user
// message — anything beats eight hex digits in a picker.
export function scanHead(file) {
  const out = {};
  let derived;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    for (const start of new Set([0, Math.max(0, size - 64 * 1024)])) {
      const buf = Buffer.alloc(Math.min(64 * 1024, size - start));
      const n = fs.readSync(fd, buf, 0, buf.length, start);
      for (const line of buf.toString('utf8', 0, n).split('\n')) {
        const wantName = !out.title && !derived
          && (line.includes('"summary"') || line.includes('"type":"user"'));
        if (!line.includes('"custom-title"') && (out.cwd || !line.includes('"cwd"')) && !wantName) continue;
        try {
          const o = JSON.parse(line);
          if (o.type === 'custom-title' && o.customTitle) out.title = o.customTitle;
          if (!out.cwd && typeof o.cwd === 'string') out.cwd = o.cwd;
          if (!derived) {
            if (o.type === 'summary' && typeof o.summary === 'string') derived = o.summary;
            else if (o.type === 'user') {
              const c = o.message?.content;
              const text = typeof c === 'string' ? c
                : Array.isArray(c) ? c.find((p) => p.type === 'text' && p.text)?.text : undefined;
              const t = text?.trim();
              // skip injected wrappers (command output, caveats, tag blobs)
              if (t && !t.startsWith('<') && !t.startsWith('Caveat:')) derived = t;
            }
          }
        } catch { /* partial line at chunk edge */ }
      }
    }
  } catch { /* unreadable */ } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (!out.title && derived) out.title = derived.replace(/\s+/g, ' ').slice(0, 60);
  return out;
}

// Complete lines only from byte offset `cursor`, so tailing a mid-write file is
// safe. Chunked: at most ~2MB per call (grown if a single line exceeds that);
// the client keeps calling while cursor < size.
const MAX_CHUNK = 2 * 1024 * 1024;

export function tail(id, cursor = 0) {
  const file = resolveId(id);
  const st = fs.statSync(file);
  const messages = [];
  let offset = cursor;
  if (st.size > cursor) {
    const fd = fs.openSync(file, 'r');
    let buf;
    try {
      let want = Math.min(st.size - cursor, MAX_CHUNK);
      for (;;) {
        buf = Buffer.alloc(want);
        fs.readSync(fd, buf, 0, want, cursor);
        if (buf.lastIndexOf(10) >= 0 || want >= st.size - cursor) break;
        want = Math.min(want * 2, st.size - cursor); // single line bigger than chunk
      }
    } finally {
      fs.closeSync(fd);
    }
    const end = buf.lastIndexOf(10); // \n
    if (end >= 0) {
      offset = cursor + end + 1;
      const ctx = {
        sessionDir: file.replace(/\.jsonl$/, ''),
        allowSidechain: file.includes(`${path.sep}subagents${path.sep}`),
      };
      for (const line of buf.toString('utf8', 0, end).split('\n')) {
        if (line.trim()) convertLine(line, ctx, messages);
      }
    }
  }
  return { messages, cursor: offset, mtime: st.mtimeMs, size: st.size };
}

function convertLine(line, ctx, messages) {
  let o;
  try { o = JSON.parse(line); } catch { return; }
  // Sidechain lines in a main transcript belong to subagents, which have their
  // own files; skip them to avoid double-rendering.
  if (o.isSidechain && !ctx.allowSidechain) return;
  const timestamp = o.timestamp ? Date.parse(o.timestamp) : undefined;

  if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
    const content = [];
    for (const c of o.message.content) {
      if (c.type === 'text' && c.text) content.push({ type: 'text', text: c.text });
      else if (c.type === 'thinking' && c.thinking) content.push({ type: 'thinking', thought: c.thinking });
      else if (c.type === 'tool_use') {
        toolNameById.set(c.id, c.name);
        const inferredRead = c.name === 'Bash' ? inferBashRead(c.input?.command, o.cwd) : null;
        if (inferredRead) inferredReadById.set(c.id, inferredRead);
        const inferredTool = c.name === 'Bash' ? inferBashTool(c.input?.command) : null;
        const displayTool = inferredTool === 'Read' && !inferredRead ? c.name : inferredTool ?? c.name;
        content.push({
          type: 'tool',
          tool_request_id: c.id,
          tool: displayTool,
          params: c.input,
          extended: { render: inferredRead ?? callRender(c.name, c.input ?? {}) },
        });
      }
    }
    if (content.length) messages.push({ id: o.uuid, timestamp, role: 'assistant', content });
  } else if (o.type === 'user' && o.message) {
    const raw = o.message.content;
    const content = [];
    if (typeof raw === 'string') {
      if (!o.isMeta && raw.trim()) pushUserText(content, raw);
    } else if (Array.isArray(raw)) {
      for (const c of raw) {
        if (c.type === 'text' && c.text && !o.isMeta) pushUserText(content, c.text);
        else if (c.type === 'tool_result') {
          const tool = toolNameById.get(c.tool_use_id) ?? sniffTool(o.toolUseResult) ?? '?';
          const inferredRead = inferredReadById.get(c.tool_use_id);
          content.push({
            type: 'tool_result',
            tool_request_id: c.tool_use_id,
            tool,
            // structured result when the transcript has one; flattened text otherwise
            result: o.toolUseResult ?? flatten(c.content),
            extended: {
              render: inferredRead && !c.is_error
                ? bashReadResult(inferredRead, o.toolUseResult, c) ?? resultRender(tool, o.toolUseResult, c, ctx)
                : resultRender(tool, o.toolUseResult, c, ctx),
              is_error: !!c.is_error,
            },
          });
        }
      }
    }
    if (content.length) messages.push({ id: o.uuid, timestamp, role: 'user', content });
  }
  // every other line type (mode, snapshots, attachments, system, ...) is meta: skipped
}

// Local slash-command turns arrive as XML-ish envelopes; render the command
// itself, drop its stdout echo and the caveat wrapper.
function pushUserText(content, text) {
  const t = text.trim();
  if (t.startsWith('<local-command-stdout>')) return;
  if (t.startsWith('Caveat: The messages below were generated')) return;
  const cmd = t.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = t.match(/<command-args>([^<]*)<\/command-args>/);
    content.push({ type: 'text', text: `⌘ ${cmd[1]}${args?.[1] ? ' ' + args[1] : ''}` });
    return;
  }
  content.push({ type: 'text', text });
}

function flatten(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

// The call→name map is process memory; after a server restart, results whose
// calls were converted by the previous process would lose their verb. The
// structured result shape identifies the tool well enough.
function sniffTool(r) {
  if (r == null || typeof r !== 'object') return null;
  if (r.file?.content !== undefined) return 'Read';
  if (r.structuredPatch && r.oldString !== undefined) return 'Edit';
  if (r.structuredPatch && r.filePath && r.content !== undefined) return 'Write';
  if (r.stdout !== undefined || r.stderr !== undefined) return 'Bash';
  if (r.agentId && r.agentType) return 'Agent';
  return null;
}

export function inferBashTool(command) {
  const parsed = unwrapCd(command);
  if (!parsed) return null;
  const source = parsed.command;
  const lines = source.split(/\r?\n/);

  // Exact heredoc-to-file shape only; scripts around it stay Bash.
  if (lines.length > 1) {
    const first = lines[0];
    const delimiter = first.match(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1/)?.[2];
    const output = first.match(/\s(>>?)\s*("[^"\r\n]+"|'[^'\r\n]+'|[^\s;&|<>"']+)(?:\s|$)/);
    if (/^cat\b/.test(first) && delimiter && output && lines.at(-1)?.trim() === delimiter && !/[;&|`]|\$\(/.test(first)) {
      const target = output[2].replace(/^(['"])(.*)\1$/, '$2');
      if (!target.startsWith('/dev/')) return output[1] === '>>' ? 'Edit' : 'Write';
    }
    return null;
  }

  if (parseBashRead(command)) return 'Read';
  if (/(?:&&|\|\||[;|`]|\$\()/.test(source)) return null;
  if (/^(?:sed\s+-\S*i\S*|perl\s+-\S*pi\S*)\s+/.test(source)) return 'Edit';

  const output = source.match(/^(?:echo|printf|cat)\s+.+\s(>>?)\s*("[^"\r\n]+"|'[^'\r\n]+'|[^\s;&|<>"']+)$/);
  if (!output) return null;
  const target = output[2].replace(/^(['"])(.*)\1$/, '$2');
  return target.startsWith('/dev/') ? null : output[1] === '>>' ? 'Edit' : 'Write';
}

function literalShellArg(source) {
  const value = source.trim();
  if (/^'[^']+'$/.test(value)) return value.slice(1, -1);
  if (/^"[^"\\$`]+"$/.test(value)) return value.slice(1, -1);
  return /^[^\s;&|<>\\'"`$()]+$/.test(value) ? value : null;
}

function unwrapCd(command) {
  const source = String(command ?? '').trim();
  if (!source) return null;
  const match = source.match(/^cd(?:\s+--)?\s+(.+?)\s+&&\s+([\s\S]+)$/);
  if (!match) return { command: source };
  const cwd = literalShellArg(match[1]);
  return cwd === null ? null : { command: match[2].trim(), cwd };
}

function parseBashRead(command) {
  const parsed = unwrapCd(command);
  if (!parsed) return null;
  let full = false; // only cat sees the whole file; head/sed are slices
  let match = parsed.command.match(/^sed\s+-n\s+(['"])(\d+)(?:,(\d+))?p\1\s+(?:--\s+)?(.+)$/);
  let start = Number(match?.[2]);
  if (match && Number(match[3] ?? match[2]) < start) return null;
  if (!match) {
    match = parsed.command.match(/^cat\s+(?:--\s+)?(.+)$/);
    start = 1;
    full = !!match;
  }
  if (!match) {
    match = parsed.command.match(/^head\s+(?:(?:-n\s+|-)(\d+)\s+)?(?:--\s+)?(.+)$/);
    start = 1;
  }
  const file = literalShellArg(match?.at(-1) ?? '');
  return file && !file.startsWith('-') && start >= 1 ? { parsed, file, start, full } : null;
}

export function inferBashRead(command, sessionCwd) {
  const spec = parseBashRead(command);
  if (!spec) return null;
  const { parsed, file, start, full } = spec;

  const windows = [file, parsed.cwd, sessionCwd]
    .some((value) => /^[a-z]:[\\/]|^\\\\/i.test(value ?? ''));
  const paths = windows ? path.win32 : path.posix;
  let cwd = parsed.cwd ?? sessionCwd;
  if (parsed.cwd && !paths.isAbsolute(parsed.cwd)) {
    if (!sessionCwd || !paths.isAbsolute(sessionCwd)) return null;
    cwd = paths.resolve(sessionCwd, parsed.cwd);
  }
  if (!paths.isAbsolute(file) && (!cwd || !paths.isAbsolute(cwd))) return null;
  const resolved = paths.isAbsolute(file) ? file : paths.resolve(cwd, file);
  return { verb: 'read_file', path: resolved, title: shortPath(resolved), start_line: start, ...(full ? { full: true } : {}) };
}

export function bashReadResult(read, result, block) {
  if (result?.stderr) return null;
  const content = result?.stdout ?? flatten(block.content);
  const lines = content ? content.replace(/\r?\n$/, '').split(/\r?\n/).length : 0;
  return {
    verb: 'read_file', path: read.path, content, start_line: read.start_line,
    // total_lines only when the command provably saw the whole file (cat);
    // head/sed slices must never become full-file authorities downstream
    ...(read.full && read.start_line === 1 ? { total_lines: lines } : {}),
    region: { start: read.start_line, end: read.start_line + Math.max(0, lines - 1) },
  };
}

// ---- render verbs: the provider-neutral contract the UI consumes ----

function callRender(tool, input) {
  if (isTableTool(tool)) return tableCall(input);
  if (isHighlightTool(tool)) return highlightCall(input);
  if (isWaypointRemoveTool(tool)) return waypointRemoveCall(input);
  if (isWaypointTool(tool)) return waypointCall(input);
  switch (tool) {
    case 'Read':
      return { verb: 'read_file', path: input.file_path, title: shortPath(input.file_path) };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { verb: 'patch_file', path: input.file_path ?? input.notebook_path, title: shortPath(input.file_path ?? input.notebook_path) };
    case 'Write':
      return { verb: 'write_file', path: input.file_path, title: shortPath(input.file_path) };
    case 'Bash':
    case 'PowerShell':
      return { verb: 'exec', command: input.command, title: input.description ?? truncate(input.command, 60) };
    case 'Grep': {
      let cmd = `grep${input['-i'] ? ' -i' : ''} "${input.pattern}"`;
      if (input.path) cmd += ` ${input.path}`;
      if (input.glob) cmd += ` --glob "${input.glob}"`;
      return { verb: 'exec', command: cmd, title: truncate(input.pattern, 60) };
    }
    case 'Glob':
      return { verb: 'exec', command: `glob "${input.pattern}"${input.path ? ' ' + input.path : ''}`, title: truncate(input.pattern, 60) };
    case 'Agent':
    case 'Task':
      return { verb: 'spawn_agent', agent_type: input.subagent_type, title: input.description ?? 'agent' };
    default:
      return { verb: 'other', title: summarizeParams(tool, input) };
  }
}

function resultRender(tool, r, block, ctx) {
  if (isTableTool(tool)) {
    const data = tableResult(r) ?? tableResult(flatten(block.content));
    if (data) return data;
    return block.is_error
      ? { verb: 'exec', stdout: '', stderr: flatten(block.content) }
      : { verb: 'exec', stdout: flatten(block.content), stderr: '' };
  }
  if (isHighlightTool(tool)) {
    const read = highlightResult(r) ?? highlightResult(flatten(block.content));
    if (read) return read;
    return { verb: 'exec', stdout: block.is_error ? '' : flatten(block.content), stderr: block.is_error ? flatten(block.content) : '' };
  }
  if (isWaypointRemoveTool(tool)) {
    const rm = waypointRemoveResult(r) ?? waypointRemoveResult(flatten(block.content));
    if (rm) return rm;
    return { verb: 'exec', stdout: block.is_error ? '' : flatten(block.content), stderr: block.is_error ? flatten(block.content) : '' };
  }
  if (isWaypointTool(tool)) {
    const wp = waypointResult(r) ?? waypointResult(flatten(block.content));
    if (wp) return wp;
    return { verb: 'exec', stdout: block.is_error ? '' : flatten(block.content), stderr: block.is_error ? flatten(block.content) : '' };
  }
  // search tools render as terminal commands; their readable output is the block text
  if (tool === 'Grep' || tool === 'Glob') {
    return { verb: 'exec', stdout: flatten(block.content), stderr: '' };
  }
  if (r == null) return { verb: 'other' };
  switch (tool) {
    case 'Read':
      if (r.file?.content !== undefined) {
        const start = r.file.startLine ?? 1;
        return {
          verb: 'read_file', path: r.file.filePath, content: r.file.content,
          start_line: start, total_lines: r.file.totalLines,
          region: { start, end: start + (r.file.numLines ?? 1) - 1 },
        };
      }
      if (r.type === 'image' && r.file?.base64) {
        return { verb: 'read_file', image_src: `data:${r.file.type ?? 'image/png'};base64,${r.file.base64}` };
      }
      return { verb: 'other' };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      if (r.structuredPatch) {
        const out = { verb: 'patch_file', path: r.filePath, hunks: r.structuredPatch };
        // with the pre-edit file we can reconstruct the post-edit state and
        // show the full file with the changed region; hunks stay as fallback
        if (typeof r.originalFile === 'string' && r.structuredPatch.length) {
          out.content = applyPatch(r.originalFile, r.structuredPatch);
          out.region = patchRegion(r.structuredPatch);
        }
        return out;
      }
      return { verb: 'other' };
    case 'Write': {
      if (!r.filePath) return { verb: 'other' };
      const content = r.content ?? '';
      return { verb: 'write_file', path: r.filePath, content, region: { start: 1, end: content.split('\n').length } };
    }
    case 'Bash':
    case 'PowerShell': {
      let { stdout, stderr } = r;
      if (stdout === undefined && stderr === undefined) {
        // older shape: result text only lives in the content block
        if (block.is_error) stderr = flatten(block.content);
        else stdout = flatten(block.content);
      }
      return { verb: 'exec', stdout: stdout ?? '', stderr: stderr ?? '', interrupted: !!r.interrupted };
    }
    case 'Agent':
    case 'Task':
      if (r.agentId) {
        return {
          verb: 'spawn_agent', agent_id: r.agentId, agent_type: r.agentType, status: r.status,
          summary: truncate(flatten(r.content), 2000),
          child_session_id: rel(path.join(ctx.sessionDir, 'subagents', `agent-${r.agentId}.jsonl`)),
        };
      }
      return { verb: 'other' };
    default:
      return { verb: 'other' };
  }
}

// Rebuild the post-edit file from the pre-edit content plus unified-diff hunks.
function applyPatch(original, hunks) {
  const old = original.split('\n');
  const out = [];
  let oi = 0;
  for (const h of hunks) {
    while (oi < h.oldStart - 1 && oi < old.length) out.push(old[oi++]);
    for (const l of h.lines) {
      if (l.startsWith('\\')) continue; // "\ No newline at end of file"
      if (l.startsWith('+')) out.push(l.slice(1));
      else if (l.startsWith('-')) oi++;
      else { out.push(old[oi] ?? l.slice(1)); oi++; }
    }
  }
  while (oi < old.length) out.push(old[oi++]);
  return out.join('\n');
}

function patchRegion(hunks) {
  const last = hunks[hunks.length - 1];
  return { start: hunks[0].newStart, end: last.newStart + Math.max(last.newLines, 1) - 1 };
}

function summarizeParams(tool, input) {
  for (const k of ['pattern', 'query', 'path', 'file_path', 'url', 'description', 'prompt']) {
    if (typeof input?.[k] === 'string') return `${truncate(input[k], 60)}`;
  }
  return tool;
}

const shortPath = (p) => (p ? String(p).split(/[\\/]/).slice(-2).join('/') : '');
const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : (s ?? ''));
