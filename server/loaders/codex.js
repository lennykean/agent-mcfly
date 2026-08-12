// Codex session loader: reads ~/.codex/sessions rollout JSONL and converts to
// the same normalized messages + render verbs as the claude-code loader.
// Minimal-but-real mapping: chat, reasoning summaries as thinking, exec-style
// tools into the terminal, apply_patch as a diff; everything else is log-only.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isTableTool, tableCall, tableResult } from '../mcfly-data.js';

const ROOT = path.join(os.homedir(), '.codex', 'sessions');
const INDEX = path.join(os.homedir(), '.codex', 'session_index.jsonl');
const MAX_CHUNK = 2 * 1024 * 1024;

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function resolveId(id) {
  const p = path.resolve(ROOT, id);
  if (!p.startsWith(ROOT + path.sep)) throw new Error('session id outside root');
  return p;
}

const norm = (p) => (p ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

// file -> { mtime, meta } head-scan cache (cwd lives in the first line)
const headCache = new Map();

function headMeta(file, st) {
  const hit = headCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.meta;
  const meta = { id: undefined, cwd: undefined, label: undefined, nickname: undefined };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      if (meta.cwd && meta.label) break;
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'session_meta') {
        meta.id = o.payload?.id ?? o.payload?.session_id;
        meta.cwd = o.payload?.cwd;
        meta.nickname = o.payload?.source?.subagent?.thread_spawn?.agent_nickname;
      } else if (!meta.label && o.type === 'response_item' && o.payload?.type === 'message' && o.payload.role === 'user') {
        // skip injected context blobs (<environment_context>, AGENTS.md dumps)
        const text = (o.payload.content ?? [])
          .filter((c) => c.type === 'input_text' && c.text)
          .map((c) => c.text.trim())
          .find((t) => t.length && !t.startsWith('<') && !t.startsWith('#'));
        if (text) meta.label = text.slice(0, 60);
      }
    }
  } catch { /* unreadable */ } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  headCache.set(file, { mtime: st.mtimeMs, meta });
  return meta;
}

export function parseThreadNames(text) {
  const names = new Map();
  for (const line of text.split('\n')) {
    try {
      const { id, thread_name: name } = JSON.parse(line);
      if (id && name) names.set(id, name);
    } catch { /* incomplete index line */ }
  }
  return names;
}

function* rolloutFiles(dir = ROOT) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* rolloutFiles(full);
    else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) yield full;
  }
}

export function listForCwd(cwd) {
  const want = norm(cwd);
  let names = new Map();
  try { names = parseThreadNames(fs.readFileSync(INDEX, 'utf8')); } catch { /* index is optional */ }
  const out = [];
  for (const file of rolloutFiles()) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    const meta = headMeta(file, st);
    if (norm(meta.cwd) !== want) continue;
    const base = path.basename(file, '.jsonl').replace(/^rollout-/, '');
    out.push({
      id: rel(file),
      provider: 'codex',
      label: names.get(meta.id) ?? meta.label ?? (meta.nickname ? `agent ${meta.nickname}` : base.slice(0, 19)),
      cwd: meta.cwd,
      updated_at: st.mtimeMs,
      size: st.size,
    });
  }
  out.sort((a, b) => b.updated_at - a.updated_at);
  return out;
}

// call_id -> render metadata (one entry per file for multi-file patches)
const callMeta = new Map();

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
        want = Math.min(want * 2, st.size - cursor);
      }
    } finally {
      fs.closeSync(fd);
    }
    const end = buf.lastIndexOf(10);
    if (end >= 0) {
      offset = cursor + end + 1;
      for (const line of buf.toString('utf8', 0, end).split('\n')) {
        if (line.trim()) convertLine(line, messages);
      }
    }
  }
  return { messages, cursor: offset, mtime: st.mtimeMs, size: st.size };
}

const texts = (content) => (Array.isArray(content) ? content : [])
  .filter((c) => (c.type === 'input_text' || c.type === 'output_text') && c.text)
  .map((c) => c.text)
  .join('\n');

