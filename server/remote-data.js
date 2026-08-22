// Remote read-only workspace/session data over one existing SSH connection.
// Nothing is installed or run persistently on the remote host: SFTP supplies
// bytes and SSH exec supplies the same git output parsed by git.js.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as claudeCode from './loaders/claude-code.js';
import * as codex from './loaders/codex.js';
import * as cursor from './loaders/cursor.js';
import { execSsh } from './ssh.js';
import { MAX_CHUNK } from './loaders/transcript.js';

// SFTP round-trips are latency, not CPU: session heads are read in parallel,
// bounded so a big session store cannot swamp the channel.
const HEAD_CONCURRENCY = 8;

async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
const sftpByClient = new WeakMap();
const codexIoByClient = new WeakMap();
// ponytail: process-lifetime cursor cache; add disconnect eviction if host churn becomes measurable.
const codexThrough = new Map();
// extension -> mime for inlined images; the local file reader shares it
export const IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const pathsFor = (connection) => connection.platform === 'win32' ? path.win32 : path.posix;
const mtimeMs = (attrs) => attrs.mtimeMs ?? Number(attrs.mtime ?? 0) * 1000;
const statShape = (attrs) => ({ size: Number(attrs.size ?? 0), mtimeMs: mtimeMs(attrs) });
const isDir = (attrs) => typeof attrs.isDirectory === 'function' ? attrs.isDirectory() : !!attrs.dir;
const missing = (error) => error?.code === 2 || error?.code === 'ENOENT';

function call(target, method, ...args) {
  return new Promise((resolve, reject) => {
    target[method](...args, (error, value) => error ? reject(error) : resolve(value));
  });
}

async function sftpFor(connection) {
  let pending = sftpByClient.get(connection.client);
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    connection.client.sftp((error, sftp) => {
      if (error) return reject(error);
      sftp?.once?.('close', () => sftpByClient.delete(connection.client));
      resolve(sftp);
    });
  });
  sftpByClient.set(connection.client, pending);
  try { return await pending; }
  catch (error) { sftpByClient.delete(connection.client); throw error; }
}

function contained(connection, root, input = '') {
  const paths = pathsFor(connection);
  const resolvedRoot = paths.resolve(root);
  const target = paths.resolve(resolvedRoot, input);
  const key = connection.platform === 'win32' ? (value) => value.toLowerCase() : (value) => value;
  if (key(target) !== key(resolvedRoot) && !key(target).startsWith(key(resolvedRoot + paths.sep))) {
    const error = new Error('outside root');
    error.code = 'EACCES';
    throw error;
  }
  return target;
}

async function stat(connection, file) {
  return statShape(await call(await sftpFor(connection), 'stat', file));
}

async function readRange(connection, file, start, length) {
  if (length <= 0) return Buffer.alloc(0);
  const sftp = await sftpFor(connection);
  const handle = await call(sftp, 'open', file, 'r');
  const buffer = Buffer.alloc(length);
  let offset = 0;
  try {
    while (offset < length) {
      const read = await new Promise((resolve, reject) => {
        sftp.read(handle, buffer, offset, length - offset, start + offset, (error, bytesRead) => {
          if (error) reject(error);
          else resolve(bytesRead);
        });
      });
      if (!read) break;
      offset += read;
    }
  } finally {
    await call(sftp, 'close', handle).catch(() => {});
  }
  return buffer.subarray(0, offset);
}

async function readFile(connection, file) {
  return call(await sftpFor(connection), 'readFile', file);
}

async function readTailChunk(reader, file, cursor, size) {
  if (size <= cursor) return Buffer.alloc(0);
  let want = Math.min(size - cursor, MAX_CHUNK);
  for (;;) {
    const buffer = await reader(file, cursor, want);
    if (buffer.lastIndexOf(10) >= 0 || want >= size - cursor || buffer.length < want) return buffer;
    want = Math.min(want * 2, size - cursor);
  }
}

async function safeReadDir(connection, dir) {
  try { return await call(await sftpFor(connection), 'readdir', dir); }
  catch (error) { if (missing(error)) return []; throw error; }
}

