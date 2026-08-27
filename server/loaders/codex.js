// Codex session loader: reads ~/.codex/sessions rollout JSONL and converts to
// the same normalized messages + render verbs as the claude-code loader.
// Minimal-but-real mapping: chat, reasoning summaries as thinking, exec-style
// tools into the terminal, apply_patch as a diff; everything else is log-only.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { dataEnvelope, highlightCall, highlightResult, isHighlightTool, isPeerMessageTool, isSpawnAgentTool, isTableTool, isWaypointRemoveTool, isWaypointTool, peerMessageCall, peerMessageResult, spawnAgentCall, spawnAgentResult, tableCall, tableResult, waypointCall, waypointRemoveCall, waypointRemoveResult, waypointResult } from '../mcfly-data.js';
import { idsFor, MAX_CHUNK, memoByStamp, readTail, truncate } from './transcript.js';

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const ROOT = path.join(CODEX_HOME, 'sessions');
const INDEX = path.join(CODEX_HOME, 'session_index.jsonl');

const { rel, resolveId, tip } = idsFor(ROOT);
export { tip };

export const projectPathKey = (p) => {
  const source = p ?? '';
  return /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(source)
    ? source.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    : source.replace(/\/+$/, '');
};
const norm = projectPathKey;

// file -> meta head-scan cache (cwd lives in the first line), valid until the
// file changes
const headOf = memoByStamp();

// ---- codex teams: matching a spawn_agent call to the sub-agent's thread ----
const jsonField = (raw, key) => {
  try {
    const v = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw))?.[key];
    return typeof v === 'string' ? v : undefined;
  } catch { return undefined; }
};
// "/root/credential_hardening_review" reads as its leaf in the tree
const agentLabel = (task) => (task ? String(task).split('/').filter(Boolean).pop() : 'agent');

// agent_path -> thread, resolved by scanning rollout heads for the same team
// root. A child's file lands a beat AFTER its call, so a miss must be re-tried
// — but the scan walks every rollout on disk, so a session full of spawns whose
// children are gone would redo that walk per call. Misses are remembered for
// MISS_TTL_MS: long enough to stop the storm, short enough that a child landing
// a beat later still gets linked.
const MISS_TTL_MS = 10_000;
const missedAt = new Map();
const childByPath = new Map(); // `${rootId}\u0000${agentPath}` -> { id, nickname }
function childThread(file, agentPath) {
  if (!file) return null;
  let rootId;
  try { rootId = headMeta(file, fs.statSync(file)).rootId; } catch { return null; }
  if (!rootId) return null;
  const key = `${rootId}\u0000${agentPath}`;
  const hit = childByPath.get(key);
  if (hit) return hit;
  if (Date.now() - (missedAt.get(key) ?? -Infinity) < MISS_TTL_MS) return null;
  for (const candidate of rolloutFiles()) {
    let meta;
    try { meta = headMeta(candidate, fs.statSync(candidate)); } catch { continue; }
    if (!meta.subagent || meta.rootId !== rootId || !meta.agentPath) continue;
    const found = { id: rel(candidate), nickname: meta.nickname };
    childByPath.set(`${rootId}\u0000${meta.agentPath}`, found);
  }
  const found = childByPath.get(key) ?? null;
  if (!found) missedAt.set(key, Date.now());
  return found;
}

function headMeta(file, st) {
  return headOf(file, st.mtimeMs, () => {
    let fd;
    let text = '';
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      text = buf.toString('utf8', 0, n);
    } catch { /* unreadable */ } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    return parseHead(text);
  });
}