function convertLine(line, messages) {
  let o;
  try { o = JSON.parse(line); } catch { return; }
  if (o.type !== 'response_item' || !o.payload) return;
  const p = o.payload;
  const timestamp = o.timestamp ? Date.parse(o.timestamp) : undefined;
  const push = (role, content) => messages.push({ timestamp, role, content });

  switch (p.type) {
    case 'message': {
      if (p.role !== 'user' && p.role !== 'assistant') return; // developer/system = injected context
      const t = (p.content ?? [])
        .filter((c) => (c.type === 'input_text' || c.type === 'output_text') && c.text && !c.text.startsWith('<'))
        .map((c) => c.text)
        .join('\n');
      if (t.trim()) push(p.role, [{ type: 'text', text: t }]);
      return;
    }
    case 'agent_message': {
      const t = texts(p.content);
      if (t.trim()) push('assistant', [{ type: 'text', text: `[${p.author} → ${p.recipient}]\n${t}` }]);
      return;
    }
    case 'reasoning': {
      const t = (p.summary ?? []).map((s) => s.text ?? '').join('\n');
      if (t.trim()) push('assistant', [{ type: 'thinking', thought: t }]);
      return;
    }
    case 'custom_tool_call':
    case 'function_call': {
      const input = p.input ?? p.arguments ?? '';
      const entries = callEntries(p.name, input);
      const metas = entries.map((entry, index) => ({
        ...entry,
        tool: toolLabel(entry.name, entry.input, entry.render),
        requestId: entries.length === 1 ? p.call_id : `${p.call_id}:${index}`,
      }));
      callMeta.set(p.call_id, metas);
      push('assistant', metas.map((meta) => ({
        type: 'tool',
        tool_request_id: meta.requestId,
        tool: meta.tool,
        params: { input: meta.input },
        extended: { render: meta.render },
      })));
      return;
    }
    case 'custom_tool_call_output':
    case 'function_call_output': {
      const metas = callMeta.get(p.call_id) ?? [];
      const text = typeof p.output === 'string' ? p.output : texts(p.output);
      const count = metas.reduce((max, meta) => Math.max(max, meta.resultIndex), -1) + 1;
      const results = splitNumberedResults(text, count)
        ?? Array.from({ length: count }, (_, index) => index === 0 ? text : '');
      push('user', metas.map((meta) => ({
        type: 'tool_result',
        tool_request_id: meta.requestId,
        tool: meta.tool ?? meta.name ?? '?',
        result: results[meta.resultIndex] ?? '',
        extended: { render: resultRender(meta, results[meta.resultIndex] ?? '', p.output) },
      })));
      return;
    }
    default:
  }
}

const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : (s ?? ''));

const JS_LITERALS = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g;
const executableCode = (input) => String(input).replace(JS_LITERALS, (s) => ' '.repeat(s.length));

function decodeJsString(literal) {
  if (literal[0] === '"') {
    try { return JSON.parse(literal); } catch { /* use the small decoder below */ }
  }
  const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
  return literal.slice(1, -1).replace(/\\([\s\S])/g, (_, c) => escapes[c] ?? c);
}

function stringProperty(input, key) {
  const source = String(input);
  try {
    const value = JSON.parse(source)?.[key];
    if (typeof value === 'string') return value;
  } catch { /* JavaScript wrapper, not JSON */ }
  const match = new RegExp(`\\b${key}\\s*:`).exec(executableCode(source));
  if (!match) return undefined;
  let start = match.index + match[0].length;
  while (/\s/.test(source[start])) start++;
  const quote = source[start];
  if (!['"', "'", '`'].includes(quote)) return undefined;
  let end = start + 1;
  while (end < source.length && source[end] !== quote) {
    if (source[end] === '\\') end++;
    end++;
  }
  return end < source.length ? decodeJsString(source.slice(start, end + 1)) : undefined;
}

// codex exec harness input is JS or JSON; dig out the actual command line
function commandOf(input) {
  const s = String(input);
  try {
    const j = JSON.parse(s);
    if (Array.isArray(j.command)) return j.command.join(' ');
    if (typeof j.command === 'string') return j.command;
    if (typeof j.cmd === 'string') return j.cmd;
  } catch { /* not plain JSON */ }
  return stringProperty(s, 'command') ?? stringProperty(s, 'cmd') ?? s;
}

function isCommandJson(input) {
  try {
    const value = JSON.parse(String(input));
    return Array.isArray(value.command) || typeof value.command === 'string' || typeof value.cmd === 'string';
  } catch { return false; }
}

