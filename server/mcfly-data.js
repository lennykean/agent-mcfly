export const DATA_MARKER = 'MCFLY_DATA_V1';

export const isTableTool = (name) => /(?:^|__)mcfly__run_table$/.test(String(name));
export const isHighlightTool = (name) => /(?:^|__)mcfly__highlight$/.test(String(name));
export const isWaypointTool = (name) => /(?:^|__)mcfly__waypoint$/.test(String(name));
export const isWaypointRemoveTool = (name) => /(?:^|__)mcfly__waypoint_remove$/.test(String(name));

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

export function parseTsv(stdout) {
  const lines = String(stdout).replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const columns = lines.shift()?.split('\t') ?? [];
  const rows = lines.map((line) => line.split('\t'));
  if (columns.length < 2 || !rows.length || columns.some((cell) => !cell)
    || new Set(columns).size !== columns.length || rows.some((row) => row.length !== columns.length)) return null;
  return { columns, rows };
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
  const at = value.indexOf(DATA_MARKER);
  if (at >= 0) {
    try { return dataEnvelope(JSON.parse(value.slice(at + DATA_MARKER.length).trim())); } catch { return null; }
  }
  // structuredContent-bearing MCP results reach transcripts as the bare
  // serialized envelope — the marker text is replaced, so match by shape
  if (!value.includes('"mcfly.data.v1"')) return null;
  try { return dataEnvelope(JSON.parse(value)); } catch { /* surrounding text */ }
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return dataEnvelope(JSON.parse(value.slice(start, end + 1))); } catch { return null; }
}

export function tableResult(value) {
  const result = dataEnvelope(value);
  const table = result?.kind === 'table' && parseTsv(result.stdout);
  if (!result || !table) return null;
  return {
    verb: 'data', command: result.command, cwd: result.cwd, stdout: result.stdout,
    stderr: result.stderr, exit_code: result.exitCode, table,
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
