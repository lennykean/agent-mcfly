export const DATA_MARKER = 'MCFLY_DATA_V1';

export const isTableTool = (name) => /(?:^|__)mcfly__run_table$/.test(String(name));
export const isHighlightTool = (name) => /(?:^|__)mcfly__highlight$/.test(String(name));
export const isWaypointTool = (name) => /(?:^|__)mcfly__waypoint$/.test(String(name));
export const isWaypointRemoveTool = (name) => /(?:^|__)mcfly__waypoint_remove$/.test(String(name));
export const isPeerMessageTool = (name) => /(?:^|__)mcfly__send_message$/.test(String(name));
export const isSpawnAgentTool = (name) => /(?:^|__)mcfly__spawn_agent$/.test(String(name));

// "12,40-45" (or an array of the same pieces) -> [{start,end}], or null
export function parseLineSpec(spec) {
  const parts = (Array.isArray(spec) ? spec : String(spec ?? '').split(',')).map((p) => String(p).trim()).filter(Boolean);
  if (!parts.length) return null;
  const ranges = [];
  for (const part of parts) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const start = Number(m[1]);
    const end = Number(m[2] ?? m[1]);
    if (start < 1 || end < start) return null;
    ranges.push({ start, end });
  }
  return ranges.sort((a, b) => a.start - b.start);
}

export const TABLE_FORMATS = ['tsv', 'csv', 'json'];

// What every format must land on to be a table: a unique, non-empty header
// row, at least two columns, at least one data row, and no ragged rows.
function tableFrom(grid) {
  const [columns, ...rows] = grid;
  if (!columns || columns.length < 2 || !rows.length || columns.some((cell) => !cell)
    || new Set(columns).size !== columns.length || rows.some((row) => row.length !== columns.length)) return null;
  return { columns, rows };
}

export function parseTsv(stdout) {
  const lines = String(stdout).replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  return tableFrom(lines.map((line) => line.split('\t')));
}

// RFC4180: a quoted field may hold the delimiter, newlines, and "" escapes.
export function parseCsv(stdout) {
  const source = String(stdout).replace(/\r\n/g, '\n').replace(/\n$/, '');
  const grid = [];
  let row = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false; // an empty field that was written as "" is still a field
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (source[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
      continue;
    }
    if (c === '"' && !field && !wasQuoted) { quoted = true; wasQuoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; wasQuoted = false; continue; }
    if (c === '\n') { row.push(field); grid.push(row); row = []; field = ''; wasQuoted = false; continue; }
    field += c;
  }
  if (quoted) return null; // unterminated quote: the output is not CSV
  if (field || wasQuoted || row.length) { row.push(field); grid.push(row); }
  return tableFrom(grid);
}

const cellText = (value) => (value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));

// Either a list of row objects (columns are the union of their keys, in
// first-seen order) or an explicit { columns, rows }.
export function parseJsonTable(stdout) {
  let value = stdout;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)
    && Array.isArray(value.columns) && Array.isArray(value.rows)) {
    return tableFrom([
      value.columns.map(cellText),
      ...value.rows.map((row) => (Array.isArray(row) ? row.map(cellText) : [])),
    ]);
  }
  if (!Array.isArray(value) || !value.length) return null;
  const columns = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    for (const key of Object.keys(item)) if (!columns.includes(key)) columns.push(key);
  }
  return tableFrom([columns, ...value.map((item) => columns.map((key) => cellText(item[key])))]);
}

export function parseTable(stdout, format = 'tsv') {
  if (format === 'csv') return parseCsv(stdout);
  if (format === 'json') return parseJsonTable(stdout);
  return parseTsv(stdout);
}

export function tableCall(input) {
  let args = input;
  if (typeof input === 'string') {
    try { args = JSON.parse(input); } catch { args = {}; }
  }
  return {
    verb: 'data', command: args?.script ?? '', title: args?.title ?? 'table', cwd: args?.cwd,
  };
}

export function dataEnvelope(value) {
  if (value?.schema === 'mcfly.data.v1' && typeof value.kind === 'string') return value;
  if (value && typeof value === 'object') {
    for (const key of ['structuredContent', 'structured_content', 'result', 'output']) {
      const found = dataEnvelope(value[key]);
      if (found) return found;
    }
    if (Array.isArray(value.content)) {
      for (const item of value.content) {
        const found = dataEnvelope(item?.text ?? item);
        if (found) return found;
      }
    }
  }
  if (typeof value !== 'string') return null;
  try {
    const found = dataEnvelope(JSON.parse(value));
    if (found) return found;
  } catch { /* surrounding text */ }
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const found = dataEnvelope(JSON.parse(value.slice(start, end + 1)));
      if (found) return found;
    } catch { /* marker text or unrelated output */ }
  }
  const at = value.indexOf(DATA_MARKER);
  if (at >= 0) {
    try { return dataEnvelope(JSON.parse(value.slice(at + DATA_MARKER.length).trim())); } catch { return null; }
  }
  // structuredContent-bearing MCP results reach transcripts as the bare
  // serialized envelope — the marker text is replaced, so match by shape
  if (!value.includes('"mcfly.data.v1"')) return null;
  return null;
}

