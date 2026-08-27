// MCP agent launcher. Providers own execution and transcript persistence;
// McFly starts them, learns the provider-issued identity, and resolves that
// exact identity to the existing loader path.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as claudeCode from './loaders/claude-code.js';
import * as codex from './loaders/codex.js';
import * as cursor from './loaders/cursor.js';
import { hasTerminalControls, killPty, killTree, launchAgentPty, setPtySession, toolPath } from './pty.js';

export const AGENT_PROVIDERS = Object.freeze({
  codex: {
    harness: 'codex', provider: 'codex', executable: 'codex',
    headless: ['exec', '--json'], peer: [],
  },
  claude: {
    harness: 'claude', provider: 'claude-code', executable: 'claude',
    headless: ['-p'], peer: [],
  },
  cursor: {
    harness: 'cursor', provider: 'cursor', executable: 'cursor-agent',
    // The MCP route already realpath-confines cwd to the selected McFly
    // workspace. Skip Cursor's duplicate workspace prompt; tool approvals keep
    // using the caller's normal Cursor settings.
    headless: ['-p', '--trust'], peer: ['--trust'],
  },
});

const LOADERS = { codex, 'claude-code': claudeCode, cursor };

export function listAgentProviders(find = toolPath, supportsCursor = cursor.cursorTranscriptsSupported) {
  return Object.values(AGENT_PROVIDERS).map((p) => {
    const executable = !!find(p.executable);
    const cursorSupported = p.provider !== 'cursor' || supportsCursor();
    return {
      harness: p.harness, provider: p.provider, executable: p.executable,
      available: executable && cursorSupported, kinds: ['subagent', 'peer'],
      ...(!executable ? { reason: `${p.executable} is not on PATH` }
        : !cursorSupported ? { reason: 'Cursor transcript discovery needs node:sqlite enabled in this Node runtime' } : {}),
    };
  });
}

function launchError(message, status = 400, code = 'AGENT_LAUNCH_FAILED') {
  return Object.assign(new Error(message), { status, code });
}

function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'CLAUDECODE' || key === 'NO_COLOR' || key.startsWith('CLAUDE_CODE_')) continue;
    env[key] = value;
  }
  return env;
}

function commandSpec(file, args, prompt) {
  const env = cleanEnv();
  if (process.platform !== 'win32' || !/\.(?:ps1|cmd|bat)$/i.test(file)) {
    return { command: file, args: prompt === undefined ? args : [...args, prompt], env };
  }
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const promptArg = prompt === undefined ? '' : ' $env:MCFLY_AGENT_PROMPT';
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `& ${quote(file)} ${args.map(quote).join(' ')}${promptArg}; exit $LASTEXITCODE`],
    env: prompt === undefined ? env : { ...env, MCFLY_AGENT_PROMPT: prompt },
  };
}

export function codexThreadId(line) {
  try {
    const event = JSON.parse(line);
    if (event?.type === 'thread.started' && typeof event.thread_id === 'string') return event.thread_id;
  } catch { /* incomplete or non-machine output */ }
  return null;
}

function startHeadless(executable, args, prompt, cwd, find = toolPath, start = spawn, idFromLine, terminateTree = killTree) {
  const file = find(executable);
  if (!file) throw launchError(`${executable} is not available`, 409, 'AGENT_PROVIDER_UNAVAILABLE');
  const spec = commandSpec(file, args, prompt);
  const child = start(spec.command, spec.args, {
    cwd, env: spec.env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { child, exited: false, code: null, error: null, sessionId: null };
  let pending = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) state.sessionId ??= idFromLine?.(line) ?? null;
  });
  child.stderr?.resume();
  child.once('exit', (code) => {
    state.sessionId ??= idFromLine?.(pending) ?? null;
    state.exited = true;
    state.code = code;
  });
  child.once('error', (error) => { state.exited = true; state.error = error; });
  state.cancel = () => {
    if (state.exited) return;
    state.exited = true;
    if (child.pid) terminateTree(child.pid);
    try { child.kill(); } catch { /* already gone */ }
  };
  state.release = () => {
    child.unref?.();
    child.stdout?.unref?.();
    child.stderr?.unref?.();
  };
  return state;
}

async function createCursorChat(executable, cwd, find = toolPath, start = spawn, timeoutMs = 30_000) {
  const file = find(executable);
  if (!file) throw launchError(`${executable} is not available`, 409, 'AGENT_PROVIDER_UNAVAILABLE');
  const spec = commandSpec(file, ['create-chat']);
  const child = start(spec.command, spec.args, {
    cwd, env: spec.env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (child.pid) killTree(child.pid);
      reject(launchError('cursor-agent create-chat timed out', 504, 'AGENT_SESSION_NOT_FOUND'));
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (value) => { clearTimeout(timer); resolve(value); });
  });
  if (code !== 0) throw launchError(`cursor-agent create-chat exited ${code}: ${stderr.trim()}`.trim(), 500);
  const id = stdout.trim();
  if (!id || /\s/.test(id)) throw launchError('cursor-agent create-chat did not return a stable chat id', 500);
  return id;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function issuedIdMatches(provider, session, issuedId) {
  const normalized = String(session.id ?? '').replace(/\\/g, '/');
  const leaf = normalized.split('/').at(-1);
  if (provider === 'codex') {
    const stem = leaf?.replace(/\.jsonl$/i, '');
    return stem === issuedId || stem?.endsWith(`-${issuedId}`);
  }
  if (provider === 'claude-code') return leaf === `${issuedId}.jsonl`;
  if (provider === 'cursor') return leaf === issuedId || normalized === issuedId;
  return false;
}

