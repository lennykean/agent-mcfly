import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_MARKER, parseLineSpec, parseTable, TABLE_FORMATS } from './mcfly-data.js';

const exec = promisify(execFile);
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version;
const INSTRUCTIONS = 'Use run_table for shell commands whose stdout is tabular data. The script must emit strict TSV: one unique, non-empty header row, at least two columns, at least one data row, and the same number of tab-separated cells on every row. Do not emit decoration or commentary to stdout; send diagnostics to stderr. Use highlight instead of a plain file read whenever you want to point the user at specific lines: it renders the file in the McFly viewer with those lines highlighted. Use waypoint to leave a durable note anchored to a specific line (a finding, explanation, or TODO): waypoints collect in the McFly Wayfinder tab and stay findable even after the file changes. Use waypoint_remove when a waypoint is resolved or obsolete. Use workspace_state whenever the user references something you cannot see — "this", "here", "that file", "what I highlighted", "where I am" — or to orient yourself in what they are looking at: it returns their open files, visible lines, playhead, panels, terminals, and recent selections and time-travel jumps. When the user mentions a review or their comments, call review_state to read the threads and review_reply to answer them; set addressed: true on replies that complete the ask. Use list_peers to discover McFly-hosted terminals before send_message. A peer is messageable only when relay is enabled and McFly has linked its agent session; interactive peers need the user to enable relay, while relay-enabled peers with session_available false are still waiting for discovery. Use data_matcher when another tool you are calling returns structured output the user will want to read as data: register the tool once and its results render in the data pane from then on, with no change to how you call it.';
const TOOL = {
  name: 'run_table',
  title: 'Run tabular shell command',
  description: 'Run a Bash script and return its tabular stdout as a semantic table for McFly. Say which format the script emits with `format`: tsv (default), csv, or json. Stdout must be that format and nothing else.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['script'],
    properties: {
      script: { type: 'string', description: 'Bash script whose stdout is a table in the declared format.' },
      format: {
        enum: TABLE_FORMATS,
        description: 'Format of the script stdout. tsv (default): tab-separated, header row first. csv: RFC4180, quoted fields may contain commas and newlines. json: either a list of row objects, or {"columns":[...],"rows":[[...]]}.',
      },
      cwd: { type: 'string', description: 'Absolute working directory. Defaults to the MCP process working directory.' },
      title: { type: 'string', description: 'Short table title.' },
    },
  },
  outputSchema: {
    type: 'object', additionalProperties: false,
    required: ['schema', 'kind', 'command', 'cwd', 'exitCode', 'stdout', 'stderr', 'data'],
    properties: {
      schema: { const: 'mcfly.data.v1' }, kind: { const: 'table' }, command: { type: 'string' },
      format: { enum: TABLE_FORMATS },
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
  description: "What the user has open, focused, and selected in McFly right now — open files and their flavor (pinned/read-only/snapshot/timeline), visible lines, playhead position, panels, live terminals — plus the git pane (selected staged/changed files, the open diff, the active worktree) and recent history: text selections, time-travel jumps, files opened. Call it whenever the user references something you cannot see: 'this', 'here', 'that file', 'these files', 'what I highlighted', 'where I am'. The git pane is read-only, so requests like 'commit these files' mean: read the selection here, then act with your own tools. Selections persist until replaced. text_selections is a list with one entry per file (newest last, each stamped with 'at'), so the user can point at code in several files at once; text_selection is the newest entry. The snapshot field selected_at maps each selection kind (text, terminal, data, git_files, git_commits, explorer, cursor) to the time it last changed: when several selections exist, the newest entry in selected_at is what the user means by 'this'.",
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

const LIST_PEERS_TOOL = {
  name: 'list_peers', title: 'List live McFly peers',
  description: 'List every terminal hosted by the current McFly workspace. messageable requires both relay_enabled and session_available; interactive terminals need user opt-in, while relay-enabled terminals may still be waiting for session discovery.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      cwd: { type: 'string', description: 'Project directory, to pick the right McFly server. Defaults to the process cwd.' },
    },
  },
  outputSchema: {
    type: 'object', additionalProperties: false, required: ['schema', 'kind', 'peers'],
    properties: {
      schema: { const: 'mcfly.data.v1' }, kind: { const: 'peers' },
      peers: { type: 'array', items: { type: 'object' } },
    },
  },
  annotations: { readOnlyHint: true },
};

