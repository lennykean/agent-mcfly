import test from 'node:test';
import assert from 'node:assert/strict';
import { appendMessages, applyPatch, createTimeline, invertHunks, fileChain, foldState, pathWithin, resolveWaypoint } from '../ui/src/lib/timeline.ts';

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

test('waypoints live from create to remove, rewindably', () => {
  const wp = { path: 'C:\\repo\\f.js', line: 3, note: 'n', before: [], anchor: 'c', after: [] };
  const steps = [
    tool(0, 'other', undefined, { waypoint: wp }),
    tool(1, 'exec', undefined, {}),
    tool(2, 'other', undefined, { waypoint_remove: { path: 'C:/repo/f.js', line: 3 } }),
  ];
  assert.equal(foldState(steps, 0).waypoints.length, 1);
  assert.equal(foldState(steps, 1).waypoints.length, 1);
  assert.equal(foldState(steps, 2).waypoints.length, 0); // removed
  assert.equal(foldState(steps, 1).waypoints.length, 1); // scrub back: it's back
  // removal without a line clears every waypoint on the file
  const steps2 = [
    tool(0, 'other', undefined, { waypoint: wp }),
    tool(1, 'other', undefined, { waypoint: { ...wp, line: 9 } }),
    tool(2, 'other', undefined, { waypoint_remove: { path: 'C:\\repo\\f.js' } }),
  ];
  assert.equal(foldState(steps2, 1).waypoints.length, 2);
  assert.equal(foldState(steps2, 2).waypoints.length, 0);
});

test('waypoints re-locate by context and detach rather than guess', () => {
  const wp = { path: 'f', line: 3, note: 'n', before: ['a', 'b'], anchor: 'c', after: ['d'] };
  // exact file: found at its recorded line
  assert.equal(resolveWaypoint('a\nb\nc\nd', wp), 3);
  // code moved down: found at the NEW line
  assert.equal(resolveWaypoint('x\ny\na\nb\nc\nd', wp), 5);
  // anchor gone: detached
  assert.equal(resolveWaypoint('a\nb\nZ\nd', wp), null);
  // ambiguous (two identical contexts): detached, never guess
  assert.equal(resolveWaypoint('a\nb\nc\nd\na\nb\nc\nd', wp), null);
});

test('fileChain: windows paths fold case, posix paths do not', () => {
  const winSteps = [tool(0, 'read_file', 'C:\\repo\\App.tsx', { content: 'x', start_line: 1, total_lines: 1 })];
  assert.equal(fileChain(winSteps, 'C:/repo/app.tsx').touches.length, 1);
  const winState = foldState([...winSteps, tool(1, 'write_file', 'c:/REPO/app.tsx', { content: 'y' })], 1);
  assert.equal(winState.tabs.length, 1);
  const posixSteps = [tool(0, 'read_file', '/repo/Foo.ts', { content: 'x', start_line: 1, total_lines: 1 })];
  assert.equal(fileChain(posixSteps, '/repo/foo.ts').touches.length, 0);
  assert.equal(fileChain(posixSteps, '/repo/Foo.ts').touches.length, 1);
  assert.equal(pathWithin('//SERVER/Share/child/f.ts', '\\\\server\\share'), true);
  assert.equal(pathWithin('C:\\repo\\child\\f.ts', 'c:/REPO'), true);
  assert.equal(pathWithin('C:\\repo-old\\f.ts', 'C:\\repo'), false);
  assert.equal(pathWithin('/repo/Foo/f.ts', '/repo/Foo'), true);
  assert.equal(pathWithin('/repo/foo/f.ts', '/repo/Foo'), false);
});

test('foldState removes deleted sources and moves renamed content', () => {
  const read = tool(0, 'read_file', 'old.txt', { content: 'old\nkeep', start_line: 1, total_lines: 2 });
  const renamed = tool(1, 'patch_file', 'new.txt', {
    source_path: 'old.txt',
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
  });
  const moved = foldState([read, renamed], 1);
  assert.equal(moved.tabs.some((tab) => tab.path === 'old.txt'), false);
  assert.equal(moved.tabs.find((tab) => tab.path === 'new.txt').render.content, 'new\nkeep');

  const pureMove = foldState([read, tool(1, 'patch_file', 'new.txt', { source_path: 'old.txt', hunks: [] })], 1);
  assert.equal(pureMove.tabs.find((tab) => tab.path === 'new.txt').render.content, 'old\nkeep');
  assert.equal(fileChain([read, tool(1, 'patch_file', 'new.txt', { source_path: 'old.txt', hunks: [] })], 'new.txt').snapshots.get(1).content, 'old\nkeep');
  assert.equal(fileChain([read, renamed], 'new.txt').snapshots.get(1).content, 'new\nkeep');

  const removal = tool(1, 'patch_file', 'old.txt', { removed: true });
  const deleted = foldState([read, removal], 1);
  assert.equal(deleted.tabs.some((tab) => tab.path === 'old.txt'), false);
  assert.equal(fileChain([read, renamed], 'old.txt').snapshots.get(1).removed, true);
  assert.equal(fileChain([read, removal], 'old.txt').snapshots.get(1).removed, true);
});

test('appendMessages keeps an unmatched tool result inspectable without replaying it', () => {
  const timeline = createTimeline('main', 'session', 'codex');
  appendMessages(timeline, [{
    role: 'user',
    content: [{
      type: 'tool_result', tool_request_id: 'missing', tool: 'unmatched result', result: 'orphan output',
      extended: { render: { verb: 'exec', stdout: '', stderr: 'orphan output' }, is_error: true },
    }],
  }]);
  assert.equal(timeline.steps.length, 1);
  assert.equal(timeline.steps[0].call.verb, 'other');
  assert.equal(timeline.steps[0].resultData, 'orphan output');
  assert.equal(timeline.steps[0].isError, true);
  assert.equal(foldState(timeline.steps, 0).term[0].stderr, 'orphan output');

  const failedPatch = tool(0, 'patch_file', 'a.txt', { verb: 'exec', stderr: 'patch failed' });
  assert.equal(foldState([failedPatch], 0).term[0].stderr, 'patch failed');
});
