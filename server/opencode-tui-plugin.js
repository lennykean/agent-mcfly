import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PTY_ID = /^[a-f0-9]{16}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const ROUTE_POLL_MS = 250;
const REQUEST_TIMEOUT_MS = 1000;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 10_000;

const text = (value, max) => typeof value === 'string' && value.length > 0
  && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

function credentials(env = process.env, home = os.homedir()) {
  const ptyId = env.MCFLY_PTY_ID;
  const portText = env.MCFLY_PTY_PORT;
  const port = Number(portText);
  if (!PTY_ID.test(ptyId ?? '') || !/^\d{1,5}$/.test(portText ?? '') || port < 1 || port > 65535) return null;
  try {
    const entries = JSON.parse(fs.readFileSync(path.join(home, '.mcfly', 'servers.json'), 'utf8'));
    const server = Array.isArray(entries) && entries.find((entry) => Number(entry?.port) === port
      && Number.isInteger(entry?.pid) && entry.pid > 0 && TOKEN.test(entry?.mcpToken ?? ''));
    if (!server) return null;
    try { process.kill(server.pid, 0); } catch { return null; }
    return { ptyId, port, token: server.mcpToken };
  } catch { return null; }
}

// undefined means this API/route state is not understood yet; null is the
// supported home route and deliberately clears McFly's prior OpenCode link.
export function currentOpenCodeRoute(api) {
  try {
    const route = api.route.current;
    if (!route || typeof route !== 'object' || Array.isArray(route)) return undefined;
    if (route.name === 'home') return null;
    if (route.name !== 'session' || !text(route.params?.sessionID, 512)) return undefined;
    if (api.state.ready !== true || typeof api.state.session?.get !== 'function') return undefined;
    const session = api.state.session.get(route.params.sessionID);
    if (!session || session.id !== route.params.sessionID || !text(session.directory, 32 * 1024)
      || !path.isAbsolute(session.directory)) return undefined;
    return { sessionID: route.params.sessionID, cwd: session.directory };
  } catch { return undefined; }
}

// The public TUI API has route navigation but no route-change event. Poll the
// reactive getter, serialize reports, and retry failures without ever guessing
// a session. The disposer waits for a pending report before clearing it, so a
// late callback cannot leave a sticky exact link behind.
export function watchOpenCodeRoute(api, report, {
  every = setInterval,
  cancel = clearInterval,
  clock = Date.now,
  intervalMs = ROUTE_POLL_MS,
  retryBaseMs = RETRY_BASE_MS,
  retryMaxMs = RETRY_MAX_MS,
} = {}) {
  let acknowledged;
  let observed;
  let retryAt = 0;
  let failures = 0;
  let running = null;
  let stopped = false;

  const poll = () => {
    if (stopped || running) return running;
    const route = currentOpenCodeRoute(api);
    if (route === undefined) return null;
    const signature = route ? `${route.sessionID}\0${route.cwd}` : 'home';
    if (signature !== observed) {
      observed = signature;
      failures = 0;
      retryAt = 0;
    }
    if (signature === acknowledged) return null;
    if (clock() < retryAt) return null;
    running = Promise.resolve()
      .then(() => report(route))
      .catch(() => false)
      .then((ok) => {
        if (ok) {
          acknowledged = signature;
          failures = 0;
          retryAt = 0;
        } else if (observed === signature) {
          failures += 1;
          const delay = Math.min(retryMaxMs, retryBaseMs * (2 ** Math.min(failures - 1, 20)));
          retryAt = clock() + delay;
        }
      })
      .finally(() => { running = null; });
    return running;
  };

  void poll();
  const timer = every(() => { void poll(); }, intervalMs);
  return async () => {
    if (stopped) return;
    stopped = true;
    cancel(timer);
    try { await running; } catch { /* report already failed harmlessly */ }
    if (acknowledged && acknowledged !== 'home') {
      try { await report(null); } catch { /* McFly may have exited first */ }
    }
  };
}

function transport(env = process.env) {
  const owner = credentials(env);
  if (!owner) return null;
  return async (route) => {
    try {
      const response = await fetch(`http://127.0.0.1:${owner.port}/api/opencode-route`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ptyId: owner.ptyId,
          sessionID: route?.sessionID ?? null,
          ...(route ? { cwd: route.cwd } : {}),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return response.ok;
    } catch { return false; }
  };
}

export async function tui(api) {
  try {
    // Feature-detect the confirmed 1.17.9 public shape. Other shapes remain
    // inactive rather than being interpreted as a session or home route.
    if (!api || typeof api.app?.version !== 'string' || !api.route
      || typeof api.state?.session?.get !== 'function'
      || typeof api.lifecycle?.onDispose !== 'function') return;
    const report = transport();
    if (!report) return;
    const dispose = watchOpenCodeRoute(api, report);
    api.lifecycle.onDispose(dispose);
  } catch { /* plugin loading must never prevent OpenCode from starting */ }
}

// OpenCode path plugins use the v1 module envelope and require a stable id.
export default { id: 'mcfly-exact-session', tui };
