import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { attachPty, claudePtySessions, claudeRecordMapping, clearPtyProviderSession, killAllPtys, killPty, launchAgentPty, listPeers, listPtys, ptyEnv, pullPeerInbox, sendPeerMessage, setPtyRelay, setPtySession, TOKEN, toolPath } from './pty.js';

test('hosted shells receive a fresh private PTY identity before descendants start', () => {
  const env = ptyEnv('0123456789abcdef', { KEEP: 'yes' }, {
    PORT: '8765', MCFLY_PTY_ID: 'parent', MCFLY_PTY_PORT: '1111', KEEP_PARENT: 'yes',
  });
  assert.equal(env.MCFLY_PTY_ID, '0123456789abcdef');
  assert.equal(env.MCFLY_PTY_PORT, '8765');
  assert.equal(env.KEEP, 'yes');
  assert.equal(env.KEEP_PARENT, 'yes');
  assert.equal(path.basename(env.OPENCODE_TUI_CONFIG), 'opencode-tui.json');

  const explicit = ptyEnv('0123456789abcdef', {}, { OPENCODE_TUI_CONFIG: 'user-layer.json' });
  assert.equal(explicit.OPENCODE_TUI_CONFIG, 'user-layer.json');
  const extra = ptyEnv('0123456789abcdef', { OPENCODE_TUI_CONFIG: 'launch-layer.json' }, {});
  assert.equal(extra.OPENCODE_TUI_CONFIG, 'launch-layer.json');
});

test('Claude PID records prove the live process and resolve an exact transcript', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-claude-pids-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '101.json'), JSON.stringify({ pid: 101, procStart: 'live-a', sessionId: 'session-a', cwd: '/repo/a' }));
  fs.writeFileSync(path.join(dir, '202.json'), JSON.stringify({ pid: 202, procStart: 'old-b', sessionId: 'session-b', cwd: '/repo/b' }));
  fs.writeFileSync(path.join(dir, '303.json'), JSON.stringify({ pid: 303, procStart: 'dead-c', sessionId: 'session-c', cwd: '/repo/c' }));
  fs.writeFileSync(path.join(dir, '404.json'), JSON.stringify({ pid: 404, sessionId: 'no-start', cwd: '/repo/d' }));
  fs.writeFileSync(path.join(dir, '505.json'), 'not json');

  const found = await claudePtySessions({
    dir,
    roots: [{ id: 'blank-pty', pid: 10, tool: '_' }, { id: 'other-pty', pid: 20 }],
    processes: new Map([
      [10, { parent: 1, starts: [] }], [11, { parent: 10, starts: [] }],
      [101, { parent: 11, starts: ['live-a'] }],
      [202, { parent: 20, starts: ['reused-b'] }],
    ]),
  });

  assert.equal(found.get('blank-pty').sessionId, 'session-a');
  assert.equal(found.has('other-pty'), false); // PID 202 was reused; 303 is dead
  const wrong = { provider: 'claude-code', id: 'project/wrong.jsonl', pwd: '/repo/a' };
  const exact = claudeRecordMapping(found.get('blank-pty'), [{ id: 'project/session-a.jsonl' }]);
  assert.notDeepEqual(exact, wrong);
  assert.deepEqual(exact, { provider: 'claude-code', id: 'project/session-a.jsonl', pwd: '/repo/a' });
  assert.equal(claudeRecordMapping(found.get('blank-pty'), []), null); // caller falls back
  assert.deepEqual(await claudePtySessions({ dir, roots: [{ id: 'blank-pty', pid: 10 }], processes: new Map() }), new Map());
  assert.deepEqual(await claudePtySessions({ dir: path.join(dir, 'missing'), roots: [{ id: 'blank-pty', pid: 10 }] }), new Map());
});

test('Windows tool lookup keeps PATH order when a later stale executable exists', () => {
  const current = 'C:\\current\\codex.cmd';
  const currentPs1 = 'C:\\current\\codex.ps1';
  const stale = 'C:\\stale\\codex.exe';
  const lookup = () => `C:\\current\\codex\r\n${current}\r\n${stale}\r\n`;

  assert.equal(toolPath('codex', {
    platform: 'win32', lookup, exists: (file) => file === currentPs1,
  }), currentPs1);
});

test('programmatic peer prompts reject terminal controls before spawning a PTY', () => {
  assert.throws(() => launchAgentPty('_', process.cwd(), [], 'bad\u001b[2J'), /control characters/);
});

