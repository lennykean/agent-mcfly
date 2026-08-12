import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DATA_MARKER, dataEnvelope, parseTsv } from './mcfly-data.js';

test('validates strict TSV and serves it through MCP stdio', () => {
  assert.deepEqual(parseTsv('name\tcount\nalpha\t2\n'), {
    columns: ['name', 'count'], rows: [['alpha', '2']],
  });
  assert.equal(parseTsv('name\tcount\nalpha\n'), null);

  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'run_table', arguments: { script: "printf 'name\\tcount\\nalpha\\t2\\n'" } },
    },
  ];
  const child = spawnSync(process.execPath, ['server/cli.js', 'mcp', 'start'], {
    cwd: process.cwd(), input: `${requests.map(JSON.stringify).join('\n')}\n`, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const responses = child.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(responses[0].result.serverInfo.name, 'mcfly');
  assert.equal(responses[1].result.tools[0].name, 'run_table');
  assert.equal(responses[2].result.isError, undefined);
  assert.deepEqual(responses[2].result.structuredContent.data, {
    columns: ['name', 'count'], rows: [['alpha', '2']],
  });
  assert.deepEqual(dataEnvelope(`${DATA_MARKER}\n${JSON.stringify(responses[2].result.structuredContent)}`), responses[2].result.structuredContent);
});
