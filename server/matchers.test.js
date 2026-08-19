import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseJsonTable, parseTable, parseTsv } from './mcfly-data.js';
import { matcherShape } from './matchers.js';

test('table formats parse to one shape, and reject what is not that format', () => {
  const table = { columns: ['name', 'count'], rows: [['alpha', '2'], ['beta', '3']] };
  assert.deepEqual(parseTsv('name\tcount\nalpha\t2\nbeta\t3\n'), table);
  assert.deepEqual(parseCsv('name,count\nalpha,2\nbeta,3\n'), table);
  assert.deepEqual(parseJsonTable('[{"name":"alpha","count":2},{"name":"beta","count":3}]'), table);
  assert.deepEqual(parseJsonTable(JSON.stringify({ columns: ['name', 'count'], rows: [['alpha', 2], ['beta', 3]] })), table);

  // csv quoting: delimiters, newlines and "" inside a quoted field
  assert.deepEqual(parseCsv('a,b\n"x, y","he said ""hi"""\n'), {
    columns: ['a', 'b'], rows: [['x, y', 'he said "hi"']],
  });
  assert.deepEqual(parseCsv('a,b\n"line\none",2\n'), { columns: ['a', 'b'], rows: [['line\none', '2']] });
  assert.equal(parseCsv('a,b\n"unterminated,2\n'), null);

  // json rows with differing keys: columns are the union, first seen first
  assert.deepEqual(parseJsonTable('[{"a":1},{"b":2,"a":3}]'), {
    columns: ['a', 'b'], rows: [['1', ''], ['3', '2']],
  });
  assert.equal(parseJsonTable('[1,2,3]'), null);
  assert.equal(parseJsonTable('not json'), null);

  // the format is declared, never sniffed: TSV read as CSV is one column
  assert.equal(parseTable('name\tcount\nalpha\t2\n', 'csv'), null);
  assert.equal(parseTable('name,count\nalpha,2\n', 'tsv'), null);
  assert.deepEqual(parseTable('name\tcount\nalpha\t2\n'), { columns: ['name', 'count'], rows: [['alpha', '2']] });

  // still a table only if it is rectangular, headed and at least two columns
  assert.equal(parseTsv('name\tcount\nalpha\n'), null);
  assert.equal(parseTsv('name\tname\na\tb\n'), null);
  assert.equal(parseTsv('only\n1\n'), null);
  assert.equal(parseCsv('name,count\n'), null);
});

test('matcher shape: keeps the targets given, drops the empty ones, defaults the rest', () => {
  const full = matcherShape({
    name: 'kube', tool: 'Bash', params: { command: 'kubectl get* -o json' },
    workspace: '/repo', session: 'proj/abc.jsonl', transform: 'return data.items;',
  });
  assert.equal(full.tool, 'Bash');
  assert.deepEqual(full.params, { command: 'kubectl get* -o json' });
  assert.equal(full.workspace, '/repo');
  assert.equal(full.session, 'proj/abc.jsonl');
  assert.equal(full.enabled, true);
  assert.match(full.id, /^[0-9a-f]{12}$/);

  // both targets optional: neither given is the global rule
  const global = matcherShape({ tool: 'mcp__github__*' });
  assert.equal(global.workspace, undefined);
  assert.equal(global.session, undefined);
  assert.equal(global.name, 'mcp__github__*'); // falls back to the pattern
  assert.equal(matcherShape({ tool: 'x', params: {} }).params, undefined);
  assert.equal(matcherShape({ tool: 'x', workspace: '   ' }).workspace, undefined);
  assert.equal(matcherShape({ tool: 'x', enabled: false }).enabled, false);
  assert.equal(matcherShape({ tool: 'x', id: 'keep-me' }).id, 'keep-me');
  assert.throws(() => matcherShape({ name: 'no tool' }), /tool pattern is required/);
});
