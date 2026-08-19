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
const dirFor = (pwd, origin) => path.join(ROOT, origin
  ? crypto.createHash('sha256').update(origin).digest('hex')
  : slug(pwd));
const projectId = (pwd) => {
  const resolved = path.resolve(String(pwd));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

function readAll(pwd, origin) {
  try {
    const project = projectId(pwd);
    const dir = dirFor(pwd, origin); // hashing the origin once, not once per file
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
      .filter((review) => review && (origin ? review.origin === origin : !review.origin && projectId(review.project) === project))
      .sort((a, b) => b.created - a.created);
  } catch { return []; }
}

function save(pwd, review, origin) {
  if (origin) review.origin = origin;
  fs.mkdirSync(dirFor(pwd, origin), { recursive: true });
  fs.writeFileSync(path.join(dirFor(pwd, origin), `${review.id}.json`), JSON.stringify(review, null, 1));
  return review;
}

export function listReviews(pwd, origin) {
  return readAll(pwd, origin);
}

export function createReview(pwd, session, origin) {
  const open = readAll(pwd, origin).find((r) => r.status === 'open'
    && r.session?.provider === session?.provider && r.session?.id === session?.id);
  if (open) return open; // one open review per session
  return save(pwd, {
    id: crypto.randomBytes(6).toString('hex'),
    project: pwd,
    session: session ?? null,
    status: 'open',
    created: Date.now(),
    comments: [],
  }, origin);
}

function mutate(pwd, id, fn, origin, from) {
  const review = (from ?? readAll(pwd, origin)).find((r) => r.id === id);
  if (!review) return null;
  fn(review);
  return save(pwd, review, origin);
}

export function closeReview(pwd, id, origin) {
  return mutate(pwd, id, (r) => { r.status = 'closed'; r.closed = Date.now(); }, origin);
}

export function addComment(pwd, id, comment, origin) {
  return mutate(pwd, id, (r) => {
    // the caller supplies the anchor and body; identity, authorship and
    // thread state are the server's to set, so they go LAST
    r.comments.push({
      ...comment,
      id: crypto.randomBytes(6).toString('hex'),
      author: 'human',
      ts: Date.now(),
      state: 'open', // open -> addressed (agent) -> resolved (human)
      replies: [],
    });
  }, origin);
}

export function addReply(pwd, commentId, body, author, addressed, origin) {
  const all = readAll(pwd, origin);
  const review = all.find((r) => r.comments.some((c) => c.id === commentId));
  if (!review) return null;
  return mutate(pwd, review.id, (r) => {
    const c = r.comments.find((x) => x.id === commentId);
    c.replies.push({ author, body, ts: Date.now() });
    if (addressed && c.state === 'open') c.state = 'addressed';
  }, origin, all);
}

// the review checklist: a base ref plus per-path check signatures. Setting
// a new base clears the ticks; base: null removes the checklist.
export function setChecklist(pwd, id, patch, origin) {
  return mutate(pwd, id, (r) => {
    if (patch.base === null) { delete r.checklist; return; }
    r.checklist = { ...(r.checklist ?? {}), ...patch };
    if (patch.base !== undefined && patch.checked === undefined) r.checklist.checked = {};
  }, origin);
}

export function setThreadState(pwd, id, commentId, state, origin) {
  if (!['open', 'addressed', 'resolved'].includes(state)) return null;
  return mutate(pwd, id, (r) => {
    const c = r.comments.find((x) => x.id === commentId);
    if (c) c.state = state;
  }, origin);
}
