import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callRender, callRenders, parseHead, parseThreadNames, patchRender, patchRenders, projectPathKey, resultRender, splitNumberedResults, tailFile, toolLabel } from './codex.js';

test('project path identity folds Windows paths but preserves POSIX case', () => {
  assert.equal(projectPathKey('C:\\Repo\\App'), projectPathKey('c:/repo/app'));
  assert.equal(projectPathKey('\\\\Server\\Share\\App'), projectPathKey('//server/share/app'));
  assert.notEqual(projectPathKey('/repo/App'), projectPathKey('/repo/app'));
});

test('uses the latest Codex Desktop thread name', () => {
  const names = parseThreadNames([
    '{"id":"one","thread_name":"Rename MR QA"}',
    'incomplete',
    '{"id":"one","thread_name":"mr qa"}',
  ].join('\n'));
  assert.equal(names.get('one'), 'mr qa');
});

test('expands programmatic calls and recognizes real quoted read arguments', () => {
  const input = `const results = await Promise.all([
    tools.shell_command({"command":"rg needle","workdir":"C:\\\\repo"}),
    tools.shell_command({"command":"Get-Content -Raw 'README.md'","workdir":"C:\\\\repo"})
  ]); results.forEach((r,i)=>{text(\`---\${i+1}---\`); text(r)})`;
  assert.deepEqual(callRenders('exec', input), [
    { verb: 'exec', command: 'rg needle', title: 'rg needle' },
    { verb: 'read_file', path: 'C:\\repo\\README.md', title: 'README.md' },
  ]);
  assert.deepEqual(splitNumberedResults('wrapper\n---1---\none\n---2---\ntwo\n', 2), ['one', 'two']);
  assert.equal(splitNumberedResults('no markers', 2), null);
});

test('labels Codex exec wrappers with their nested tools', () => {
  assert.equal(toolLabel('shell_command', '{}', { verb: 'read_file' }), 'read_file');
  assert.equal(toolLabel('exec', 'const r = await tools.shell_command({ command: "pwd" });'), 'shell_command');
  assert.equal(toolLabel('exec', 'await Promise.all([tools.shell_command({}), tools.shell_command({})])'), 'shell_command ×2');
  assert.equal(toolLabel('exec', 'const a = await tools.web__run({}); const b = await tools.view_image({});'), 'web__run + view_image');
  assert.equal(toolLabel('exec', 'const patch = "tools.shell_command({})"; await tools.apply_patch(patch);'), 'apply_patch');
  assert.equal(toolLabel('exec', 'plain JavaScript'), 'exec');
  assert.equal(toolLabel('apply_patch', 'tools.shell_command({})'), 'apply_patch');
});