export function tableResult(value) {
  const result = dataEnvelope(value);
  // envelopes written before formats were selectable carry no `format` and are
  // always TSV
  const table = result?.kind === 'table' && parseTable(result.stdout, result.format);
  if (!result || !table) return null;
  return {
    verb: 'data', command: result.command, cwd: result.cwd, stdout: result.stdout,
    stderr: result.stderr, exit_code: result.exitCode, format: result.format ?? 'tsv', table,
  };
}

export function peerMessageCall(input) {
  let args = input;
  if (typeof input === 'string') {
    try { args = JSON.parse(input); } catch { args = {}; }
  }
  return { verb: 'peer_message', peer_id: args?.id, title: 'message peer' };
}

export function peerMessageResult(value) {
  const result = dataEnvelope(value);
  if (result?.kind !== 'peer_message' || (result.delivered !== true && result.queued !== true) || !result.peer?.id) return null;
  return { verb: 'peer_message', status: result.queued ? 'queued' : 'delivered', peer: result.peer };
}

export function spawnAgentCall(input) {
  let args = input;
  if (typeof input === 'string') {
    try { args = JSON.parse(input); } catch { args = {}; }
  }
  const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
  return {
    verb: 'spawn_agent', agent_type: args?.harness ?? 'agent',
    title: prompt.length > 80 ? `${prompt.slice(0, 79)}…` : prompt || 'agent',
    launch_kind: args?.kind ?? 'subagent',
  };
}

export function spawnAgentResult(value) {
  const result = dataEnvelope(value);
  if (result?.kind !== 'agent_spawn' || !result.provider || !result.session_id || !result.workspace) return null;
  if (result.launch_kind === 'peer' && !result.peer?.id) return null;
  return {
    verb: 'spawn_agent', agent_type: result.harness ?? result.provider, status: 'running',
    launch_kind: result.launch_kind ?? 'subagent',
    ...(result.launch_kind === 'peer'
      ? { peer: result.peer }
      : {
          child_session_id: result.session_id,
          child_provider: result.provider,
          child_workspace: result.workspace,
        }),
  };
}

export function waypointCall(input) {
  let args = input;
  if (typeof input === 'string') {
    try { args = JSON.parse(input); } catch { args = {}; }
  }
  const name = String(args?.path ?? '').split(/[\\/]/).pop() || 'waypoint';
  return { verb: 'other', title: `waypoint ${name}:${args?.line ?? '?'}` };
}

export function waypointResult(value) {
  const result = dataEnvelope(value);
  if (result?.kind !== 'waypoint' || typeof result.anchor !== 'string') return null;
  return {
    verb: 'other',
    waypoint: {
      path: result.path, line: result.line, note: result.note ?? '',
      before: Array.isArray(result.before) ? result.before : [],
      anchor: result.anchor,
      after: Array.isArray(result.after) ? result.after : [],
      // the file as the agent marked it, when the envelope carries it: the
      // live view shows the waypoint in session content, not the disk file
      ...(typeof result.content === 'string' ? { content: result.content } : {}),
    },
  };
}

export function waypointRemoveCall(input) {
  let args = input;
  if (typeof input === 'string') {
    try { args = JSON.parse(input); } catch { args = {}; }
  }
  const name = String(args?.path ?? '').split(/[\\/]/).pop() || '?';
  return { verb: 'other', title: `remove waypoint ${name}${args?.line ? ':' + args.line : ''}` };
}

export function waypointRemoveResult(value) {
  const result = dataEnvelope(value);
  if (result?.kind !== 'waypoint_remove' || typeof result.path !== 'string') return null;
  return {
    verb: 'other',
    waypoint_remove: { path: result.path, ...(result.line ? { line: result.line } : {}) },
  };
}

export function highlightCall(input) {
  let args = input;
  if (typeof input === 'string') {
    try { args = JSON.parse(input); } catch { args = {}; }
  }
  const p = args?.path ?? '';
  return { verb: 'read_file', path: p, title: String(p).split(/[\\/]/).pop() || 'highlight' };
}

export function highlightResult(value) {
  const result = dataEnvelope(value);
  if (result?.kind !== 'file' || typeof result.content !== 'string') return null;
  const total = result.content.split(/\r?\n/).length;
  const highlights = Array.isArray(result.highlights) ? result.highlights : [];
  return {
    verb: 'read_file', path: result.path, content: result.content,
    start_line: 1, total_lines: total,
    // first range drives the existing scroll+flash; all ranges render as bands
    ...(highlights.length ? { region: highlights[0], highlights } : {}),
  };
}
