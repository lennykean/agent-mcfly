import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import ssh2 from 'ssh2';
import { execSsh } from './ssh.js';

const { Server: SshServer } = ssh2;

const listen = (server, port = 0) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => resolve(server.address().port));
});

test('SSH exec rejects connection loss and closes a channel that opens after timeout', async () => {
  class Channel extends EventEmitter {
    stderr = new EventEmitter();
    closed = false;
    constructor() {
      super();
      this.stderr.setEncoding = () => {};
    }
    setEncoding() {}
    close() { this.closed = true; }
  }

  const channel = new Channel();
  const client = new EventEmitter();
  client.exec = (_command, callback) => callback(null, channel);
  const disconnected = execSsh({ client }, 'git status');
  channel.emit('data', 'partial');
  client.emit('close');
  channel.emit('close');
  await assert.rejects(disconnected, /SSH connection closed during command/);
  assert.equal(client.listenerCount('close'), 0);

  const lateChannel = new Channel();
  const slowClient = new EventEmitter();
  let open;
  slowClient.exec = (_command, callback) => { open = callback; };
  await assert.rejects(execSsh({ client: slowClient }, 'git log', { timeout: 0 }), /timed out/);
  open(null, lateChannel);
  assert.equal(lateChannel.closed, true);
  assert.equal(lateChannel.listenerCount('data'), 0);
  assert.equal(slowClient.listenerCount('close'), 0);
});

