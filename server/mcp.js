import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_MARKER, parseLineSpec, parseTsv } from './mcfly-data.js';

const exec = promisify(execFile);
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version;
const INSTRUCTIONS = 'Use run_table for shell commands whose stdout is tabular data. The script must emit strict TSV: one unique, non-empty header row, at least two columns, at least one data row, and the same number of tab-separated cells on every row. Do not emit decoration or commentary to stdout; send diagnostics to stderr. Use highlight instead of a plain file read whenever you want to point the user at specific lines: it renders the file in the McFly viewer with those lines highlighted. Use waypoint to leave a durable note anchored to a specific line (a finding, explanation, or TODO): waypoints collect in the McFly Wayfinder tab and stay findable even after the file changes. Use waypoint_remove when a waypoint is resolved or obsolete. Use workspace_state whenever the user references something you cannot see — "this", "here", "that file", "what I highlighted", "where I am" — or to orient yourself in what they are looking at: it returns their open files, visible lines, playhead, panels, terminals, and recent selections and time-travel jumps. When the user mentions a review or their comments, call review_state to read the threads and review_reply to answer them; set addressed: true on replies that complete the ask.';
const TOOL = {
  name: 'run_table',
  title: 'Run tabular shell command',
  description: 'Run a Bash script and return strict TSV output as a semantic table for McFly. Stdout must follow the server instructions.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['script'],
    properties: {
      script: { type: 'string', description: 'Bash script whose stdout is strict TSV.' },
      cwd: { type: 'string', description: 'Absolute working directory. Defaults to the MCP process working directory.' },
      title: { type: 'string', description: 'Short table title.' },
    },
  },
  outputSchema: {
    type: 'object', additionalProperties: false,
    required: ['schema', 'kind', 'command', 'cwd', 'exitCode', 'stdout', 'stderr', 'data'],
    properties: {
      schema: { const: 'mcfly.data.v1' }, kind: { const: 'table' }, command: { type: 'string' },
      cwd: { type: 'string' }, exitCode: { type: 'integer' }, stdout: { type: 'string' }, stderr: { type: 'string' },
      data: {
        type: 'object', additionalProperties: false, required: ['columns', 'rows'],
        properties: {
          columns: { type: 'array', items: { type: 'string' }, minItems: 2 },
          rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, minItems: 1 },
        },
      },
    },
  },
  annotations: { destructiveHint: true, openWorldHint: true },
};

const HIGHLIGHT_TOOL = {
  name: 'highlight',
  title: 'Read a file with highlighted lines',
  description: 'Read a file and render it in the McFly viewer with one or more lines highlighted. Use instead of a plain read when pointing the user at specific lines. lines is a comma-separated list of line numbers and ranges, e.g. "12,40-45".',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['path', 'lines'],
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to cwd.' },
      lines: { type: 'string', description: 'Lines to highlight: comma-separated numbers and ranges, e.g. "12,40-45".' },
      cwd: { type: 'string', description: 'Base directory for a relative path. Defaults to the MCP process working directory.' },
    },
  },
  outputSchema: {
    type: 'object', additionalProperties: false,
    required: ['schema', 'kind', 'path', 'content', 'highlights'],
    properties: {
      schema: { const: 'mcfly.data.v1' }, kind: { const: 'file' }, path: { type: 'string' },
      content: { type: 'string' },
      highlights: {
        type: 'array', minItems: 1,
        items: {
          type: 'object', additionalProperties: false, required: ['start', 'end'],
          properties: { start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 } },
        },
      },
    },
  },
  annotations: { readOnlyHint: true },
};

