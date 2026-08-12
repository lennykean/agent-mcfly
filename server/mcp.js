import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_MARKER, parseTsv } from './mcfly-data.js';

const exec = promisify(execFile);
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version;
const INSTRUCTIONS = 'Use run_table for shell commands whose stdout is tabular data. The script must emit strict TSV: one unique, non-empty header row, at least two columns, at least one data row, and the same number of tab-separated cells on every row. Do not emit decoration or commentary to stdout; send diagnostics to stderr.';
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
    case 'tools/list': return { tools: [TOOL] };
    case 'tools/call':
      if (request.params?.name !== TOOL.name) throw new Error(`unknown tool: ${request.params?.name}`);
      return runTable(request.params.arguments);
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
