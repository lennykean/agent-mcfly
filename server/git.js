// Read-only git inspection for the GIT pane: status, log for the graph,
// worktrees, and per-file diffs. Everything shells out to the git CLI in the
// given root; nothing here mutates a repository.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const run = (root, args) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) reject(new Error(String(stderr || err.message).split('\n')[0]));
    else resolve(stdout);
  });
});

export const okRoot = (root) => {
  try { return fs.statSync(root).isDirectory(); } catch { return false; }
};

export const isNotRepositoryError = (error) =>
  /not a git repository/i.test(String(error?.stderr || error?.message || error));

// exit 1 with no output is git grep's "no matches" — an empty result;
// anything else (not a repo, git missing) must SURFACE, not silently read
// as no matches
const runLenient = (root, args) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err && err.code !== 1) reject(new Error(String(stderr || err.message).split('\n')[0]));
    else resolve(stdout);
  });
});

const localIo = {
  run,
  runLenient,
  stat: (file) => fs.promises.stat(file),
  readFile: (file) => fs.promises.readFile(file, 'utf8'),
  join: path.join,
};

// grep the work tree (tracked files) with an extended regex; smart case —
// an all-lowercase query matches case-insensitively, any capital goes exact
export async function grep(root, q, io = localIo) {
  const smart = /[A-Z]/.test(q) ? [] : ['-i'];
  const out = await io.runLenient(root, ['grep', '-n', '-I', '--no-color', '-E', ...smart, '--', q]);
  const hits = [];
  for (const l of out.split('\n')) {
    // CRLF work trees: the \r would block the $ anchor (JS "." skips \r)
    const m = l && l.replace(/\r$/, '').match(/^(.+?):(\d+):(.*)$/);
    if (m && hits.push({ path: m[1], line: Number(m[2]), text: m[3].slice(0, 400) }) >= 500) break;
  }
  return hits;
}

// ---- review checklist: what differs between a base ref and the work tree ----
// each file carries a cheap content signature (status:size:mtime) so a
// checked-off file that changes afterward can be auto-unchecked
export async function resolveRef(root, ref, io = localIo) {
  const out = await io.run(root, ['rev-parse', '--verify', '--short', `${ref}^{commit}`]);
  return out.trim();
}
export async function diffFiles(root, ref, io = localIo) {
  const out = await io.run(root, ['diff', '--name-status', '-M', ref, '--']);
  const files = out.split('\n').filter(Boolean).map((l) => {
    const parts = l.replace(/\r$/, '').split('\t');
    const status = (parts[0] ?? '?')[0];
    const p = (parts.length > 2 ? parts[2] : parts[1])?.replace(/\\/g, '/');
    return p ? { status, path: p } : null;
  }).filter(Boolean);
  return Promise.all(files.map(async ({ status, path: p }) => {
    let sig = `${status}:gone`;
    try {
      const s = await io.stat(io.join(root, p));
      sig = `${status}:${s.size}:${Math.round(s.mtimeMs)}`;
    } catch { /* deleted in the work tree */ }
    return { status, path: p, sig };
  }));
}
export async function diffAgainstRef(root, ref, file, io = localIo) {
  const out = await io.run(root, ['diff', ref, '--', file]);
  return parseUnified(out);
}

// find files by name substring, case-insensitive: tracked AND untracked
// (minus ignored) — a freshly created file must be findable
export async function listFiles(root, q, io = localIo) {
  const out = await io.runLenient(root, ['ls-files', '--cached', '--others', '--exclude-standard']);
  const needle = q.toLowerCase();
  // typed per keystroke over every tracked path, so stop at the cap instead of
  // lower-casing the whole repo first
  const hits = [];
  for (const p of out.split('\n')) {
    if (p && p.toLowerCase().includes(needle) && hits.push(p) >= 200) break;
  }
  return hits;
}

// porcelain v1 -z: "XY path\0" — renames add the original as a second record.
// -uall lists the files INSIDE untracked directories: without it git emits a
// bare "dir/" entry, which renders as a nameless row in the tree
export async function status(root, io = localIo) {
  const out = await io.run(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = out.split('\0').filter(Boolean);
  const staged = [];
  const changed = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const x = e[0];
    const y = e[1];
    const file = e.slice(3);
    if (x === 'R' || x === 'C') i++; // skip the rename origin record
    if (file.endsWith('/')) continue; // a bare directory entry has no diff to show
    if (x === '?') { changed.push({ path: file, status: 'U' }); continue; }
    if (x === '!') continue; // ignored
    if (x !== ' ') staged.push({ path: file, status: x });
    if (y !== ' ') changed.push({ path: file, status: y });
  }
  return { staged, changed };
}

export async function log(root, limit = 150, skip = 0, io = localIo) {
  // the ancestry of HEAD, like the VS Code graph: merged branches show as
  // converging lanes; branches that never contributed to HEAD stay out.
  // %B is the FULL message (multiline), so records split on \x1e, not lines.
  const fmt = '%x1e%H\x1f%P\x1f%an\x1f%ct\x1f%D\x1f%s\x1f%B';
  const out = await io.run(root, ['log', 'HEAD', '--topo-order', `-n${limit}`, `--skip=${skip}`, `--pretty=format:${fmt}`]);
  return out.split('\x1e').filter((r) => r.trim()).map((rec) => {
    const [hash, parents, author, time, refs, subject, body] = rec.split('\x1f');
    return {
      hash,
      parents: parents ? parents.split(' ') : [],
      author,
      time: Number(time) * 1000,
      refs: refs ? refs.split(', ').filter(Boolean) : [],
      subject: subject ?? '',
      body: (body ?? '').replace(/\r/g, '').trim(),
    };
  });
}

export async function worktrees(root, io = localIo) {
  const out = await io.run(root, ['worktree', 'list', '--porcelain']);
  const list = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9) }; list.push(cur); }
    else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (cur && line === 'bare') cur.bare = true;
    else if (cur && line === 'detached') cur.detached = true;
  }
  return list;
}

// unified diff -> the hunks shape DiffView renders: prefixed lines
export function parseUnified(text) {
  const hunks = [];
  let h = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      h = { oldStart: +m[1], oldLines: +(m[2] ?? 1), newStart: +m[3], newLines: +(m[4] ?? 1), lines: [] };
      hunks.push(h);
      continue;
    }
    if (!h) continue;
    if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) h.lines.push(line);
    else if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    else h = null; // a new file header ends the hunk run
  }
  return hunks;
}

export async function diff(root, file, staged, io = localIo) {
  const args = staged ? ['diff', '--cached', '--', file] : ['diff', '--', file];
  const text = await io.run(root, args);
  if (!text.trim() && !staged) {
    // untracked: git has no diff — the whole file is an addition
    try {
      const content = await io.readFile(io.join(root, file));
      const lines = content.split(/\r?\n/);
      if (lines.at(-1) === '') lines.pop();
      return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => `+${l}`) }];
    } catch { return []; }
  }
  return parseUnified(text);
}
