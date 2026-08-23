import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { DATA_MARKER, dataEnvelope, highlightResult, parseLineSpec, parseTsv } from './mcfly-data.js';
import { checklistFiles, findWorkspaceState, runListPeers, runSendMessage } from './mcp.js';

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
  // the server answers concurrently, so responses arrive by id, not in order
  const byId = new Map(child.stdout.trim().split('\n').map(JSON.parse).map((r) => [r.id, r]));
  assert.equal(byId.size, requests.length);
  const responses = requests.map((r) => byId.get(r.id));
  assert.equal(responses[0].result.serverInfo.name, 'mcfly');
  assert.equal(responses[1].result.tools[0].name, 'run_table');
  assert.deepEqual(responses[1].result.tools.slice(-2).map((tool) => tool.name), ['list_peers', 'send_message']);
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

test('workspace routing skips unrelated server scopes', async () => {
  const project = path.join(process.cwd(), 'repo');
  const wrongScope = `${project}-old`;
  const host = async (scope, marker) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ scope, snapshot: { marker }, events: [] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server;
  };
  const wrong = await host(wrongScope, 'wrong');
  const right = await host(project, 'right');
  const root = await host('/', 'root');
  try {
    const servers = [
      { port: wrong.address().port, pwd: wrongScope, started: 2 },
      { port: right.address().port, pwd: project, started: 1 },
    ];
    const found = await findWorkspaceState(servers, project);
    assert.equal(found.pick.port, right.address().port);
    assert.equal(found.data.snapshot.marker, 'right');
    assert.equal(await findWorkspaceState([servers[0]], project), null);
    const rooted = await findWorkspaceState([{ port: root.address().port, pwd: '/', started: 1 }], '/repo/child');
    assert.equal(rooted.data.snapshot.marker, 'root');
  } finally {
    await Promise.all([wrong, right, root].map((server) => new Promise((resolve) => server.close(resolve))));
  }
});

test('lists live peers and sends a complete message through the workspace server', async () => {
  let received;
  const peer = { id: 'peer-1', terminal_id: 'term-1', messageable: true, interactive: false };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/peers') return res.end(JSON.stringify([peer]));
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received = JSON.parse(body);
      res.end(JSON.stringify({ id: received.id, delivered: true, bracketed: true, peer }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const servers = [{ port: server.address().port, pwd: process.cwd(), started: 1 }];
    const listed = await runListPeers({}, servers);
    assert.deepEqual(listed.structuredContent.peers, [peer]);
    const sent = await runSendMessage({ id: peer.id, message: 'hello\npeer' }, servers);
    assert.deepEqual(received, { id: peer.id, message: 'hello\npeer' });
    assert.equal(sent.structuredContent.peer.terminal_id, 'term-1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('checklist review state requires the current file signature', () => {
  const files = [{ status: 'M', path: 'same.js', sig: 'M:10:2' }, { status: 'M', path: 'changed.js', sig: 'M:20:3' }];
  assert.deepEqual(checklistFiles(files, { 'same.js': 'M:10:2', 'changed.js': 'M:19:1' }), [
    { status: 'M', path: 'same.js', reviewed: true },
    { status: 'M', path: 'changed.js', reviewed: false },
  ]);
});
