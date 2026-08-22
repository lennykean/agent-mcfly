// Cursor Agent CLI session loader. Cursor stores a chat as a directory, not a
// transcript file: ~/.cursor/chats/<md5(cwd)>/<chatId>/ holds a meta.json and
// a SQLite content-addressed blob store. Inside the store, the single `meta`
// row names the latest root blob; the root blob is a protobuf whose repeated
// field 1 is the ordered list of message-blob ids; each message blob is a JSON
// message (system / user / assistant / tool). Everything else in the store is
// cursor's own UI state and prior snapshots.
//
// Consequences for the loader contract: the cursor is a MESSAGE INDEX, not a
// byte offset (there is no append-only file to seek in), and listForCwd's
// `size` stays bytes-on-disk because that is what the picker prints.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { highlightCall, highlightResult, isHighlightTool, isTableTool, isWaypointRemoveTool, isWaypointTool, tableCall, tableResult, waypointCall, waypointRemoveCall, waypointRemoveResult, waypointResult } from '../mcfly-data.js';
import { parseUnified } from '../git.js';
import { idsFor, MAX_CHUNK, memoByStamp, patchRegion, shortPath, truncate } from './transcript.js';

const ROOT = path.resolve(os.homedir(), '.cursor', 'chats');

const { resolveId } = idsFor(ROOT);

// cursor keys a workspace by the md5 of the cwd exactly as the CLI saw it.
export const workspaceHash = (cwd) => crypto.createHash('md5').update(String(cwd ?? '')).digest('hex');

// ---- the blob store ----

// Last activity, cursor's own definition: it rewrites meta.json every time the
// store's root blob moves (i.e. on every message), stamping updatedAtMs. File
// mtimes are NOT usable here — SQLite writes into -wal until a checkpoint, and
// merely opening a WAL database (which this loader does, to read) recreates
// -wal, so its mtime tracks our own reads. store.db's mtime is the fallback
// for chats written before the sidecar existed.
function storeStamp(dir, meta = readChatMeta(dir)) {
  const stat = (name) => { try { return fs.statSync(path.join(dir, name)); } catch { return null; } };
  const db = stat('store.db');
  if (!db) return { updated_at: 0, size: 0 };
  return {
    updated_at: meta?.updatedAtMs > 0 ? meta.updatedAtMs : db.mtimeMs,
    size: db.size + (stat('store.db-wal')?.size ?? 0),
  };
}

// node:sqlite arrived in node 22.5; mcfly still supports 20, so it is loaded
// on demand and a missing module simply means "no cursor sessions here".
const require = createRequire(import.meta.url);
let sqlite;
function sqliteModule() {
  if (sqlite === undefined) {
    try { sqlite = require('node:sqlite'); } catch { sqlite = null; }
  }
  return sqlite;
}

// Read-only: cursor-agent may be writing this store right now.
function open(dir) {
  const mod = sqliteModule();
  if (!mod) throw new Error('reading Cursor sessions needs node 22.5+ (node:sqlite)');
  return new mod.DatabaseSync(path.join(dir, 'store.db'), { readOnly: true });
}

// The meta row's value is hex-encoded JSON: the chat name, and the root blob
// that the rest of the conversation hangs off. A row this cannot read is a
// store McFly does not understand, not a reason to fail the request.
function parseStoreMeta(value) {
  const hex = typeof value === 'string' ? value : Buffer.from(value ?? '').toString();
  try { return JSON.parse(Buffer.from(hex, 'hex').toString('utf8')); } catch { return null; }
}

function storeMeta(db) {
  const row = db.prepare('select value from meta order by key limit 1').get();
  return row ? parseStoreMeta(row.value) : null;
}

function varint(buf, at) {
  let shift = 0;
  let value = 0;
  for (let i = at; i < buf.length; i++) {
    value += (buf[i] & 0x7f) * 2 ** shift;
    if (!(buf[i] & 0x80)) return [value, i + 1];
    shift += 7;
    if (shift > 56) break; // beyond safe-integer territory: not a field we read
  }
  throw new Error('truncated varint');
}