test('recovers patch semantics from Codex exec wrappers', () => {
  const patch = 'const patch = "*** Begin Patch\\n*** Update File: server/server.js\\n@@\\n-old\\n+new\\n*** End Patch"; await tools.apply_patch(patch);';
  assert.deepEqual(patchRender(patch), {
    verb: 'patch_file', path: 'server/server.js', title: 'server.js',
    hunks: [{ oldStart: 0, oldLines: 1, newStart: 0, newLines: 1, lines: ['-old', '+new'] }],
  });

  const add = 'const patch = "*** Begin Patch\\n*** Add File: hello.txt\\n+hello\\n+world\\n*** End Patch"; await tools.apply_patch(patch);';
  assert.equal(patchRender(add).verb, 'write_file');
  assert.equal(patchRender(add).content, 'hello\nworld');
  const direct = patchRender('*** Begin Patch\n*** Update File: direct.js\n@@\n-const marker = "*** Begin Patch";\n+const marker = "*** End Patch";\n*** End Patch');
  assert.equal(direct.path, 'direct.js');
  assert.equal(direct.hunks[0].lines.at(-1), '+const marker = "*** End Patch";');

  const multi = '*** Begin Patch\n*** Update File: one.txt\n@@\n-old\n+new\n*** Add File: two.txt\n+two\n*** End Patch';
  assert.deepEqual(patchRenders(multi).map(({ verb, path }) => ({ verb, path })), [
    { verb: 'patch_file', path: 'one.txt' },
    { verb: 'write_file', path: 'two.txt' },
  ]);
  assert.equal(callRenders('apply_patch', multi).length, 2);

  assert.deepEqual(patchRender('*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch'), {
    verb: 'patch_file', path: 'gone.txt', title: 'gone.txt', removed: true,
  });
  const moved = patchRender('*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-old\n+new\n*** End Patch');
  assert.equal(moved.path, 'new.txt');
  assert.equal(moved.source_path, 'old.txt');

  assert.equal(callRender('exec', 'await tools.shell_command({ command: "rg \'*** Begin Patch\'" });').verb, 'exec');
  const readInput = 'await tools.shell_command({ command: "Get-Content -Raw -LiteralPath \'server/server.js\'", workdir: "C:\\\\repo" });';
  const read = callRender('exec', readInput);
  assert.deepEqual(read, { verb: 'read_file', path: 'C:\\repo\\server\\server.js', title: 'server.js' });
  const readResult = resultRender({ name: 'exec', input: readInput, render: read }, 'Script completed\nOutput:\n\nExit code: 0\nOutput:\nfile body');
  assert.equal(readResult.content, 'file body');
  assert.equal(readResult.stdout, undefined);
  assert.equal(callRender('exec', 'for (const p of paths) await tools.shell_command({ command: `Get-Content -LiteralPath \'${p}\'` });').verb, 'exec');
  assert.deepEqual(
    callRenders('exec', 'await Promise.all([tools.shell_command({ command: "Get-Content -LiteralPath \'a\'" }), tools.shell_command({ command: "Get-Content -LiteralPath \'b\'" })]);')
      .map(({ verb, path }) => ({ verb, path })),
    [{ verb: 'read_file', path: 'a' }, { verb: 'read_file', path: 'b' }],
  );
});

test('failed patches remain errors instead of edit results', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-codex-failed-'));
  const file = path.join(dir, 'rollout.jsonl');
  const patch = '*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch';
  const lines = [
    { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'failed-patch', name: 'apply_patch', input: patch } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'failed-patch', output: 'apply_patch verification failed: context not found' } },
  ];
  try {
    fs.writeFileSync(file, lines.map(JSON.stringify).join('\n') + '\n');
    const block = tailFile(file).messages.flatMap((message) => message.content).find((item) => item.type === 'tool_result');
    assert.equal(block.extended.render.verb, 'exec');
    assert.equal(block.extended.is_error, true);
    assert.match(block.extended.render.stderr, /verification failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tail recovers call metadata from before its cursor and preserves unmatched results', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-codex-tail-'));
  const file = path.join(dir, 'rollout.jsonl');
  const patch = '*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch';
  const call = JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'recovered-call', name: 'apply_patch', input: patch } }) + '\n';
  const output = JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'recovered-call', output: 'Success. Updated the following files:\nM a.txt' } }) + '\n';
  try {
    fs.writeFileSync(file, call + output);
    const recovered = tailFile(file, Buffer.byteLength(call)).messages[0].content[0];
    assert.equal(recovered.tool_request_id, 'recovered-call');
    assert.equal(recovered.extended.render.verb, 'patch_file');

    fs.writeFileSync(file, JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'missing-call', output: 'orphan output' } }) + '\n');
    const unmatched = tailFile(file).messages[0].content[0];
    assert.equal(unmatched.tool, 'unmatched result');
    assert.equal(unmatched.result, 'orphan output');
    assert.equal(unmatched.extended.is_error, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failed commands never masquerade as file reads', () => {
  const render = { verb: 'read_file', path: 'C:\\repo\\a.js', title: 'a.js' };
  // ANSI-styled output = a colored error, not file content
  const ansi = resultRender({ name: 'exec', input: '', render },
    'Script completed\nWall time 0.1 seconds\nOutput:\n\u001b[31;1msqlite3: \u001b[0mnear "x": syntax error');
  assert.equal(ansi.verb, 'exec');
  assert.equal(ansi.content, undefined);
  // harness call with no Output marker never actually ran
  const noMarker = resultRender({ name: 'exec', input: '', render }, 'Script failed: boom');
  assert.equal(noMarker.verb, 'exec');
  // direct shell tools return raw stdout with no marker: still a read
  const direct = resultRender({ name: 'local_shell', input: '', render }, 'raw file body');
  assert.equal(direct.verb, 'read_file');
  assert.equal(direct.content, 'raw file body');
  // nested harness shell_command failures are NOT direct: plain error text
  // without ANSI must not classify as a read
  const nestedFail = resultRender({ name: 'shell_command', input: '', render, nested: true },
    'Exit code: 1\nWall time: 0.1 seconds\nOutput:\ncat: a.js: No such file or directory');
  assert.equal(nestedFail.verb, 'exec');
  const scriptError = resultRender({ name: 'shell_command', input: '', render, nested: true },
    'Script error:\nExit code: 124\nWall time: 14.4 seconds\nOutput:\ncommand timed out');
  assert.equal(scriptError.verb, 'exec');
  // nested success still reads
  const nestedOk = resultRender({ name: 'shell_command', input: '', render, nested: true },
    'Exit code: 0\nWall time: 0.1 seconds\nOutput:\nreal file body');
  assert.equal(nestedOk.verb, 'read_file');
  assert.equal(nestedOk.content, 'real file body');
});

