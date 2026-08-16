import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import * as git from './git.js';
import { fsList, fsRead, gitIo, listProviders, listSessions, pasteImage, tailSession } from './remote-data.js';

class FakeSftp {
  constructor(files = {}) {
    this.entries = new Map([['/', { dir: true, mtime: 1 }]]);
    for (const [file, content] of Object.entries(files)) this.put(file, content);
  }

  put(file, content) {
    const parts = file.split('/').filter(Boolean);
    let parent = '';
    for (const part of parts.slice(0, -1)) {
      parent += `/${part}`;
      this.entries.set(parent, { dir: true, mtime: 1 });
    }
    this.entries.set(file, { dir: false, content: Buffer.from(content), mtime: 2 });
  }

  attrs(entry) {
    return {
      size: entry.content?.length ?? 0, mtime: entry.mtime,
      isDirectory: () => entry.dir, isFile: () => !entry.dir,
    };
  }

  error() { const error = new Error('not found'); error.code = 2; return error; }
  once() {}
  stat(file, callback) {
    const entry = this.entries.get(file);
    callback(entry ? null : this.error(), entry && this.attrs(entry));
  }
  readdir(dir, callback) {
    if (!this.entries.get(dir)?.dir) return callback(this.error());
    const prefix = dir === '/' ? '/' : `${dir}/`;
    const found = [];
    for (const [file, entry] of this.entries) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (rest && !rest.includes('/')) found.push({ filename: rest, attrs: this.attrs(entry) });
    }
    callback(null, found);
  }
  readFile(file, callback) {
    const entry = this.entries.get(file);
    callback(entry?.content ? null : this.error(), entry?.content);
  }
  open(file, _flags, callback) {
    callback(this.entries.get(file)?.content ? null : this.error(), file);
  }
  read(handle, buffer, offset, length, position, callback) {
    const source = this.entries.get(handle)?.content;
    if (!source) return callback(this.error());
    const bytes = Math.min(length, Math.max(0, source.length - position));
    source.copy(buffer, offset, position, position + bytes);
    callback(null, bytes, buffer, position);
  }
  close(_handle, callback) { callback(null); }
  mkdir(dir, callback) {
    if (this.entries.has(dir)) return callback(Object.assign(new Error('exists'), { code: 4 }));
    this.entries.set(dir, { dir: true, mtime: 1 });
    callback(null);
  }
  writeFile(file, bytes, callback) { this.put(file, bytes); callback(null); }
}

class FakeChannel extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.stderr.setEncoding = () => {};
  }
  setEncoding() {}
  close() {}
}

