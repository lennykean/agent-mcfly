import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  AGENT_PROVIDERS, codexThreadId, launchAgent, listAgentProviders,
} from './agent-launch.js';

const cwd = fs.realpathSync(process.cwd());
const session = (id, provider = 'codex') => ({ id, provider, cwd, updated_at: Date.now(), size: 1 });

test('reports provider availability, including the Cursor loader runtime capability', () => {
  const found = listAgentProviders(
    (name) => name === 'codex' || name === 'cursor-agent' ? `/bin/${name}` : null,
    () => false,
  );
  assert.deepEqual(found.map(({ harness, provider, available, reason }) => ({ harness, provider, available, reason })), [
    { harness: 'codex', provider: 'codex', available: true, reason: undefined },
    { harness: 'claude', provider: 'claude-code', available: false, reason: 'claude is not on PATH' },
    {
      harness: 'cursor', provider: 'cursor', available: false,
      reason: 'Cursor transcript discovery needs node:sqlite enabled in this Node runtime',
    },
  ]);
});

test('launch commands use provider defaults and never add authority-bypass flags', () => {
  assert.deepEqual(AGENT_PROVIDERS.codex, {
    harness: 'codex', provider: 'codex', executable: 'codex', headless: ['exec', '--json'], peer: [],
  });
  assert.deepEqual(AGENT_PROVIDERS.claude.headless, ['-p']);
  assert.deepEqual(AGENT_PROVIDERS.cursor.headless, ['-p']);
  assert.equal(JSON.stringify(AGENT_PROVIDERS).includes('dangerously'), false);
  assert.equal(JSON.stringify(AGENT_PROVIDERS).includes('--force'), false);
});

test('reads the exact Codex thread id from early JSON machine output', () => {
  assert.equal(codexThreadId('{"type":"thread.started","thread_id":"thread-123"}'), 'thread-123');
  assert.equal(codexThreadId('{"type":"item.completed"}'), null);
  assert.equal(codexThreadId('not json'), null);
});

test('headless Codex uses its emitted id and cannot claim a simultaneous manual session', async () => {
  const sessions = [session('old.jsonl')];
  let launched;
  const state = { exited: false, sessionId: null, release() { this.released = true; } };
  const out = await launchAgent({ harness: 'codex', prompt: 'do the work' }, {
    toolPath: () => '/bin/codex', loaders: { codex: { listForCwd: () => sessions } },
    startHeadless: (...args) => {
      launched = args;
      queueMicrotask(() => {
        sessions.push(session('2026/rollout-manual-thread.jsonl'));
        sessions.push(session('2026/rollout-2026-08-23-thread-launched.jsonl'));
        state.sessionId = 'thread-launched';
      });
      return state;
    },
    timeoutMs: 1000,
  });
  assert.deepEqual(launched.slice(0, 3), ['codex', ['exec', '--json'], 'do the work']);
  assert.equal(out.session_id, '2026/rollout-2026-08-23-thread-launched.jsonl');
  assert.equal(state.released, true);
});