const SEND_MESSAGE_TOOL = {
  name: 'send_message', title: 'Message a live McFly peer',
  description: 'Send one complete message to a messageable McFly terminal. Use the stable peer id returned by list_peers. Relay must be enabled and McFly must have discovered the target session metadata used by the chat link.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['id', 'message'],
    properties: {
      id: { type: 'string', description: 'Stable peer id from list_peers.' },
      message: { type: 'string', description: 'Complete message to submit to the peer.' },
      cwd: { type: 'string', description: 'Project directory, to pick the right McFly server. Defaults to the process cwd.' },
    },
  },
  outputSchema: {
    type: 'object', additionalProperties: false, required: ['schema', 'kind', 'id', 'delivered', 'peer'],
    properties: {
      schema: { const: 'mcfly.data.v1' }, kind: { const: 'peer_message' },
      id: { type: 'string' }, delivered: { type: 'boolean' }, bracketed: { type: 'boolean' },
      peer: { type: 'object' },
    },
  },
  annotations: { destructiveHint: true, openWorldHint: true },
};

function liveServers() {
  try {
    const all = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.mcfly', 'servers.json'), 'utf8'));
    return all.filter((s) => { try { process.kill(s.pid, 0); return true; } catch { return false; } });
  } catch { return []; }
}

const workspacePath = (p) => {
  const source = String(p ?? '').replace(/\\/g, '/');
  const normalized = source === '/' ? source : source.replace(/\/+$/, '');
  return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
};

const scopeOwns = (scope, project) => {
  const have = workspacePath(scope);
  const want = workspacePath(project);
  return Boolean(have && want && (have === want || want.startsWith(have.endsWith('/') ? have : `${have}/`)));
};

export async function findWorkspaceState(servers, project, params = new URLSearchParams()) {
  const qs = new URLSearchParams(params);
  qs.set('project', project);
  for (const pick of [...servers].sort((a, b) => b.started - a.started)) {
    try {
      const res = await fetch(`http://127.0.0.1:${pick.port}/api/workspace-state?${qs}`);
      const data = await res.json();
      // Validate the returned scope too: older servers fell back to an
      // unrelated recent scope when they had no match.
      if (scopeOwns(data.scope, project)) return { pick, data };
    } catch { /* stale registry entry; try the next live server */ }
  }
  return null;
}

async function runWorkspaceState(args = {}) {
  const servers = liveServers();
  if (!servers.length) {
    return { content: [{ type: 'text', text: 'no running mcfly server found' }], isError: true };
  }
  const cwd = path.resolve(args.cwd ?? process.cwd());
  const qs = new URLSearchParams();
  if (args.history) qs.set('history', String(args.history));
  if (Array.isArray(args.kinds) && args.kinds.length) qs.set('kinds', args.kinds.join(','));
  if (args.since_seconds) qs.set('since_seconds', String(args.since_seconds));
  const found = await findWorkspaceState(servers, cwd, qs);
  if (!found) return { content: [{ type: 'text', text: `no McFly workspace found for ${cwd}` }], isError: true };
  const { pick, data } = found;
  const result = { schema: 'mcfly.data.v1', kind: 'workspace_state', server: { port: pick.port, pwd: pick.pwd }, ...data };
  return { content: [{ type: 'text', text: `${DATA_MARKER}\n${JSON.stringify(result)}` }], structuredContent: result };
}