function fixture() {
  const codexLines = [
    { type: 'session_meta', payload: { id: 'codex-id', cwd: '/repo' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Remote Codex' }] } },
  ];
  const claudeLines = [
    { type: 'user', cwd: '/repo', message: { content: 'Remote Claude' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello from Claude' }] } },
  ];
  const sftp = new FakeSftp({
    '/repo/readme.txt': 'hello remote',
    '/repo/src/app.js': 'app',
    '/repo/.git/config': 'ignored',
    '/repo/node_modules/pkg/a.js': 'ignored',
    '/home/u/.codex/session_index.jsonl': '{"id":"codex-id","thread_name":"Named remote"}\n',
    '/home/u/.codex/sessions/2026/08/rollout-one.jsonl': codexLines.map(JSON.stringify).join('\n'),
    '/home/u/.claude/projects/-repo/claude-one.jsonl': claudeLines.map(JSON.stringify).join('\n') + '\n',
  });
  const commands = [];
  const client = {
    sftp(callback) { callback(null, sftp); },
    exec(command, callback) {
      commands.push(command);
      const channel = new FakeChannel();
      callback(null, channel);
      queueMicrotask(() => {
        if (command.includes("'status'")) channel.emit('data', ' M readme.txt\0');
        channel.emit('close', command.includes("'grep'") ? 1 : 0, null);
      });
    },
  };
  return { connection: { id: 'remote-1', home: '/home/u', platform: 'linux', client }, sftp, commands };
}

function sudoCodexFixture(wrapper = [
  '#!/usr/bin/env bash',
  'set -e',
  'executable=/home/codex/.codex/packages/standalone/current/codex',
  'if [ "$(id -un)" = codex ]; then exec "$executable" "$@"; fi',
  'exec sudo -u codex -H "$executable" "$@"',
  '',
].join('\n')) {
  const stateDir = "/srv/codex owner's state";
  const id = '2026/08/rollout-effective.jsonl';
  const transcript = Buffer.from('é\n' + [
    { type: 'session_meta', payload: { id: 'effective-id', cwd: '/repo' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Effective Codex' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  const index = Buffer.from('{"id":"effective-id","thread_name":"Effective remote"}\n');
  const sftp = new FakeSftp(); // the SSH login cannot read the effective user's home
  const commands = [];
  const client = {
    sftp(callback) { callback(null, sftp); },
    exec(command, callback) {
      commands.push(command);
      const channel = new FakeChannel();
      callback(null, channel);
      queueMicrotask(() => {
        let stdout = '';
        let stderr = '';
        let code = 0;
        if (command === 'command -v codex') stdout = '/usr/local/bin/codex\n';
        else if (command.startsWith('head -c 8192 -- ')) stdout = wrapper;
        else if (command.includes('CODEX_HOME')) stdout = `${stateDir}\n`;
        else if (command.includes(' find ')) stdout = [id, String(transcript.length), '2', ''].join('\0');
        else if (command.includes(' stat -c ')) {
          const bytes = command.includes('session_index.jsonl') ? index : transcript;
          stdout = `${bytes.length}\t2\n`;
        }
        else if (command.includes(' dd ')) {
          const bytes = command.includes('session_index.jsonl') ? index : transcript;
          const start = Number(command.match(/\bskip=(\d+)/)?.[1] ?? 0);
          const count = Number(command.match(/\bcount=(\d+)/)?.[1] ?? bytes.length);
          stdout = bytes.subarray(start, start + count).toString('base64');
        } else { code = 127; stderr = 'unexpected command'; }
        if (stdout) channel.emit('data', stdout);
        if (stderr) channel.stderr.emit('data', stderr);
        channel.emit('close', code, null);
      });
    },
  };
  return {
    connection: { id: 'sudo-codex', home: '/home/login', platform: 'linux', tools: ['codex'], client },
    commands, stateDir, id, transcript,
  };
}

test('browses and reads contained remote files over SFTP', async () => {
  const { connection } = fixture();
  assert.deepEqual(await fsList(connection, '/repo'), [
    { name: 'src', dir: true },
    { name: 'readme.txt', dir: false },
  ]);
  assert.deepEqual(await fsRead(connection, '/repo', 'readme.txt'), { content: 'hello remote' });
  await assert.rejects(() => fsRead(connection, '/repo', '../secret'), { code: 'EACCES' });
});

test('discovers and incrementally parses remote Codex and Claude sessions locally', async () => {
  const { connection, sftp } = fixture();
  assert.deepEqual(await listProviders(connection, '/repo'), [
    { provider: 'claude-code', count: 1 },
    { provider: 'codex', count: 1 },
  ]);
  const codexSessions = await listSessions(connection, 'codex', '/repo');
  assert.equal(codexSessions[0].label, 'Named remote');
  const first = await tailSession(connection, 'codex', codexSessions[0].id, 0);
  assert.equal(first.messages.length, 0); // final user line is still incomplete
  const file = '/home/u/.codex/sessions/2026/08/rollout-one.jsonl';
  sftp.put(file, sftp.entries.get(file).content.toString('utf8') + '\n');
  const second = await tailSession(connection, 'codex', codexSessions[0].id, first.cursor);
  assert.equal(second.messages[0].content[0].text, 'Remote Codex');

  const claudeSessions = await listSessions(connection, 'claude-code', '/repo');
  assert.equal(claudeSessions[0].label, 'Remote Claude');
  const claude = await tailSession(connection, 'claude-code', claudeSessions[0].id, 0);
  assert.deepEqual(claude.messages.map((message) => message.role), ['user', 'assistant']);
});

test('discovers and tails Codex through a validated sudo wrapper', async () => {
  const { connection, commands, stateDir, id, transcript } = sudoCodexFixture();
  assert.deepEqual(await listProviders(connection, '/repo'), [
    { provider: 'claude-code', count: 0 },
    { provider: 'codex', count: 1 },
  ]);
  const sessions = await listSessions(connection, 'codex', '/repo');
  assert.equal(sessions[0].label, 'Effective remote');
  assert.equal(sessions[0].id, id);
  const tail = await tailSession(connection, 'codex', id, 1); // starts inside the two-byte é
  assert.equal(tail.messages[0].content[0].text, 'Effective Codex');
  assert.equal(tail.cursor, transcript.length);
  assert.ok(commands.some((command) => command.includes("sudo -n -u 'codex' -H")));
  assert.ok(commands.some((command) => command.includes("'/srv/codex owner'\\''s state/sessions'")));
  assert.ok(commands.every((command) => !command.includes(`${connection.home}/.codex`)));
  assert.ok(commands.some((command) => command.includes(stateDir.replace("'", "'\\''"))));
  assert.ok(commands.filter((command) => command.includes(' dd ')).every((command) => command.endsWith('| base64 -w0')));
});

test('rejects an unsafe user in a Codex sudo wrapper', async () => {
  const { connection, commands } = sudoCodexFixture('#!/bin/sh\nexec sudo -u bad;touch -H /opt/codex/bin/codex "$@"\n');
  assert.deepEqual(await listSessions(connection, 'codex', '/repo'), []);
  assert.ok(commands.every((command) => !command.startsWith('sudo ')));
});

test('skips remote session files that disappear after directory listing', async () => {
  const { connection, sftp } = fixture();
  const gone = [
    '/home/u/.codex/sessions/2026/08/rollout-gone.jsonl',
    '/home/u/.claude/projects/-repo/claude-gone.jsonl',
  ];
  for (const file of gone) sftp.put(file, '{}\n');
  const open = sftp.open.bind(sftp);
  sftp.open = (file, flags, callback) => {
    if (gone.includes(file)) sftp.entries.delete(file);
    open(file, flags, callback);
  };

  assert.deepEqual(await listProviders(connection, '/repo'), [
    { provider: 'claude-code', count: 1 },
    { provider: 'codex', count: 1 },
  ]);
});

test('preserves non-missing errors while listing remote sessions', async () => {
  for (const [provider, failedFile] of [
    ['codex', '/home/u/.codex/sessions/2026/08/rollout-one.jsonl'],
    ['claude-code', '/home/u/.claude/projects/-repo/claude-one.jsonl'],
  ]) {
    const { connection, sftp } = fixture();
    const open = sftp.open.bind(sftp);
    sftp.open = (file, flags, callback) => file === failedFile
      ? callback(Object.assign(new Error('denied'), { code: 'EACCES' }))
      : open(file, flags, callback);
    await assert.rejects(() => listSessions(connection, provider, '/repo'), { code: 'EACCES' });
  }
});

test('recovers a remote Codex call before a resumed cursor', async () => {
  const { connection, sftp } = fixture();
  connection.id = 'resumed-remote';
  const call = JSON.stringify({
    type: 'response_item',
    payload: { type: 'function_call', call_id: 'before-cursor', name: 'shell_command', arguments: '{"command":"pwd"}' },
  });
  const result = JSON.stringify({
    type: 'response_item', payload: { type: 'function_call_output', call_id: 'before-cursor', output: '/repo' },
  });
  const file = '/home/u/.codex/sessions/2026/08/rollout-one.jsonl';
  sftp.put(file, `${call}\n${result}\n`);
  const cursor = Buffer.byteLength(call + '\n');
  const [tail, concurrent] = await Promise.all([
    tailSession(connection, 'codex', '2026/08/rollout-one.jsonl', cursor),
    tailSession(connection, 'codex', '2026/08/rollout-one.jsonl', cursor),
  ]);
  const block = tail.messages[0].content[0];
  assert.equal(block.tool, 'shell_command');
  assert.deepEqual(block.extended.render, { verb: 'exec', stdout: '/repo', stderr: '' });
  assert.deepEqual(concurrent.messages, tail.messages);
  const retry = await tailSession(connection, 'codex', '2026/08/rollout-one.jsonl', cursor);
  assert.deepEqual(retry.messages, tail.messages);
});

test('reuses git parsers with SSH exec and uploads pasted images by SFTP', async () => {
  const { connection, sftp, commands } = fixture();
  assert.deepEqual(await git.status('/repo', gitIo(connection)), {
    staged: [], changed: [{ path: 'readme.txt', status: 'M' }],
  });
  assert.match(commands[0], /^git -C '\/repo' 'status'/);
  await gitIo(connection).run("/repo/it's", ['status']);
  assert.match(commands[1], /^git -C '\/repo\/it'\\''s' 'status'$/);
  assert.equal(await git.grep('/repo', 'missing', gitIo(connection)).then((items) => items.length), 0);
  await gitIo({ ...connection, platform: 'win32' }).run("C:\\repo'; Write-Output PWNED; #", [
    'grep', '-F', '--', 'title="Rewind', '', 'trailing\\',
  ]);
  assert.match(commands[3], /^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/]+=*$/);
  const script = Buffer.from(commands[3].split(' ').at(-1), 'base64').toString('utf16le');
  const nativeArgs = String.raw`"-C" "C:\repo'; Write-Output PWNED; #" "grep" "-F" "--" "title=\"Rewind" "" "trailing\\"`;
  assert.ok(script.includes(`$start.Arguments = '${nativeArgs.replaceAll("'", "''")}'`));
  assert.match(script, /StandardOutput\.BaseStream\.CopyToAsync/);
  assert.match(script, /StandardError\.BaseStream\.CopyToAsync/);
  const file = await pasteImage(connection, Buffer.from('image'), '.png');
  assert.match(file, /^\/home\/u\/\.mcfly\/tmp\/mcfly-paste-.*\.png$/);
  assert.equal(sftp.entries.get(file).content.toString(), 'image');
});

test('Windows Git preserves native arguments through PowerShell 5.1', {
  skip: process.platform !== 'win32',
}, async () => {
  const { connection, commands } = fixture();
  const io = gitIo({ ...connection, platform: 'win32' });
  await io.run(process.cwd(), [
    'grep', '-F', '--', 'title="Rewind',
  ]);
  const output = execFileSync('cmd.exe', ['/d', '/s', '/c', commands[0]], { encoding: 'utf8' });
  assert.match(output, /ui\/src\/components\/ChatPane\.tsx/);
  await io.run(process.cwd(), ['rev-parse', '--sq-quote', '', 'trailing\\', 'quote"x']);
  const argv = execFileSync('cmd.exe', ['/d', '/s', '/c', commands[1]], { encoding: 'utf8' });
  assert.equal(argv.trimEnd(), " '' 'trailing\\' 'quote\"x'");
});