const WAYPOINT_TOOL = {
  name: 'waypoint',
  title: 'Drop a waypoint on a line',
  description: 'Mark a line of a file with a note. The waypoint captures the line and surrounding context so McFly can find it again even after the file changes, and shows the note above the line in the Wayfinder tab. Use it to leave findings, explanations, or TODOs anchored to code.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['path', 'line', 'note'],
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to cwd.' },
      line: { type: 'integer', minimum: 1, description: '1-based line to anchor the waypoint to.' },
      note: { type: 'string', description: 'Markdown note shown above the line.' },
      cwd: { type: 'string', description: 'Base directory for a relative path. Defaults to the MCP process working directory.' },
    },
  },
  outputSchema: {
    type: 'object', additionalProperties: false,
    required: ['schema', 'kind', 'path', 'line', 'note', 'before', 'anchor', 'after'],
    properties: {
      schema: { const: 'mcfly.data.v1' }, kind: { const: 'waypoint' },
      path: { type: 'string' }, line: { type: 'integer' }, note: { type: 'string' },
      before: { type: 'array', items: { type: 'string' } },
      anchor: { type: 'string' },
      after: { type: 'array', items: { type: 'string' } },
    },
  },
  annotations: { readOnlyHint: true },
};

const WORKSPACE_STATE_TOOL = {
  name: 'workspace_state',
  title: "See the user's McFly workspace",
  description: "What the user has open, focused, and selected in McFly right now — open files and their flavor (pinned/read-only/snapshot/timeline), visible lines, playhead position, panels, live terminals — plus recent history: text selections, time-travel jumps, files opened. Call it whenever the user references something you cannot see: 'this', 'here', 'that file', 'what I highlighted', 'where I am'.",
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      history: { type: 'integer', minimum: 1, maximum: 500, description: 'Return up to N recent events (newest last).' },
      kinds: { type: 'array', items: { type: 'string' }, description: 'Filter events by kind: select, seek, file_open, file_close, tab_focus, pane_switch, terminal_focus, session_open.' },
      since_seconds: { type: 'integer', minimum: 1, description: 'Only events from the last N seconds.' },
      cwd: { type: 'string', description: 'Project directory, to pick the right McFly server when several run. Defaults to the process cwd.' },
    },
  },
  outputSchema: {
    type: 'object', required: ['schema', 'kind'],
    properties: { schema: { const: 'mcfly.data.v1' }, kind: { const: 'workspace_state' } },
  },
  annotations: { readOnlyHint: true },
};

function liveServers() {
  try {
    const all = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.mcfly', 'servers.json'), 'utf8'));
    return all.filter((s) => { try { process.kill(s.pid, 0); return true; } catch { return false; } });
  } catch { return []; }
}

async function runWorkspaceState(args = {}) {
  const servers = liveServers();
  if (!servers.length) {
    return { content: [{ type: 'text', text: 'no running mcfly server found' }], isError: true };
  }
  const cwd = path.resolve(args.cwd ?? process.cwd()).toLowerCase();
  const byNewest = [...servers].sort((a, b) => b.started - a.started);
  const pick = byNewest.find((s) => cwd.startsWith(String(s.pwd).toLowerCase())) ?? byNewest[0];
  const qs = new URLSearchParams();
  if (args.history) qs.set('history', String(args.history));
  if (Array.isArray(args.kinds) && args.kinds.length) qs.set('kinds', args.kinds.join(','));
  if (args.since_seconds) qs.set('since_seconds', String(args.since_seconds));
  try {
    const res = await fetch(`http://127.0.0.1:${pick.port}/api/workspace-state?${qs}`);
    const data = await res.json();
    const result = { schema: 'mcfly.data.v1', kind: 'workspace_state', server: { port: pick.port, pwd: pick.pwd }, ...data };
    return { content: [{ type: 'text', text: `${DATA_MARKER}\n${JSON.stringify(result)}` }], structuredContent: result };
  } catch (error) {
    return { content: [{ type: 'text', text: `mcfly server on port ${pick.port} did not answer: ${error.message}` }], isError: true };
  }
}

const REVIEW_STATE_TOOL = {
  name: 'review_state',
  title: 'Read human reviews',
  description: "Human code reviews for this project: threaded comments the user anchored to lines, GitHub-review style. Call it when a review is active, when the user mentions their review or comments, or before starting work the user asked to be reviewed. Reply to threads with review_reply.",
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      cwd: { type: 'string', description: 'Project directory. Defaults to the process cwd.' },
      all: { type: 'boolean', description: 'Include closed reviews. Default: open reviews only.' },
    },
  },
  outputSchema: {
    type: 'object', required: ['schema', 'kind'],
    properties: { schema: { const: 'mcfly.data.v1' }, kind: { const: 'review_state' } },
  },
  annotations: { readOnlyHint: true },
};