// Shared by local files and remote SFTP reads; transcript semantics stay here.
export function parseHead(text) {
  const meta = {
    id: undefined, cwd: undefined, label: undefined, nickname: undefined,
    // multi-agent teams (codex "collaboration"): a sub-agent thread names its
    // parent, the root of the team, and its own agent path — the same string
    // spawn_agent hands back as task_name
    subagent: false, parentId: undefined, rootId: undefined, agentPath: undefined,
  };
  for (const line of text.split('\n')) {
    if (meta.cwd && meta.label) break;
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'session_meta' && !meta.id) {
      meta.id = o.payload?.id ?? o.payload?.session_id;
      meta.cwd = o.payload?.cwd;
      const spawn = o.payload?.source?.subagent?.thread_spawn;
      meta.nickname = o.payload?.agent_nickname ?? spawn?.agent_nickname;
      meta.subagent = o.payload?.thread_source === 'subagent' || !!o.payload?.source?.subagent;
      meta.parentId = o.payload?.parent_thread_id ?? spawn?.parent_thread_id;
      meta.rootId = o.payload?.session_id;
      meta.agentPath = o.payload?.agent_path ?? spawn?.agent_path;
    } else if (!meta.label && o.type === 'response_item' && o.payload?.type === 'message' && o.payload.role === 'user') {
      // skip injected context blobs (<environment_context>, AGENTS.md dumps)
      const label = (o.payload.content ?? [])
        .filter((c) => c.type === 'input_text' && c.text)
        .map((c) => c.text.trim())
        .find((t) => t.length && !t.startsWith('<') && !t.startsWith('#'));
      if (label) meta.label = label.slice(0, 60);
    }
  }
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
    // sub-agent threads belong to their parent's tree, not the session list
    if (meta.subagent) continue;
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

const SESSION_START_SOURCES = new Set(['startup', 'resume', 'clear', 'compact']);
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']);
const hookText = (value, max) => typeof value === 'string' && value.length > 0
  && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const hookSession = (file, root, meta, st, cwd) => ({
  id: path.relative(root, file).split(path.sep).join('/'), provider: 'codex', cwd,
  label: meta.label ?? path.basename(file, '.jsonl').replace(/^rollout-/, '').slice(0, 19),
  updated_at: st.mtimeMs, size: st.size,
});
const hookMetaMatches = (meta, input, want) => !meta.subagent
  && meta.id === input.session_id
  && hookText(meta.cwd, 32 * 1024) && path.isAbsolute(meta.cwd)
  && norm(meta.cwd) === want;

const validHookBase = (input) => input && typeof input === 'object' && !Array.isArray(input)
  && hookText(input.session_id, 512)
  && hookText(input.cwd, 32 * 1024) && path.isAbsolute(input.cwd)
  && (input.transcript_path == null
    || (hookText(input.transcript_path, 32 * 1024) && path.isAbsolute(input.transcript_path)));

// Resolve a validated Codex lifecycle identity to the rollout McFly reads.
// transcript_path is nullable. When present it selects that exact rollout;
// when absent, the newest rollout for the exact id and cwd is selected.
function sessionForHook(input, root) {
  const want = norm(input.cwd);
  if (input.transcript_path) {
    try {
      const realRoot = fs.realpathSync(root);
      const file = fs.realpathSync(input.transcript_path);
      const relative = path.relative(realRoot, file);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
        || !path.basename(file).startsWith('rollout-') || !file.endsWith('.jsonl')) return null;
      const st = fs.statSync(file);
      const meta = headMeta(file, st);
      return hookMetaMatches(meta, input, want)
        ? hookSession(file, realRoot, meta, st, meta.cwd) : null;
    } catch { return null; }
  }

  let found = null;
  for (const file of rolloutFiles(root)) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    const meta = headMeta(file, st);
    if (!hookMetaMatches(meta, input, want)) continue;
    const candidate = hookSession(file, root, meta, st, meta.cwd);
    if (!found || candidate.updated_at > found.updated_at) found = candidate;
  }
  return found;
}

export function sessionForSessionStart(input, root = ROOT) {
  if (!validHookBase(input) || input.hook_event_name !== 'SessionStart'
    || !SESSION_START_SOURCES.has(input.source)
    || !hookText(input.model, 512)
    || !PERMISSION_MODES.has(input.permission_mode)) return null;
  return sessionForHook(input, root);
}

export function sessionForSessionEnd(input, root = ROOT) {
  if (!validHookBase(input) || input.hook_event_name !== 'SessionEnd' || input.reason !== 'other'
    || (input.model !== undefined && !hookText(input.model, 512))) return null;
  return sessionForHook(input, root);
}

