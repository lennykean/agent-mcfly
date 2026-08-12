export const DATA_MARKER = 'MCFLY_DATA_V1';

export const isTableTool = (name) => /(?:^|__)mcfly__run_table$/.test(String(name));

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
  if (value?.schema === 'mcfly.data.v1' && value.kind === 'table') return value;
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
  if (at < 0) return null;
  try { return dataEnvelope(JSON.parse(value.slice(at + DATA_MARKER.length).trim())); } catch { return null; }
}

export function tableResult(value) {
  const result = dataEnvelope(value);
  const table = result && parseTsv(result.stdout);
  if (!result || !table) return null;
  return {
    verb: 'data', command: result.command, cwd: result.cwd, stdout: result.stdout,
    stderr: result.stderr, exit_code: result.exitCode, table,
  };
}
