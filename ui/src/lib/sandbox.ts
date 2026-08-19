// Runs a matcher's transform — a JS function body written by an agent — over a
// tool result, off the main thread and away from everything that matters.
//
// The isolation is the Worker itself: it has no DOM, no window, no React state,
// and cannot navigate or touch the page. On top of that the worker deletes the
// network and storage globals it DOES inherit before the transform ever runs,
// so a transform cannot exfiltrate the data it is handed. Input and output
// cross by structured clone, so the transform never holds a live reference to
// anything on this side.
//
// What this is NOT: a defence against a hostile transform burning CPU in ways
// the timeout does not catch, or against `new Function` reaching a global we
// failed to name. It is the seatbelt for code the user's own agent wrote, not a
// jail for code from a stranger.

const TIMEOUT_MS = 2000;

const WORKER_SOURCE = `
// Blank the escape hatches this worker inherited, ONCE, before any transform
// runs. These live on WorkerGlobalScope.prototype, not on self — deleting an
// own property that was never there would leave the real one reachable, so
// each is shadowed by an own property instead.
for (const name of [
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts',
  'indexedDB', 'caches', 'localStorage', 'sessionStorage', 'navigator',
  'Notification', 'BroadcastChannel', 'SharedWorker', 'Worker',
]) {
  try {
    Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false });
  } catch { /* already non-configurable: nothing more to do */ }
}

self.onmessage = (e) => {
  try {
    const run = new Function('data', e.data.body);
    const value = run(e.data.input);
    // force the clone here so an unclonable return is OUR error, not a silent
    // postMessage failure the caller would see as a timeout
    self.postMessage({ ok: true, value: JSON.parse(JSON.stringify(value ?? null)) });
  } catch (error) {
    self.postMessage({ ok: false, error: String((error && error.message) || error) });
  }
};
`;

let blobUrl: string | undefined;
function workerUrl() {
  blobUrl ??= URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
  return blobUrl;
}

export function runTransform(body: string, input: unknown): Promise<{ value?: unknown; error?: string }> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(workerUrl());
    } catch (error) {
      resolve({ error: `sandbox unavailable: ${String(error)}` });
      return;
    }
    const finish = (out: { value?: unknown; error?: string }) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(out);
    };
    const timer = setTimeout(() => finish({ error: `transform timed out after ${TIMEOUT_MS}ms` }), TIMEOUT_MS);
    worker.onmessage = (e) => finish(e.data.ok ? { value: e.data.value } : { error: e.data.error });
    worker.onerror = (e) => finish({ error: e.message || 'transform failed' });
    try {
      // a result that will not clone cannot reach the worker at all
      worker.postMessage({ body, input: JSON.parse(JSON.stringify(input ?? null)) });
    } catch {
      finish({ error: 'result could not be passed to the transform' });
    }
  });
}