// Interactive Codex has no caller-assigned session id. Its first prompt gets
// an unguessable launch marker, so a concurrent manual launch cannot match.
export function findByLaunchMarker(cwd, marker, startedAt = 0, root = ROOT) {
  const want = norm(cwd);
  const out = [];
  for (const file of rolloutFiles(root)) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (st.mtimeMs < startedAt - 1000) continue;
    try { if (!fs.readFileSync(file, 'utf8').includes(marker)) continue; } catch { continue; }
    const meta = headMeta(file, st);
    if (meta.subagent || norm(meta.cwd) !== want) continue;
    out.push({
      id: path.relative(root, file).split(path.sep).join('/'), provider: 'codex',
      label: meta.label ?? path.basename(file, '.jsonl').replace(/^rollout-/, '').slice(0, 19),
      cwd: meta.cwd, updated_at: st.mtimeMs, size: st.size,
    });
  }
  return out;
}

// transcript + call_id -> render metadata (one entry per file for multi-file patches)
const callMeta = new Map();
const completedCallMeta = new Map();
const callKey = (file, id) => `${file}\0${id}`;

export function tail(id, cursor = 0) {
  return tailFile(resolveId(id), cursor);
}

export function tailFile(file, cursor = 0) {
  const { st, buf } = readTail(file, cursor);
  return parseTailChunk(file, cursor, st, buf);
}

export function parseTailChunk(fileKey, cursor, st, buf) {
  const messages = [];
  let offset = cursor;
  const end = buf.lastIndexOf(10);
  if (end >= 0) {
    offset = cursor + end + 1;
    for (const line of buf.toString('utf8', 0, end).split('\n')) {
      if (line.trim()) convertLine(line, messages, fileKey, cursor);
    }
  }
  return { messages, cursor: offset, mtime: st.mtimeMs, size: st.size };
}

const texts = (content) => (Array.isArray(content) ? content : [])
  .filter((c) => (c.type === 'input_text' || c.type === 'output_text') && c.text)
  .map((c) => c.text)
  .join('\n');

function metasForCall(p) {
  const input = p.input ?? p.arguments ?? '';
  const entries = callEntries(p.name, input);
  return entries.map((entry, index) => ({
    ...entry,
    tool: toolLabel(entry.name, entry.input, entry.render),
    requestId: entries.length === 1 ? p.call_id : `${p.call_id}:${index}`,
  }));
}

// A result whose call was converted by an earlier process (or an earlier
// request) has no meta in memory. Recovering it means re-reading the transcript
// prefix — so the pass harvests EVERY call it passes, not just the one asked
// for, and the file's scanned-through mark stops the next miss from repeating
// it. One prefix read per file instead of one per orphaned result.
const recoveredThrough = new Map();
function recoverCallMeta(file, callId, before) {
  if (!before || (recoveredThrough.get(file) ?? 0) >= before) return [];
  const harvest = (line) => {
    try {
      const o = JSON.parse(line);
      const p = o.type === 'response_item' ? o.payload : undefined;
      if (p?.type !== 'custom_tool_call' && p?.type !== 'function_call') return;
      const metas = metasForCall(p);
      for (const meta of metas) meta.file = file;
      callMeta.set(callKey(file, p.call_id), metas);
    } catch { /* unrelated or incomplete line */ }
  };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const decoder = new StringDecoder('utf8');
    let carry = '';
    for (let offset = 0; offset < before;) {
      const buf = Buffer.alloc(Math.min(MAX_CHUNK, before - offset));
      const read = fs.readSync(fd, buf, 0, buf.length, offset);
      if (!read) break;
      offset += read;
      const lines = (carry + decoder.write(buf.subarray(0, read))).split('\n');
      carry = lines.pop() ?? '';
      for (const candidate of lines) harvest(candidate);
    }
    carry += decoder.end();
    if (carry) harvest(carry);
    recoveredThrough.set(file, before);
  } catch { /* recovery is best-effort; the result remains visible below */ } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return callMeta.get(callKey(file, callId)) ?? [];
}

