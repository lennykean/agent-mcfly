import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

test('workspace state: ingests snapshots and events, serves filtered queries', async () => {
  const port = 17700 + Math.floor(Math.random() * 200);
  const server = spawn(process.execPath, ['server/server.js'], {
    // MCFLY_OPEN off: a test run must never launch a browser tab
    cwd: process.cwd(), env: { ...process.env, PORT: String(port), MCFLY_OPEN: '0' }, stdio: 'pipe',
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

    // A multi-byte character split across two body chunks must survive: the
    // reader concatenates bytes and decodes once, rather than stringifying
    // each chunk as it lands.
    const note = `${'x'.repeat(400)}héllo — 🎉 日本語`;
    const bytes = Buffer.from(JSON.stringify({ scope: 'utf8', snapshot: { note } }), 'utf8');
    const split = bytes.length - 5; // lands INSIDE the last multi-byte character
    await fetch(`${base}/api/workspace-events`, {
      method: 'POST',
      duplex: 'half',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.subarray(0, split));
          controller.enqueue(bytes.subarray(split));
          controller.close();
        },
      }),
    });
    const utf8 = await (await fetch(`${base}/api/workspace-state?project=utf8`)).json();
    assert.equal(utf8.snapshot.note, note);

    // Explicit project queries must not fall through to the newest unrelated
    // scope, and prefix lookalikes are not ancestors.
    const project = path.join(process.cwd(), 'project');
    const lookalike = `${project}-old`;
    await fetch(`${base}/api/workspace-events`, {
      method: 'POST', body: JSON.stringify({ scope: project, snapshot: { marker: 'right' } }),
    });
    await fetch(`${base}/api/workspace-events`, {
      method: 'POST', body: JSON.stringify({ scope: lookalike, snapshot: { marker: 'wrong' } }),
    });
    const matched = await (await fetch(`${base}/api/workspace-state?project=${encodeURIComponent(path.join(project, 'child'))}`)).json();
    assert.equal(matched.snapshot.marker, 'right');
    const missing = await (await fetch(`${base}/api/workspace-state?project=${encodeURIComponent(path.join(process.cwd(), 'elsewhere'))}`)).json();
    assert.equal(missing.scope, null);
    assert.deepEqual(missing.snapshot, {});
    assert.deepEqual(missing.events, []);

    const remoteScope = `connection-id\0/remote/project`;
    await fetch(`${base}/api/workspace-events`, {
      method: 'POST', body: JSON.stringify({ scope: remoteScope, snapshot: { marker: 'remote' } }),
    });
    const remote = await (await fetch(`${base}/api/workspace-state?project=${encodeURIComponent('/remote/project/child')}`)).json();
    assert.equal(remote.scope, remoteScope);
    assert.equal(remote.snapshot.marker, 'remote');

    await fetch(`${base}/api/workspace-events`, {
      method: 'POST', body: JSON.stringify({ scope: '/repo/Foo', snapshot: { marker: 'upper' } }),
    });
    await fetch(`${base}/api/workspace-events`, {
      method: 'POST', body: JSON.stringify({ scope: '/repo/foo', snapshot: { marker: 'lower' } }),
    });
    const upper = await (await fetch(`${base}/api/workspace-state?project=${encodeURIComponent('/repo/Foo')}`)).json();
    const lower = await (await fetch(`${base}/api/workspace-state?project=${encodeURIComponent('/repo/foo')}`)).json();
    assert.equal(upper.snapshot.marker, 'upper');
    assert.equal(lower.snapshot.marker, 'lower');

    await fetch(`${base}/api/workspace-events`, {
      method: 'POST', body: JSON.stringify({ scope: '/', snapshot: { marker: 'root' } }),
    });
    const rooted = await (await fetch(`${base}/api/workspace-state?project=${encodeURIComponent('/some/project')}`)).json();
    assert.equal(rooted.scope, '/');
    assert.equal(rooted.snapshot.marker, 'root');
  } finally {
    server.kill('SIGKILL');
  }
});
