import test from 'node:test';
import assert from 'node:assert/strict';

test('workspace reports and editor selections stay with their owning scope', async () => {
  const timers = [];
  const posts = [];
  globalThis.window = {
    setTimeout(fn) { timers.push(fn); return 999_999; },
  };
  globalThis.document = {
    querySelectorAll() { return []; },
  };
  globalThis.fetch = async (_url, init) => { posts.push(JSON.parse(init.body)); };

  const { editorSelFor, emit, onEditorSelection, reportEditorSelection } =
    await import('../ui/src/lib/workspace.ts');

  const seenA = [];
  const alsoSeenA = [];
  const seenB = [];
  const offA = onEditorSelection('project-a', (sels) => seenA.push(sels.map((s) => s.text)));
  const offA2 = onEditorSelection('project-a', (sels) => alsoSeenA.push(sels.map((s) => s.text)));
  const offB = onEditorSelection('project-b', (sels) => seenB.push(sels.map((s) => s.text)));

  emit('project-a', { kind: 'tab_focus', tab: 'a' });
  emit('project-b', { kind: 'tab_focus', tab: 'b' });
  reportEditorSelection('project-a', { path: 'one.ts', text: 'A1', rects: [] });
  reportEditorSelection('project-a', { path: 'two.ts', text: 'A2', rects: [] });
  reportEditorSelection('project-b', { path: 'one.ts', text: 'B1', rects: [] });

  assert.equal(editorSelFor('project-a', 'one.ts')?.text, 'A1');
  assert.equal(editorSelFor('project-b', 'one.ts')?.text, 'B1');
  assert.deepEqual(seenA.at(-1), ['A1', 'A2']);
  assert.deepEqual(alsoSeenA.at(-1), ['A1', 'A2']);
  assert.deepEqual(seenB.at(-1), ['B1']);

  timers.at(-1)();
  const byScope = Object.fromEntries(posts.map((post) => [post.scope, post]));
  assert.deepEqual(byScope['project-a'].events.map((event) => event.tab), ['a']);
  assert.deepEqual(byScope['project-b'].events.map((event) => event.tab), ['b']);
  assert.deepEqual(byScope['project-a'].snapshot.text_selections.map((sel) => sel.text), ['A1', 'A2']);
  assert.deepEqual(byScope['project-b'].snapshot.text_selections.map((sel) => sel.text), ['B1']);

  reportEditorSelection('posix', { path: '/repo/Foo.ts', text: 'case-sensitive', rects: [] });
  assert.equal(editorSelFor('posix', '/repo/foo.ts'), undefined);

  offA();
  offA2();
  offB();
});
