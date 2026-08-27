import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const psQuote = (value) => String(value).replace(/'/g, "''");
const shQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function hookCommand(cwd, event, marker) {
  const encoded = Buffer.from(JSON.stringify(event)).toString('base64');
  const cli = path.join(process.cwd(), 'server', 'cli.js');
  if (process.platform === 'win32') {
    return `Set-Location -LiteralPath '${psQuote(cwd)}'; `
      + `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | `
      + `& '${psQuote(process.execPath)}' '${psQuote(cli)}' codex-hook; `
      + `Write-Output ('__MCFLY_' + '${marker}__')`;
  }
  return `cd -- ${shQuote(cwd)} && printf %s ${shQuote(JSON.stringify(event))} | `
    + `${shQuote(process.execPath)} ${shQuote(cli)} codex-hook; `
    + `printf '%s\\n' '__MCFLY_''${marker}__'`;
}

test('Codex hook binds a post-cd session to its owning hosted PTY only when every cwd agrees', { timeout: 45_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-codex-e2e-'));
  const home = path.join(root, 'home');
  const initialCwd = path.join(root, 'initial');
  const activeCwd = path.join(root, 'after-cd');
  const codexHome = path.join(home, '.codex');
  const sessions = path.join(codexHome, 'sessions');
  for (const dir of [home, initialCwd, activeCwd, sessions]) fs.mkdirSync(dir, { recursive: true });

  const port = await freePort();
  const server = spawn(process.execPath, ['server/server.js'], {
    cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: String(port), MCFLY_OPEN: '0', CODEX_HOME: codexHome,
      HOME: home, USERPROFILE: home,
    },
  });
  let ws;
  let ptyId;
  t.after(async () => {
    try {
      if (ptyId) await fetch(`http://127.0.0.1:${port}/api/pty-kill`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ptyId }),
      });
    } catch { /* server may already be gone */ }
    try { ws?.close(); } catch { /* already closed */ }
    if (server.exitCode === null) {
      server.kill();
      await Promise.race([once(server, 'exit'), delay(5000)]);
    }
    if (server.exitCode === null) server.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  let startup = '';
  let startupError = '';
  server.stdout.setEncoding('utf8');
  server.stderr.setEncoding('utf8');
  server.stdout.on('data', (chunk) => { startup += chunk; });
  server.stderr.on('data', (chunk) => { startupError += chunk; });
  const deadline = Date.now() + 15_000;
  while (!startup.includes('Agent McFly API:') && server.exitCode === null && Date.now() < deadline) await delay(25);
  assert.equal(server.exitCode, null, startupError);
  assert.match(startup, /Agent McFly API:/, startupError);

  const base = `http://127.0.0.1:${port}`;
  const configResponse = await fetch(`${base}/api/config`);
  assert.equal(configResponse.ok, true);
  const config = await configResponse.json();
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws/pty?token=${config.token}&tool=_&cwd=${encodeURIComponent(initialCwd)}`);
  const ptyReady = new Promise((resolve, reject) => {
    ws.on('message', (data) => {
      const text = data.toString();
      if (text.charCodeAt(0) !== 0) return;
      const control = JSON.parse(text.slice(1));
      if (control.ptyId) { ptyId = control.ptyId; resolve(); }
    });
    ws.once('error', reject);
  });
  await once(ws, 'open');
  await ptyReady;

  const runHook = async (event, marker) => {
    const expected = `__MCFLY_${marker}__`;
    let output = '';
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`hook command timed out: ${output}`)), 15_000);
      const onMessage = (data) => {
        const text = data.toString();
        if (text.charCodeAt(0) === 0) return;
        output += text;
        if (!output.includes(expected)) return;
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve();
      };
      ws.on('message', onMessage);
    });
    ws.send(JSON.stringify({ t: 'i', d: `${hookCommand(activeCwd, event, marker)}\r` }));
    await done;
  };
  const mapped = async () => {
    const response = await fetch(`${base}/api/ptys`);
    assert.equal(response.ok, true);
    return (await response.json()).find((pty) => pty.id === ptyId);
  };

  const thread = 'thread-exact-e2e';
  const rollout = (name, cwd) => {
    const file = path.join(sessions, `rollout-${name}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: thread, cwd } })}\n`);
    return file;
  };
  const initialRollout = rollout('initial-cwd', initialCwd);
  const activeRollout = rollout('active-cwd', activeCwd);
  const event = (cwd, transcript_path) => ({
    hook_event_name: 'SessionStart', source: 'startup', session_id: thread, cwd, transcript_path,
    model: 'gpt-5.6', permission_mode: 'default',
  });

  await runHook(event(initialCwd, initialRollout), 'PROCESS_MISMATCH');
  assert.equal((await mapped()).session, null);

  await runHook(event(activeCwd, initialRollout), 'METADATA_MISMATCH');
  assert.equal((await mapped()).session, null);

  await runHook(event(activeCwd, activeRollout), 'POST_CD_MATCH');
  const pty = await mapped();
  assert.equal(pty.cwd, initialCwd);
  assert.deepEqual(pty.session, {
    provider: 'codex', id: path.basename(activeRollout), pwd: activeCwd, label: 'active-cwd',
  });
});
