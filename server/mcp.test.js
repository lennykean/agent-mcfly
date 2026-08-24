import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { DATA_MARKER, dataEnvelope, highlightResult, parseLineSpec, parseTsv } from './mcfly-data.js';
import { checklistFiles, findWorkspaceState, runListAgentProviders, runListPeers, runPullInbox, runSendMessage, runSpawnAgent } from './mcp.js';

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
  assert.deepEqual(responses[1].result.tools.slice(-5).map((tool) => tool.name), [
    'list_agent_providers', 'spawn_agent', 'list_peers', 'send_message', 'pull_inbox',
  ]);
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

test('agent tools route through a workspace attached in the McFly UI', async () => {
  const project = path.join(process.cwd(), '..', 'attached-project');
  const providers = [{ harness: 'codex', available: true }];
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/api/workspace-state?')) {
      return res.end(JSON.stringify({ scope: project, snapshot: {}, events: [] }));
    }
    if (req.url === '/api/agent-providers') return res.end(JSON.stringify(providers));
    res.writeHead(404).end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const servers = [{ port: server.address().port, pwd: process.cwd(), started: 1, mcpToken: 'test-token' }];
    assert.deepEqual((await runListAgentProviders({ cwd: project }, servers)).structuredContent.providers, providers);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('lists live peers, relays messages, and explicitly queues inbox messages', async () => {
  const received = [];
  const inbox = [];
  const mcpToken = 'test-only-private-token';
  const peer = {
    id: 'peer-1', terminal_id: 'term-1', messageable: true, interactive: false,
    relay_enabled: true, session_available: true,
    provider: 'codex', session_id: 'session.jsonl', workspace: process.cwd(),
  };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/peers') return res.end(JSON.stringify([peer]));
    assert.equal(req.headers.authorization, `Bearer ${mcpToken}`);
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const value = JSON.parse(body);
      received.push(value);
      if (req.url === '/api/peer-inbox') {
        const messages = inbox.splice(0);
        return res.end(JSON.stringify({ id: value.id, messages, peer }));
      }
      if (value.inbox) {
        inbox.push({ id: 'message-1', message: value.message, queued_at: '2026-08-23T00:00:00.000Z' });
        return res.end(JSON.stringify({ id: value.id, delivered: false, queued: true, message_id: 'message-1', peer }));
      }
      res.end(JSON.stringify({ id: value.id, delivered: true, bracketed: true, peer }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const servers = [{ port: server.address().port, pwd: process.cwd(), started: 1, mcpToken }];
    const listed = await runListPeers({}, servers);
    assert.deepEqual(listed.structuredContent.peers, [peer]);
    const sent = await runSendMessage({ id: peer.id, message: 'hello\npeer' }, servers);
    assert.deepEqual(received[0], { id: peer.id, message: 'hello\npeer' });
    assert.equal(sent.structuredContent.peer.terminal_id, 'term-1');
    assert.equal(sent.structuredContent.peer.session_id, 'session.jsonl');
    assert.equal(sent.structuredContent.queued, false);
    const queued = await runSendMessage({ id: peer.id, message: 'later', inbox: true }, servers);
    assert.equal(queued.structuredContent.queued, true);
    assert.deepEqual(received[1], { id: peer.id, message: 'later', inbox: true });
    const pulled = await runPullInbox({ id: peer.id }, servers);
    assert.deepEqual(pulled.structuredContent.messages.map(({ message }) => message), ['later']);
    assert.deepEqual(received[2], { id: peer.id });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('discovers launch providers and returns stable spawned session metadata', async () => {
  const providers = [{ harness: 'codex', provider: 'codex', executable: 'codex', available: true, kinds: ['subagent', 'peer'] }];
  const mcpToken = 'test-only-private-token';
  let received;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    assert.equal(req.headers.authorization, `Bearer ${mcpToken}`);
    if (req.url === '/api/agent-providers') return res.end(JSON.stringify(providers));
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received = JSON.parse(body);
      res.end(JSON.stringify({
        kind: received.kind ?? 'subagent', harness: received.harness, provider: 'codex',
        session_id: 'stable.jsonl', workspace: process.cwd(),
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const servers = [{ port: server.address().port, pwd: process.cwd(), started: 1, mcpToken }];
    assert.deepEqual((await runListAgentProviders({}, servers)).structuredContent.providers, providers);
    const spawned = await runSpawnAgent({ harness: 'codex', prompt: 'audit', kind: 'subagent' }, servers);
    assert.deepEqual(received, { harness: 'codex', prompt: 'audit', kind: 'subagent', cwd: process.cwd() });
    assert.equal(spawned.structuredContent.kind, 'agent_spawn');
    assert.equal(spawned.structuredContent.session_id, 'stable.jsonl');
    assert.equal(spawned.structuredContent.provider, 'codex');
    assert.equal(JSON.stringify(spawned).includes(mcpToken), false);
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