// The root blob, walked for its repeated field 1 (32-byte message-blob ids).
// Other fields are skipped by wire type rather than assumed absent, so a
// cursor release that adds fields before the list still parses.
//
// A field this cannot walk past ends the scan and keeps what was collected —
// the ids come first in every store seen so far, so a partial conversation
// beats the blank screen that a throw would produce here.
export function rootMessageIds(buf) {
  const ids = [];
  let i = 0;
  try {
    while (i < buf.length) {
      let tag;
      [tag, i] = varint(buf, i);
      const field = tag >>> 3;
      const wire = tag & 7;
      if (wire === 0) { [, i] = varint(buf, i); } else if (wire === 1) { i += 8; } else if (wire === 5) { i += 4; } else if (wire === 2) {
        let len;
        [len, i] = varint(buf, i);
        if (i + len > buf.length) break;
        if (field === 1 && len === 32) ids.push(buf.toString('hex', i, i + 32));
        i += len;
      } else break; // groups (3/4) and 6/7: not something this format uses
      if (i > buf.length) break;
    }
  } catch { /* truncated varint: keep what was read */ }
  return ids;
}

// ---- listing ----
//
// The sidecar (meta.json) carries everything the picker needs except a label
// for an unnamed chat: cwd, last activity, whether the chat is a subagent, and
// the chat name once the agent has picked one. Reading it keeps the poll off
// SQLite entirely for named chats.
const chatMeta = memoByStamp();

function readChatMeta(dir) {
  let stamp;
  try { stamp = fs.statSync(path.join(dir, 'meta.json')).mtimeMs; } catch { return {}; }
  return chatMeta(dir, stamp, () => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { return {}; }
  });
}

// What only the store can answer: whether a chat is a subagent (chats written
// before the sidecar existed carry no flag) and, for an unnamed chat, its first
// user query. Both are fixed ONCE THE CONVERSATION STARTS, so only a started
// chat is cached — a chat that has not begun is asked again next poll, which is
// how a new session appears in the picker at all.
const storeHeads = new Map();

function storeHead(dir) {
  const hit = storeHeads.get(dir);
  if (hit) return hit;
  const head = {};
  let db;
  try {
    db = open(dir);
    const meta = storeMeta(db);
    head.subagent = !!meta?.subagentInfo;
    if (!meta?.latestRootBlobId) return head;
    const blob = db.prepare('select data from blobs where id = ?');
    const root = blob.get(meta.latestRootBlobId);
    if (!root) return head;
    head.started = true;
    // the query is in the first turn; the leading system/context messages are
    // big, so only the head of the list is worth reading
    for (const id of rootMessageIds(Buffer.from(root.data)).slice(0, 12)) {
      const data = blob.get(id)?.data;
      if (!data) continue;
      let message;
      try { message = JSON.parse(Buffer.from(data).toString('utf8')); } catch { continue; }
      if (message?.role !== 'user') continue;
      const text = userText(message);
      if (!text) continue;
      head.label = text.replace(/\s+/g, ' ').slice(0, 60);
      break;
    }
    storeHeads.set(dir, head);
    return head;
  } catch { return head; } finally {
    try { db?.close(); } catch { /* already gone */ }
  }
}

export function listForCwd(cwd) {
  // Offering a session that tail() would refuse to open is worse than offering
  // none: the picker row is dead and says nothing about why.
  if (!sqliteModule()) return [];
  return listChats(path.join(ROOT, workspaceHash(cwd)), cwd);
}

export function listChats(dir, cwd) {
  let chats = [];
  try { chats = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const chat of chats) {
    if (!chat.isDirectory()) continue;
    const chatDir = path.join(dir, chat.name);
    const meta = readChatMeta(chatDir);
    // subagent chats are siblings on disk but belong to their parent's tree;
    // a chat with no conversation yet has nothing to replay
    if (meta.isSubagent || meta.hasConversation === false) continue;
    const stamp = storeStamp(chatDir, meta);
    if (!stamp.updated_at) continue;
    // meta.title is set only once the agent names the chat — and it is also
    // what cursor writes into the terminal title, which is how a live terminal
    // gets mapped back to this session. Without one, the store has to answer.
    let label = meta.title;
    if (!label) {
      const head = storeHead(chatDir);
      if (head.subagent || !head.started) continue;
      label = head.label;
    }
    out.push({
      // <workspace hash>/<chat id>, the same shape resolveId() expects back
      id: `${path.basename(dir)}/${chat.name}`,
      provider: 'cursor',
      label: label ?? chat.name.slice(0, 8),
      cwd: meta.cwd ?? cwd,
      updated_at: stamp.updated_at,
      size: stamp.size,
    });
  }
  out.sort((a, b) => b.updated_at - a.updated_at);
  return out;
}