test('SSH routes require explicit host-key confirmation and retain no credentials', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  let passwordAuthentications = 0;
  let sftpAvailable = true;
  let execAvailable = true;
  const clients = new Set();
  const ssh = new SshServer({
    hostKeys: [privateKey.export({ format: 'pem', type: 'pkcs1' })],
  }, (client) => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') passwordAuthentications += 1;
      if (ctx.method === 'password' && ctx.username === 'mcfly' && ctx.password === 'secret') ctx.accept();
      else ctx.reject();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp, rejectSftp) => {
          if (!sftpAvailable) { rejectSftp(); return; }
          const stream = acceptSftp();
          stream.on('STAT', (id, filename) => {
            if (filename !== '/home/mcfly') return stream.status(id, 2); // SSH_FX_NO_SUCH_FILE
            stream.attrs(id, { mode: fs.constants.S_IFDIR | 0o755, size: 0, atime: 0, mtime: 0 });
          });
        });
        session.on('exec', (acceptExec, rejectExec) => {
          if (!execAvailable) { rejectExec(); return; }
          const stream = acceptExec();
          stream.end('__MCFLY_HOME__/home/mcfly\n__MCFLY_PLATFORM__Linux\n__MCFLY_TOOL__codex\n');
        });
      });
    });
  });
  const sshPort = await listen(ssh);

  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-ssh-'));
  const knownFile = path.join(dir, 'known.json');
  const app = spawn(process.execPath, ['server/server.js'], {
    cwd: process.cwd(),
    // MCFLY_OPEN off: a test run must never launch a browser tab
    env: { ...process.env, PORT: String(port), MCFLY_OPEN: '0', MCFLY_SSH_KNOWN_HOSTS: knownFile },
    stdio: 'pipe',
  });

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('server never listened')), 10_000);
      app.stdout.on('data', (data) => {
        if (String(data).includes('Agent McFly API')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      app.once('exit', () => reject(new Error('server exited')));
    });
    const base = `http://127.0.0.1:${port}`;
    const credentials = { host: '127.0.0.1', port: sshPort, username: 'mcfly', password: 'secret' };
    const post = (pathname, body) => fetch(`${base}${pathname}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

    const validWorkspace = await fetch(`${base}/api/workspace/validate?pwd=${encodeURIComponent(process.cwd())}`);
    assert.equal(validWorkspace.status, 200);
    assert.deepEqual(await validWorkspace.json(), { ok: true });
    for (const invalid of ['', path.join(dir, 'missing'), path.join(process.cwd(), 'package.json')]) {
      const response = await fetch(`${base}/api/workspace/validate${invalid ? `?pwd=${encodeURIComponent(invalid)}` : ''}`);
      assert.equal(response.status, 404);
      assert.equal((await response.json()).code, 'WORKSPACE_NOT_FOUND');
    }
    const unknownWorkspace = await fetch(`${base}/api/workspace/validate?pwd=%2Fhome%2Fmcfly&connection=gone`);
    assert.equal(unknownWorkspace.status, 404);
    assert.equal((await unknownWorkspace.json()).code, 'SSH_CONNECTION_NOT_FOUND');
    const unknownSession = await fetch(`${base}/api/session?provider=codex&id=gone&connection=gone`);
    assert.equal(unknownSession.status, 404);
    assert.equal((await unknownSession.json()).code, 'SSH_CONNECTION_NOT_FOUND');

    const unknownResponse = await post('/api/ssh/connect', credentials);
    const unknown = await unknownResponse.json();
    assert.equal(unknownResponse.status, 409);
    assert.equal(unknown.code, 'HOST_KEY_UNKNOWN');
    assert.match(unknown.fingerprint, /^SHA256:[A-Za-z0-9+/]+$/);
    assert.equal(passwordAuthentications, 0, 'host key must be accepted before credentials are sent');

    const connectedResponse = await post('/api/ssh/connect', { ...credentials, fingerprint: unknown.fingerprint });
    const connected = await connectedResponse.json();
    assert.equal(connectedResponse.status, 200);
    assert.equal(connected.home, '/home/mcfly');
    assert.equal(connected.platform, 'linux');
    assert.deepEqual(connected.tools, ['codex']);
    assert.equal(passwordAuthentications, 1);

    const remoteWorkspace = await fetch(`${base}/api/workspace/validate?pwd=%2Fhome%2Fmcfly&connection=${encodeURIComponent(connected.id)}`);
    assert.equal(remoteWorkspace.status, 200);
    assert.deepEqual(await remoteWorkspace.json(), { ok: true });
    const missingRemoteWorkspace = await fetch(`${base}/api/workspace/validate?pwd=%2Fmissing&connection=${encodeURIComponent(connected.id)}`);
    assert.equal(missingRemoteWorkspace.status, 404);
    assert.equal((await missingRemoteWorkspace.json()).code, 'WORKSPACE_NOT_FOUND');

    const listed = await (await fetch(`${base}/api/ssh/connections`)).json();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, connected.id);
    assert.doesNotMatch(JSON.stringify(listed), /secret|privateKey|password/);

    const config = await (await fetch(`${base}/api/config?connection=${encodeURIComponent(connected.id)}`)).json();
    assert.equal(config.home, '/home/mcfly');
    assert.deepEqual(config.tools, ['codex', '_']);

    const known = fs.readFileSync(knownFile, 'utf8');
    assert.match(known, new RegExp(unknown.fingerprint.replace(/[+]/g, '\\+')));
    assert.doesNotMatch(known, /secret|privateKey|password/);

    assert.deepEqual(await (await post('/api/ssh/disconnect', { id: connected.id })).json(), { ok: true });
    assert.deepEqual(await (await fetch(`${base}/api/ssh/connections`)).json(), []);

    const rememberedResponse = await post('/api/ssh/connect', credentials);
    const remembered = await rememberedResponse.json();
    assert.equal(rememberedResponse.status, 200);
    assert.equal(passwordAuthentications, 2);
    await post('/api/ssh/disconnect', { id: remembered.id });

    sftpAvailable = false;
    const unavailableResponse = await post('/api/ssh/connect', credentials);
    const unavailable = await unavailableResponse.json();
    assert.equal(unavailableResponse.status, 400);
    assert.equal(unavailable.code, 'SFTP_UNAVAILABLE');
    assert.match(unavailable.error, /SFTP is unavailable/);
    assert.equal(passwordAuthentications, 3);
    sftpAvailable = true;

    execAvailable = false;
    const probeResponse = await post('/api/ssh/connect', credentials);
    const probeFailure = await probeResponse.json();
    assert.equal(probeResponse.status, 400);
    assert.equal(probeFailure.code, 'SSH_PROBE_FAILED');
    assert.match(probeFailure.error, /command execution or home-directory detection failed/);
    assert.deepEqual(await (await fetch(`${base}/api/ssh/connections`)).json(), []);
    assert.equal(passwordAuthentications, 4);
    execAvailable = true;

    const changed = JSON.parse(fs.readFileSync(knownFile, 'utf8'));
    changed[Object.keys(changed)[0]] = 'SHA256:different';
    fs.writeFileSync(knownFile, JSON.stringify(changed));
    const mismatchResponse = await post('/api/ssh/connect', credentials);
    const mismatch = await mismatchResponse.json();
    assert.equal(mismatchResponse.status, 409);
    assert.equal(mismatch.code, 'HOST_KEY_MISMATCH');
    assert.equal(mismatch.expectedFingerprint, 'SHA256:different');
    assert.equal(mismatch.fingerprint, unknown.fingerprint);
    assert.equal(passwordAuthentications, 4, 'changed host key must be rejected before authentication');
  } finally {
    app.kill('SIGKILL');
    for (const client of clients) client.end();
    await new Promise((resolve) => ssh.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
