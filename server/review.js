// Human review storage: session-scoped threaded code reviews, stored as JSON
// under ~/.mcfly/reviews/<project-slug>/. The human comments from the UI;
// agents read and reply through the MCP. All mutations come through the
// server so the UI and the MCP never race on the files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.join(os.homedir(), '.mcfly', 'reviews');

const slug = (pwd) => String(pwd).replace(/[:\\/]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
const dirFor = (pwd) => path.join(ROOT, slug(pwd));

function readAll(pwd) {
  try {
    return fs.readdirSync(dirFor(pwd))
      .filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dirFor(pwd), f), 'utf8')); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => b.created - a.created);
  } catch { return []; }
}

function save(pwd, review) {
  fs.mkdirSync(dirFor(pwd), { recursive: true });
  fs.writeFileSync(path.join(dirFor(pwd), `${review.id}.json`), JSON.stringify(review, null, 1));
  return review;
}

export function listReviews(pwd) {
  return readAll(pwd);
}

export function createReview(pwd, session) {
  const open = readAll(pwd).find((r) => r.status === 'open'
    && r.session?.provider === session?.provider && r.session?.id === session?.id);
  if (open) return open; // one open review per session
  return save(pwd, {
    id: crypto.randomBytes(6).toString('hex'),
    project: pwd,
    session: session ?? null,
    status: 'open',
    created: Date.now(),
    comments: [],
  });
}

function mutate(pwd, id, fn) {
  const review = readAll(pwd).find((r) => r.id === id);
  if (!review) return null;
  fn(review);
  return save(pwd, review);
}

export function closeReview(pwd, id) {
  return mutate(pwd, id, (r) => { r.status = 'closed'; r.closed = Date.now(); });
}

export function addComment(pwd, id, comment) {
  return mutate(pwd, id, (r) => {
    r.comments.push({
      id: crypto.randomBytes(6).toString('hex'),
      author: 'human',
      ts: Date.now(),
      state: 'open', // open -> addressed (agent) -> resolved (human)
      replies: [],
      ...comment,
    });
  });
}

export function addReply(pwd, commentId, body, author, addressed) {
  const review = readAll(pwd).find((r) => r.comments.some((c) => c.id === commentId));
  if (!review) return null;
  return mutate(pwd, review.id, (r) => {
    const c = r.comments.find((x) => x.id === commentId);
    c.replies.push({ author, body, ts: Date.now() });
    if (addressed && c.state === 'open') c.state = 'addressed';
  });
}

// the review checklist: a base ref plus per-path check signatures. Setting
// a new base clears the ticks; base: null removes the checklist.
export function setChecklist(pwd, id, patch) {
  return mutate(pwd, id, (r) => {
    if (patch.base === null) { delete r.checklist; return; }
    r.checklist = { ...(r.checklist ?? {}), ...patch };
    if (patch.base !== undefined && patch.checked === undefined) r.checklist.checked = {};
  });
}

export function setThreadState(pwd, id, commentId, state) {
  if (!['open', 'addressed', 'resolved'].includes(state)) return null;
  return mutate(pwd, id, (r) => {
    const c = r.comments.find((x) => x.id === commentId);
    if (c) c.state = state;
  });
}