test('keeps non-shell Codex wrappers out of the terminal and preserves images', () => {
  assert.equal(callRender('exec', 'await tools.web__run({ search_query: [] });').verb, 'other');
  assert.equal(callRender('exec', 'await tools.other({ command: "not a shell" });').verb, 'other');
  assert.equal(callRender('exec', 'plain JavaScript').verb, 'other');
  assert.equal(callRender('exec', '{"cmd":"git status"}').verb, 'exec');
  assert.equal(callRender('exec_command', '{"cmd":"git status"}').verb, 'exec');
  assert.equal(
    resultRender(
      { name: 'shell_command', render: { verb: 'exec' } },
      'Script completed\nWall time 1.5 seconds\nOutput:\n\nExit code: 0\nWall time: 0.7 seconds\nOutput:\nhi',
    ).stdout,
    'hi',
  );

  const input = 'const r = await tools.view_image({ path: "C:\\\\repo\\\\picture.png" }); image(r.image_url);';
  const render = callRender('exec', input);
  assert.equal(render.verb, 'read_file');
  assert.equal(render.title, 'picture.png');
  const result = resultRender(
    { name: 'exec', input, render },
    'Script completed',
    [{ type: 'input_image', image_url: 'data:image/png;base64,cG5n' }],
  );
  assert.deepEqual(result, { ...render, image_src: 'data:image/png;base64,cG5n' });
  assert.equal(resultRender({ name: 'exec', input: 'await tools.web__run({})', render: { verb: 'other' } }, 'web output').verb, 'other');
});

test('recovers McFly table semantics from MCP results', () => {
  const input = JSON.stringify({ script: "printf 'name\\tcount\\nalpha\\t2\\n'", title: 'counts' });
  const call = callRender('mcp__mcfly__run_table', input);
  assert.deepEqual(call, { verb: 'data', command: "printf 'name\\tcount\\nalpha\\t2\\n'", title: 'counts', cwd: undefined });
  const envelope = {
    schema: 'mcfly.data.v1', kind: 'table', command: 'printf ...', cwd: '/repo', exitCode: 0,
    stdout: 'name\tcount\nalpha\t2\n', stderr: '', data: { columns: ['name', 'count'], rows: [['alpha', '2']] },
  };
  assert.deepEqual(resultRender({ name: 'mcp__mcfly__run_table', render: call }, `MCFLY_DATA_V1\n${JSON.stringify(envelope)}`), {
    verb: 'data', command: 'printf ...', cwd: '/repo', exit_code: 0, stdout: envelope.stdout, stderr: '',
    format: 'tsv', // envelopes written before formats existed are TSV
    table: envelope.data,
  });
  // structuredContent results reach transcripts as bare envelope JSON with NO
  // marker (Claude Code replaces the text content) — must still render
  const bare = resultRender({ name: 'mcp__mcfly__run_table', render: call }, JSON.stringify(envelope));
  assert.equal(bare.verb, 'data');
  assert.deepEqual(bare.table, envelope.data);

  // a declared format is parsed as that format, not guessed
  const csv = resultRender({ name: 'mcp__mcfly__run_table', render: call }, JSON.stringify({
    ...envelope, format: 'csv', stdout: 'name,count\n"alpha, jr",2\n', data: undefined,
  }));
  assert.equal(csv.format, 'csv');
  assert.deepEqual(csv.table, { columns: ['name', 'count'], rows: [['alpha, jr', '2']] });
});