const REVIEW_STATE_TOOL = {
  name: 'review_state',
  title: 'Read human reviews',
  description: "Human code reviews for this project: threaded comments the user anchored to lines, GitHub-review style. A review may carry a checklist — the user's punch list for a target diff: base (the ref being diffed against, HEAD = uncommitted work), files (each with status and reviewed: whether the human has looked at it yet), and reviewed/total progress. Use the checklist to know what the review is ABOUT and which files still await the human's eyes. Call it when a review is active, when the user mentions their review, comments, or checklist, or before starting work the user asked to be reviewed. Reply to threads with review_reply.",
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

function pickServer(args, servers = liveServers()) {
  if (!servers.length) return null;
  const cwd = path.resolve(args.cwd ?? process.cwd());
  // among cwd matches, prefer the newest server — it runs the newest code.
  // The server's pwd only picks WHICH server; reviews belong to the
  // project, so the query pwd is always the agent's own cwd.
  // A server that does NOT own this cwd is not a fallback: reviews would be
  // read from, and written to, an unrelated project.
  const pick = [...servers].sort((a, b) => b.started - a.started)
    .find((s) => scopeOwns(s.pwd, cwd));
  return pick ? { cwd, pick } : null;
}

const noWorkspace = (args) => ({
  content: [{ type: 'text', text: `no McFly workspace found for ${path.resolve(args.cwd ?? process.cwd())}` }],
  isError: true,
});

export async function runListPeers(args = {}, servers) {
  const found = pickServer(args, servers);
  if (!found) return noWorkspace(args);
  try {
    const response = await fetch(`http://127.0.0.1:${found.pick.port}/api/peers`);
    const peers = await response.json();
    if (!response.ok) throw new Error(peers.error ?? `HTTP ${response.status}`);
    const result = { schema: 'mcfly.data.v1', kind: 'peers', peers };
    return { content: [{ type: 'text', text: `${DATA_MARKER}\n${JSON.stringify(result)}` }], structuredContent: result };
  } catch (error) {
    return { content: [{ type: 'text', text: `peer lookup failed: ${error.message}` }], isError: true };
  }
}

export async function runSendMessage(args = {}, servers) {
  if (typeof args.id !== 'string' || !args.id || typeof args.message !== 'string' || !args.message.trim()) {
    return { content: [{ type: 'text', text: 'id and message are required' }], isError: true };
  }
  const found = pickServer(args, servers);
  if (!found) return noWorkspace(args);
  try {
    const response = await fetch(`http://127.0.0.1:${found.pick.port}/api/peer-message`, {
      method: 'POST', body: JSON.stringify({ id: args.id, message: args.message }),
    });
    const out = await response.json();
    if (!response.ok) return { content: [{ type: 'text', text: out.error ?? `HTTP ${response.status}` }], isError: true };
    const result = { schema: 'mcfly.data.v1', kind: 'peer_message', ...out };
    return { content: [{ type: 'text', text: `${DATA_MARKER}\n${JSON.stringify(result)}` }], structuredContent: result };
  } catch (error) {
    return { content: [{ type: 'text', text: `peer message failed: ${error.message}` }], isError: true };
  }
}

async function reviewFetch(args, route, payload) {
  const found = pickServer(args);
  if (!found) return null;
  const { cwd, pick } = found;
  const res = payload
    ? await fetch(`http://127.0.0.1:${pick.port}${route}`, { method: 'POST', body: JSON.stringify({ ...payload, pwd: cwd }) })
    : await fetch(`http://127.0.0.1:${pick.port}${route}?pwd=${encodeURIComponent(cwd)}`);
  return res.json();
}

// a review with a checklist gets its TARGET DIFF resolved: which files
// differ from the base ref right now, and which the human already reviewed
async function enrichChecklist(review, args) {
  const base = review.checklist?.base;
  if (!base) return review;
  const found = pickServer(args);
  if (!found) return review;
  try {
    const d = await fetch(`http://127.0.0.1:${found.pick.port}/api/git/reffiles?root=${encodeURIComponent(review.project)}&ref=${encodeURIComponent(base)}`)
      .then((r) => r.json());
    if (d.error) return { ...review, checklist: { base, error: String(d.error) } };
    const files = checklistFiles(d.files, review.checklist.checked);
    return {
      ...review,
      checklist: {
        base,
        base_resolved: d.ref,
        files,
        reviewed: files.filter((f) => f.reviewed).length,
        total: files.length,
      },
    };
  } catch {
    return review;
  }
}

export function checklistFiles(files = [], checked = {}) {
  return files.map((f) => ({ status: f.status, path: f.path, reviewed: checked?.[f.path] === f.sig }));
}

async function runReviewState(args = {}) {
  try {
    const reviews = await reviewFetch(args, '/api/reviews');
    if (reviews === null) return noWorkspace(args);
    const filtered = args.all ? reviews : reviews.filter((r) => r.status === 'open');
    const enriched = await Promise.all(filtered.map((r) => enrichChecklist(r, args)));
    const result = { schema: 'mcfly.data.v1', kind: 'review_state', reviews: enriched };
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
    if (out === null) return noWorkspace(args);
    if (out.error) return { content: [{ type: 'text', text: out.error }], isError: true };
    const result = { schema: 'mcfly.data.v1', kind: 'review_reply', review_id: out.id, comment_id: args.comment_id };
    return { content: [{ type: 'text', text: `${DATA_MARKER}\n${JSON.stringify(result)}` }], structuredContent: result };
  } catch (error) {
    return { content: [{ type: 'text', text: `reply failed: ${error.message}` }], isError: true };
  }
}

const DATA_MATCHER_TOOL = {
  name: 'data_matcher',
  title: 'Route a tool\'s results to the data pane',
  description: "Teach McFly that another tool's results are DATA: matching calls render in the user's data pane as JSON, with no extra work from you — you keep calling the tool normally. Use it when a tool you are about to call repeatedly returns structured output the user will want to read as data (an API client, a query tool, a Bash command emitting JSON). Scope with workspace and/or session; omit both for every project. Optional transform is a JavaScript function BODY receiving `data` (the parsed result) and returning what to display — use it to reshape noisy output into something readable. It runs sandboxed in the user's browser, so no I/O, no require, no await. action: 'list' shows the current rules, 'remove' deletes one by id.",
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      action: { enum: ['set', 'list', 'remove'], description: "Default 'set'." },
      id: { type: 'string', description: 'Existing matcher id: to update it, or to remove it.' },
      name: { type: 'string', description: 'Short label shown in settings.' },
      tool: { type: 'string', description: 'Glob matched against the tool name, e.g. "mcp__github__*", "Bash", "*_query".' },
      params: {
        type: 'object', additionalProperties: { type: 'string' },
        description: 'Optional. Param name -> glob that the call\'s params must match, e.g. {"command": "kubectl get* -o json"}. All listed params must match.',
      },
      workspace: { type: 'string', description: 'Optional project directory. The matcher applies there and below it.' },
      session: { type: 'string', description: 'Optional session id. The matcher applies to that transcript only.' },
      transform: { type: 'string', description: 'Optional JavaScript function body: receives `data`, returns the value to render. Sandboxed, synchronous, no I/O.' },
      enabled: { type: 'boolean', description: 'Default true.' },
      cwd: { type: 'string', description: 'Project directory, to pick the right McFly server. Defaults to the process cwd.' },
    },
  },
  outputSchema: {
    type: 'object', required: ['schema', 'kind'],
    properties: { schema: { const: 'mcfly.data.v1' }, kind: { const: 'data_matcher' } },
  },
};

