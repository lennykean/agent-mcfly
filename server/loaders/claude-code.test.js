import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bashReadResult, inferBashRead, inferBashTool, parseTailChunk, projectSlugMatches, scanHead } from './claude-code.js';

test('project directory matching folds Windows paths but preserves POSIX case', () => {
  assert.equal(projectSlugMatches('C:\\Repo\\App', 'C--repo-app'), true);
  assert.equal(projectSlugMatches('//Server/Share/App', '--server-share-app'), true);
  assert.equal(projectSlugMatches('/repo/App', '-repo-App'), true);
  assert.equal(projectSlugMatches('/repo/App', '-repo-app'), false);
});

test('finds Claude titles written after the transcript head', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-'));
  const file = path.join(dir, 'session.jsonl');
  try {
    fs.writeFileSync(file, `${JSON.stringify({ type: 'user', cwd: '/repo' })}\n${'x'.repeat(20_000)}\n${JSON.stringify({ type: 'custom-title', customTitle: 'mr dev' })}\n`);
    assert.deepEqual(scanHead(file), { cwd: '/repo', title: 'mr dev' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('conservatively infers file operations from Claude Bash commands', () => {
  assert.equal(inferBashTool('cat "README.md"'), 'Read');
  assert.equal(inferBashTool('head -20 README.md'), 'Read');
  assert.equal(inferBashTool("sed -n '10,30p' src/app.js"), 'Read');
  assert.equal(inferBashTool("echo 'hello' > hello.txt"), 'Write');
  assert.equal(inferBashTool("printf '%s' hello >> hello.txt"), 'Edit');
  assert.equal(inferBashTool("sed -i 's/old/new/' app.js"), 'Edit');
  assert.equal(inferBashTool("cat > config.ini <<'EOF'\nvalue=1\nEOF"), 'Write');
  assert.equal(inferBashTool('rg needle src'), null);
  assert.equal(inferBashTool('ls -la'), null);
  assert.equal(inferBashTool('cat README.md | head'), null);
  assert.equal(inferBashTool('cat one.txt two.txt'), null);
  assert.equal(inferBashTool('tail -20 README.md'), null);
  assert.equal(inferBashTool('nl README.md'), null);
  assert.equal(inferBashTool("echo 'not > a write'"), null);
  assert.equal(inferBashTool('cat --help'), null);
  assert.equal(inferBashTool('echo done > /dev/null'), null);
});

test('renders conservative shell reads in the editor', () => {
  const read = inferBashRead("cd '/repo' && sed -n '10,30p' -- 'src/app.js'", '/elsewhere');
  assert.deepEqual(read, {
    verb: 'read_file', path: '/repo/src/app.js', title: 'src/app.js', start_line: 10,
  });
  assert.deepEqual(bashReadResult(read, { stdout: 'ten\neleven\n' }, {}), {
    verb: 'read_file', path: '/repo/src/app.js', content: 'ten\neleven\n', start_line: 10,
    region: { start: 10, end: 11 },
  });
  assert.equal(inferBashTool("cd '/repo' && sed -n '10,30p' src/app.js"), 'Read');
  assert.equal(inferBashTool('cd /repo && ls'), null);
  assert.equal(inferBashRead("cd src && sed -n '5p' app.js", '/repo').path, '/repo/src/app.js');
  assert.deepEqual(inferBashRead("cd /repo && cat -- 'src/app.js'", '/elsewhere'), {
    verb: 'read_file', path: '/repo/src/app.js', title: 'src/app.js', start_line: 1, full: true,
  });
  // cat sees the whole file: its result may claim full-file authority
  assert.equal(bashReadResult(
    inferBashRead("cd /repo && cat -- 'src/app.js'", '/elsewhere'),
    { stdout: 'a\nb\n' }, {},
  ).total_lines, 2);
  // head is a slice: no total_lines, never an authority
  const head = inferBashRead('head -20 src/app.js', '/repo');
  assert.equal(head.path, '/repo/src/app.js');
  assert.equal(head.full, undefined);
  assert.equal(bashReadResult(head, { stdout: 'a\nb\n' }, {}).total_lines, undefined);
  assert.equal(inferBashRead("sed -n '5p' app.js", 'C:\\repo').path, 'C:\\repo\\app.js');
  assert.equal(bashReadResult(read, { stdout: '', stderr: 'sed: failed' }, {}), null);
  assert.equal(inferBashRead("cd \"$HOME\" && sed -n '1p' app.js", '/repo'), null);
  assert.equal(inferBashRead("cd /repo && sed -n '1,2p' app.js && echo done", '/repo'), null);
});

test('renders a delivered McFly peer message as a peer link', () => {
  const peer = {
    id: 'pty-1', terminal_id: 'pty-1', tool: 'codex', cwd: '/repo', title: 'Peer',
    session_id: 'rollout.jsonl', provider: 'codex',
  };
  const envelope = { schema: 'mcfly.data.v1', kind: 'peer_message', id: peer.id, delivered: true, peer };
  const rows = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'peer-call', name: 'mcp__mcfly__send_message', input: { id: peer.id, message: 'hi' } }] } },
    { type: 'user', toolUseResult: envelope, message: { content: [{ type: 'tool_result', tool_use_id: 'peer-call', content: JSON.stringify(envelope) }] } },
  ];
  const buf = Buffer.from(rows.map(JSON.stringify).join('\n') + '\n');
  const result = parseTailChunk('session.jsonl', 0, { mtimeMs: 1, size: buf.length }, buf);
  assert.equal(result.messages[0].content[0].extended.render.verb, 'peer_message');
  assert.deepEqual(result.messages[1].content[0].extended.render.peer, peer);
});

test('renders a McFly-launched cross-provider child', () => {
  const envelope = {
    schema: 'mcfly.data.v1', kind: 'agent_spawn', launch_kind: 'subagent', harness: 'cursor',
    provider: 'cursor', session_id: 'workspace/child', workspace: '/repo',
  };
  const rows = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'spawn-call', name: 'mcp__mcfly__spawn_agent', input: { harness: 'cursor', prompt: 'audit' } }] } },
    { type: 'user', toolUseResult: envelope, message: { content: [{ type: 'tool_result', tool_use_id: 'spawn-call', content: JSON.stringify(envelope) }] } },
  ];
  const buf = Buffer.from(rows.map(JSON.stringify).join('\n') + '\n');
  const messages = parseTailChunk('session.jsonl', 0, { mtimeMs: 1, size: buf.length }, buf).messages;
  assert.equal(messages[0].content[0].extended.render.verb, 'spawn_agent');
  assert.equal(messages[1].content[0].extended.render.child_provider, 'cursor');
  assert.equal(messages[1].content[0].extended.render.child_session_id, 'workspace/child');
});