const REVIEW_REPLY_TOOL = {
  name: 'review_reply',
  title: 'Reply to a review thread',
  description: 'Reply to a human review comment. Set addressed: true when your reply resolves the ask — the thread shows as addressed until the human resolves it.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['comment_id', 'body'],
    properties: {
      comment_id: { type: 'string', description: 'The id of the comment thread to reply to.' },
      body: { type: 'string', description: 'The reply text (markdown).' },
      addressed: { type: 'boolean', description: 'Mark the thread addressed (you did what it asked).' },
      cwd: { type: 'string', description: 'Project directory. Defaults to the process cwd.' },
    },
  },
  outputSchema: {
    type: 'object', required: ['schema', 'kind'],
    properties: { schema: { const: 'mcfly.data.v1' }, kind: { const: 'review_reply' } },
  },
};

async function reviewFetch(args, route, payload) {
  const servers = liveServers();
  if (!servers.length) return null;
  const cwd = path.resolve(args.cwd ?? process.cwd());
  // among cwd matches, prefer the newest server — it runs the newest code.
  // The server's pwd only picks WHICH server; reviews belong to the
  // project, so the query pwd is always the agent's own cwd.
  const byNewest = [...servers].sort((a, b) => b.started - a.started);
  const pick = byNewest.find((s) => cwd.toLowerCase().startsWith(String(s.pwd).toLowerCase())) ?? byNewest[0];
  const res = payload
    ? await fetch(`http://127.0.0.1:${pick.port}${route}`, { method: 'POST', body: JSON.stringify({ ...payload, pwd: cwd }) })
    : await fetch(`http://127.0.0.1:${pick.port}${route}?pwd=${encodeURIComponent(cwd)}`);
  return res.json();
}

async function runReviewState(args = {}) {
  try {
    const reviews = await reviewFetch(args, '/api/reviews');
    if (reviews === null) return { content: [{ type: 'text', text: 'no running mcfly server found' }], isError: true };
    const filtered = args.all ? reviews : reviews.filter((r) => r.status === 'open');
    const result = { schema: 'mcfly.data.v1', kind: 'review_state', reviews: filtered };
    return { content: [{ type: 'text', text: `${DATA_MARKER}\n${JSON.stringify(result)}` }], structuredContent: result };
  } catch (error) {
    return { content: [{ type: 'text', text: `review lookup failed: ${error.message}` }], isError: true };
  }
}

async function runReviewReply(args = {}) {
  if (typeof args.comment_id !== 'string' || typeof args.body !== 'string' || !args.body.trim()) {
    return { content: [{ type: 'text', text: 'comment_id and body are required' }], isError: true };
  }
  try {
    const out = await reviewFetch(args, '/api/review-reply', {
      commentId: args.comment_id, body: args.body, author: 'agent', addressed: !!args.addressed,
    });
    if (out === null) return { content: [{ type: 'text', text: 'no running mcfly server found' }], isError: true };
    if (out.error) return { content: [{ type: 'text', text: out.error }], isError: true };
    const result = { schema: 'mcfly.data.v1', kind: 'review_reply', review_id: out.id, comment_id: args.comment_id };
    return { content: [{ type: 'text', text: `${DATA_MARKER}\n${JSON.stringify(result)}` }], structuredContent: result };
  } catch (error) {
    return { content: [{ type: 'text', text: `reply failed: ${error.message}` }], isError: true };
  }
}

const WAYPOINT_REMOVE_TOOL = {
  name: 'waypoint_remove',
  title: 'Remove waypoints',
  description: 'Remove waypoints previously dropped on a file. With line, removes the waypoint anchored at that (original) line; without, removes all waypoints on the file.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['path'],
    properties: {
      path: { type: 'string', description: 'File path the waypoint was dropped on.' },
      line: { type: 'integer', minimum: 1, description: 'The line the waypoint was originally anchored to. Omit to remove all waypoints on the file.' },
      cwd: { type: 'string', description: 'Base directory for a relative path.' },
    },
  },
  outputSchema: {
    type: 'object', additionalProperties: false, required: ['schema', 'kind', 'path'],
    properties: {
      schema: { const: 'mcfly.data.v1' }, kind: { const: 'waypoint_remove' },
      path: { type: 'string' }, line: { type: 'integer' },
    },
  },
  annotations: { readOnlyHint: true },
};

