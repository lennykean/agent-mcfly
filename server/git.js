// Read-only git inspection for the GIT pane: status, log for the graph,
// worktrees, and per-file diffs. Everything shells out to the git CLI in the
// given root; nothing here mutates a repository.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const run = (root, args) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
    if (err) reject(err);
    else resolve(stdout);
  });
});

export const okRoot = (root) => {
  try { return fs.statSync(root).isDirectory(); } catch { return false; }
};

// porcelain v1 -z: "XY path\0" — renames add the original as a second record.
// -uall lists the files INSIDE untracked directories: without it git emits a
// bare "dir/" entry, which renders as a nameless row in the tree
export async function status(root) {
  const out = await run(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
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

export async function log(root, limit = 150, skip = 0) {
  // the ancestry of HEAD, like the VS Code graph: merged branches show as
  // converging lanes; branches that never contributed to HEAD stay out
  const fmt = '%H\x1f%P\x1f%an\x1f%ct\x1f%D\x1f%s';
  const out = await run(root, ['log', 'HEAD', '--topo-order', `-n${limit}`, `--skip=${skip}`, `--pretty=format:${fmt}`]);
  return out.split('\n').filter(Boolean).map((line) => {
    const [hash, parents, author, time, refs, subject] = line.split('\x1f');
    return {
      hash,
      parents: parents ? parents.split(' ') : [],
      author,
      time: Number(time) * 1000,
      refs: refs ? refs.split(', ').filter(Boolean) : [],
      subject: subject ?? '',
    };
  });
}

export async function worktrees(root) {
  const out = await run(root, ['worktree', 'list', '--porcelain']);
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

export async function diff(root, file, staged) {
  const args = staged ? ['diff', '--cached', '--', file] : ['diff', '--', file];
  const text = await run(root, args);
  if (!text.trim() && !staged) {
    // untracked: git has no diff — the whole file is an addition
    try {
      const content = fs.readFileSync(path.join(root, file), 'utf8');
      const lines = content.split(/\r?\n/);
      if (lines.at(-1) === '') lines.pop();
      return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => `+${l}`) }];
    } catch { return []; }
  }
  return parseUnified(text);
}