// Last activity for the agent tree. A store that is not there must THROW, the
// way every other provider's tip does (see idsFor in transcript.js): the caller
// omits an id that throws, but a zero timestamp reads as "ten minutes idle" and
// settles the agent out of the tree for good.
export function tip(id) {
  const dir = resolveId(id);
  const stamp = storeStamp(dir);
  if (!stamp.updated_at) throw Object.assign(new Error('no cursor store'), { code: 'ENOENT' });
  return stamp;
}

// ---- subagents ----
//
// A Task spawns a sibling chat whose store names the tool call that started
// it, so a RUNNING subagent is linkable the moment its store appears — no
// waiting for the result.
//
// The child lands a beat AFTER its call, so a miss must be re-tried; but the
// scan opens a SQLite store per subagent chat, so a parent whose children are
// gone would redo that walk on every tail. Misses are remembered for
// MISS_TTL_MS — long enough to stop the storm, short enough that a child
// arriving a beat later still gets linked. (Same shape as the codex loader.)
// A successful probe is kept for good: subagentInfo never changes once the
// store exists. A FAILED probe is never cached — "not written yet" is the
// normal state of the child this feature exists to catch.
const MISS_TTL_MS = 10_000;
const subagentInfoOf = new Map(); // chat dir -> subagentInfo
const childByCall = new Map(); // `${parentAgentId}\0${toolCallId}` -> { name, type }
const missedAt = new Map();

function probeSubagent(chatDir) {
  const hit = subagentInfoOf.get(chatDir);
  if (hit) return hit;
  let db;
  try {
    db = open(chatDir);
    const info = storeMeta(db)?.subagentInfo;
    if (info?.toolCallId) subagentInfoOf.set(chatDir, info);
    return info;
  } catch { return undefined; /* unreadable, or the store is still being created */ } finally {
    try { db?.close(); } catch { /* already gone */ }
  }
}

// `siblings` is false for a store read through the SSH mirror: a mirror has no
// sibling chats to scan, so over SSH the link lands with the Task's result.
function childOfToolCall(dir, id, toolCallId, siblings) {
  if (!toolCallId || !siblings) return {};
  const ws = String(id).replace(/\\/g, '/').split('/');
  const key = `${ws.at(-1)}\0${toolCallId}`;
  let child = childByCall.get(key);
  if (!child) {
    if (Date.now() - (missedAt.get(key) ?? -Infinity) < MISS_TTL_MS) return {};
    const wsDir = path.dirname(dir);
    let entries = [];
    try { entries = fs.readdirSync(wsDir, { withFileTypes: true }); } catch { /* workspace gone */ }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const chatDir = path.join(wsDir, entry.name);
      // A written sidecar already says whether this is a subagent, which saves
      // opening the store. A child too young to have one is probed anyway —
      // that is precisely the child worth finding.
      const meta = readChatMeta(chatDir);
      if (meta.schemaVersion !== undefined && !meta.isSubagent) continue;
      const info = probeSubagent(chatDir);
      if (info?.toolCallId) {
        childByCall.set(`${info.parentAgentId}\0${info.toolCallId}`, { name: entry.name, type: info.typeName });
      }
    }
    child = childByCall.get(key);
    if (!child) { missedAt.set(key, Date.now()); return {}; }
  }
  return {
    agent_id: child.name,
    child_session_id: `${ws[0]}/${child.name}`,
    ...(child.type ? { agent_type: child.type } : {}),
  };
}

// ---- tailing ----

export function tail(id, cursor = 0) {
  return tailStore(resolveId(id), cursor, id, true);
}