test('programmatic agent terminals start visible with human input locked', async () => {
  const peer = launchAgentPty('_', process.cwd(), [], 'test');
  try {
    assert.equal(peer.relay_enabled, true);
    assert.equal(peer.interactive, false);
    assert.equal(peer.session_available, false);
    assert.equal(peer.messageable, false);
    assert.ok(listPeers().some((item) => item.id === peer.id));
  } finally {
    killPty(peer.terminal_id);
    for (let i = 0; i < 20 && listPeers().some((item) => item.id === peer.id); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
});

test('session precedence is unfollow, explicit, exact, then automatic', async () => {
  const peer = launchAgentPty('_', process.cwd(), [], 'test');
  const first = { provider: 'claude-code', id: 'first.jsonl', pwd: process.cwd() };
  const second = { provider: 'claude-code', id: 'second.jsonl', pwd: process.cwd() };
  const third = { provider: 'claude-code', id: 'third.jsonl', pwd: process.cwd() };
  try {
    assert.equal(setPtySession(peer.terminal_id, first), true);
    assert.equal(setPtySession(peer.terminal_id, second), true);
    assert.deepEqual(listPtys().find((item) => item.id === peer.terminal_id)?.session, second);
    assert.equal(setPtySession(peer.terminal_id, third, undefined, 'exact'), true);
    assert.equal(setPtySession(peer.terminal_id, { ...third, pwd: path.join(process.cwd(), 'alias') }), true);
    assert.equal(setPtySession(peer.terminal_id, first), null);
    assert.deepEqual(listPtys().find((item) => item.id === peer.terminal_id)?.session, third);
    assert.equal(setPtySession(peer.terminal_id, second, undefined, 'exact'), true); // clear/resume changes session
    assert.deepEqual(listPtys().find((item) => item.id === peer.terminal_id)?.session, second);
    assert.equal(setPtySession(peer.terminal_id, null, undefined, 'unfollow'), true);
    assert.equal(listPtys().find((item) => item.id === peer.terminal_id)?.session, null);
    assert.equal(setPtySession(peer.terminal_id, first), null);
    assert.equal(setPtySession(peer.terminal_id, second, undefined, 'exact'), null);
    assert.equal(listPtys().find((item) => item.id === peer.terminal_id)?.session, null);
    assert.equal(setPtySession(peer.terminal_id, first, undefined, 'explicit'), true);
    assert.equal(setPtySession(peer.terminal_id, second), null);
    assert.equal(setPtySession(peer.terminal_id, second, undefined, 'exact'), null);
    assert.deepEqual(listPtys().find((item) => item.id === peer.terminal_id)?.session, first);
    assert.equal(setPtySession(peer.terminal_id, third, undefined, 'explicit'), true);
    assert.deepEqual(listPtys().find((item) => item.id === peer.terminal_id)?.session, third);
    assert.equal(setPtySession(peer.terminal_id, null, undefined, 'unfollow'), true);
    assert.equal(setPtySession(peer.terminal_id, second), null);
    assert.equal(listPtys().find((item) => item.id === peer.terminal_id)?.session, null);
  } finally {
    killPty(peer.terminal_id);
    for (let i = 0; i < 20 && listPtys().some((item) => item.id === peer.terminal_id); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
});

test('OpenCode home and disposal clear only their own automatic or exact link', async () => {
  const peer = launchAgentPty('_', process.cwd(), [], 'test');
  const opencode = { provider: 'opencode', id: 'ses_a', pwd: process.cwd() };
  const other = { provider: 'codex', id: 'other.jsonl', pwd: process.cwd() };
  try {
    assert.equal(setPtySession(peer.terminal_id, other, undefined, 'exact'), true);
    assert.equal(clearPtyProviderSession(peer.terminal_id, 'opencode'), null);
    assert.deepEqual(listPtys().find((item) => item.id === peer.terminal_id)?.session, other);

    assert.equal(setPtySession(peer.terminal_id, opencode, undefined, 'exact'), true);
    assert.equal(clearPtyProviderSession(peer.terminal_id, 'opencode'), true);
    assert.equal(listPtys().find((item) => item.id === peer.terminal_id)?.session, null);
    assert.equal(setPtySession(peer.terminal_id, opencode), true);
    assert.equal(clearPtyProviderSession(peer.terminal_id, 'opencode'), true);

    assert.equal(setPtySession(peer.terminal_id, opencode, undefined, 'explicit'), true);
    assert.equal(clearPtyProviderSession(peer.terminal_id, 'opencode'), null);
    assert.deepEqual(listPtys().find((item) => item.id === peer.terminal_id)?.session, opencode);
    assert.equal(setPtySession(peer.terminal_id, null, undefined, 'unfollow'), true);
    assert.equal(clearPtyProviderSession(peer.terminal_id, 'opencode'), null);
    assert.equal(listPtys().find((item) => item.id === peer.terminal_id)?.session, null);
  } finally {
    killPty(peer.terminal_id);
    for (let i = 0; i < 20 && listPtys().some((item) => item.id === peer.terminal_id); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
});

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

test('hosts a remote PTY and waits for session discovery before relay delivery', async (t) => {
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

  let peer = listPeers()[0];
  assert.equal(peer.terminal_id, control.ptyId);
  assert.equal(peer.cwd, "/srv/it's here");
  assert.equal(peer.relay_enabled, false);
  assert.equal(peer.session_available, false);
  assert.equal(peer.messageable, false);
  assert.equal(peer.interactive, true);
  await assert.rejects(sendPeerMessage(peer.id, 'not yet'), { code: 'PEER_INTERACTIVE' });
  const queued = await sendPeerMessage(peer.id, 'read this later', { inbox: true });
  assert.equal(queued.delivered, false);
  assert.equal(queued.queued, true);
  assert.deepEqual(pullPeerInbox(peer.id).messages.map(({ message }) => message), ['read this later']);
  assert.deepEqual(pullPeerInbox(peer.id).messages, []);

  assert.equal(setPtyRelay(control.ptyId, true, 'host-1'), true);
  assert.equal(listPtys('host-1')[0].relayEnabled, true);
  peer = listPeers()[0];
  assert.equal(peer.relay_enabled, true);
  assert.equal(peer.session_available, false);
  assert.equal(peer.messageable, false);
  assert.equal(peer.interactive, false);
  await assert.rejects(sendPeerMessage(peer.id, 'not linked yet'), {
    code: 'PEER_SESSION_UNAVAILABLE',
    message: /session is not available yet/,
  });
  assert.deepEqual(channel.writes, ['pwd\r']);

  assert.equal(setPtySession(control.ptyId, {
    provider: 'codex', id: 'session.jsonl', pwd: '/srv/session-worktree',
  }, 'host-1'), true);
  peer = listPeers()[0];
  assert.equal(peer.workspace, '/srv/session-worktree');
  assert.equal(peer.session_available, true);
  assert.equal(peer.messageable, true);
  const blocked = new Promise((resolve) => {
    const onMessage = (data) => {
      const text = data.toString();
      if (text.charCodeAt(0) !== 0) return;
      const value = JSON.parse(text.slice(1));
      if (!value.inputBlocked) return;
      ws.off('message', onMessage);
      resolve(value);
    };
    ws.on('message', onMessage);
  });
  ws.send(JSON.stringify({ t: 'i', d: 'human input\r' }));
  assert.equal((await blocked).relayEnabled, true);
  assert.deepEqual(channel.writes, ['pwd\r']);

  const fallback = await sendPeerMessage(peer.id, 'one line');
  assert.equal(fallback.bracketed, false);
  assert.equal(channel.writes.at(-1), 'one line\r');
  await assert.rejects(sendPeerMessage(peer.id, 'one\nline'), {
    code: 'BRACKETED_PASTE_REQUIRED',
    message: /cannot be delivered exactly/,
  });
  await assert.rejects(sendPeerMessage(peer.id, 'one\tline'), { code: 'BRACKETED_PASTE_REQUIRED' });
  assert.equal(channel.writes.at(-1), 'one line\r');

  channel.emit('data', '\x1b[?2004h');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const sent = await Promise.all([
    sendPeerMessage(peer.id, 'first\nmessage'),
    sendPeerMessage(peer.id, 'second\nmessage'),
  ]);
  assert.deepEqual(sent.map((value) => value.bracketed), [true, true]);
  assert.equal(sent[0].peer.id, peer.id);
  assert.equal(sent[0].peer.messageable, true);
  assert.equal(sent[0].peer.provider, 'codex');
  assert.equal(sent[0].peer.session_id, 'session.jsonl');
  assert.equal(sent[0].peer.workspace, '/srv/session-worktree');
  assert.deepEqual(channel.writes.slice(-4), [
    '\x1b[200~first\nmessage\x1b[201~', '\r',
    '\x1b[200~second\nmessage\x1b[201~', '\r',
  ]);
  const writesBeforeInbox = channel.writes.length;
  await sendPeerMessage(peer.id, 'queue this explicitly', { inbox: true });
  assert.equal(channel.writes.length, writesBeforeInbox);
  assert.deepEqual(pullPeerInbox(peer.id).messages.map(({ message }) => message), ['queue this explicitly']);
  await sendPeerMessage(peer.id, 'line one\n\tline two');
  assert.deepEqual(channel.writes.slice(-2), ['\x1b[200~line one\n\tline two\x1b[201~', '\r']);

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