function runWaypointRemove(args = {}) {
  if (typeof args.path !== 'string' || !args.path.trim()) {
    return { content: [{ type: 'text', text: 'path is required' }], isError: true };
  }
  const line = args.line === undefined ? undefined : Number(args.line);
  if (line !== undefined && (!Number.isInteger(line) || line < 1)) {
    return { content: [{ type: 'text', text: 'line must be a positive integer' }], isError: true };
  }
  const file = path.resolve(args.cwd ?? process.cwd(), args.path);
  const result = { schema: 'mcfly.data.v1', kind: 'waypoint_remove', path: file, ...(line ? { line } : {}) };
  return { content: [{ type: 'text', text: `${DATA_MARKER}\n${JSON.stringify(result)}` }], structuredContent: result };
}

const WAYPOINT_CONTEXT = 3;

function runWaypoint(args = {}) {
  if (typeof args.path !== 'string' || !args.path.trim()) {
    return { content: [{ type: 'text', text: 'path is required' }], isError: true };
  }
  const line = Number(args.line);
  if (!Number.isInteger(line) || line < 1) {
    return { content: [{ type: 'text', text: 'line must be a positive integer' }], isError: true };
  }
  if (typeof args.note !== 'string' || !args.note.trim()) {
    return { content: [{ type: 'text', text: 'note is required' }], isError: true };
  }
  const file = path.resolve(args.cwd ?? process.cwd(), args.path);
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch (error) {
    return { content: [{ type: 'text', text: `cannot read ${file}: ${error.message}` }], isError: true };
  }
  if (line > lines.length) {
    return { content: [{ type: 'text', text: `line ${line} is past the end of the file (${lines.length} lines)` }], isError: true };
  }
  const content = lines.join('\n');
  const result = {
    schema: 'mcfly.data.v1', kind: 'waypoint', path: file, line, note: args.note,
    before: lines.slice(Math.max(0, line - 1 - WAYPOINT_CONTEXT), line - 1),
    anchor: lines[line - 1],
    after: lines.slice(line, line + WAYPOINT_CONTEXT),
    // the file as the agent marked it: lets the workbench show the waypoint
    // in the live session view instead of hunting the file on disk
    ...(content.length <= MAX_HIGHLIGHT_BYTES ? { content } : {}),
  };
  return { content: [{ type: 'text', text: `${DATA_MARKER}\n${JSON.stringify(result)}` }], structuredContent: result };
}

const MAX_HIGHLIGHT_BYTES = 2 * 1024 * 1024;

function runHighlight(args = {}) {
  if (typeof args.path !== 'string' || !args.path.trim()) {
    return { content: [{ type: 'text', text: 'path is required' }], isError: true };
  }
  const highlights = parseLineSpec(args.lines);
  if (!highlights) {
    return { content: [{ type: 'text', text: 'lines must be numbers and ranges like "12,40-45"' }], isError: true };
  }
  const file = path.resolve(args.cwd ?? process.cwd(), args.path);
  let content;
  try {
    if (fs.statSync(file).size > MAX_HIGHLIGHT_BYTES) {
      return { content: [{ type: 'text', text: `file too large to render: ${file}` }], isError: true };
    }
    content = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { content: [{ type: 'text', text: `cannot read ${file}: ${error.message}` }], isError: true };
  }
  const total = content.split(/\r?\n/).length;
  if (highlights.at(-1).end > total) {
    return { content: [{ type: 'text', text: `line ${highlights.at(-1).end} is past the end of the file (${total} lines)` }], isError: true };
  }
  const result = { schema: 'mcfly.data.v1', kind: 'file', path: file, content, highlights };
  return { content: [{ type: 'text', text: `${DATA_MARKER}\n${JSON.stringify(result)}` }], structuredContent: result };
}