// Shared with the SSH path, which mirrors the store to a local copy first —
// hence `siblings`: a mirror has no neighbouring chats to resolve children in.
export function tailStore(dir, cursor = 0, id, siblings = false) {
  const stamp = storeStamp(dir);
  const messages = [];
  let db;
  let ids = [];
  let at = Math.max(0, cursor);
  let reset = false;
  try {
    db = open(dir);
    const blob = db.prepare('select data from blobs where id = ?');
    try {
      const meta = storeMeta(db);
      const root = meta?.latestRootBlobId && blob.get(meta.latestRootBlobId);
      if (root) ids = rootMessageIds(Buffer.from(root.data));
    } catch { /* a store shape this version cannot read: no messages, not a 500 */ }
    // Unlike a transcript file, the root list is rewritten whole on every turn,
    // so it can SHRINK — cursor compacts and rewinds conversations. A cursor
    // past the end means the client holds a timeline that no longer exists;
    // say so and hand back the whole thing rather than going silent forever.
    // ponytail: only a shrink still visible at poll time is caught. A compaction
    // that regrows past the old cursor between two polls slips through; catching
    // that needs a generation marker echoed by the client.
    if (at > ids.length) { at = 0; reset = true; }
    // a big file read is stored out of line, as a base64 blob id; the tool
    // result is only complete once it is resolved back to bytes
    const ctx = {
      id,
      siblings,
      dir,
      turnTs: undefined,
      bytes: 0,
      blob(base64) {
        let data;
        try { data = blob.get(Buffer.from(String(base64), 'base64').toString('hex'))?.data; } catch { return undefined; }
        // inlined blobs count against the chunk budget like any other bytes —
        // a handful of image reads is otherwise tens of megabytes in one reply
        if (data) this.bytes += data.length;
        return data;
      },
    };
    // one call yields at most MAX_CHUNK of message bytes; the client keeps
    // asking while cursor < size, exactly as it does for the file loaders
    for (; at < ids.length && ctx.bytes < MAX_CHUNK; at++) {
      const data = blob.get(ids[at])?.data;
      if (!data) continue; // pruned blob: skip it, but never stall the cursor
      ctx.bytes += data.length;
      convertMessage(Buffer.from(data).toString('utf8'), ctx, messages);
    }
  } finally {
    try { db?.close(); } catch { /* already gone */ }
  }
  return { messages, cursor: at, mtime: stamp.updated_at, size: ids.length, ...(reset ? { reset: true } : {}) };
}

// ---- message conversion ----

