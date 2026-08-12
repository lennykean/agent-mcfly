import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inferBashTool, scanHead } from './claude-code.js';

test('finds Claude titles written after the transcript head', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-'));
  const file = path.join(dir, 'session.jsonl');
  try {
    fs.writeFileSync(file, `${JSON.stringify({ type: 'user', cwd: '/repo' })}\n${'x'.repeat(20_000)}\n${JSON.stringify({ type: 'custom-title', customTitle: 'mr dev' })}\n`);
    assert.deepEqual(scanHead(file), { cwd: '/repo', title: 'mr dev' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('conservatively infers file operations from Claude Bash commands', () => {
  assert.equal(inferBashTool('cat "README.md"'), 'Read');
  assert.equal(inferBashTool("sed -n '10,30p' src/app.js"), 'Read');
  assert.equal(inferBashTool("echo 'hello' > hello.txt"), 'Write');
  assert.equal(inferBashTool("printf '%s' hello >> hello.txt"), 'Edit');
  assert.equal(inferBashTool("sed -i 's/old/new/' app.js"), 'Edit');
  assert.equal(inferBashTool("cat > config.ini <<'EOF'\nvalue=1\nEOF"), 'Write');
  assert.equal(inferBashTool('rg needle src'), null);
  assert.equal(inferBashTool('ls -la'), null);
  assert.equal(inferBashTool('cat README.md | head'), null);
  assert.equal(inferBashTool("echo 'not > a write'"), null);
  assert.equal(inferBashTool('cat --help'), null);
  assert.equal(inferBashTool('echo done > /dev/null'), null);
});
