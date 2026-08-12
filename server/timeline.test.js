import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch } from '../ui/src/lib/timeline.ts';

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
