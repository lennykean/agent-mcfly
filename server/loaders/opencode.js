// OpenCode 1.17.x stores sessions and their mutable message parts in one
// SQLite database. The loader deliberately covers only McFly's existing
// picker/live-view contract: session metadata plus text, reasoning, and
// generic tool calls/results. OpenCode-specific file/diff semantics can be
// added later without weakening exact route matching.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let sqlite;

function trySqlite(load) {
  try {
    const mod = load('node:sqlite');
    return typeof mod?.DatabaseSync === 'function' ? mod : null;
  } catch { return null; }
}

function sqliteModule() {
  if (sqlite === undefined) sqlite = trySqlite(require);
  return sqlite;
}

export function opencodeTranscriptsSupported(load) {
  return !!(load ? trySqlite(load) : sqliteModule());
}

export function databasePath(env = process.env, home = os.homedir()) {
  const data = path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode');
  const override = env.OPENCODE_DB;
  if (override === ':memory:') return null;
  if (override) return path.isAbsolute(override) ? override : path.join(data, override);
  // The installed stable/latest channel uses this documented production DB.
  // Do not scan other channel files and guess which one is active.
  return path.join(data, 'opencode.db');
}

function open(file = databasePath(), load) {
  const mod = load ? trySqlite(load) : sqliteModule();
  if (!mod) throw new Error('reading OpenCode sessions needs node:sqlite enabled in this Node runtime');
  if (!file) throw Object.assign(new Error('OpenCode in-memory sessions are not readable by McFly'), { code: 'ENOENT' });
  return new mod.DatabaseSync(file, { readOnly: true });
}

const ROUTE_SCHEMA = {
  session: ['id', 'slug', 'directory', 'title', 'time_updated', 'time_archived'],
  message: ['session_id', 'time_updated', 'data'],
  part: ['session_id', 'time_updated', 'data'],
};

function compatibleRouteSchema(db) {
  return Object.entries(ROUTE_SCHEMA).every(([table, required]) => {
    const columns = new Set(db.prepare(`pragma table_info(${table})`).all().map((row) => row.name));
    return required.every((column) => columns.has(column));
  });
}

const permanentSqliteError = (error) => error?.code === 'ERR_SQLITE_ERROR'
  && /(?:unable to open database file|file is not a database|database disk image is malformed)/i.test(error.message ?? '');

const pathKey = (value) => {
  const source = String(value ?? '').replace(/\\/g, '/');
  const normalized = source === '/' ? source : source.replace(/\/+$/, '');
  return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
};

function canonicalDirectory(value) {
  if (typeof value !== 'string' || !value || value.length > 32 * 1024 || !path.isAbsolute(value)) return null;
  try {
    const real = fs.realpathSync.native(value);
    return fs.statSync(real).isDirectory() ? pathKey(real) : null;
  } catch { return null; }
}

