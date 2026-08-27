import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { databasePath, listForCwd, opencodeTranscriptsSupported, routeSession, sessionForRoute, tail, tip } from './opencode.js';

const require = createRequire(import.meta.url);
let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { /* node:sqlite can be absent or disabled */ }

test('probes the loadable OpenCode SQLite capability', () => {
  assert.equal(opencodeTranscriptsSupported(() => ({ DatabaseSync() {} })), true);
  assert.equal(opencodeTranscriptsSupported(() => { throw new Error('disabled'); }), false);
  assert.equal(opencodeTranscriptsSupported(() => ({})), false);
});

test('resolves only OpenCode supported production and explicit database paths', () => {
  const home = path.resolve('home-for-test');
  assert.equal(databasePath({}, home), path.join(home, '.local', 'share', 'opencode', 'opencode.db'));
  assert.equal(databasePath({ XDG_DATA_HOME: path.resolve('xdg') }, home), path.resolve('xdg', 'opencode', 'opencode.db'));
  assert.equal(databasePath({ XDG_DATA_HOME: path.resolve('xdg'), OPENCODE_DB: 'custom.db' }, home), path.resolve('xdg', 'opencode', 'custom.db'));
  assert.equal(databasePath({ OPENCODE_DB: path.resolve('exact.db') }, home), path.resolve('exact.db'));
  assert.equal(databasePath({ OPENCODE_DB: ':memory:' }, home), null);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-opencode-loader-'));
  const cwd = path.join(root, 'repo');
  const other = path.join(root, 'other');
  fs.mkdirSync(cwd);
  fs.mkdirSync(other);
  const file = path.join(root, 'opencode.db');
  const db = new sqlite.DatabaseSync(file);
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
  const addSession = db.prepare('insert into session values (?, ?, ?, ?, ?, ?, ?)');
  addSession.run('ses_active', null, 'active-slug', cwd, 'Active session', 1000, null);
  addSession.run('ses_child', 'ses_active', 'child-slug', cwd, 'Child session', 1001, null);
  addSession.run('ses_archived', null, 'old', cwd, 'Archived', 1002, 1003);
  addSession.run('ses_other', null, 'other', other, 'Other', 1004, null);
  const addMessage = db.prepare('insert into message values (?, ?, ?, ?, ?)');
  const addPart = db.prepare('insert into part values (?, ?, ?, ?, ?, ?)');
  addMessage.run('msg_user', 'ses_active', 1100, 1100, JSON.stringify({ role: 'user', time: { created: 1100 } }));
  addPart.run('prt_user', 'msg_user', 'ses_active', 1100, 1100, JSON.stringify({ type: 'text', text: 'Fix it' }));
  addPart.run('prt_hidden', 'msg_user', 'ses_active', 1101, 1101, JSON.stringify({ type: 'text', text: 'injected', synthetic: true }));
  addMessage.run('msg_assistant', 'ses_active', 1200, 1200, JSON.stringify({ role: 'assistant', time: { created: 1200 } }));
  addPart.run('prt_reasoning', 'msg_assistant', 'ses_active', 1200, 1200, JSON.stringify({ type: 'reasoning', text: 'Inspect first', time: { start: 1200 } }));
  addPart.run('prt_text', 'msg_assistant', 'ses_active', 1201, 1201, JSON.stringify({ type: 'text', text: 'Done' }));
  addPart.run('prt_tool', 'msg_assistant', 'ses_active', 1202, 1202, JSON.stringify({
    type: 'tool', callID: 'call-1', tool: 'bash',
    state: { status: 'completed', input: { command: 'pwd' }, output: cwd, title: 'Working directory', time: { start: 1202, end: 1203 } },
  }));
  addPart.run('prt_bad', 'msg_assistant', 'ses_active', 1203, 1203, '{not json');
  db.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { cwd, other, file };
}

test('exact route validation and the picker use the same real OpenCode session', { skip: !sqlite && 'needs node:sqlite' }, (t) => {
  const { cwd, other, file } = fixture(t);
  const sessions = listForCwd(cwd, file);
  assert.deepEqual(sessions.map((session) => session.id).sort(), ['ses_active', 'ses_child']);
  assert.equal(sessions.find((session) => session.id === 'ses_active').label, 'Active session');
  assert.equal(sessions.every((session) => session.provider === 'opencode' && session.cwd === cwd), true);
  assert.equal(listForCwd(other, file)[0].id, 'ses_other');
  assert.equal(listForCwd(path.join(cwd, 'missing'), file).length, 0);

  assert.equal(sessionForRoute('ses_active', cwd, file)?.id, 'ses_active');
  assert.equal(routeSession('ses_active', cwd, file).kind, 'session');
  assert.equal(routeSession('ses_missing', cwd, file).kind, 'missing');
  assert.equal(sessionForRoute('ses_child', cwd, file)?.id, 'ses_child');
  assert.equal(sessionForRoute('ses_active', other, file), null);
  assert.equal(sessionForRoute('ses_archived', cwd, file), null);
  assert.equal(sessionForRoute('ses_missing', cwd, file), null);
  assert.equal(sessionForRoute('bad\nidentity', cwd, file), null);
  assert.equal(sessionForRoute('ses_active', path.join(cwd, 'gone'), file), null);
});

test('tails enough OpenCode content for the existing live transcript view and rebuilds mutable parts', { skip: !sqlite && 'needs node:sqlite' }, (t) => {
  const { cwd, file } = fixture(t);
  const first = tail('ses_active', 0, file);
  assert.equal(first.reset, undefined);
  assert.deepEqual(first.messages.map((message) => message.role), ['user', 'assistant', 'user']);
  assert.deepEqual(first.messages[0].content, [{ type: 'text', text: 'Fix it' }]);
  assert.deepEqual(first.messages[1].content.slice(0, 2), [
    { type: 'thinking', thought: 'Inspect first' },
    { type: 'text', text: 'Done' },
  ]);
  const call = first.messages[1].content[2];
  assert.deepEqual(call.extended.render, { verb: 'exec', command: 'pwd', title: 'Working directory' });
  const result = first.messages[2].content[0];
  assert.equal(result.result, cwd);
  assert.deepEqual(result.extended.render, { verb: 'exec', command: 'pwd', stdout: cwd, stderr: '' });
  assert.deepEqual(tail('ses_active', first.cursor, file).messages, []);
  assert.deepEqual(tip('ses_active', file), { updated_at: first.mtime, size: first.cursor });

  const db = new sqlite.DatabaseSync(file);
  db.prepare('update part set time_updated = ?, data = ? where id = ?').run(1300, JSON.stringify({
    type: 'tool', callID: 'call-1', tool: 'bash',
    state: { status: 'error', input: { command: 'pwd' }, error: 'stopped', time: { start: 1202, end: 1300 } },
  }), 'prt_tool');
  db.close();
  const changed = tail('ses_active', first.cursor, file);
  assert.equal(changed.reset, true);
  assert.notEqual(changed.cursor, first.cursor);
  assert.equal(changed.messages.at(-1).content[0].extended.is_error, true);
  assert.equal(changed.messages.at(-1).content[0].result, 'stopped');
  assert.throws(() => tail('missing', 0, file), /not found/);
});

test('missing or unsupported OpenCode storage stays an empty provider', () => {
  const missing = path.join(os.tmpdir(), 'definitely-missing-opencode.db');
  assert.deepEqual(listForCwd(process.cwd(), missing), []);
  assert.equal(sessionForRoute('ses_x', process.cwd(), null), null);
  assert.equal(routeSession('ses_x', process.cwd(), null).kind, 'unsupported');
  assert.equal(routeSession('ses_x', process.cwd(), missing, () => ({ DatabaseSync() {} })).kind, 'unavailable');
  assert.equal(routeSession('ses_x', process.cwd(), missing, () => { throw new Error('node:sqlite disabled'); }).kind, 'unsupported');
});

test('an incompatible OpenCode schema is a permanent no-op, not a missing-session race', { skip: !sqlite && 'needs node:sqlite' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-opencode-schema-'));
  const file = path.join(root, 'opencode.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec('create table session (id text primary key)');
  db.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(routeSession('ses_x', process.cwd(), file).kind, 'incompatible');
});
