import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('lossy slug collisions stay isolated by persisted project', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-review-test-'));
  const oldHome = process.env.HOME;
  const oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const review = await import(`./review.js?isolated=${Date.now()}`);
    const a = path.join(home, 'foo-bar');
    const b = path.join(home, 'foo', 'bar');
    const aReview = review.createReview(a, { provider: 'codex', id: 'a' });
    const bReview = review.createReview(b, { provider: 'codex', id: 'b' });

    assert.deepEqual(review.listReviews(a).map((r) => r.id), [aReview.id]);
    assert.deepEqual(review.listReviews(b).map((r) => r.id), [bReview.id]);
    assert.equal(review.closeReview(b, aReview.id), null);
    assert.equal(review.listReviews(a)[0].status, 'open');
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
    const resolved = path.resolve(home);
    if (resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) fs.rmSync(resolved, { recursive: true, force: true });
  }
});
