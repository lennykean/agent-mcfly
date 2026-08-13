import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test('workspace state: ingests snapshots and events, serves filtered queries', async () => {
  const port = 17700 + Math.floor(Math.random() * 200);
  const server = spawn(process.execPath, ['server/server.js'], {
    cwd: process.cwd(), env: { ...process.env, PORT: String(port) }, stdio: 'pipe',
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { if (String(d).includes('Agent McFly API')) resolve(); });
    server.on('exit', () => reject(new Error('server died')));
    setTimeout(() => reject(new Error('server never listened')), 10_000);
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    const post = await fetch(`${base}/api/workspace-events`, {
      method: 'POST',
      body: JSON.stringify({
        snapshot: { playhead: { pointer: 42 }, editor: { active: 'pinned' } },
        events: [
          { ts: Date.now() - 60_000, kind: 'select', path: 'a.ts', lines: [1, 3], text: 'old' },
          { ts: Date.now(), kind: 'seek', from: 10, to: 400 },
          { ts: Date.now(), kind: 'select', path: 'b.ts', lines: [5, 9], text: 'fresh' },
        ],
      }),
    });
    assert.equal(post.status, 200);

    // bare query: snapshot only, no events
    const bare = await (await fetch(`${base}/api/workspace-state`)).json();
    assert.equal(bare.snapshot.playhead.pointer, 42);
    assert.deepEqual(bare.events, []);

    // history + kind filter
    const sel = await (await fetch(`${base}/api/workspace-state?history=10&kinds=select`)).json();
    assert.deepEqual(sel.events.map((e) => e.text), ['old', 'fresh']);

    // since_seconds excludes the old one
    const fresh = await (await fetch(`${base}/api/workspace-state?history=10&kinds=select&since_seconds=30`)).json();
    assert.deepEqual(fresh.events.map((e) => e.text), ['fresh']);

    // snapshot merge keeps prior keys
    await fetch(`${base}/api/workspace-events`, {
      method: 'POST', body: JSON.stringify({ snapshot: { playhead: { pointer: 43 } } }),
    });
    const merged = await (await fetch(`${base}/api/workspace-state`)).json();
    assert.equal(merged.snapshot.playhead.pointer, 43);
    assert.equal(merged.snapshot.editor.active, 'pinned');
  } finally {
    server.kill('SIGKILL');
  }
});