test('recovers a delivered McFly peer message with linkable session metadata', () => {
  const call = callRender('mcp__mcfly__send_message', JSON.stringify({ id: 'remote-1:pty-1', message: 'hello' }));
  assert.deepEqual(call, { verb: 'peer_message', peer_id: 'remote-1:pty-1', title: 'message peer' });
  const peer = {
    id: 'remote-1:pty-1', terminal_id: 'pty-1', tool: 'claude', cwd: '/repo', title: 'Reviewer',
    session_id: 'session.jsonl', provider: 'claude-code', connection: 'remote-1',
  };
  const envelope = { schema: 'mcfly.data.v1', kind: 'peer_message', id: peer.id, delivered: true, peer };
  assert.deepEqual(resultRender({ name: 'mcp__mcfly__send_message', render: call }, JSON.stringify(envelope)), {
    verb: 'peer_message', status: 'delivered', peer,
  });
});

test('renders McFly-launched cross-provider children and top-level peers', () => {
  const subCall = callRender('mcp__mcfly__spawn_agent', JSON.stringify({ harness: 'claude', prompt: 'audit this' }));
  assert.equal(subCall.verb, 'spawn_agent');
  assert.equal(subCall.title, 'audit this');
  const sub = resultRender({ name: 'mcp__mcfly__spawn_agent', render: subCall }, JSON.stringify({
    schema: 'mcfly.data.v1', kind: 'agent_spawn', launch_kind: 'subagent', harness: 'claude',
    provider: 'claude-code', session_id: 'project/child.jsonl', workspace: '/repo',
  }));
  assert.equal(sub.child_session_id, 'project/child.jsonl');
  assert.equal(sub.child_provider, 'claude-code');
  assert.equal(sub.child_workspace, '/repo');

  const peerCall = callRender('mcp__mcfly__spawn_agent', JSON.stringify({ harness: 'cursor', kind: 'peer', prompt: 'pair' }));
  const peer = { id: 'pty-1', terminal_id: 'pty-1', provider: 'cursor', session_id: 'ws/chat', workspace: '/repo' };
  const peerResult = resultRender({ name: 'mcp__mcfly__spawn_agent', render: peerCall }, JSON.stringify({
    schema: 'mcfly.data.v1', kind: 'agent_spawn', launch_kind: 'peer', harness: 'cursor',
    provider: 'cursor', session_id: 'ws/chat', workspace: '/repo', peer,
  }));
  assert.equal(peerResult.child_session_id, undefined);
  assert.deepEqual(peerResult.peer, peer);
});

test('codex teams: sub-agent threads stay out of the session list and link to their spawn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-codex-team-'));
  const root = { session_id: 'root-1', id: 'root-1', cwd: dir, source: 'vscode' };
  const child = {
    session_id: 'root-1', id: 'kid-1', cwd: dir, parent_thread_id: 'root-1',
    thread_source: 'subagent', agent_path: '/root/audit', agent_nickname: 'Euler',
    source: { subagent: { thread_spawn: { parent_thread_id: 'root-1', depth: 1 } } },
  };
  assert.equal(parseHead(JSON.stringify({ type: 'session_meta', payload: root })).subagent, false);
  const kid = parseHead(JSON.stringify({ type: 'session_meta', payload: child }));
  assert.equal(kid.subagent, true);
  assert.equal(kid.agentPath, '/root/audit');
  assert.equal(kid.rootId, 'root-1');
  assert.equal(kid.nickname, 'Euler');

  // the call renders as an agent spawn; the result carries the agent's identity
  const [call] = callRenders('spawn_agent', '{"task_name":"audit","fork_turns":"none"}');
  assert.equal(call.verb, 'spawn_agent');
  assert.equal(call.title, 'audit');
  const done = resultRender({ name: 'spawn_agent', render: call }, '{"task_name":"/root/audit"}');
  assert.equal(done.verb, 'spawn_agent');
  assert.equal(done.agent_id, '/root/audit');
  assert.equal(done.title, 'audit');
});
