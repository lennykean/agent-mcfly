import test from 'node:test';
import assert from 'node:assert/strict';
import { peerLabel, peerSession } from '../ui/src/lib/peer.js';

test('peer links use the target session and preserve local or remote identity', () => {
  const local = {
    id: 'pty-1', terminal_id: 'pty-1', tool: 'codex', cwd: 'C:\\launch',
    workspace: 'C:\\repo', title: 'Reviewer',
    session_id: 'rollout.jsonl', provider: 'codex',
  };
  assert.equal(peerLabel(local), 'Reviewer');
  assert.deepEqual(peerSession(local), {
    id: 'rollout.jsonl', provider: 'codex', project: 'C:\\repo', cwd: 'C:\\repo',
    label: 'Reviewer', updated_at: 0, size: 0,
  });
  assert.equal(peerSession({ ...local, id: 'remote-1:pty-1', connection: 'remote-1' })?.id, 'rollout.jsonl');
  assert.equal(peerSession({ ...local, session_id: null }), null);
  assert.equal(peerSession({ ...local, workspace: null }), null);
});
