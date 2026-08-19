import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

// The transform sandbox is a string of worker source, so it cannot be imported
// — it is read and run inside a node worker, which (like a browser Worker) has
// its own global object. That is what makes the shadowing assertions below
// mean anything: `new Function` resolves free variables against the worker's
// global, so a global blanked there is blanked for the transform.
//
// Not covered here: that the browser's Worker boundary itself holds. This
// tests the code we wrote, not the platform we rely on.
const source = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'sandbox.ts'),
  'utf8',
);
const workerBody = source.match(/const WORKER_SOURCE = `([\s\S]*?)`;/)?.[1];

const HARNESS = `
import { parentPort } from 'node:worker_threads';
globalThis.self = globalThis;
globalThis.postMessage = (m) => parentPort.postMessage(m);
${workerBody}
parentPort.on('message', (data) => self.onmessage({ data }));
`;

function runInWorker(body: string, input: unknown): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  return new Promise((resolve) => {
    const w = new Worker(HARNESS, { eval: true, type: 'module' } as never);
    const done = (v: { ok: boolean; value?: unknown; error?: string }) => {
      clearTimeout(timer);
      void w.terminate();
      resolve(v);
    };
    const timer = setTimeout(() => done({ ok: false, error: 'harness timeout' }), 10_000);
    w.on('message', done);
    w.on('error', (e) => done({ ok: false, error: String(e.message) }));
    w.postMessage({ body, input });
  });
}

test('sandboxed transform: returns, fails loudly, and never hangs the pane', async () => {
  assert.ok(workerBody, 'worker source not found in sandbox.ts');

  const mapped = await runInWorker('return data.items.map((x) => x.name);', { items: [{ name: 'one' }, { name: 'two' }] });
  assert.deepEqual(mapped.value, ['one', 'two']);

  // every failure mode has to come back as a message, not a silent nothing:
  // the pane shows the untransformed value plus the reason
  assert.match((await runInWorker('throw new Error("boom")', {})).error ?? '', /boom/);
  assert.equal((await runInWorker('return notDefined.x;', {})).ok, false);
  assert.equal((await runInWorker('const o = {}; o.self = o; return o;', {})).ok, false); // cyclic, not a hang

  assert.equal((await runInWorker('return undefined;', { a: 1 })).value, null);
  assert.deepEqual((await runInWorker('return data;', { deep: [1, { x: true }] })).value, { deep: [1, { x: true }] });
});

test('sandboxed transform cannot reach the network it was handed data from', async () => {
  // these live on WorkerGlobalScope.prototype: deleting an own property that
  // was never there would leave the real one reachable
  const seen = await runInWorker('return typeof fetch + "/" + typeof XMLHttpRequest + "/" + typeof navigator;', {});
  assert.equal(seen.value, 'undefined/undefined/undefined');

  const called = await runInWorker('try { fetch("http://example.invalid"); return "REACHED"; } catch { return "blocked"; }', {});
  assert.equal(called.value, 'blocked');

  const regained = await runInWorker('try { self.fetch = () => 1; } catch { /* frozen */ } return typeof fetch === "function" ? "REGAINED" : "still gone";', {});
  assert.notEqual(regained.value, 'REGAINED');
});
