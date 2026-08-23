import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { listChats, rootMessageIds, tailStore, tip, turnTimestamp, userText, workspaceHash } from './cursor.js';

const require = createRequire(import.meta.url);
let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { /* node < 22.5 */ }

// ---- fixture: a real cursor chat directory ----

const digest = (buf) => crypto.createHash('sha256').update(buf).digest();

// protobuf: repeated field 1, length-delimited 32-byte ids
function rootBlob(ids, extraFields = Buffer.alloc(0)) {
  return Buffer.concat([...ids.map((id) => Buffer.concat([Buffer.from([0x0a, 0x20]), id])), extraFields]);
}

const workspace = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-cursor-test-'));

function chatDir(messages, { name, extraBlobs = [], root, ws, chat = 'chat-1', subagentInfo, sidecar } = {}) {
  const dir = ws ? path.join(ws, chat) : workspace();
  fs.mkdirSync(dir, { recursive: true });
  const db = new sqlite.DatabaseSync(path.join(dir, 'store.db'));
  db.exec('create table blobs (id TEXT PRIMARY KEY, data BLOB)');
  db.exec('create table meta (key TEXT PRIMARY KEY, value TEXT)');
  const insert = db.prepare('insert or replace into blobs (id, data) values (?, ?)');
  const put = (buf) => {
    const id = digest(buf);
    insert.run(id.toString('hex'), buf);
    return id;
  };
  for (const blob of extraBlobs) put(blob);
  const ids = messages.map((m) => put(Buffer.from(JSON.stringify(m), 'utf8')));
  const rootId = put(root ? root(ids) : rootBlob(ids));
  const meta = {
    agentId: chat, latestRootBlobId: rootId.toString('hex'), name: name ?? 'New Agent',
    ...(subagentInfo ? { subagentInfo } : {}),
  };
  db.prepare('insert into meta (key, value) values (?, ?)')
    .run('0', Buffer.from(JSON.stringify(meta), 'utf8').toString('hex'));
  db.close();
  if (sidecar !== null) {
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      schemaVersion: 1, createdAtMs: 1, updatedAtMs: 2, hasConversation: true, cwd: '/repo',
      ...(name ? { title: name } : {}), ...sidecar,
    }));
  }
  return dir;
}

const call = (id, toolName, args) => ({ type: 'tool-call', toolCallId: id, toolName, args });
const resultMessage = (id, toolName, result, output) => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: id, toolName, result }],
  providerOptions: { cursor: { highLevelToolCallResult: { output, isError: !output.success } } },
});

// ---- pure helpers (no SQLite needed) ----

test('a workspace is keyed by the md5 of the cwd cursor was launched in', () => {
  assert.equal(workspaceHash('C:\\Users\\Lenny\\git\\magpie'), 'e725bd715a7787eaf72f7c52a8583fae');
  assert.notEqual(workspaceHash('/repo'), workspaceHash('/repo/'));
});

test('the root blob yields message ids and skips fields cursor adds around them', () => {
  const ids = [digest(Buffer.from('a')), digest(Buffer.from('b'))];
  // field 26 varint (a turn timestamp), field 22 string, and a 16-byte field 1
  // that is NOT a blob id
  const extra = Buffer.concat([
    Buffer.from([0xd0, 0x01, 0x80, 0x01]), // field 26, varint 128
    Buffer.from([0xb2, 0x01, 0x03]), Buffer.from('cli'), // field 22, "cli"
    Buffer.from([0x0a, 0x10]), Buffer.alloc(16), // field 1, wrong length
  ]);
  assert.deepEqual(rootMessageIds(rootBlob(ids, extra)), ids.map((id) => id.toString('hex')));
});

test('a user turn shows its query, not the context cursor wraps around it', () => {
  assert.equal(userText({ content: [{ type: 'text', text: '<timestamp>x</timestamp>\n<user_query>\nship it\n</user_query>' }] }), 'ship it');
  assert.equal(userText({ content: [{ type: 'text', text: '<user_info>OS: win32</user_info>' }] }), '');
  assert.equal(userText({ content: 'bare text' }), 'bare text');
});

test('the turn timestamp honours the zone cursor writes, not the reader s', () => {
  assert.equal(turnTimestamp('<timestamp>Monday, Dec 1, 2025, 11:59 PM (UTC+2)</timestamp>'),
    Date.parse('2025-12-01T21:59:00Z'));
  assert.equal(turnTimestamp('<timestamp>Saturday, Jul 25, 2026, 8:05 PM (UTC-7)</timestamp>'),
    Date.parse('2026-07-26T03:05:00Z'));
  assert.equal(turnTimestamp('no stamp here'), undefined);
});