async function runTable(args = {}) {
  if (typeof args.script !== 'string' || !args.script.trim()) {
    return { content: [{ type: 'text', text: 'script is required' }], isError: true };
  }
  const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error();
  } catch {
    return { content: [{ type: 'text', text: `cwd is not a directory: ${cwd}` }], isError: true };
  }
  let stdout = '', stderr = '', exitCode = 0;
  try {
    ({ stdout, stderr } = await exec(bash(), ['-lc', args.script], { cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }));
  } catch (error) {
    stdout = error.stdout ?? '';
    stderr = error.stderr ?? error.message;
    exitCode = Number.isInteger(error.code) ? error.code : 1;
  }
  const data = exitCode === 0 ? parseTsv(stdout) : null;
  if (!data) {
    const reason = exitCode ? `command exited ${exitCode}` : 'stdout is not strict TSV';
    return { content: [{ type: 'text', text: [reason, stdout, stderr].filter(Boolean).join('\n') }], isError: true };
  }
  const result = { schema: 'mcfly.data.v1', kind: 'table', command: args.script, cwd, exitCode, stdout, stderr, data };
  return { content: [{ type: 'text', text: `${DATA_MARKER}\n${JSON.stringify(result)}` }], structuredContent: result };
}

function bash() {
  if (process.env.MCFLY_BASH) return process.env.MCFLY_BASH;
  if (process.platform !== 'win32') return 'bash';
  try {
    const found = execFileSync('where.exe', ['bash.exe'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).filter(Boolean);
    return found.find((file) => /\\Git\\(?:bin|usr\\bin)\\bash\.exe$/i.test(file))
      ?? found.find((file) => !/\\Windows\\(?:System32|Apps)\\/i.test(file)) ?? 'bash';
  } catch { return 'bash'; }
}

async function handle(request) {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} }, serverInfo: { name: 'mcfly', version: VERSION }, instructions: INSTRUCTIONS,
      };
    case 'ping': return {};
    case 'tools/list': return { tools: [TOOL, HIGHLIGHT_TOOL, WAYPOINT_TOOL, WAYPOINT_REMOVE_TOOL, WORKSPACE_STATE_TOOL, REVIEW_STATE_TOOL, REVIEW_REPLY_TOOL] };
    case 'tools/call':
      if (request.params?.name === TOOL.name) return runTable(request.params.arguments);
      if (request.params?.name === HIGHLIGHT_TOOL.name) return runHighlight(request.params.arguments);
      if (request.params?.name === WAYPOINT_TOOL.name) return runWaypoint(request.params.arguments);
      if (request.params?.name === WAYPOINT_REMOVE_TOOL.name) return runWaypointRemove(request.params.arguments);
      if (request.params?.name === WORKSPACE_STATE_TOOL.name) return runWorkspaceState(request.params.arguments);
      if (request.params?.name === REVIEW_STATE_TOOL.name) return runReviewState(request.params.arguments);
      if (request.params?.name === REVIEW_REPLY_TOOL.name) return runReviewReply(request.params.arguments);
      throw new Error(`unknown tool: ${request.params?.name}`);
    default: throw Object.assign(new Error(`method not found: ${request.method}`), { code: -32601 });
  }
}

export async function startMcp() {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (request.id === undefined) continue;
    try {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: await handle(request) })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id: request.id,
        error: { code: error.code ?? -32603, message: error.message ?? String(error) },
      })}\n`);
    }
  }
}

const START = process.platform === 'win32'
  ? { command: 'cmd', args: ['/c', 'mcfly', 'mcp', 'start'] }
  : { command: 'mcfly', args: ['mcp', 'start'] };
const MANIFEST = { mcpServers: { mcfly: START } };

function configure(command, args) {
  const options = { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' };
  const check = spawnSync(command, ['mcp', 'get', 'mcfly'], options);
  if (check.status === 0) return `${command}: already configured`;
  const added = spawnSync(command, args, options);
  return added.status === 0 ? `${command}: configured` : `${command}: unavailable or configuration failed`;
}

export function configureMcp() {
  const dir = path.join(os.homedir(), '.mcfly');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, `${JSON.stringify(MANIFEST, null, 2)}\n`);
  const adapters = [
    configure('codex', ['mcp', 'add', 'mcfly', '--', START.command, ...START.args]),
    configure('claude', ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'mcfly', '--', START.command, ...START.args]),
  ];
  return { file, manifest: MANIFEST, adapters };
}
