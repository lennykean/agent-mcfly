import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isNotRepositoryError, status } from './git.js';

test('only a non-repository Git failure is treated as an empty pane', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcfly-nonrepo-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(() => status(root), isNotRepositoryError);
  assert.equal(isNotRepositoryError(new Error('fatal: detected dubious ownership in repository')), false);
});