export async function isDirectory(connection, dir) {
  try { return isDir(await call(await sftpFor(connection), 'stat', dir)); }
  catch (error) {
    if (missing(error) || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

export async function fsList(connection, root, relative = '') {
  const target = contained(connection, root, relative);
  const attrs = await call(await sftpFor(connection), 'stat', target);
  if (!isDir(attrs)) {
    const error = new Error('not a directory');
    error.code = 'ENOTDIR';
    throw error;
  }
  const entries = await safeReadDir(connection, target);
  return entries
    .filter((entry) => !['node_modules', '.git'].includes(entry.filename))
    .map((entry) => ({ name: entry.filename, dir: isDir(entry.attrs) }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

export async function fsMkdir(connection, root, name) {
  await call(await sftpFor(connection), 'mkdir', contained(connection, root, name));
}

export async function fsRead(connection, root, relative = '') {
  const paths = pathsFor(connection);
  const target = contained(connection, root, relative);
  const attrs = await stat(connection, target);
  const ext = paths.extname(target).toLowerCase();
  if (IMG[ext]) {
    if (attrs.size > 8 * 1024 * 1024) return { error: 'image too large' };
    return { image_src: `data:${IMG[ext]};base64,${(await readFile(connection, target)).toString('base64')}` };
  }
  if (attrs.size > 2 * 1024 * 1024) return { error: `file too large (${Math.round(attrs.size / 1024)} KB)` };
  return { content: (await readFile(connection, target)).toString('utf8') };
}

const REMOTE_USER = /^[a-z_][a-z0-9_-]{0,31}$/;

function sudoWrapperUser(source) {
  const lines = String(source).replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines[0]?.startsWith('#!')) lines.shift();
  const word = "('[^'\\r\\n]*'|\"[^\"$`\\\\\\r\\n]*\"|[A-Za-z0-9_@%+=:,./-]+)";
  const direct = lines.length === 1
    ? new RegExp(`^exec\\s+sudo\\s+-u\\s+([a-z_][a-z0-9_-]{0,31})\\s+-H\\s+${word}\\s+"\\$@"$`).exec(lines[0])
    : null;
  if (direct) {
    const target = /^['"]/.test(direct[2]) ? direct[2].slice(1, -1) : direct[2];
    return REMOTE_USER.test(direct[1]) && path.posix.isAbsolute(target) ? direct[1] : null;
  }
  if (lines.length !== 4 || lines[0] !== 'set -e') return null;
  const assigned = new RegExp(`^executable=${word}$`).exec(lines[1]);
  const checked = /^if\s+\[\s+"\$\(id -un\)"\s+=\s+([a-z_][a-z0-9_-]{0,31})\s+\];\s+then\s+exec\s+"\$executable"\s+"\$@";\s+fi$/.exec(lines[2]);
  const elevated = /^exec\s+sudo\s+-u\s+([a-z_][a-z0-9_-]{0,31})\s+-H\s+"\$executable"\s+"\$@"$/.exec(lines[3]);
  if (!assigned || !checked || !elevated || checked[1] !== elevated[1] || !REMOTE_USER.test(elevated[1])) return null;
  const target = /^['"]/.test(assigned[1]) ? assigned[1].slice(1, -1) : assigned[1];
  return path.posix.isAbsolute(target) ? elevated[1] : null;
}

async function detectSudoCodex(connection) {
  if (connection.platform !== 'linux' || !connection.tools?.includes('codex')) return null;
  try {
    const executable = (await exec(connection, 'command -v codex', false, { timeout: 5_000, maxBytes: 4096 })).trim();
    if (!path.posix.isAbsolute(executable) || /[\r\n]/.test(executable)) return null;
    const wrapper = await exec(connection, `dd if=${quote(executable)} bs=8192 count=1 2>/dev/null`, false, { timeout: 5_000, maxBytes: 8192 });
    const user = sudoWrapperUser(wrapper);
    if (!user) return null;
    const prefix = `cd /tmp && sudo -n -u ${quote(user)} -H`;
    const stateDir = (await exec(connection,
      `${prefix} sh -c ${quote('printf "%s\\n" "${CODEX_HOME:-$HOME/.codex}"')}`, false,
      { timeout: 5_000, maxBytes: 4096 })).trim();
    return path.posix.isAbsolute(stateDir) && !/[\r\n]/.test(stateDir) ? { prefix, stateDir } : null;
  } catch { return null; }
}

function rolloutTime(file) {
  const hit = /rollout-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})/.exec(path.posix.basename(file));
  const time = hit ? Date.parse(`${hit[1]}:${hit[2]}:${hit[3]}Z`) : 0;
  return Number.isFinite(time) ? time : 0;
}

async function sudoCodexFiles(connection, access, root) {
  const script = 'cd "$1" 2>/dev/null || exit 0\n'
    + 'find . -type f -name "rollout-*.jsonl" -exec sh -c \'for file; do size=$(wc -c < "$file") || continue; printf "%s\\000%s\\000" "${file#./}" "$size"; done\' sh {} +';
  const command = `${access.prefix} sh -c ${quote(script)} sh ${quote(root)}`;
  const fields = (await exec(connection, command, false, { maxBytes: MAX_CHUNK })).split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 2) throw new Error('invalid remote Codex file list');
  const out = [];
  for (let i = 0; i < fields.length; i += 2) {
    const size = Number(fields[i + 1]);
    if (!fields[i] || !Number.isSafeInteger(size) || size < 0) continue;
    out.push({ id: fields[i], file: contained(connection, root, fields[i]), attrs: { size, mtimeMs: rolloutTime(fields[i]) } });
  }
  return out;
}

async function codexIo(connection) {
  let pending = codexIoByClient.get(connection.client);
  if (pending) return pending;
  pending = (async () => {
    const access = await detectSudoCodex(connection);
    if (!access) return {
      stateDir: pathsFor(connection).join(connection.home, '.codex'),
      files: (root) => codexFiles(connection, root),
      stat: (file) => stat(connection, file),
      readRange: (file, start, length) => readRange(connection, file, start, length),
      readIndex: (file) => readFile(connection, file),
    };
    const statAsUser = async (file) => {
      const size = Number((await exec(connection,
        `${access.prefix} sh -c ${quote('wc -c < "$1"')} sh ${quote(file)}`, false,
        { maxBytes: 4096 })).trim());
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('invalid remote Codex stat');
      return { size, mtimeMs: rolloutTime(file) };
    };
    const readRangeAsUser = async (file, start, length) => {
      const count = Math.min(length, MAX_CHUNK);
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) || count < 0) throw new Error('invalid remote Codex range');
      if (!count) return Buffer.alloc(0);
      const encoded = (await exec(connection,
        `${access.prefix} od -A n -v -t x1 -j ${start} -N ${count} ${quote(file)}`, false,
        { maxBytes: count * 4 + 4096 })).replace(/\s/g, '');
      if (!/^(?:[0-9a-fA-F]{2})*$/.test(encoded)) throw new Error('invalid remote Codex bytes');
      const buffer = Buffer.from(encoded, 'hex');
      if (buffer.length > count) throw new Error('invalid remote Codex range');
      return buffer;
    };
    return {
      stateDir: access.stateDir,
      files: (root) => sudoCodexFiles(connection, access, root),
      stat: statAsUser,
      readRange: readRangeAsUser,
      readIndex: async (file) => {
        const attrs = await statAsUser(file);
        const count = Math.min(attrs.size, MAX_CHUNK);
        return readRangeAsUser(file, attrs.size - count, count);
      },
    };
  })();
  codexIoByClient.set(connection.client, pending);
  return pending;
}

async function codexFiles(connection, dir, base = '') {
  const paths = pathsFor(connection);
  const out = [];
  for (const entry of await safeReadDir(connection, dir)) {
    const relative = base ? `${base}/${entry.filename}` : entry.filename;
    const full = paths.join(dir, entry.filename);
    if (isDir(entry.attrs)) out.push(...await codexFiles(connection, full, relative));
    else if (entry.filename.startsWith('rollout-') && entry.filename.endsWith('.jsonl')) {
      out.push({ id: relative, file: full, attrs: statShape(entry.attrs) });
    }
  }
  return out;
}

async function listCodex(connection, cwd) {
  const paths = pathsFor(connection);
  const io = await codexIo(connection);
  const root = paths.join(io.stateDir, 'sessions');
  const index = paths.join(io.stateDir, 'session_index.jsonl');
  let names = new Map();
  try { names = codex.parseThreadNames((await io.readIndex(index)).toString('utf8')); }
  catch { /* optional */ }
  const want = codex.projectPathKey(cwd);
  const heads = await mapLimited(await io.files(root), HEAD_CONCURRENCY, async (item) => {
    try {
      const head = codex.parseHead((await io.readRange(item.file, 0, Math.min(64 * 1024, item.attrs.size))).toString('utf8'));
      return { item, head };
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  });
  const out = [];
  for (const entry of heads) {
    if (!entry) continue;
    const { item, head } = entry;
    if (codex.projectPathKey(head.cwd) !== want) continue;
    const base = paths.basename(item.file, '.jsonl').replace(/^rollout-/, '');
    out.push({
      id: item.id, provider: 'codex',
      label: names.get(head.id) ?? head.label ?? (head.nickname ? `agent ${head.nickname}` : base.slice(0, 19)),
      cwd: head.cwd, updated_at: item.attrs.mtimeMs, size: item.attrs.size,
    });
  }
  return out.sort((a, b) => b.updated_at - a.updated_at);
}

async function listClaude(connection, cwd) {
  const paths = pathsFor(connection);
  const root = paths.join(connection.home, '.claude', 'projects');
  const out = [];
  for (const project of await safeReadDir(connection, root)) {
    if (!isDir(project.attrs) || !claudeCode.projectSlugMatches(cwd, project.filename)) continue;
    const dir = paths.join(root, project.filename);
    const files = (await safeReadDir(connection, dir))
      .filter((entry) => !isDir(entry.attrs) && entry.filename.endsWith('.jsonl'));
    const scanned = await mapLimited(files, HEAD_CONCURRENCY, async (entry) => {
      const file = paths.join(dir, entry.filename);
      const attrs = statShape(entry.attrs);
      const starts = [...new Set([0, Math.max(0, attrs.size - 64 * 1024)])];
      try {
        const chunks = await Promise.all(starts.map(async (start) =>
          (await readRange(connection, file, start, Math.min(64 * 1024, attrs.size - start))).toString('utf8')));
        return { entry, attrs, head: claudeCode.scanHeadChunks(chunks) };
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    });
    for (const found of scanned) {
      if (!found) continue;
      const { entry, attrs, head } = found;
      out.push({
        id: `${project.filename}/${entry.filename}`, provider: 'claude-code', project: project.filename,
        label: head.title ?? entry.filename.replace(/\.jsonl$/, '').slice(0, 8), cwd: head.cwd,
        updated_at: attrs.mtimeMs, size: attrs.size,
      });
    }
  }
  return out.sort((a, b) => b.updated_at - a.updated_at);
}

// ---- cursor: a SQLite store per chat, so there is nothing to tail over SFTP ----
//
// The sidecar (meta.json) is what the picker needs — cwd, last activity, the
// chat name — and it is a few hundred bytes, so listing never touches the
// store itself. Only an OPEN session pays for the store, mirrored locally.
const cursorRoot = (connection) => pathsFor(connection).join(connection.home, '.cursor', 'chats');

async function listCursor(connection, cwd) {
  const paths = pathsFor(connection);
  const hash = cursor.workspaceHash(cwd);
  const dir = paths.join(cursorRoot(connection), hash);
  const chats = (await safeReadDir(connection, dir)).filter((entry) => isDir(entry.attrs));
  const found = await mapLimited(chats, HEAD_CONCURRENCY, async (chat) => {
    const chatDir = paths.join(dir, chat.filename);
    let meta;
    // No sidecar, no listing: reading the store to decide would mean
    // downloading every chat in the workspace on a 4-second poll. Chats old
    // enough to predate the sidecar stay local-only.
    try { meta = JSON.parse((await readFile(connection, paths.join(chatDir, 'meta.json'))).toString('utf8')); } catch { return null; }
    if (!meta || meta.isSubagent || meta.hasConversation === false) return null;
    let store;
    try { store = await stat(connection, paths.join(chatDir, 'store.db')); } catch { return null; }
    return {
      id: `${hash}/${chat.filename}`,
      provider: 'cursor',
      // remote listing stops at the sidecar, so an unnamed chat shows its id
      // rather than costing a store download for its first user query
      label: meta.title ?? chat.filename.slice(0, 8),
      cwd: meta.cwd ?? cwd,
      updated_at: meta.updatedAtMs > 0 ? meta.updatedAtMs : store.mtimeMs,
      size: store.size,
    };
  });
  return found.filter(Boolean).sort((a, b) => b.updated_at - a.updated_at);
}

// The mirror lives in a private temp directory, one subdirectory per
// (connection, chat). Private because /tmp is world-writable: a shared,
// name-predictable path is both a symlink target and an EACCES waiting for the
// second user on the box.
const mirrorRoot = (() => {
  let dir;
  return () => (dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-cursor-')));
})();

// store.db and its -wal are stamped separately: during a live turn only the
// -wal grows, so a refresh re-fetches kilobytes rather than the whole store.
const mirrorStamps = new Map();

async function mirrorFile(connection, remote, local, key) {
  let attrs = null;
  try { attrs = await stat(connection, remote); } catch (error) { if (!missing(error)) throw error; }
  const stamp = attrs ? `${attrs.size}:${attrs.mtimeMs}` : 'gone';
  // the stamp describes a local file, so it is only good while that file is
  // there — a temp cleaner must not leave us short-circuiting on nothing
  if (mirrorStamps.get(key) === stamp && fs.existsSync(local) === !!attrs) return;
  if (!attrs) fs.rmSync(local, { force: true });
  else fs.writeFileSync(local, await readFile(connection, remote));
  mirrorStamps.set(key, stamp);
}

// Two tabs on one session, or a parent and its child timeline, otherwise both
// download the whole store and can interleave a stale store.db over a fresh
// one. Share the in-flight mirror the way sftpFor shares its connection.
const mirroring = new Map();

function mirrorCursorStore(connection, id) {
  const localDir = path.join(mirrorRoot(), createHash('sha1').update(`${connection.id}\0${id}`).digest('hex'));
  const pending = mirroring.get(localDir);
  if (pending) return pending;
  const run = (async () => {
    const paths = pathsFor(connection);
    const remoteDir = contained(connection, cursorRoot(connection), String(id).replace(/[\\/]/g, paths.sep));
    fs.mkdirSync(localDir, { recursive: true });
    // store.db first: a newer -wal over an older db is the combination SQLite
    // cannot reconcile
    for (const name of ['store.db', 'store.db-wal', 'meta.json']) {
      await mirrorFile(connection, paths.join(remoteDir, name), path.join(localDir, name), `${localDir}\0${name}`);
    }
    // a stale index left over from the previous mirror would describe the old
    // -wal; SQLite rebuilds it on open
    fs.rmSync(path.join(localDir, 'store.db-shm'), { force: true });
    return localDir;
  })().finally(() => mirroring.delete(localDir));
  mirroring.set(localDir, run);
  return run;
}

export function listSessions(connection, provider, cwd) {
  if (!connection.home) throw new Error('remote home unavailable');
  if (provider === 'codex') return listCodex(connection, cwd);
  if (provider === 'claude-code') return listClaude(connection, cwd);
  if (provider === 'cursor') return listCursor(connection, cwd);
  throw new Error('unknown provider');
}

export async function listProviders(connection, cwd) {
  if (!connection.home) throw new Error('remote home unavailable');
  const [claude, codexSessions, cursorSessions] = await Promise.all([
    listClaude(connection, cwd), listCodex(connection, cwd), listCursor(connection, cwd),
  ]);
  return [
    { provider: 'claude-code', count: claude.length },
    { provider: 'codex', count: codexSessions.length },
    { provider: 'cursor', count: cursorSessions.length },
  ];
}

export async function tailSession(connection, provider, id, cursorAt = 0) {
  const paths = pathsFor(connection);
  if (provider === 'cursor') {
    return cursor.tailStore(await mirrorCursorStore(connection, id), cursorAt, id);
  }
  const codexData = provider === 'codex' ? await codexIo(connection) : null;
  const providerRoot = provider === 'codex'
    ? paths.join(codexData.stateDir, 'sessions')
    : provider === 'claude-code' ? paths.join(connection.home, '.claude', 'projects') : null;
  if (!providerRoot) throw new Error('unknown provider');
  const file = contained(connection, providerRoot, String(id).replace(/[\\/]/g, paths.sep));
  const reader = codexData?.readRange ?? ((target, start, length) => readRange(connection, target, start, length));
  const attrs = codexData ? await codexData.stat(file) : await stat(connection, file);
  const fileKey = `ssh:${connection.id}:${id}`;
  if (provider === 'codex' && cursorAt > 0) {
    let through = Math.min(codexThrough.get(fileKey) ?? 0, attrs.size);
    if (through >= cursorAt) through = 0;
    while (through < cursorAt) {
      const prefix = await readTailChunk(reader, file, through, cursorAt);
      const primed = codex.parseTailChunk(fileKey, through, { ...attrs, size: cursorAt }, prefix);
      if (primed.cursor <= through) break;
      through = primed.cursor;
    }
    codexThrough.set(fileKey, through);
  }
  const buffer = await readTailChunk(reader, file, cursorAt, attrs.size);
  if (provider !== 'codex') return claudeCode.parseTailChunk(id, cursorAt, attrs, buffer);
  const result = codex.parseTailChunk(fileKey, cursorAt, attrs, buffer);
  codexThrough.set(fileKey, Math.max(codexThrough.get(fileKey) ?? 0, result.cursor));
  return result;
}

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const powershellQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
function win32Quote(value) {
  let quoted = '"';
  let slashes = 0;
  for (const char of String(value)) {
    if (char === '\\') { slashes++; continue; }
    if (char === '"') {
      quoted += '\\'.repeat(slashes * 2 + 1) + '"';
      slashes = 0;
      continue;
    }
    quoted += '\\'.repeat(slashes) + char;
    slashes = 0;
  }
  return quoted + '\\'.repeat(slashes * 2) + '"';
}

async function exec(connection, command, allowOne = false, options = {}) {
  const result = await execSsh(connection, command, { maxBytes: 16 * 1024 * 1024, ...options });
  if (result.signal || (result.code && !(allowOne && result.code === 1))) {
    const failure = new Error(String(result.stderr || `remote command exited ${result.signal ?? result.code}`).split('\n')[0]);
    failure.code = result.code;
    throw failure;
  }
  return result.stdout;
}

export function gitIo(connection) {
  const paths = pathsFor(connection);
  const run = (root, args, lenient) => {
    let command = `git -C ${quote(root)} ${args.map(quote).join(' ')}`;
    if (connection.platform === 'win32') {
      const nativeArgs = ['-C', root, ...args].map(win32Quote).join(' ');
      const script = `$ErrorActionPreference = 'Stop'\n`
        + '$start = [System.Diagnostics.ProcessStartInfo]::new()\n'
        + "$start.FileName = 'git.exe'\n"
        + `$start.Arguments = ${powershellQuote(nativeArgs)}\n`
        + '$start.UseShellExecute = $false\n'
        + '$start.RedirectStandardOutput = $true\n'
        + '$start.RedirectStandardError = $true\n'
        + '$process = [System.Diagnostics.Process]::new()\n'
        + '$process.StartInfo = $start\n'
        + '[void]$process.Start()\n'
        + '$stdout = $process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())\n'
        + '$stderr = $process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())\n'
        + '$process.WaitForExit()\n'
        + '[Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout, $stderr))\n'
        + 'exit $process.ExitCode';
      command = `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
    }
    return exec(connection, command, lenient);
  };
  return {
    run: (root, args) => run(root, args, false),
    runLenient: (root, args) => run(root, args, true),
    stat: (file) => stat(connection, file),
    readFile: async (file) => (await readFile(connection, file)).toString('utf8'),
    join: paths.join,
  };
}

async function ensureDirectory(connection, dir) {
  const sftp = await sftpFor(connection);
  try { await call(sftp, 'mkdir', dir); }
  catch (error) {
    try { if (isDir(await call(sftp, 'stat', dir))) return; } catch { /* original error below */ }
    throw error;
  }
}

export async function pasteImage(connection, bytes, ext) {
  const paths = pathsFor(connection);
  const base = paths.join(connection.home, '.mcfly');
  const dir = paths.join(base, 'tmp');
  await ensureDirectory(connection, base);
  await ensureDirectory(connection, dir);
  const file = paths.join(dir, `mcfly-paste-${Date.now()}-${randomUUID()}${ext}`);
  await call(await sftpFor(connection), 'writeFile', file, bytes);
  return file;
}
