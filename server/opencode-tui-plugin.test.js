import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import pty from '@lydell/node-pty';
import { currentOpenCodeRoute, tui, watchOpenCodeRoute } from './opencode-tui-plugin.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function apiFor(route, sessions = new Map()) {
  const state = { route };
  return {
    state,
    api: {
      app: { version: '1.17.9' },
      route: { get current() { return state.route; } },
      state: { ready: true, session: { get: (id) => sessions.get(id) } },
      lifecycle: { onDispose() {} },
    },
  };
}

test('reads only the confirmed OpenCode public route shape and live session state', () => {
  const cwd = process.cwd();
  const sessions = new Map([['ses_a', { id: 'ses_a', directory: cwd }]]);
  const { state, api } = apiFor({ name: 'session', params: { sessionID: 'ses_a' } }, sessions);
  assert.deepEqual(currentOpenCodeRoute(api), { sessionID: 'ses_a', cwd });
  state.route = { name: 'home' };
  assert.equal(currentOpenCodeRoute(api), null);
  state.route = { name: 'session', params: { id: 'ses_a' } };
  assert.equal(currentOpenCodeRoute(api), undefined);
  state.route = { name: 'session', params: { sessionID: 'ses_missing' } };
  assert.equal(currentOpenCodeRoute(api), undefined);
  state.route = { name: 'dialog', params: { sessionID: 'ses_a' } };
  assert.equal(currentOpenCodeRoute(api), undefined);
});

test('route create, resume, switch, and home reports are exact and ordered', async () => {
  const cwd = process.cwd();
  const sessions = new Map([
    ['ses_a', { id: 'ses_a', directory: cwd }],
    ['ses_b', { id: 'ses_b', directory: cwd }],
  ]);
  const { state, api } = apiFor({ name: 'session', params: { sessionID: 'ses_a' } }, sessions);
  const reports = [];
  let tick;
  let cancelled = false;
  const dispose = watchOpenCodeRoute(api, async (route) => { reports.push(route); return true; }, {
    every: (fn) => { tick = fn; return 7; },
    cancel: (id) => { assert.equal(id, 7); cancelled = true; },
  });
  await flush();
  state.route = { name: 'session', params: { sessionID: 'ses_b' } };
  tick();
  await flush();
  state.route = { name: 'session', params: { sessionID: 'ses_b' } };
  tick(); // acknowledged routes do not spam the callback
  await flush();
  state.route = { name: 'home' };
  tick();
  await flush();
  await dispose();
  assert.equal(cancelled, true);
  assert.deepEqual(reports, [
    { sessionID: 'ses_a', cwd },
    { sessionID: 'ses_b', cwd },
    null,
  ]);
});

test('disposal waits out a pending route report and then releases its exact mapping', async () => {
  const cwd = process.cwd();
  const { api } = apiFor({ name: 'session', params: { sessionID: 'ses_a' } },
    new Map([['ses_a', { id: 'ses_a', directory: cwd }]]));
  const reports = [];
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const dispose = watchOpenCodeRoute(api, async (route) => {
    reports.push(route);
    if (route) await pending;
    return true;
  }, { every: () => 1, cancel() {} });
  const stopped = dispose();
  await flush();
  assert.deepEqual(reports, [{ sessionID: 'ses_a', cwd }]);
  release();
  await stopped;
  assert.deepEqual(reports, [{ sessionID: 'ses_a', cwd }, null]);
});

test('malformed or unsupported APIs stay inert instead of clearing a mapping', async () => {
  const { api } = apiFor({ name: 'session', params: { sessionID: '' } });
  const reports = [];
  let tick;
  const dispose = watchOpenCodeRoute(api, async (route) => { reports.push(route); return true; }, {
    every: (fn) => { tick = fn; return 1; }, cancel() {},
  });
  tick();
  await flush();
  await dispose();
  assert.deepEqual(reports, []);

  let registered = false;
  await tui({ app: { version: 'future' }, route: {}, state: {}, lifecycle: { onDispose() { registered = true; } } });
  assert.equal(registered, false);
});