// A user turn is wrapped in cursor's context envelope; the query is the only
// part the human wrote. Everything else (<user_info>, <git_status>, rules
// dumps) is injected context and stays hidden, as it does for the other
// providers.
const textOf = (message) => (typeof message.content === 'string' ? message.content
  : (Array.isArray(message.content) ? message.content : [])
    .filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n'));

export function userText(message) {
  const raw = textOf(message);
  const query = raw.match(/<user_query>([\s\S]*?)<\/user_query>/)?.[1]?.trim();
  if (query) return query;
  return raw.trim().startsWith('<') ? '' : raw.trim();
}

// Cursor records no per-message time. It does stamp each user turn with a
// human-readable timestamp inside the envelope, so the turn's time carries
// forward over the assistant/tool messages that answer it — turn resolution,
// which is all the store actually knows.
export function turnTimestamp(raw) {
  const stamp = raw.match(/<timestamp>([^<]+)<\/timestamp>/)?.[1];
  if (!stamp) return undefined;
  // "Saturday, Jul 25, 2026, 8:05 PM (UTC-7)" — Date.parse ignores the
  // parenthesised zone, so normalise it into an offset it does honour
  const normalized = stamp.trim().replace(/^[A-Za-z]+,\s*/, '')
    .replace(/\s*\(UTC([+-]\d{1,2})(?::(\d{2}))?\)\s*$/, (_, hours, minutes) =>
      ` ${hours[0] === '-' ? '-' : '+'}${String(Math.abs(Number(hours))).padStart(2, '0')}${minutes ?? '00'}`);
  // A zone that survived the rewrite is one Date.parse will silently drop,
  // dating the turn in the READER's zone instead of the agent's. No timestamp
  // beats a wrong one: the UI already draws steps that have none.
  if (/\(/.test(normalized)) return undefined;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : undefined;
}

function convertMessage(text, ctx, messages) {
  let message;
  try { message = JSON.parse(text); } catch { return; }
  if (message?.role === 'system') return; // the prompt, not the conversation

  if (message.role === 'user') {
    ctx.turnTs = turnTimestamp(textOf(message)) ?? ctx.turnTs;
    const body = userText(message);
    if (body) messages.push({ timestamp: ctx.turnTs, role: 'user', content: [{ type: 'text', text: body }] });
    return;
  }

  if (message.role === 'assistant') {
    const content = [];
    for (const c of Array.isArray(message.content) ? message.content : []) {
      // redacted-reasoning carries no text — an empty thought bubble is noise
      if (c.type === 'text' && c.text) content.push({ type: 'text', text: c.text });
      else if (c.type === 'reasoning' && c.text) content.push({ type: 'thinking', thought: c.text });
      else if (c.type === 'tool-call') {
        const { tool, input } = toolOf(c);
        content.push({
          type: 'tool',
          tool_request_id: c.toolCallId,
          tool,
          params: input,
          extended: { render: callRender(tool, input, ctx, c.toolCallId) },
        });
      }
    }
    if (content.length) messages.push({ timestamp: ctx.turnTs, role: 'assistant', content });
    return;
  }

  if (message.role !== 'tool') return;
  const envelope = message.providerOptions?.cursor?.highLevelToolCallResult;
  const content = [];
  for (const c of Array.isArray(message.content) ? message.content : []) {
    if (c.type !== 'tool-result') continue;
    const { tool, input } = toolOf(c);
    const failed = !!envelope?.isError || (!!envelope && !envelope.output?.success);
    content.push({
      type: 'tool_result',
      tool_request_id: c.toolCallId,
      tool,
      result: c.result ?? '',
      extended: { render: resultRender(tool, input, c, envelope, ctx), ...(failed ? { is_error: true } : {}) },
    });
  }
  if (content.length) messages.push({ timestamp: ctx.turnTs, role: 'user', content });
}

// MCP calls all arrive as CallMcpTool; flattening them to `server__tool`
// matches how the other providers name MCP tools, so the mcfly data/highlight/
// waypoint matchers (and user data-matchers) recognise them unchanged.
function toolOf(block) {
  const args = block.args ?? {};
  if (block.toolName === 'CallMcpTool' && args.server && args.toolName) {
    return { tool: `${args.server}__${args.toolName}`, input: args.arguments ?? {} };
  }
  return { tool: block.toolName ?? '?', input: args };
}

// ---- render verbs: the provider-neutral contract the UI consumes ----

function callRender(tool, input, ctx, toolCallId) {
  if (isTableTool(tool)) return tableCall(input);
  if (isHighlightTool(tool)) return highlightCall(input);
  if (isWaypointRemoveTool(tool)) return waypointRemoveCall(input);
  if (isWaypointTool(tool)) return waypointCall(input);
  switch (tool) {
    case 'Read':
      return { verb: 'read_file', path: input.path, title: shortPath(input.path) };
    case 'StrReplace':
    case 'EditNotebook':
      return { verb: 'patch_file', path: input.path, title: shortPath(input.path) };
    case 'Write':
      return { verb: 'write_file', path: input.path, title: shortPath(input.path) };
    case 'Delete':
      return { verb: 'patch_file', path: input.path, title: shortPath(input.path), removed: true };
    case 'Shell':
    case 'AwaitShell':
      return {
        verb: 'exec', command: input.command ?? '',
        title: input.description ?? truncate(input.command, 60), cwd: input.working_directory,
      };
    case 'Grep': {
      let command = `grep${input['-i'] ? ' -i' : ''} "${input.pattern}"`;
      if (input.path) command += ` ${input.path}`;
      if (input.glob) command += ` --glob "${input.glob}"`;
      return { verb: 'exec', command, title: truncate(input.pattern, 60) };
    }
    case 'Glob': {
      const pattern = input.glob_pattern ?? input.glob ?? '';
      return {
        verb: 'exec', command: `glob "${pattern}"${input.target_directory ? ' ' + input.target_directory : ''}`,
        title: truncate(pattern, 60),
      };
    }
    case 'Task':
      return {
        verb: 'spawn_agent', agent_type: input.subagent_type, title: input.description ?? 'agent',
        ...childOfToolCall(ctx.dir, ctx.id, toolCallId, ctx.siblings),
      };
    default:
      return { verb: 'other', title: summarizeParams(tool, input) };
  }
}

const flatten = (value) => (typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value));

const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};
const MAX_IMAGE = 8 * 1024 * 1024;