const EXEC_NAMES = new Set(['exec', 'shell', 'exec_command', 'local_shell', 'container.exec']);
const DIRECT_SHELL_NAMES = new Set(['shell', 'shell_command', 'exec_command', 'local_shell', 'container.exec']);

function nestedToolCalls(input) {
  const source = String(input);
  const code = executableCode(source);
  const calls = [];
  for (const match of code.matchAll(/\btools\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    for (; end < code.length && depth; end++) {
      if (code[end] === '(') depth++;
      else if (code[end] === ')') depth--;
    }
    if (!depth) calls.push({ name: match[1], input: source.slice(start, end - 1).trim() });
  }
  return calls;
}

const nestedToolNames = (input) => nestedToolCalls(input).map((call) => call.name);

export function toolLabel(name, input, render) {
  if (render?.verb === 'read_file' && DIRECT_SHELL_NAMES.has(name)) return 'read_file';
  if (!EXEC_NAMES.has(name)) return name;
  const counts = new Map();
  // ponytail: mask literals/comments; use a JS parser if wrappers start generating regex-literal tool text.
  for (const tool of nestedToolNames(input)) {
    counts.set(tool, (counts.get(tool) ?? 0) + 1);
  }
  return [...counts].map(([tool, count]) => count > 1 ? `${tool} ×${count}` : tool).join(' + ') || name;
}

function fileReadRender(command, input) {
  const getContent = command.match(/^\s*Get-Content\b(?=[^|;&\r\n]*$).*?\s-(?:Literal)?Path\s+("[^"]+"|'[^']+')\s*$/i);
  const positional = command.match(/^\s*Get-Content\s+(?:-Raw\s+)?("[^"]+"|'[^']+'|[^\s|;&]+)\s*$/i);
  const cat = command.match(/^\s*cat\s+(?:--\s+)?("[^"]+"|'[^']+'|[^\s|;&]+)\s*$/);
  const raw = getContent?.[1] ?? positional?.[1] ?? cat?.[1];
  if (!raw) return null;
  const file = /^['"]/.test(raw) ? raw.slice(1, -1) : raw;
  const cwd = stringProperty(input, 'workdir');
  return readRender(file, cwd);
}

function imageReadRender(input) {
  const file = stringProperty(input, 'path');
  if (!file) return null;
  return readRender(file, stringProperty(input, 'workdir'));
}

function readRender(file, cwd) {
  const windows = path.win32.isAbsolute(file) || (cwd && path.win32.isAbsolute(cwd));
  const paths = windows ? path.win32 : path.posix;
  const resolved = cwd && !path.win32.isAbsolute(file) && !path.posix.isAbsolute(file)
    ? paths.resolve(cwd, file)
    : file;
  return { verb: 'read_file', path: resolved, title: paths.basename(resolved) };
}

export function callRender(name, input) {
  return callRenders(name, input)[0];
}

function directRenders(name, input, source = input) {
  if (isTableTool(name)) return [tableCall(input)];
  if (DIRECT_SHELL_NAMES.has(name) || (name === 'exec' && isCommandJson(input))) {
    const command = commandOf(input);
    const read = !command.includes('${') && fileReadRender(command, input);
    if (read) return [read];
    return [{ verb: 'exec', command, title: truncate(command, 60) }];
  }
  if (name === 'apply_patch') {
    const patches = patchRenders(String(source));
    return patches.length ? patches : [{ verb: 'other', title: 'apply_patch' }];
  }
  if (name === 'view_image') {
    return [imageReadRender(input) ?? { verb: 'other', title: 'view_image' }];
  }
  return [{ verb: 'other', title: `${name} ${truncate(String(input), 40)}` }];
}

function callEntries(name, input) {
  const nested = name === 'exec' ? nestedToolCalls(input) : [];
  if (!nested.length) {
    return directRenders(name, input).map((render) => ({ name, input, render, resultIndex: 0 }));
  }
  return nested.flatMap((call, resultIndex) => directRenders(call.name, call.input, input)
    .map((render) => ({ ...call, render, resultIndex })));
}

export function callRenders(name, input) {
  return callEntries(name, input).map((entry) => entry.render);
}

export function splitNumberedResults(text, count) {
  if (count < 2) return [text];
  const source = String(text);
  const markers = [...source.matchAll(/^---([1-9]\d*)---\r?$/gm)];
  if (markers.length !== count || markers.some((marker, index) => Number(marker[1]) !== index + 1)) return null;
  return markers.map((marker, index) => source
    .slice(marker.index + marker[0].length, markers[index + 1]?.index ?? source.length)
    .replace(/^\r?\n/, '')
    .replace(/\r?\n$/, ''));
}

function execPayload(text) {
  const marker = '\nOutput:\n';
  const first = text.indexOf(marker);
  const second = first < 0 ? -1 : text.indexOf(marker, first + marker.length);
  const start = second < 0 ? first : second;
  return start < 0 ? text : text.slice(start + marker.length);
}

export function resultRender(meta, text, output) {
  if (!meta) return { verb: 'other' };
  if (meta.render?.verb === 'data') {
    return tableResult(output) ?? tableResult(text) ?? { verb: 'exec', stdout: execPayload(text), stderr: '' };
  }
  // Edits render from the result side so the timeline applies them only after completion.
  if (meta.name === 'apply_patch' || nestedToolNames(meta.input).includes('apply_patch')) {
    return meta.render;
  }
  if (meta.render?.verb === 'read_file') {
    const image = (meta.name === 'view_image' || nestedToolNames(meta.input).includes('view_image')) && Array.isArray(output)
      && output.find((item) => item.type === 'input_image' && item.image_url);
    if (image) return { ...meta.render, image_src: image.image_url };
    const content = execPayload(text);
    // a failed command's output is NOT file content: ANSI styling means a
    // colored error, and a harness call without its Output marker never ran.
    // Treating either as a read poisons file-state chains with garbage.
    // eslint-disable-next-line no-control-regex
    const ansi = /\x1b\[/.test(content);
    const harnessNoMarker = !DIRECT_SHELL_NAMES.has(meta.name) && !text.includes('\nOutput:\n');
    if (ansi || harnessNoMarker) return { verb: 'exec', stdout: content, stderr: '' };
    const lines = content.split('\n').length;
    return { ...meta.render, content, start_line: 1, total_lines: lines, region: { start: 1, end: lines } };
  }
  if (meta.render?.verb === 'exec') return { verb: 'exec', stdout: execPayload(text), stderr: '' };
  return { verb: 'other' };
}

// codex patch envelope -> pseudo-hunks the diff view can draw (+/-/context)
export function patchRender(input) {
  return patchRenders(input)[0] ?? null;
}

export function patchRenders(input) {
  let source = String(input);
  if (source.includes('*** Begin Patch\\n')) {
    for (const match of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/g)) {
      if (match[0].includes('*** Begin Patch')) { source = decodeJsString(match[0]); break; }
    }
  }
  const start = source.indexOf('*** Begin Patch');
  if (start < 0) return [];
  const end = source.lastIndexOf('*** End Patch');
  const body = source.slice(start, end < 0 ? undefined : end + 13);
  const lines = body.split('\n').slice(1, -1);
  const files = lines.map((line, index) => ({ line, index, match: line.match(/^\*\*\* (Update|Add|Delete) File:\s*(.*)$/) })).filter((f) => f.match);
  return files.map((file, index) => {
    const kind = file.match[1];
    const section = lines.slice(file.index + 1, files[index + 1]?.index ?? lines.length);
    const moved = section[0]?.match(/^\*\*\* Move to:\s*(.*)$/);
    const filePath = (moved?.[1] ?? file.match[2]).trim();
    const patchLines = moved ? section.slice(1) : section;
    if (kind === 'Add') {
      const content = patchLines.filter((line) => line.startsWith('+')).map((line) => line.slice(1)).join('\n');
      const count = content.split('\n').length;
      return { verb: 'write_file', path: filePath, title: path.basename(filePath), content, region: { start: 1, end: count } };
    }
    const groups = [];
    for (const line of patchLines) {
      if (line.startsWith('@@')) groups.push([]);
      else {
        if (!groups.length) groups.push([]);
        groups.at(-1).push(line);
      }
    }
    return {
      verb: 'patch_file', path: filePath, title: path.basename(filePath),
      hunks: groups.filter((group) => group.length).map((group) => ({
        oldStart: 1, oldLines: group.filter((line) => !line.startsWith('+')).length,
        newStart: 1, newLines: group.filter((line) => !line.startsWith('-')).length,
        lines: group,
      })),
    };
  });
}
