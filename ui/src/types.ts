// Wire format: simulacra-shaped normalized messages plus provider-neutral
// render verbs attached by the server-side loader. The UI never sees
// provider-specific tool names except as display labels.

export interface SessionMeta {
  id: string;
  provider: string;
  project?: string;
  label: string;
  cwd?: string;
  updated_at: number;
  size: number;
}

// Local workspaces omit this. Remote workspaces keep the SSH connection
// identity separate from their path so identical paths on two hosts do not
// collapse into one project.
export interface WorkspaceSource {
  connection: string;
  host: string;
  port: number;
}

export type RenderVerb = 'read_file' | 'patch_file' | 'write_file' | 'exec' | 'data' | 'spawn_agent' | 'other';

// A note anchored to a line by its surrounding context (a zero-change hunk):
// re-locatable in the current file even after the code moves.
export interface Waypoint {
  path: string;
  line: number; // 1-based line at capture time
  note: string; // markdown
  before: string[];
  anchor: string;
  after: string[];
  content?: string; // the whole file at capture time, when the envelope carries it
}

export interface CallRender {
  verb: RenderVerb;
  title?: string;
  path?: string;
  source_path?: string; // original path for a move/rename
  removed?: boolean;
  command?: string;
  agent_type?: string;
  // a spawn knows its child as soon as the child announces itself (claude's
  // meta sidecar, codex's spawn result) — the tree needs no death to show it
  agent_id?: string;
  child_session_id?: string;
}

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface ResultRender {
  verb: RenderVerb;
  path?: string;
  source_path?: string; // original path for a move/rename
  removed?: boolean;
  content?: string;
  start_line?: number;
  total_lines?: number;
  region?: { start: number; end: number }; // 1-based lines of interest in content
  highlights?: { start: number; end: number }[]; // persistent highlight bands (mcfly highlight tool)
  waypoint?: Waypoint; // mcfly waypoint tool: context-anchored note
  waypoint_remove?: { path: string; line?: number }; // lifts waypoints from this step on
  image_src?: string; // data URI for image reads
  hunks?: PatchHunk[];
  stdout?: string;
  stderr?: string;
  command?: string;
  cwd?: string;
  interrupted?: boolean;
  exit_code?: number;
  table?: { columns: string[]; rows: string[][] };
  agent_id?: string;
  agent_type?: string;
  status?: string;
  summary?: string;
  child_session_id?: string;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thought: string }
  | { type: 'tool'; tool_request_id: string; tool: string; params: unknown; extended?: { render: CallRender } }
  | { type: 'tool_result'; tool_request_id: string; tool: string; result: unknown; extended?: { render: ResultRender; is_error?: boolean } };

export interface Message {
  id?: string;
  timestamp?: number;
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

// ---- human review: session-scoped threaded comments on code ----

export interface ReviewReply { author: string; body: string; ts: number }

export interface ReviewComment {
  id: string;
  author: string;
  ts: number;
  state: 'open' | 'addressed' | 'resolved';
  path: string;
  line: number; // line at capture time (range start)
  line_end?: number; // range end, when the comment covers several lines
  step?: number; // playhead step when commented from a historical view
  before: string[];
  anchor: string;
  after: string[];
  body: string;
  replies: ReviewReply[];
}

export interface Review {
  id: string;
  project: string;
  session: { provider: string; id: string } | null;
  status: 'open' | 'closed';
  created: number;
  closed?: number;
  comments: ReviewComment[];
  // the punch list: diff-from-base file checklist; checked maps path -> the
  // content signature it had when ticked (a change auto-unchecks it)
  checklist?: { base?: string | null; checked?: Record<string, string> };
}

export interface TailResponse {
  messages: Message[];
  cursor: number;
  mtime: number;
  size: number;
}

// ---- timeline (client-side model) ----

export type Step =
  | { kind: 'user'; text: string; ts?: number }
  | { kind: 'assistant'; text: string; ts?: number }
  | { kind: 'thinking'; text: string; ts?: number }
  | {
      kind: 'tool';
      ts?: number;
      tool: string;
      requestId: string;
      call: CallRender;
      params: unknown;
      // attached later when the result message arrives
      result?: ResultRender;
      resultData?: unknown;
      isError?: boolean;
    };

export interface Timeline {
  key: string; // 'main' or child session id
  sessionId: string;
  provider: string;
  steps: Step[];
  cursor: number; // server byte cursor
  mtime: number;
  pending: Map<string, number>; // requestId -> step index awaiting result
}
