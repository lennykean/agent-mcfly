import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import WebSocket from 'ws';
import { attachPty, killAllPtys, listPtys, TOKEN } from './pty.js';

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
