import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DATA_MARKER, dataEnvelope, highlightResult, parseLineSpec, parseTsv } from './mcfly-data.js';

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
    {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'highlight', arguments: { path: 'package.json', lines: '2,4-5' } },
    },
    {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'highlight', arguments: { path: 'package.json', lines: 'nope' } },
    },
    {
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'waypoint', arguments: { path: 'package.json', line: 2, note: 'the package name' } },
    },
    {
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'waypoint_remove', arguments: { path: 'package.json', line: 2 } },
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

  assert.equal(responses[1].result.tools[1].name, 'highlight');
  const hl = responses[3].result;
  assert.equal(hl.isError, undefined);
  assert.equal(hl.structuredContent.kind, 'file');
  assert.deepEqual(hl.structuredContent.highlights, [{ start: 2, end: 2 }, { start: 4, end: 5 }]);
  assert.match(hl.structuredContent.content, /agent-mcfly/);
  // bare envelope (structuredContent serialization, no marker) still renders
  const render = highlightResult(JSON.stringify(hl.structuredContent));
  assert.equal(render.verb, 'read_file');
  assert.deepEqual(render.region, { start: 2, end: 2 });
  assert.equal(render.highlights.length, 2);
  assert.equal(responses[4].result.isError, true);

  const wp = responses[5].result.structuredContent;
  assert.equal(wp.kind, 'waypoint');
  assert.match(wp.anchor, /agent-mcfly/);
  assert.equal(wp.before.length, 1); // line 2: only line 1 above
  assert.equal(wp.after.length, 3);

  const rm = responses[6].result.structuredContent;
  assert.equal(rm.kind, 'waypoint_remove');
  assert.equal(rm.line, 2);
  assert.equal(rm.path, wp.path);
});

test('parses line specs strictly', () => {
  assert.deepEqual(parseLineSpec('12,40-45'), [{ start: 12, end: 12 }, { start: 40, end: 45 }]);
  assert.deepEqual(parseLineSpec(['3', '1-2']), [{ start: 1, end: 2 }, { start: 3, end: 3 }]);
  assert.equal(parseLineSpec('5-2'), null);
  assert.equal(parseLineSpec('a,b'), null);
  assert.equal(parseLineSpec(''), null);
});
