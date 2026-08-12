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

export type RenderVerb = 'read_file' | 'patch_file' | 'write_file' | 'exec' | 'data' | 'spawn_agent' | 'other';

export interface CallRender {
  verb: RenderVerb;
  title?: string;
  path?: string;
  command?: string;
  agent_type?: string;
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
  content?: string;
  start_line?: number;
  total_lines?: number;
  region?: { start: number; end: number }; // 1-based lines of interest in content
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