function jsonData(value) {
  try {
    const parsed = JSON.parse(typeof value === 'string' ? value : Buffer.from(value ?? '').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

const missing = (message) => Object.assign(new Error(message), { code: 'ENOENT' });

function stats(db, id, sessionUpdated = 0) {
  const row = db.prepare(`
    select
      max(updated) as updated_at,
      count(*) as records,
      coalesce(sum(bytes), 0) as bytes
    from (
      select ? as updated, 0 as bytes
      union all
      select time_updated, length(data) from message where session_id = ?
      union all
      select time_updated, length(data) from part where session_id = ?
    )
  `).get(Number(sessionUpdated) || 0, id, id);
  const updated = Number(row?.updated_at) || 0;
  const records = Number(row?.records) || 1;
  // A numeric opaque token, not a byte offset. A new row in the same
  // millisecond still changes it; updates use OpenCode's time_updated field.
  const revision = updated > 0 ? updated * 2048 + (records % 2048) : records;
  return { updated, revision, bytes: Number(row?.bytes) || 0 };
}

function meta(row, db) {
  const stamp = stats(db, row.id, row.time_updated);
  return {
    id: row.id,
    provider: 'opencode',
    label: row.title || row.slug || row.id.slice(0, 19),
    cwd: row.directory,
    updated_at: stamp.updated,
    size: stamp.bytes,
  };
}

export function listForCwd(cwd, file = databasePath()) {
  const want = pathKey(cwd);
  if (!want) return [];
  let db;
  try {
    db = open(file);
    const rows = db.prepare(`
      select id, slug, directory, title, time_updated
      from session
      where time_archived is null
      order by time_updated desc, id
    `).all();
    return rows.filter((row) => pathKey(row.directory) === want).map((row) => meta(row, db));
  } catch { return []; }
  finally { try { db?.close(); } catch { /* already closed */ } }
}

// Permanent storage incompatibility is distinct from a new route whose row
// may still be racing the callback. The server acknowledges the former as an
// unsupported no-op and retries only the latter.
export function routeSession(sessionID, cwd, file = databasePath(), load) {
  if (typeof sessionID !== 'string' || !sessionID || sessionID.length > 512
    || /[\u0000-\u001f\u007f]/.test(sessionID)) return { kind: 'invalid' };
  const want = canonicalDirectory(cwd);
  if (!want) return { kind: 'invalid' };
  if (!(load ? trySqlite(load) : sqliteModule())) return { kind: 'unsupported' };
  if (!file) return { kind: 'unsupported' };
  try {
    if (!fs.statSync(file).isFile()) return { kind: 'unavailable' };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error?.code)) return { kind: 'unavailable' };
    throw error;
  }
  let db;
  try {
    db = open(file, load);
    if (!compatibleRouteSchema(db)) return { kind: 'incompatible' };
    const row = db.prepare(`
      select id, slug, directory, title, time_updated
      from session where id = ? and time_archived is null
    `).get(sessionID);
    if (!row) return { kind: 'missing' };
    if (canonicalDirectory(row.directory) !== want) return { kind: 'invalid' };
    return { kind: 'session', session: meta(row, db) };
  } catch (error) {
    if (permanentSqliteError(error)) return { kind: 'incompatible' };
    throw error;
  }
  finally { try { db?.close(); } catch { /* already closed */ } }
}

// Kept as the small nullable helper used by existing loader tests/callers.
export function sessionForRoute(sessionID, cwd, file = databasePath()) {
  try {
    const result = routeSession(sessionID, cwd, file);
    return result.kind === 'session' ? result.session : null;
  } catch { return null; }
}

export function tip(id, file = databasePath()) {
  let db;
  try {
    db = open(file);
    const row = db.prepare('select time_updated from session where id = ? and time_archived is null').get(id);
    if (!row) throw missing('OpenCode session not found');
    const stamp = stats(db, id, row.time_updated);
    return { updated_at: stamp.updated, size: stamp.revision };
  } finally { try { db?.close(); } catch { /* already closed */ } }
}

function callRender(tool, state) {
  const command = typeof state.input?.command === 'string' ? state.input.command : undefined;
  if (command && /^(?:bash|shell)$/i.test(tool)) return { verb: 'exec', command, title: state.title || command };
  return { verb: 'other', title: state.title || tool };
}

function resultRender(tool, state) {
  const command = typeof state.input?.command === 'string' ? state.input.command : undefined;
  if (command && /^(?:bash|shell)$/i.test(tool)) {
    return {
      verb: 'exec', command,
      ...(state.status === 'error' ? { stderr: state.error || '', stdout: '' } : { stdout: state.output || '', stderr: '' }),
    };
  }
  return { verb: 'other' };
}

function convertMessage(row, parts, messages) {
  const info = jsonData(row.data);
  if (!info || (info.role !== 'user' && info.role !== 'assistant')) return;
  const timestamp = Number(info.time?.created) || Number(row.time_created) || undefined;
  const content = [];
  const results = [];

  for (const partRow of parts) {
    const part = jsonData(partRow.data);
    if (!part) continue;
    if (part.type === 'text' && typeof part.text === 'string' && part.text
      && !part.synthetic && !part.ignored) {
      content.push({ type: 'text', text: part.text });
    } else if (info.role === 'assistant' && part.type === 'reasoning'
      && typeof part.text === 'string' && part.text) {
      content.push({ type: 'thinking', thought: part.text });
    } else if (info.role === 'assistant' && part.type === 'tool' && part.state
      && typeof part.state === 'object' && !Array.isArray(part.state)) {
      const tool = typeof part.tool === 'string' && part.tool ? part.tool : '?';
      const requestId = typeof part.callID === 'string' && part.callID ? part.callID : partRow.id;
      const input = part.state.input && typeof part.state.input === 'object' ? part.state.input : {};
      const state = { ...part.state, input };
      content.push({
        type: 'tool', tool_request_id: requestId, tool, params: input,
        extended: { render: callRender(tool, state) },
      });
      if (state.status === 'completed' || state.status === 'error') {
        results.push({
          type: 'tool_result', tool_request_id: requestId, tool,
          result: state.status === 'error' ? state.error ?? '' : state.output ?? '',
          extended: {
            render: resultRender(tool, state),
            ...(state.status === 'error' ? { is_error: true } : {}),
          },
        });
      }
    }
  }

  if (content.length) messages.push({ id: row.id, timestamp, role: info.role, content });
  if (results.length) messages.push({
    id: `${row.id}:results`,
    timestamp: Math.max(...parts.map((part) => Number(part.time_updated) || 0), timestamp || 0) || undefined,
    role: 'user', content: results,
  });
}

export function tail(id, cursor = 0, file = databasePath()) {
  let db;
  try {
    db = open(file);
    const session = db.prepare('select time_updated from session where id = ? and time_archived is null').get(id);
    if (!session) throw missing('OpenCode session not found');
    const stamp = stats(db, id, session.time_updated);
    if (Number(cursor) === stamp.revision) {
      return { messages: [], cursor: stamp.revision, mtime: stamp.updated, size: stamp.revision };
    }

    const rows = db.prepare(`
      select id, time_created, time_updated, data
      from message where session_id = ?
      order by time_created, id
    `).all(id);
    const partRows = db.prepare(`
      select id, message_id, time_created, time_updated, data
      from part where session_id = ?
      order by message_id, time_created, id
    `).all(id);
    const byMessage = new Map();
    for (const part of partRows) {
      const group = byMessage.get(part.message_id) ?? [];
      group.push(part);
      byMessage.set(part.message_id, group);
    }
    const messages = [];
    for (const row of rows) convertMessage(row, byMessage.get(row.id) ?? [], messages);
    return {
      messages,
      cursor: stamp.revision,
      mtime: stamp.updated,
      size: stamp.revision,
      ...(Number(cursor) > 0 ? { reset: true } : {}),
    };
  } finally { try { db?.close(); } catch { /* already closed */ } }
}