test('Claude launches can overlap because caller-assigned ids correlate each exact transcript', async () => {
  const sessions = [];
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const started = [];
  const deps = {
    toolPath: () => '/bin/claude', randomUUID: () => ids.shift(),
    loaders: { 'claude-code': { listForCwd: () => sessions } },
    startHeadless: (_executable, args) => {
      const id = args[args.indexOf('--session-id') + 1];
      started.push(id);
      setTimeout(() => {
        sessions.push(session(`project/manual-${id}.jsonl`, 'claude-code'));
        sessions.push(session(`project/${id}.jsonl`, 'claude-code'));
      }, 5);
      return { exited: false, release() {} };
    },
    timeoutMs: 1000,
  };
  const [first, second] = await Promise.all([
    launchAgent({ harness: 'claude', prompt: 'first' }, deps),
    launchAgent({ harness: 'claude', prompt: 'second' }, deps),
  ]);
  assert.deepEqual(started, [
    '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  ]);
  assert.equal(first.session_id, 'project/11111111-1111-4111-8111-111111111111.jsonl');
  assert.equal(second.session_id, 'project/22222222-2222-4222-8222-222222222222.jsonl');
});

test('Cursor creates an exact chat id before launching a relay-enabled peer', async () => {
  const id = 'cursor-chat-123';
  let launched;
  let mapping;
  const out = await launchAgent({ harness: 'cursor', kind: 'peer', prompt: 'pair with me' }, {
    cursorTranscriptsSupported: () => true, toolPath: () => '/bin/cursor-agent', createCursorChat: async () => id,
    loaders: { cursor: { listForCwd: () => [session(`workspace/manual-chat`, 'cursor'), session(`workspace/${id}`, 'cursor')] } },
    launchAgentPty: (...args) => {
      launched = args;
      return {
        id: 'pty-1', terminal_id: 'pty-1', tool: 'cursor-agent', cwd,
        relay_enabled: true, interactive: false, session_available: false, messageable: false,
      };
    },
    setPtySession: (terminalId, value) => { mapping = { terminalId, value }; return true; },
    timeoutMs: 1000,
  });
  assert.deepEqual(launched.slice(0, 3), ['cursor-agent', cwd, ['--resume', id]]);
  assert.deepEqual(mapping, {
    terminalId: 'pty-1', value: { provider: 'cursor', id: `workspace/${id}`, pwd: cwd },
  });
  assert.equal(out.peer.messageable, true);
  assert.equal(out.peer.session_id, `workspace/${id}`);
});

test('interactive Codex correlates by an unguessable prompt marker, not the newest session', async () => {
  const marker = '33333333-3333-4333-8333-333333333333';
  let launchPrompt;
  const exact = session('2026/rollout-exact.jsonl');
  const out = await launchAgent({ harness: 'codex', kind: 'peer', prompt: 'pair' }, {
    toolPath: () => '/bin/codex', randomUUID: () => marker,
    loaders: { codex: {
      listForCwd: () => [session('2026/rollout-newer-manual.jsonl'), exact],
      findByLaunchMarker: (_cwd, value) => value === marker ? [exact] : [],
    } },
    launchAgentPty: (_tool, _cwd, _args, prompt) => {
      launchPrompt = prompt;
      return { id: 'pty-2', terminal_id: 'pty-2', relay_enabled: true, interactive: false };
    },
    setPtySession: () => true,
    timeoutMs: 1000,
  });
  assert.match(launchPrompt, new RegExp(marker));
  assert.equal(out.session_id, exact.id);
});

test('rejects terminal controls before a peer PTY can receive bytes', async () => {
  let launched = false;
  await assert.rejects(launchAgent({ harness: 'codex', kind: 'peer', prompt: 'unsafe\u001b[2J' }, {
    toolPath: () => '/bin/codex', launchAgentPty: () => { launched = true; },
  }), { code: 'INVALID_AGENT_PROMPT', message: /control characters/ });
  assert.equal(launched, false);
});

test('Cursor is rejected before launch when node:sqlite is disabled', async () => {
  let touched = false;
  await assert.rejects(launchAgent({ harness: 'cursor', prompt: 'x' }, {
    cursorTranscriptsSupported: () => false, toolPath: () => { touched = true; return '/bin/cursor-agent'; },
    createCursorChat: async () => { touched = true; return 'chat'; },
  }), { code: 'AGENT_PROVIDER_UNAVAILABLE', message: /node:sqlite enabled/ });
  assert.equal(touched, false);
});

test('does not signal a retained child after its exit was observed', async () => {
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 12345,
    stdout: Object.assign(new EventEmitter(), { setEncoding() {}, unref() {} }),
    stderr: { resume() {}, unref() {} },
    unref() {},
  });
  let treeKills = 0;
  let childKills = 0;
  child.kill = () => { childKills++; };
  await assert.rejects(launchAgent({ harness: 'codex', prompt: 'done already' }, {
    toolPath: () => '/bin/codex',
    loaders: { codex: { listForCwd: () => [] } },
    spawn: () => {
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    },
    killTree: () => { treeKills++; },
    timeoutMs: 1,
  }), { code: 'AGENT_SESSION_NOT_FOUND' });
  assert.equal(treeKills, 0);
  assert.equal(childKills, 0);
});

test('cancels the retained child tree when exact transcript correlation is ambiguous or times out', async () => {
  let cancelled = 0;
  const id = 'thread-ambiguous';
  await assert.rejects(launchAgent({ harness: 'codex', prompt: 'ambiguous' }, {
    toolPath: () => '/bin/codex',
    loaders: { codex: { listForCwd: () => [
      session(`one/rollout-${id}.jsonl`), session(`two/rollout-${id}.jsonl`),
    ] } },
    startHeadless: () => ({ exited: false, sessionId: id, cancel: () => { cancelled++; } }),
    timeoutMs: 1000,
  }), { code: 'AGENT_SESSION_AMBIGUOUS' });
  await assert.rejects(launchAgent({ harness: 'codex', prompt: 'timeout' }, {
    toolPath: () => '/bin/codex', loaders: { codex: { listForCwd: () => [] } },
    startHeadless: () => ({ exited: false, sessionId: 'missing', cancel: () => { cancelled++; } }),
    timeoutMs: 1,
  }), { code: 'AGENT_SESSION_NOT_FOUND' });
  assert.equal(cancelled, 2);
});

test('server scope rejects a valid directory outside its selected workspace', async () => {
  await assert.rejects(launchAgent({ harness: 'codex', prompt: 'x', cwd: path.dirname(cwd) }, {
    scope: cwd,
  }), { code: 'AGENT_CWD_OUT_OF_SCOPE', status: 403 });
});

test('rejects unavailable providers and bad launch input truthfully', async () => {
  await assert.rejects(launchAgent({ harness: 'gemini', prompt: 'x' }), { code: 'INVALID_AGENT_PROVIDER' });
  await assert.rejects(launchAgent({ harness: 'codex', prompt: '' }), { code: 'INVALID_AGENT_PROMPT' });
  await assert.rejects(launchAgent({ harness: 'codex', prompt: 'x' }, { toolPath: () => null }), {
    code: 'AGENT_PROVIDER_UNAVAILABLE', message: /not available/,
  });
  await assert.rejects(launchAgent({ harness: 'codex', prompt: 'x' }, {
    toolPath: () => '/bin/codex', loaders: { codex: { listForCwd: () => [] } },
    startHeadless: () => { throw new Error('spawn broke'); },
  }), { code: 'AGENT_LAUNCH_FAILED', status: 500, message: /spawn broke/ });
});