function convertLine(line, messages, file, recoveryEnd) {
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
      const metas = metasForCall(p);
      for (const meta of metas) meta.file = file; // spawn results resolve their child thread from here
      callMeta.set(callKey(file, p.call_id), metas);
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
      const text = typeof p.output === 'string' ? p.output : texts(p.output);
      const key = callKey(file, p.call_id);
      const metas = callMeta.get(key) ?? completedCallMeta.get(key) ?? recoverCallMeta(file, p.call_id, recoveryEnd);
      if (!metas.length) {
        push('user', [{
          type: 'tool_result',
          tool_request_id: p.call_id,
          tool: 'unmatched result',
          result: text,
          extended: { render: { verb: 'exec', stdout: '', stderr: text }, is_error: true },
        }]);
        return;
      }
      const count = metas.reduce((max, meta) => Math.max(max, meta.resultIndex), -1) + 1;
      const envelope = dataEnvelope(text);
      const fallbackMeta = envelope?.kind === 'agent_spawn'
        ? metas.find((meta) => isSpawnAgentTool(meta.name))
        : envelope?.kind === 'peer_message'
          ? metas.find((meta) => isPeerMessageTool(meta.name))
          : undefined;
      const fallbackIndex = fallbackMeta?.resultIndex ?? 0;
      const results = splitNumberedResults(text, count)
        ?? Array.from({ length: count }, (_, index) => index === fallbackIndex ? text : '');
      push('user', metas.map((meta) => {
        const result = results[meta.resultIndex] ?? '';
        const failed = isPatchCall(meta) && patchResultFailed(result, p.output);
        return {
          type: 'tool_result',
          tool_request_id: meta.requestId,
          tool: meta.tool ?? meta.name ?? '?',
          result,
          extended: {
            render: resultRender(meta, result, p.output),
            ...(failed ? { is_error: true } : {}),
          },
        };
      }));
      callMeta.delete(key);
      completedCallMeta.delete(key);
      completedCallMeta.set(key, metas);
      if (completedCallMeta.size > 5000) completedCallMeta.delete(completedCallMeta.keys().next().value);
      return;
    }
    default:
  }
}

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
// Masking literals and brace-scanning the whole input is not cheap, and every
// result asks about the same meta three or four times. Answer once per meta.
const nestedNamesOf = (meta) => (meta.names ??= nestedToolNames(meta.input));

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
  if (isSpawnAgentTool(name)) {
    const render = spawnAgentCall(input);
    const prompt = stringProperty(input, 'prompt')?.trim();
    return [{
      ...render,
      agent_type: stringProperty(input, 'harness') ?? render.agent_type,
      launch_kind: stringProperty(input, 'kind') ?? render.launch_kind,
      title: prompt ? truncate(prompt, 80) : render.title,
    }];
  }
  if (isPeerMessageTool(name)) return [peerMessageCall(input)];
  if (isTableTool(name)) return [tableCall(input)];
  if (isHighlightTool(name)) return [highlightCall(input)];
  if (isWaypointRemoveTool(name)) return [waypointRemoveCall(input)];
  if (isWaypointTool(name)) return [waypointCall(input)];
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
  // codex teams: spawn_agent starts a sub-agent thread. The task message is
  // encrypted, so the task NAME is what we can show.
  if (name === 'spawn_agent') {
    const task = jsonField(input, 'task_name');
    return [{ verb: 'spawn_agent', agent_type: 'agent', title: task ?? 'agent' }];
  }
  return [{ verb: 'other', title: `${name} ${truncate(String(input), 40)}` }];
}

