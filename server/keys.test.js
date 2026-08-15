import test from 'node:test';
import assert from 'node:assert/strict';
import { actionOf, bindingsFor, setLeaders, setTmuxMode } from '../ui/src/lib/keys.ts';

test('tmux project chooser is a named action on the configured prefix', () => {
  setLeaders(undefined, undefined);
  setTmuxMode(true);
  try {
    const row = bindingsFor().find((x) => x.action === 'termProjects');
    assert.deepEqual(row, { action: 'termProjects', bindings: ['Ctrl+b w'], source: 'tmux' });
    assert.equal(actionOf({ key: 'b', code: 'KeyB', ctrlKey: true, shiftKey: false, altKey: false }, ['termProjects']), null);
    assert.equal(actionOf({ key: 'w', code: 'KeyW', ctrlKey: false, shiftKey: false, altKey: false }, ['termProjects']), 'termProjects');
  } finally {
    setTmuxMode(false);
  }
});