// ---- the store ----

test('converts a cursor chat store into normalized messages and render verbs', { skip: !sqlite && 'needs node 22.5+' }, () => {
  const bigRead = Buffer.from('line one\nline two\n', 'utf8');
  const dir = chatDir([
    { role: 'system', content: 'you are an agent' },
    { role: 'user', content: [{ type: 'text', text: '<user_info>OS: linux</user_info>' }] },
    { role: 'user', content: [{ type: 'text', text: '<timestamp>Monday, Dec 1, 2025, 11:59 PM (UTC+2)</timestamp>\n<user_query>\nfix the parser\n</user_query>' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'thinking about it' },
        { type: 'redacted-reasoning', data: 'xxx' },
        { type: 'text', text: 'on it' },
        call('c1', 'Read', { path: '/repo/a.txt' }),
        call('c2', 'StrReplace', { path: '/repo/a.txt', old_string: 'a', new_string: 'b' }),
        call('c3', 'Shell', { command: 'ls', description: 'list files', working_directory: '/repo' }),
        call('c4', 'CallMcpTool', { server: 'mcfly', toolName: 'run_table', arguments: { script: 'x', title: 't' } }),
      ],
    },
    resultMessage('c1', 'Read', 'annotated text', {
      success: {
        path: '/repo/a.txt', totalLines: 2, fileSize: bigRead.length,
        readRange: { startLine: 1, endLine: 2 },
        contentBlobId: digest(bigRead).toString('base64'),
      },
    }),
    resultMessage('c2', 'StrReplace', 'updated', {
      success: {
        path: '/repo/a.txt', beforeFullFileContent: 'a\n', afterFullFileContent: 'b\n',
        diffString: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n',
      },
    }),
    resultMessage('c3', 'Shell', 'Exit code: 2\n\nCommand output:\n\n```\nboom\n```', {
      success: { command: 'ls', workingDirectory: '/repo', stdout: 'boom', stderr: 'bad', executionTime: 5 },
    }),
    resultMessage('c4', 'CallMcpTool', 'no envelope', { success: { content: '' } }),
  ], { extraBlobs: [bigRead] });

  const { messages, cursor, size } = tailStore(dir, 0, 'ws/chat-1');
  assert.equal(size, 8);
  assert.equal(cursor, 8);
  // system and the injected-context user turn carry nothing to show
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user', 'user', 'user', 'user']);
  assert.deepEqual(messages[0].content, [{ type: 'text', text: 'fix the parser' }]);
  // every message of the turn inherits the turn's time
  assert.equal(messages[1].timestamp, Date.parse('2025-12-01T21:59:00Z'));

  const assistant = messages[1].content;
  assert.deepEqual(assistant.map((c) => c.type), ['thinking', 'text', 'tool', 'tool', 'tool', 'tool']);
  assert.deepEqual(assistant.slice(2).map((c) => [c.tool, c.extended.render.verb]), [
    ['Read', 'read_file'], ['StrReplace', 'patch_file'], ['Shell', 'exec'], ['mcfly__run_table', 'data'],
  ]);
  assert.equal(assistant[4].extended.render.title, 'list files');

  // a large read is stored out of line: the render must resolve it back
  const read = messages[2].content[0].extended.render;
  assert.equal(read.content, 'line one\nline two\n');
  assert.deepEqual(read.region, { start: 1, end: 2 });
  assert.equal(read.total_lines, 2);

  const patch = messages[3].content[0].extended.render;
  assert.equal(patch.content, 'b\n');
  assert.deepEqual(patch.hunks, [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }]);

  const exec = messages[4].content[0].extended.render;
  assert.deepEqual(
    { stdout: exec.stdout, stderr: exec.stderr, exit_code: exec.exit_code, cwd: exec.cwd },
    { stdout: 'boom', stderr: 'bad', exit_code: 2, cwd: '/repo' },
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('renders a delivered McFly peer message as a peer link', { skip: !sqlite && 'needs node 22.5+' }, () => {
  const peer = {
    id: 'remote-1:pty-1', terminal_id: 'pty-1', tool: 'claude', cwd: '/repo', title: 'Peer',
    session_id: 'session.jsonl', provider: 'claude-code', connection: 'remote-1',
  };
  const envelope = { schema: 'mcfly.data.v1', kind: 'peer_message', id: peer.id, delivered: true, peer };
  const args = { server: 'mcfly', toolName: 'send_message', arguments: { id: peer.id, message: 'hi' } };
  const dir = chatDir([
    { role: 'assistant', content: [call('peer-call', 'CallMcpTool', args)] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'peer-call', toolName: 'CallMcpTool', args, result: JSON.stringify(envelope) }] },
  ]);
  const messages = tailStore(dir, 0, 'ws/chat-1').messages;
  assert.equal(messages[0].content[0].extended.render.verb, 'peer_message');
  assert.deepEqual(messages[1].content[0].extended.render.peer, peer);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failed call keeps its message and is flagged, not silently dropped', { skip: !sqlite && 'needs node 22.5+' }, () => {
  const dir = chatDir([
    { role: 'assistant', content: [call('c1', 'Shell', { command: 'nope' })] },
    resultMessage('c1', 'Shell', 'command not found', { error: { error: 'command not found' } }),
  ]);
  const { messages } = tailStore(dir, 0, 'ws/chat-1');
  const block = messages[1].content[0];
  assert.equal(block.extended.is_error, true);
  assert.deepEqual(block.extended.render, { verb: 'exec', stdout: '', stderr: 'command not found' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tailing resumes from a message index and never stalls on a pruned blob', { skip: !sqlite && 'needs node 22.5+' }, () => {
  const dir = chatDir([
    { role: 'user', content: [{ type: 'text', text: '<user_query>one</user_query>' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'three' }] },
  ], {
    // an id nothing was ever stored under, standing in for a pruned blob
    root: (ids) => rootBlob([ids[0], digest(Buffer.from('missing')), ...ids.slice(1)]),
  });
  const first = tailStore(dir, 0, 'ws/chat-1');
  assert.equal(first.size, 4);
  assert.equal(first.cursor, 4);
  assert.equal(first.messages.length, 3);
  const resumed = tailStore(dir, 2, 'ws/chat-1');
  assert.equal(resumed.cursor, 4);
  assert.deepEqual(resumed.messages.map((m) => m.content[0].text), ['two', 'three']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- the defects the first cut shipped with ----

test('tip throws for a store that is not there, the way every provider does', () => {
  // a zero timestamp would read as "long idle" and settle the agent out of the
  // tree for good; the caller omits an id that throws
  assert.throws(() => tip(`${workspaceHash('/gone')}/nope`));
});

test('a root blob McFly cannot fully walk keeps the ids it did read', () => {
  const ids = [digest(Buffer.from('a')), digest(Buffer.from('b'))];
  // wire type 3 (a legacy group) is not something this format uses
  const stopper = Buffer.concat([Buffer.from([0x1b]), Buffer.from('junk')]);
  assert.deepEqual(rootMessageIds(rootBlob(ids, stopper)), ids.map((id) => id.toString('hex')));
  // a length that runs off the end must not read past the buffer either
  assert.deepEqual(rootMessageIds(Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.alloc(4)])), []);
});

test('a result with no cursor envelope is output, not an error', { skip: !sqlite && 'needs node 22.5+' }, () => {
  const dir = chatDir([
    { role: 'assistant', content: [call('n1', 'Shell', { command: 'ls' })] },
    // no providerOptions at all — cursor omits the envelope for some tools
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'n1', toolName: 'Shell', result: 'a\nb\n' }] },
  ]);
  const block = tailStore(dir, 0, 'ws/chat-1').messages[1].content[0];
  assert.equal(block.extended.is_error, undefined);
  assert.deepEqual(block.extended.render, { verb: 'exec', stdout: 'a\nb\n', stderr: '' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a read whose content blob is gone is not reported as an empty file', { skip: !sqlite && 'needs node 22.5+' }, () => {
  const dir = chatDir([
    { role: 'assistant', content: [call('r1', 'Read', { path: '/a.txt' })] },
    resultMessage('r1', 'Read', 'annotated', {
      success: {
        path: '/a.txt', totalLines: 500, readRange: { startLine: 1, endLine: 500 },
        contentBlobId: digest(Buffer.from('never stored')).toString('base64'),
      },
    }),
  ]);
  const render = tailStore(dir, 0, 'ws/chat-1').messages[1].content[0].extended.render;
  // no `content` key at all: an empty string here would tell the file timeline
  // the agent saw an empty file
  assert.deepEqual(render, { verb: 'read_file', path: '/a.txt' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an inlined image counts against the chunk budget', { skip: !sqlite && 'needs node 22.5+' }, () => {
  const image = Buffer.alloc(3 * 1024 * 1024, 7);
  const read = (n) => [
    { role: 'assistant', content: [call(`i${n}`, 'Read', { path: `/shot${n}.png` })] },
    resultMessage(`i${n}`, 'Read', 'Read image file', {
      success: { path: `/shot${n}.png`, fileSize: image.length, dataBlobId: digest(image).toString('base64') },
    }),
  ];
  const dir = chatDir([...read(1), ...read(2), ...read(3)], { extraBlobs: [image] });
  const first = tailStore(dir, 0, 'ws/chat-1');
  // the budget stops the reply well before three 4MB base64 payloads
  assert.ok(first.cursor < first.size, `expected a partial chunk, drained ${first.cursor}/${first.size}`);
  assert.ok(first.messages.some((m) => m.content[0].extended?.render?.image_src));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a session rewritten behind the client asks it to rebuild', { skip: !sqlite && 'needs node 22.5+' }, () => {
  // cursor compacts and rewinds, so the root list can SHRINK; a cursor past the
  // end must not leave the client silently stuck forever
  const dir = chatDir([{ role: 'assistant', content: [{ type: 'text', text: 'only' }] }]);
  const late = tailStore(dir, 99, 'ws/chat-1');
  assert.equal(late.reset, true);
  assert.equal(late.cursor, 1);
  assert.deepEqual(late.messages.map((m) => m.content[0].text), ['only']);
  // the ordinary resume must NOT claim a reset
  assert.equal(tailStore(dir, 1, 'ws/chat-1').reset, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a Task links its subagent from the call, before any result arrives', { skip: !sqlite && 'needs node 22.5+' }, () => {
  const ws = workspace();
  const parent = chatDir([
    { role: 'assistant', content: [call('t1', 'Task', { description: 'dig', subagent_type: 'generalPurpose' })] },
  ], { ws, chat: 'parent-1' });
  // the child exists but has not written its sidecar yet — the state this
  // feature exists to catch
  chatDir([{ role: 'assistant', content: [{ type: 'text', text: 'child' }] }], {
    ws, chat: 'kid-1', sidecar: null,
    subagentInfo: { parentAgentId: 'parent-1', toolCallId: 't1', typeName: 'generalPurpose' },
  });
  const render = tailStore(parent, 0, `wshash/parent-1`, true).messages[0].content[0].extended.render;
  assert.deepEqual(render, {
    verb: 'spawn_agent', agent_type: 'generalPurpose', title: 'dig',
    agent_id: 'kid-1', child_session_id: 'wshash/kid-1',
  });
  // a mirrored (SSH) store has no siblings to scan and must not guess
  assert.deepEqual(tailStore(parent, 0, 'wshash/parent-1', false).messages[0].content[0].extended.render, {
    verb: 'spawn_agent', agent_type: 'generalPurpose', title: 'dig',
  });
  fs.rmSync(ws, { recursive: true, force: true });
});

test('the picker lists real chats and hides subagents and empty ones', { skip: !sqlite && 'needs node 22.5+' }, () => {
  const ws = workspace();
  chatDir([{ role: 'user', content: [{ type: 'text', text: '<user_query>do the thing</user_query>' }] }], { ws, chat: 'plain' });
  chatDir([{ role: 'user', content: [{ type: 'text', text: '<user_query>named</user_query>' }] }], { ws, chat: 'titled', name: 'Ship It' });
  chatDir([], { ws, chat: 'sub', subagentInfo: { parentAgentId: 'plain', toolCallId: 'x' }, sidecar: { isSubagent: true } });
  chatDir([], { ws, chat: 'fresh', sidecar: { hasConversation: false } });
  // predates the sidecar entirely, and is a subagent: only the store knows
  chatDir([], { ws, chat: 'legacy-sub', sidecar: null, subagentInfo: { parentAgentId: 'plain', toolCallId: 'y' } });

  const listed = listChats(ws, '/repo');
  assert.deepEqual(listed.map((s) => s.id.split('/')[1]).sort(), ['plain', 'titled']);
  assert.equal(listed.find((s) => s.id.endsWith('titled')).label, 'Ship It');
  assert.equal(listed.find((s) => s.id.endsWith('plain')).label, 'do the thing');
  assert.equal(listed[0].cwd, '/repo');
  fs.rmSync(ws, { recursive: true, force: true });
});