async function runDataMatcher(args = {}) {
  const action = args.action ?? 'set';
  const body = { ...args };
  delete body.action;
  delete body.cwd;
  try {
    let out;
    if (action === 'list') out = await matcherFetch(args, 'GET');
    else if (action === 'remove') {
      if (!args.id) return { content: [{ type: 'text', text: 'id is required to remove a matcher' }], isError: true };
      const all = await matcherFetch(args, 'GET');
      if (all === null) return noWorkspace(args);
      if (!all.some((m) => m.id === args.id)) {
        return { content: [{ type: 'text', text: `no matcher with id ${args.id}` }], isError: true };
      }
      out = await matcherFetch(args, 'POST', all.filter((m) => m.id !== args.id));
    } else {
      if (!args.tool) return { content: [{ type: 'text', text: 'tool pattern is required' }], isError: true };
      const all = await matcherFetch(args, 'GET');
      if (all === null) return noWorkspace(args);
      const at = args.id ? all.findIndex((m) => m.id === args.id) : -1;
      out = await matcherFetch(args, 'POST', at >= 0
        ? all.map((m, i) => (i === at ? { ...m, ...body } : m))
        : [...all, body]);
    }
    if (out === null) return noWorkspace(args);
    if (out.error) return { content: [{ type: 'text', text: out.error }], isError: true };
    const result = { schema: 'mcfly.data.v1', kind: 'data_matcher', action, matchers: out };
    return { content: [{ type: 'text', text: `${DATA_MARKER}\n${JSON.stringify(result)}` }], structuredContent: result };
  } catch (error) {
    return { content: [{ type: 'text', text: `data_matcher failed: ${error.message}` }], isError: true };
  }
}