export async function discoverLaunchedSession(loader, cwd, provider, correlation, state, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const issuedId = correlation.issuedId ?? state?.sessionId;
    const found = issuedId
      ? loader.listForCwd(cwd).filter((session) => issuedIdMatches(provider, session, issuedId))
      : correlation.marker ? loader.findByLaunchMarker?.(cwd, correlation.marker, correlation.startedAt) ?? [] : [];
    if (found.length === 1) return found[0];
    if (found.length > 1) throw launchError('more than one session matched the launched agent identity', 409, 'AGENT_SESSION_AMBIGUOUS');
    if (state?.error) throw launchError(`agent failed to start: ${state.error.message}`, 500);
    if (state?.exited && state.code !== 0) throw launchError(`agent exited ${state.code} before its session was discovered`, 500);
    await delay(Math.max(0, Math.min(100, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw launchError('agent started, but its transcript session was not discovered in time', 504, 'AGENT_SESSION_NOT_FOUND');
}

function directory(value, code = 'INVALID_AGENT_CWD') {
  const resolved = path.resolve(value);
  try {
    if (!fs.statSync(resolved).isDirectory()) throw new Error();
    return fs.realpathSync(resolved);
  } catch { throw launchError(`cwd is not a directory: ${resolved}`, 400, code); }
}

function launchCwd(value, scope) {
  const cwd = directory(value);
  if (!scope) return cwd;
  const root = directory(scope);
  const relative = path.relative(root, cwd);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw launchError('cwd is outside this McFly server workspace', 403, 'AGENT_CWD_OUT_OF_SCOPE');
  }
  return cwd;
}

export async function launchAgent(input, deps = {}) {
  const harness = typeof input?.harness === 'string' ? input.harness.trim() : '';
  const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
  const kind = input?.kind ?? 'subagent';
  const provider = AGENT_PROVIDERS[harness];
  if (!provider) throw launchError('harness must be codex, claude, or cursor', 400, 'INVALID_AGENT_PROVIDER');
  if (!prompt) throw launchError('prompt is required', 400, 'INVALID_AGENT_PROMPT');
  if (Buffer.byteLength(prompt) > 16 * 1024) throw launchError('prompt is too large', 413, 'INVALID_AGENT_PROMPT');
  if (hasTerminalControls(prompt)) throw launchError('prompt contains terminal control characters', 400, 'INVALID_AGENT_PROMPT');
  if (!['subagent', 'peer'].includes(kind)) throw launchError('kind must be subagent or peer', 400, 'INVALID_AGENT_KIND');
  if (provider.provider === 'cursor' && !(deps.cursorTranscriptsSupported ?? cursor.cursorTranscriptsSupported)()) {
    throw launchError('Cursor transcript discovery needs node:sqlite enabled in this Node runtime', 409, 'AGENT_PROVIDER_UNAVAILABLE');
  }
  const cwd = launchCwd(input.cwd ?? deps.scope ?? process.cwd(), deps.scope);
  const find = deps.toolPath ?? toolPath;
  if (!find(provider.executable)) throw launchError(`${provider.executable} is not available`, 409, 'AGENT_PROVIDER_UNAVAILABLE');
  const loader = (deps.loaders ?? LOADERS)[provider.provider];
  const correlation = { startedAt: Date.now() };
  let launchPrompt = prompt;
  let args = [...provider[kind === 'peer' ? 'peer' : 'headless']];
  let peer;
  let peerLinked = false;
  let state = null;
  let linked = false;
  try {
    if (provider.provider === 'claude-code') {
      correlation.issuedId = (deps.randomUUID ?? crypto.randomUUID)();
      args.push('--session-id', correlation.issuedId);
    } else if (provider.provider === 'cursor') {
      correlation.issuedId = await (deps.createCursorChat ?? createCursorChat)(
        provider.executable, cwd, find, deps.spawn ?? spawn, deps.timeoutMs,
      );
      args.push('--resume', correlation.issuedId);
    } else if (kind === 'peer') {
      correlation.marker = (deps.randomUUID ?? crypto.randomUUID)();
      launchPrompt += `\n\n<!-- mcfly-launch:${correlation.marker} -->`;
    }
    if (kind === 'peer') peer = (deps.launchAgentPty ?? launchAgentPty)(provider.executable, cwd, args, launchPrompt);
    else state = (deps.startHeadless ?? startHeadless)(
      provider.executable, args, launchPrompt, cwd, find, deps.spawn ?? spawn,
      provider.provider === 'codex' ? codexThreadId : undefined, deps.killTree ?? killTree,
    );
    const session = await discoverLaunchedSession(loader, cwd, provider.provider, correlation, state, deps.timeoutMs);
    const mapping = { provider: provider.provider, id: session.id, pwd: session.cwd ?? cwd };
    if (peer) {
      const result = (deps.setPtySession ?? setPtySession)(peer.terminal_id, mapping);
      if (result === false) throw launchError('peer terminal ended before its session could be linked', 500);
      peerLinked = result === true;
    }
    linked = true;
    state?.release?.();
    return {
      kind, harness, provider: provider.provider, session_id: session.id,
      workspace: mapping.pwd,
      ...(peer ? { peer: peerLinked
        ? { ...peer, provider: mapping.provider, session_id: mapping.id, workspace: mapping.pwd, session_available: true, messageable: true }
        : peer } : {}),
    };
  } catch (error) {
    if (!linked) state?.cancel?.();
    if (peer) (deps.killPty ?? killPty)(peer.terminal_id);
    throw error.status ? error : launchError(`agent launch failed: ${error.message ?? error}`, 500);
  }
}