function callEntries(name, input) {
  const nested = name === 'exec' ? nestedToolCalls(input) : [];
  if (!nested.length) {
    return directRenders(name, input).map((render) => ({ name, input, render, resultIndex: 0 }));
  }
  return nested.flatMap((call, resultIndex) => directRenders(call.name, call.input, input)
    .map((render) => ({ ...call, render, resultIndex, nested: true })));
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

function isPatchCall(meta) {
  return meta.name === 'apply_patch' || nestedNamesOf(meta).includes('apply_patch');
}

function structuredFailure(value) {
  if (typeof value === 'string') {
    const source = value.trim();
    if (source.startsWith('{') || source.startsWith('[')) {
      try { return structuredFailure(JSON.parse(source)); } catch { return false; }
    }
    return false;
  }
  if (Array.isArray(value)) return value.some(structuredFailure);
  if (!value || typeof value !== 'object') return false;
  if (value.success === false || value.is_error === true || value.isError === true) return true;
  const code = value.exit_code ?? value.exitCode ?? value.metadata?.exit_code ?? value.metadata?.exitCode;
  return typeof code === 'number' && code !== 0;
}

function patchResultFailed(text, output) {
  return structuredFailure(output)
    || /\bapply_patch verification failed\b|(?:^|\n)(?:Patch failed\b|Invalid patch\b|Script failed\b|Script error:|Exit code:\s*[1-9]\d*)/i.test(text);
}

export function resultRender(meta, text, output) {
  if (!meta) return { verb: 'other' };
  if (isSpawnAgentTool(meta.name)) {
    return spawnAgentResult(output) ?? spawnAgentResult(text) ?? { verb: 'exec', stdout: execPayload(text), stderr: '' };
  }
  if (meta.render?.verb === 'spawn_agent') {
    // the output names the agent (/root/task_name); its thread is a rollout
    // of its own, findable by that path under the same team root
    const task = jsonField(text, 'task_name') ?? meta.render.title;
    const child = task ? childThread(meta.file, task) : null;
    return {
      verb: 'spawn_agent',
      agent_id: task,
      agent_type: child?.nickname ?? 'agent',
      title: agentLabel(task),
      status: 'running',
      ...(child ? { child_session_id: child.id } : {}),
    };
  }
  if (meta.render?.verb === 'data') {
    return tableResult(output) ?? tableResult(text) ?? { verb: 'exec', stdout: execPayload(text), stderr: '' };
  }
  if (meta.render?.verb === 'peer_message') {
    return peerMessageResult(output) ?? peerMessageResult(text) ?? { verb: 'exec', stdout: execPayload(text), stderr: '' };
  }
  if (isHighlightTool(meta.name)) {
    return highlightResult(output) ?? highlightResult(text) ?? { verb: 'exec', stdout: execPayload(text), stderr: '' };
  }
  if (isWaypointRemoveTool(meta.name)) {
    return waypointRemoveResult(output) ?? waypointRemoveResult(text) ?? { verb: 'exec', stdout: execPayload(text), stderr: '' };
  }
  if (isWaypointTool(meta.name)) {
    return waypointResult(output) ?? waypointResult(text) ?? { verb: 'exec', stdout: execPayload(text), stderr: '' };
  }
  // Edits render from the result side so the timeline applies them only after completion.
  if (isPatchCall(meta)) {
    return patchResultFailed(text, output)
      ? { verb: 'exec', stdout: '', stderr: execPayload(text) }
      : meta.render;
  }
  if (meta.render?.verb === 'read_file') {
    const image = (meta.name === 'view_image' || nestedNamesOf(meta).includes('view_image')) && Array.isArray(output)
      && output.find((item) => item.type === 'input_image' && item.image_url);
    if (image) return { ...meta.render, image_src: image.image_url };
    const content = execPayload(text);
    // a failed command's output is NOT file content: ANSI styling means a
    // colored error, a harness call without its Output marker never ran, and
    // a harness header saying so (Script failed / nonzero Exit code) means the
    // payload is an error message. Treating any as a read poisons file-state
    // chains with garbage. Only genuinely direct shell calls (whose raw
    // stdout has no header at all) skip the header checks.
    // eslint-disable-next-line no-control-regex
    const ansi = /\x1b\[/.test(content);
    const direct = DIRECT_SHELL_NAMES.has(meta.name) && !meta.nested;
    const markerAt = text.indexOf('\nOutput:\n');
    const header = markerAt < 0 ? text : text.slice(0, markerAt);
    const failed = /^Script (failed|error)/.test(header) || /^Exit code:\s*[1-9]/m.test(header);
    if (ansi || (!direct && (markerAt < 0 || failed))) return { verb: 'exec', stdout: content, stderr: '' };
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
    const sourcePath = file.match[2].trim();
    const filePath = (moved?.[1] ?? sourcePath).trim();
    const patchLines = moved ? section.slice(1) : section;
    if (kind === 'Add') {
      const content = patchLines.filter((line) => line.startsWith('+')).map((line) => line.slice(1)).join('\n');
      const count = content.split('\n').length;
      return { verb: 'write_file', path: filePath, title: path.basename(filePath), content, region: { start: 1, end: count } };
    }
    if (kind === 'Delete') {
      return { verb: 'patch_file', path: sourcePath, title: path.basename(sourcePath), removed: true };
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
      ...(moved ? { source_path: sourcePath } : {}),
      // codex patch envelopes carry no line numbers; 0 = "position unknown",
      // so downstream never mistakes it for a real placement hint
      hunks: groups.filter((group) => group.length).map((group) => ({
        oldStart: 0, oldLines: group.filter((line) => !line.startsWith('+')).length,
        newStart: 0, newLines: group.filter((line) => !line.startsWith('-')).length,
        lines: group,
      })),
    };
  });
}

