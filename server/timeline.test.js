import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, invertHunks, fileChain } from '../ui/src/lib/timeline.ts';

const tool = (index, verb, path, result) => ({
  kind: 'tool', tool: 'T', requestId: String(index), params: {},
  call: { verb, path }, result: { verb, path, ...result },
});

test('reconstructs a file from consecutive exact-context patches', () => {
  const first = applyPatch('one\ntwo\n', [{
    oldStart: 1, oldLines: 2, newStart: 1, newLines: 3,
    lines: [' one', ' two', '+three'],
  }]);
  assert.deepEqual(first, { content: 'one\ntwo\nthree\n', region: { start: 3, end: 3 } });

  const second = applyPatch(first.content, [{
    oldStart: 1, oldLines: 3, newStart: 1, newLines: 4,
    lines: [' one', ' two', ' three', '+four'],
  }]);
  assert.deepEqual(second, { content: 'one\ntwo\nthree\nfour\n', region: { start: 4, end: 4 } });
});

test('leaves an unmatchable patch for the diff fallback', () => {
  assert.equal(applyPatch('one\n', [{
    oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
    lines: [' missing', '+replacement'],
  }]), null);
});

test('duplicate context: a real position hint picks the right block, a placeholder refuses', () => {
  const content = 'a\nx\nb\na\nx\nb\n';
  const hinted = applyPatch(content, [{
    oldStart: 4, oldLines: 2, newStart: 4, newLines: 2, lines: [' a', '-x', '+y'],
  }]);
  assert.equal(hinted.content, 'a\nx\nb\na\ny\nb\n');
  // codex pseudo-hunks carry oldStart 0 = no position info: never guess
  assert.equal(applyPatch(content, [{
    oldStart: 0, oldLines: 2, newStart: 0, newLines: 2, lines: [' a', '-x', '+y'],
  }]), null);
});

test('inverted hunks un-apply cleanly with swapped positions', () => {
  const hunks = [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' one', '+added', ' two'] }];
  const after = applyPatch('one\ntwo\n', hunks);
  assert.equal(after.content, 'one\nadded\ntwo\n');
  const undone = applyPatch(after.content, invertHunks(hunks));
  assert.equal(undone.content, 'one\ntwo\n');
  assert.equal(invertHunks(hunks)[0].oldStart, 1);
  assert.equal(invertHunks(hunks)[0].oldLines, 3);
});

test('fileChain: full reads anchor, patches accumulate blame, slices never gain authority', () => {
  const H = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' one', '+added'] }];
  const steps = [
    tool(0, 'read_file', 'f', { content: 'one\ntwo\nthree', start_line: 1, total_lines: 3 }),
    tool(1, 'patch_file', 'f', { hunks: H }),
    // head-style slice: starts at 1, NO total_lines — must not truncate the chain
    tool(2, 'read_file', 'f', { content: 'one\nadded', start_line: 1 }),
  ];
  const { touches, snapshots } = fileChain(steps, 'f');
  assert.equal(touches.length, 3);
  assert.equal(snapshots.get(1).content, 'one\nadded\ntwo\nthree');
  assert.deepEqual(snapshots.get(1).blame, [null, 1, null, null]);
  // the confirming slice keeps the full carried state
  assert.equal(snapshots.get(2).content, 'one\nadded\ntwo\nthree');
});

test('fileChain: a contradicting slice read severs the chain', () => {
  const steps = [
    tool(0, 'read_file', 'f', { content: 'one\ntwo', start_line: 1, total_lines: 2 }),
    tool(1, 'read_file', 'f', { content: 'SOMETHING ELSE', start_line: 1 }),
    tool(2, 'patch_file', 'f', { hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-one', '+uno'] }] }),
  ];
  const { snapshots } = fileChain(steps, 'f');
  // the slice is shown as-is, not the refuted carried content
  assert.equal(snapshots.get(1).content, 'SOMETHING ELSE');
  // and the patch after the sever has no chain to apply to... but a future
  // anchor doesn't exist either, so it stays a raw diff
  assert.equal(snapshots.get(2).content, undefined);
  assert.notEqual(snapshots.get(2).hunks, undefined);
});

test('fileChain: reverse reconstruction from a future full read', () => {
  const H = [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' one', '+added', ' two'] }];
  const steps = [
    tool(0, 'patch_file', 'f', { hunks: H }),
    tool(1, 'read_file', 'f', { content: 'one\nadded\ntwo', start_line: 1, total_lines: 3 }),
  ];
  const { snapshots } = fileChain(steps, 'f');
  assert.equal(snapshots.get(0).content, 'one\nadded\ntwo');
  assert.deepEqual(snapshots.get(0).region, { start: 2, end: 2 });
});

test('fileChain: a write between a patch and a future read severs backfill', () => {
  const H = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' one', '+added'] }];
  const steps = [
    tool(0, 'patch_file', 'f', { hunks: H }),
    tool(1, 'write_file', 'f', { content: 'rewritten' }),
    tool(2, 'read_file', 'f', { content: 'rewritten', start_line: 1, total_lines: 1 }),
  ];
  const { snapshots } = fileChain(steps, 'f');
  assert.equal(snapshots.get(0).content, undefined);
});

test('fileChain: windows paths fold case, posix paths do not', () => {
  const winSteps = [tool(0, 'read_file', 'C:\\repo\\App.tsx', { content: 'x', start_line: 1, total_lines: 1 })];
  assert.equal(fileChain(winSteps, 'C:/repo/app.tsx').touches.length, 1);
  const posixSteps = [tool(0, 'read_file', '/repo/Foo.ts', { content: 'x', start_line: 1, total_lines: 1 })];
  assert.equal(fileChain(posixSteps, '/repo/foo.ts').touches.length, 0);
  assert.equal(fileChain(posixSteps, '/repo/Foo.ts').touches.length, 1);
});
