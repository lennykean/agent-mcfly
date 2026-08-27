import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { /* node:sqlite can be absent or disabled */ }

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('authenticated OpenCode route callbacks switch, clear, and remain followable', {
  skip: !sqlite && 'needs node:sqlite', timeout: 45_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-opencode-route-'));
  const home = path.join(root, 'home');
  const xdg = path.join(root, 'data');
  const cwd = path.join(root, 'repo');
  const other = path.join(root, 'other');
  for (const dir of [home, xdg, cwd, other, path.join(xdg, 'opencode')]) fs.mkdirSync(dir, { recursive: true });
  const database = path.join(xdg, 'opencode', 'opencode.db');
  const db = new sqlite.DatabaseSync(database);
  db.exec(`
    create table session (
      id text primary key, parent_id text, slug text not null, directory text not null,
      title text not null, time_updated integer not null, time_archived integer
    );
    create table message (
      id text primary key, session_id text not null, time_created integer not null,
      time_updated integer not null, data text not null
    );
    create table part (
      id text primary key, message_id text not null, session_id text not null,
      time_created integer not null, time_updated integer not null, data text not null
    );
  `);
  const add = db.prepare('insert into session values (?, null, ?, ?, ?, ?, null)');
  add.run('ses_a', 'a', cwd, 'Session A', 1000);
  add.run('ses_b', 'b', cwd, 'Session B', 1001);
  db.prepare('insert into message values (?, ?, ?, ?, ?)').run(
    'msg_a', 'ses_a', 1100, 1100, JSON.stringify({ role: 'user', time: { created: 1100 } }),
  );
  db.prepare('insert into part values (?, ?, ?, ?, ?, ?)').run(
    'part_a', 'msg_a', 'ses_a', 1100, 1100, JSON.stringify({ type: 'text', text: 'hello from OpenCode' }),
  );
  db.close();

  const port = await freePort();
  const server = spawn(process.execPath, ['server/server.js'], {
    cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: String(port), MCFLY_OPEN: '0', HOME: home, USERPROFILE: home,
      XDG_DATA_HOME: xdg, OPENCODE_DISABLE_CHANNEL_DB: '1',
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
  const config = await (await fetch(`${base}/api/config`)).json();
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws/pty?token=${config.token}&tool=_&cwd=${encodeURIComponent(cwd)}`);
  const ptyReady = new Promise((resolve, reject) => {
    ws.on('message', (data) => {
      const value = data.toString();
      if (value.charCodeAt(0) !== 0) return;
      const control = JSON.parse(value.slice(1));
      if (control.ptyId) { ptyId = control.ptyId; resolve(); }
    });
    ws.once('error', reject);
  });
  await once(ws, 'open');
  await ptyReady;

  const registryFile = path.join(home, '.mcfly', 'servers.json');
  let token;
  for (let i = 0; i < 100 && !token; i++) {
    try { token = JSON.parse(fs.readFileSync(registryFile, 'utf8')).find((entry) => entry.port === port)?.mcpToken; } catch { /* boot race */ }
    if (!token) await delay(25);
  }
  assert.match(token, /^[a-f0-9]{64}$/);
  const callback = (body, authorization = `Bearer ${token}`) => fetch(`${base}/api/opencode-route`, {
    method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const mapped = async () => (await (await fetch(`${base}/api/ptys`)).json()).find((pty) => pty.id === ptyId);

  assert.equal((await callback({ ptyId, sessionID: 'ses_a', cwd }, 'Bearer wrong')).status, 401);
  assert.equal((await callback({ ptyId: '0000000000000000', sessionID: 'ses_a', cwd })).status, 404);
  assert.equal((await callback({ ptyId, sessionID: 'ses_a', cwd: other })).status, 404);
  assert.equal((await callback({ ptyId, cwd })).status, 400);

  assert.equal((await callback({ ptyId, sessionID: 'ses_a', cwd })).status, 200);
  assert.deepEqual((await mapped()).session, { provider: 'opencode', id: 'ses_a', pwd: cwd, label: 'Session A' });
  const listed = await (await fetch(`${base}/api/sessions?provider=opencode&pwd=${encodeURIComponent(cwd)}`)).json();
  assert.deepEqual(listed.map((session) => session.id), ['ses_b', 'ses_a']);
  const transcript = await (await fetch(`${base}/api/session?provider=opencode&id=ses_a&cursor=0`)).json();
  assert.equal(transcript.messages[0].content[0].text, 'hello from OpenCode');

  assert.equal((await callback({ ptyId, sessionID: 'ses_b', cwd })).status, 200);
  assert.equal((await mapped()).session.id, 'ses_b');
  assert.equal((await callback({ ptyId, sessionID: null })).status, 200);
  assert.equal((await mapped()).session, null);

  await callback({ ptyId, sessionID: 'ses_a', cwd });
  const automatic = await fetch(`${base}/api/pty-session`, {
    method: 'POST', body: JSON.stringify({ ptyId, provider: 'codex', session: 'guess', pwd: cwd, intent: 'automatic' }),
  });
  assert.deepEqual(await automatic.json(), { ok: false, blocked: true });
  assert.equal((await mapped()).session.id, 'ses_a');

  await fetch(`${base}/api/pty-session`, {
    method: 'POST', body: JSON.stringify({ ptyId, provider: 'codex', session: 'chosen', pwd: cwd, intent: 'explicit' }),
  });
  await callback({ ptyId, sessionID: null });
  assert.deepEqual((await mapped()).session, { provider: 'codex', id: 'chosen', pwd: cwd });
  await fetch(`${base}/api/pty-session`, {
    method: 'POST', body: JSON.stringify({ ptyId, intent: 'unfollow' }),
  });
  assert.deepEqual(await (await callback({ ptyId, sessionID: 'ses_b', cwd })).json(), { ok: false, blocked: true });
  assert.equal((await mapped()).session, null);

  fs.renameSync(database, `${database}.unavailable`);
  const unsupported = await callback({ ptyId, sessionID: 'ses_a', cwd });
  assert.equal(unsupported.status, 200);
  assert.deepEqual(await unsupported.json(), { ok: false, unsupported: true });
});
