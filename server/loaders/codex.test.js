import test from 'node:test';
import assert from 'node:assert/strict';
import { callRender, callRenders, parseThreadNames, patchRender, patchRenders, resultRender, splitNumberedResults, toolLabel } from './codex.js';

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
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
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
