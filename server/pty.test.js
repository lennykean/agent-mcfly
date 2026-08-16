import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import WebSocket from 'ws';
import { attachPty, killAllPtys, killPty, listPtys, TOKEN } from './pty.js';

test('kills hosted terminals during shutdown', async () => {
  const server = http.createServer();
  const hosts = new Set();
  attachPty(server, hosts);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  hosts.add(`127.0.0.1:${port}`);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/pty?token=${TOKEN}&tool=_`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await new Promise((resolve) => {
    if (listPtys().length) resolve();
    else ws.once('message', resolve);
  });

  killAllPtys();
  await new Promise((resolve) => ws.once('close', resolve));
  assert.equal(listPtys().length, 0);
  await new Promise((resolve) => server.close(resolve));
});

test('hosts a remote terminal on an SSH PTY channel', async (t) => {
  class Channel extends EventEmitter {
    stderr = new EventEmitter();
    writes = [];
    windows = [];
    closed = false;
    encoding = null;
    setEncoding(value) { this.encoding = value; }
    write(data) { this.writes.push(data); this.emit('activity'); }
    setWindow(...args) { this.windows.push(args); this.emit('activity'); }
    signal() { this.close(); }
    close() {
      if (this.closed) return;
      this.closed = true;
      queueMicrotask(() => this.emit('close'));
    }
  }
  const channel = new Channel();
  const client = {
    command: '',
    options: null,
    exec(command, options, cb) {
      this.command = command;
      this.options = options;
      queueMicrotask(() => cb(null, channel));
    },
  };
  const server = http.createServer();
  const hosts = new Set();
  attachPty(server, hosts, (id) => (id === 'host-1'
    ? { id, client, home: '/home/test', platform: 'linux' }
    : undefined));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  hosts.add(`127.0.0.1:${port}`);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/pty?token=${TOKEN}&connection=host-1&tool=_&cwd=${encodeURIComponent("/srv/it's here")}`);
  t.after(async () => {
    killAllPtys();
    if (ws.readyState < 2) ws.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const control = await new Promise((resolve, reject) => {
    ws.on('message', (data) => {
      const text = data.toString();
      if (text.charCodeAt(0) === 0) resolve(JSON.parse(text.slice(1)));
    });
    ws.once('error', reject);
  });
  assert.ok(client.command.includes("'/srv/it'\\''s here'"));
  assert.equal(client.options.pty.term, 'xterm-256color');
  assert.equal(channel.encoding, 'utf8');
  assert.equal(listPtys('host-1').length, 1);
  assert.equal(listPtys().length, 0);

  const output = new Promise((resolve) => ws.once('message', (data) => resolve(data.toString())));
  channel.emit('data', 'remote output');
  assert.equal(await output, 'remote output');

  const activity = new Promise((resolve) => {
    let count = 0;
    channel.on('activity', () => { if (++count === 2) resolve(); });
  });
  ws.send(JSON.stringify({ t: 'i', d: 'pwd\r' }));
  ws.send(JSON.stringify({ t: 'r', cols: 120, rows: 40 }));
  await activity;
  assert.deepEqual(channel.writes, ['pwd\r']);
  assert.deepEqual(channel.windows, [[40, 120, 0, 0]]);

  const closed = new Promise((resolve) => ws.once('close', resolve));
  assert.equal(killPty(control.ptyId, 'host-1'), true);
  await closed;
  assert.equal(listPtys('host-1').length, 0);
});

test('closes an SSH PTY that opens after its browser leaves', async (t) => {
  class Channel extends EventEmitter {
    stderr = new EventEmitter();
    closed = false;
    setEncoding() {}
    close() { this.closed = true; }
  }
  const channel = new Channel();
  let finishOpen;
  const client = { exec(_command, _options, cb) { finishOpen = () => cb(null, channel); } };
  const server = http.createServer();
  const hosts = new Set();
  attachPty(server, hosts, () => ({ client, home: '/home/test', platform: 'linux' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  hosts.add(`127.0.0.1:${port}`);
  t.after(async () => {
    killAllPtys();
    await new Promise((resolve) => server.close(resolve));
  });

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/pty?token=${TOKEN}&connection=host-1&tool=_`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.close();
  await new Promise((resolve) => ws.once('close', resolve));
  finishOpen();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(channel.closed, true);
  assert.equal(listPtys('host-1').length, 0);
});