function resultRender(tool, input, block, envelope, ctx) {
  const text = flatten(block.result);
  const ok = envelope?.output?.success;
  // A call that FAILED has no structured output; a call with no cursor envelope
  // at all still succeeded, and its payload belongs in stdout. Conflating the
  // two paints ordinary output in the error style.
  const failed = !!envelope && !ok;
  // mcfly's own tools answer with an envelope of their own; cursor may carry it
  // in the result or tuck it under the tool-call output
  const mine = (read) => read(block.result) ?? read(text) ?? read(ok)
    ?? (failed ? { verb: 'exec', stdout: '', stderr: text } : { verb: 'exec', stdout: text, stderr: '' });
  if (isTableTool(tool)) return mine(tableResult);
  if (isHighlightTool(tool)) return mine(highlightResult);
  if (isWaypointRemoveTool(tool)) return mine(waypointRemoveResult);
  if (isWaypointTool(tool)) return mine(waypointResult);
  // search tools render as terminal commands; their output is the block text
  if (tool === 'Grep' || tool === 'Glob') {
    return failed ? { verb: 'exec', stdout: '', stderr: text } : { verb: 'exec', stdout: text, stderr: '' };
  }
  if (!ok) {
    return tool === 'Shell' || tool === 'AwaitShell'
      ? { verb: 'exec', ...(failed ? { stdout: '', stderr: text } : { stdout: text, stderr: '' }) }
      : { verb: 'other' };
  }
  switch (tool) {
    case 'Read': {
      const filePath = ok.path ?? input.path;
      if (ok.dataBlobId) {
        const bytes = ctx.blob?.(ok.dataBlobId);
        const mime = IMAGE_MIME[path.extname(String(filePath)).toLowerCase()];
        // same ceiling the file reader uses; base64 of more than this is not
        // something a browser wants inlined into a transcript
        if (!bytes || !mime || bytes.length > MAX_IMAGE) return { verb: 'read_file', path: filePath };
        return { verb: 'read_file', path: filePath, image_src: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` };
      }
      let content = ok.content;
      if (typeof content !== 'string' && ok.contentBlobId) {
        // a blob that is gone is NOT an empty file: saying so would poison the
        // file timeline with a wrong "the agent saw nothing here"
        const bytes = ctx.blob?.(ok.contentBlobId);
        if (!bytes) return { verb: 'read_file', path: filePath };
        content = Buffer.from(bytes).toString('utf8');
      }
      if (typeof content !== 'string') return { verb: 'other' };
      const start = ok.readRange?.startLine ?? 1;
      const end = ok.readRange?.endLine ?? start + content.split('\n').length - 1;
      return {
        verb: 'read_file', path: filePath, content,
        start_line: start, total_lines: ok.totalLines, region: { start, end },
      };
    }
    case 'StrReplace':
    case 'EditNotebook':
    case 'Write': {
      const filePath = ok.path ?? input.path;
      const content = ok.afterFullFileContent;
      const hunks = ok.diffString ? parseUnified(String(ok.diffString)) : [];
      // a Write with no prior content is a creation; anything with a before
      // state renders as a patch so the file timeline shows the change
      if (tool === 'Write' && ok.beforeFullFileContent === undefined) {
        const body = content ?? input.contents ?? '';
        return { verb: 'write_file', path: filePath, content: body, region: { start: 1, end: body.split('\n').length } };
      }
      return {
        verb: 'patch_file', path: filePath, ...(hunks.length ? { hunks } : {}),
        ...(typeof content === 'string' ? { content } : {}),
        ...(hunks.length ? { region: patchRegion(hunks) } : {}),
      };
    }
    case 'Delete':
      return { verb: 'patch_file', path: ok.path ?? input.path, removed: true };
    case 'Shell':
    case 'AwaitShell': {
      const exit = text.match(/^Exit code:\s*(-?\d+)/)?.[1];
      return {
        verb: 'exec',
        stdout: ok.stdout ?? (ok.stderr === undefined ? ok.interleavedOutput ?? '' : ''),
        stderr: ok.stderr ?? '',
        cwd: ok.workingDirectory ?? input.working_directory,
        ...(exit === undefined ? {} : { exit_code: Number(exit) }),
      };
    }
    case 'Task': {
      if (!ok.agentId) return { verb: 'other' };
      const summary = ok.conversationSteps?.map((s) => s.assistantMessage?.text ?? '').filter(Boolean).join('\n') || text;
      // The subagent's chat sits beside its parent under the same workspace,
      // named by its agent id. Ask the sibling scan first so the call side and
      // the result side agree on one child id — two ids would draw the agent
      // twice in the tree, one of them dead.
      const ws = String(ctx.id).replace(/\\/g, '/').split('/')[0];
      const child = childOfToolCall(ctx.dir, ctx.id, block.toolCallId, ctx.siblings);
      return {
        verb: 'spawn_agent', status: 'completed', summary: truncate(summary, 2000),
        agent_id: ok.agentId, child_session_id: `${ws}/${ok.agentId}`,
        ...child,
      };
    }
    default:
      return { verb: 'other' };
  }
}

function summarizeParams(tool, input) {
  for (const key of ['pattern', 'query', 'path', 'command', 'description', 'prompt', 'url']) {
    if (typeof input?.[key] === 'string') return truncate(input[key], 60);
  }
  return tool;
}