test('transient callback failures back off, retry, and a route change bypasses the old delay', async () => {
  const cwd = process.cwd();
  const sessions = new Map([
    ['ses_a', { id: 'ses_a', directory: cwd }],
    ['ses_b', { id: 'ses_b', directory: cwd }],
    ['ses_c', { id: 'ses_c', directory: cwd }],
  ]);
  const { state, api } = apiFor({ name: 'session', params: { sessionID: 'ses_a' } }, sessions);
  const attempts = [];
  let now = 0;
  let tick;
  const dispose = watchOpenCodeRoute(api, async (route) => {
    attempts.push({ id: route?.sessionID ?? null, at: now });
    return route?.sessionID === 'ses_c' || attempts.filter((item) => item.id === 'ses_a').length >= 3;
  }, {
    every: (fn) => { tick = fn; return 1; }, cancel() {}, clock: () => now,
    retryBaseMs: 500, retryMaxMs: 2000,
  });
  await flush();
  for (now of [100, 250, 499]) { tick(); await flush(); }
  assert.deepEqual(attempts, [{ id: 'ses_a', at: 0 }]);
  now = 500; tick(); await flush();
  now = 1499; tick(); await flush();
  now = 1500; tick(); await flush();
  assert.deepEqual(attempts, [
    { id: 'ses_a', at: 0 }, { id: 'ses_a', at: 500 }, { id: 'ses_a', at: 1500 },
  ]);
  state.route = { name: 'session', params: { sessionID: 'ses_b' } };
  now = 1501; tick(); await flush();
  assert.deepEqual(attempts.at(-1), { id: 'ses_b', at: 1501 });
  state.route = { name: 'session', params: { sessionID: 'ses_c' } };
  now = 1502; tick(); await flush();
  assert.deepEqual(attempts.at(-1), { id: 'ses_c', at: 1502 });
  await dispose();
});

function installedOpenCode() {
  const override = process.env.MCFLY_OPENCODE_BIN;
  const candidates = [
    override,
    ...(process.platform === 'win32'
      ? [path.join(path.dirname(process.execPath), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')]
      : ['/usr/local/bin/opencode', '/usr/bin/opencode']),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      if (result.status === 0 && result.stdout.trim() === '1.17.9') return candidate;
    } catch { /* not the confirmed binary */ }
  }
  return null;
}

const opencode1179 = installedOpenCode();

test('installed OpenCode 1.17.9 exposes route.current sessionID in a real isolated TUI PTY and --pure skips the layer', {
  skip: !opencode1179 && 'OpenCode 1.17.9 is not installed', timeout: 30_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-opencode-route-api-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'repo');
  const log = path.join(root, 'routes.jsonl');
  const plugin = path.join(root, 'route-plugin.js');
  const config = path.join(root, 'tui.json');
  for (const dir of [home, cwd, 'data', 'cache', 'config', 'state'].map((dir) => path.isAbsolute(dir) ? dir : path.join(root, dir))) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(plugin, `
    import fs from 'node:fs';
    const log = ${JSON.stringify(log)};
    const write = (api) => fs.appendFileSync(log, JSON.stringify({ version: api.app.version, route: api.route.current }) + '\\n');
    async function tui(api) {
      write(api);
      api.route.navigate('session', { sessionID: 'ses_exact_route_probe' });
      write(api);
      api.route.navigate('home');
      write(api);
    }
    export default { id: 'mcfly-route-probe', tui };
  `);
  fs.writeFileSync(config, JSON.stringify({ plugin: ['./route-plugin.js'] }));
  const env = {
    ...process.env,
    HOME: home, USERPROFILE: home, OPENCODE_TEST_HOME: home,
    XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'),
    OPENCODE_TUI_CONFIG: config, OPENCODE_CONFIG_CONTENT: '{}',
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_PRUNE: 'true',
  };
  const children = new Set();
  let terminalOutput = '';
  t.after(() => {
    for (const child of children) { try { child.kill(); } catch { /* already exited */ } }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const launch = (args = []) => {
    const child = pty.spawn(opencode1179, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd, env });
    child.onData((chunk) => { terminalOutput += chunk; });
    children.add(child);
    child.onExit(() => { children.delete(child); });
    return child;
  };
  const waitUntil = async (predicate, timeout = 10_000) => {
    const deadline = Date.now() + timeout;
    while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    return predicate();
  };
  const stop = async (child) => {
    if (children.has(child)) child.kill();
    await waitUntil(() => !children.has(child), 5000);
  };

  const regular = launch();
  assert.equal(await waitUntil(() => {
    try { return fs.readFileSync(log, 'utf8').trim().split('\n').length >= 3; } catch { return false; }
  }), true, `real TUI plugin did not report routes: ${terminalOutput.slice(0, 8000)}`);
  await stop(regular);
  const routes = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(routes[0].version, '1.17.9');
  assert.deepEqual(routes.map((entry) => entry.route), [
    { name: 'home' },
    { name: 'session', params: { sessionID: 'ses_exact_route_probe' } },
    { name: 'home' },
  ]);

  fs.rmSync(log, { force: true });
  const pure = launch(['--pure']);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await stop(pure);
  assert.equal(fs.existsSync(log), false);
});