async function matcherFetch(args, method, payload) {
  const found = pickServer(args);
  if (!found) return null;
  const url = `http://127.0.0.1:${found.pick.port}/api/data-matchers`;
  const res = method === 'POST'
    ? await fetch(url, { method: 'POST', body: JSON.stringify(payload) })
    : await fetch(url);
  return res.json();
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
  const format = args.format ?? 'tsv';
  if (!TABLE_FORMATS.includes(format)) {
    return { content: [{ type: 'text', text: `format must be one of: ${TABLE_FORMATS.join(', ')}` }], isError: true };
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
  const data = exitCode === 0 ? parseTable(stdout, format) : null;
  if (!data) {
    const reason = exitCode ? `command exited ${exitCode}` : `stdout is not valid ${format}`;
    return { content: [{ type: 'text', text: [reason, stdout, stderr].filter(Boolean).join('\n') }], isError: true };
  }
  const result = { schema: 'mcfly.data.v1', kind: 'table', command: args.script, format, cwd, exitCode, stdout, stderr, data };
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

// the tool table: one row per tool, in the order they are advertised. Adding a
// tool is one entry, not three edits.
const TOOLS = [
  [TOOL, runTable],
  [HIGHLIGHT_TOOL, runHighlight],
  [WAYPOINT_TOOL, runWaypoint],
  [WAYPOINT_REMOVE_TOOL, runWaypointRemove],
  [WORKSPACE_STATE_TOOL, runWorkspaceState],
  [REVIEW_STATE_TOOL, runReviewState],
  [REVIEW_REPLY_TOOL, runReviewReply],
  [DATA_MATCHER_TOOL, runDataMatcher],
  [LIST_PEERS_TOOL, runListPeers],
  [SEND_MESSAGE_TOOL, runSendMessage],
];

async function handle(request) {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} }, serverInfo: { name: 'mcfly', version: VERSION }, instructions: INSTRUCTIONS,
      };
    case 'ping': return {};
    case 'tools/list': return { tools: TOOLS.map(([tool]) => tool) };
    case 'tools/call': {
      const run = TOOLS.find(([tool]) => tool.name === request.params?.name)?.[1];
      if (!run) throw new Error(`unknown tool: ${request.params?.name}`);
      return run(request.params.arguments);
    }
    default: throw Object.assign(new Error(`method not found: ${request.method}`), { code: -32601 });
  }
}

// Requests are dispatched as they arrive rather than awaited in turn: run_table
// can hold the process for two minutes, and nothing else the agent asks for
// should queue behind it. Responses carry their id, so replying out of order is
// exactly what JSON-RPC expects.
export async function startMcp() {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const inFlight = new Set();
  for await (const line of lines) {
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (request.id === undefined) continue;
    const done = handle(request).then(
      (result) => ({ jsonrpc: '2.0', id: request.id, result }),
      (error) => ({
        jsonrpc: '2.0', id: request.id,
        error: { code: error.code ?? -32603, message: error.message ?? String(error) },
      }),
    ).then((message) => process.stdout.write(`${JSON.stringify(message)}\n`));
    inFlight.add(done);
    done.finally(() => inFlight.delete(done));
  }
  await Promise.allSettled(inFlight); // stdin closed: let the last replies out
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

// Cursor Agent has no `mcp add`: it reads ~/.cursor/mcp.json. Merge into it
// rather than writing the manifest over the user's other servers.
//
// A file that exists but will not parse is NOT treated as absent: rewriting it
// would silently delete every other MCP server the user configured. Report the
// failure and touch nothing.
const CURSOR_FAILED = 'cursor-agent: unavailable or configuration failed';

function configureCursorFile() {
  const file = path.join(os.homedir(), '.cursor', 'mcp.json');
  if (!fs.existsSync(path.dirname(file))) return CURSOR_FAILED;
  let config = {};
  if (fs.existsSync(file)) {
    try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return CURSOR_FAILED; }
    if (!config || typeof config !== 'object' || Array.isArray(config)) return CURSOR_FAILED;
  }
  const servers = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {};
  if (servers.mcfly) return 'cursor-agent: already configured';
  try {
    fs.writeFileSync(file, `${JSON.stringify({ ...config, mcpServers: { ...servers, mcfly: START } }, null, 2)}\n`);
    return 'cursor-agent: configured';
  } catch { return CURSOR_FAILED; }
}

export function configureMcp() {
  const dir = path.join(os.homedir(), '.mcfly');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, `${JSON.stringify(MANIFEST, null, 2)}\n`);
  const adapters = [
    configure('codex', ['mcp', 'add', 'mcfly', '--', START.command, ...START.args]),
    configure('claude', ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'mcfly', '--', START.command, ...START.args]),
    configureCursorFile(),
  ];
  return { file, manifest: MANIFEST, adapters };
}
