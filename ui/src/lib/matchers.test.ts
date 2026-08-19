import test from 'node:test';
import assert from 'node:assert/strict';
import { matchTool, scopedMatchers, type DataMatcher } from './matchers.ts';

const m = (over: Partial<DataMatcher>): DataMatcher => ({ id: over.tool ?? 'x', name: 'n', tool: '*', ...over });

test('matcher globs: tool name patterns, and params that must all match', () => {
  const byName = [m({ tool: 'mcp__github__*' })];
  assert.ok(matchTool(byName, 'mcp__github__list_issues', {}));
  assert.ok(!matchTool(byName, 'mcp__gitlab__list_issues', {}));
  assert.ok(matchTool([m({ tool: 'bash' })], 'Bash', {})); // names match case-insensitively

  // a glob is a glob, not a regex: dots are literal
  assert.ok(!matchTool([m({ tool: 'a.c' })], 'abc', {}));
  assert.ok(matchTool([m({ tool: 'a.c' })], 'a.c', {}));

  const withParams = [m({ tool: 'Bash', params: { command: 'kubectl get* -o json' } })];
  assert.ok(matchTool(withParams, 'Bash', { command: 'kubectl get pods -o json' }));
  assert.ok(!matchTool(withParams, 'Bash', { command: 'kubectl delete pod x' }));
  assert.ok(!matchTool(withParams, 'Bash', {})); // a param the call never sent cannot match
  assert.ok(!matchTool(withParams, 'Bash', undefined));

  // every listed param must match, and non-strings compare as text
  const two = [m({ tool: '*', params: { a: '1*', b: 'yes' } })];
  assert.ok(matchTool(two, 'T', { a: 123, b: 'yes' }));
  assert.ok(!matchTool(two, 'T', { a: 123, b: 'no' }));
  assert.ok(matchTool([m({ tool: '*', params: { o: '*"k":1*' } })], 'T', { o: { k: 1 } }));
});

test('matcher scope: both targets optional, most specific wins', () => {
  const all: DataMatcher[] = [
    m({ id: 'global', tool: 'Bash' }),
    m({ id: 'ws', tool: 'Bash', workspace: '/repo' }),
    m({ id: 'sess', tool: 'Bash', session: 'proj/a.jsonl' }),
    m({ id: 'other', tool: 'Bash', workspace: '/elsewhere' }),
    m({ id: 'off', tool: 'Bash', enabled: false }),
  ];

  // neither target set = everywhere
  const nowhere = scopedMatchers(all, undefined, undefined);
  assert.deepEqual(nowhere.map((x) => x.id), ['global']);

  // a workspace target covers the project and anything under it
  const inRepo = scopedMatchers(all, '/repo/pkg/sub', 'proj/b.jsonl');
  assert.deepEqual(inRepo.map((x) => x.id).sort(), ['global', 'ws']);
  assert.equal(matchTool(inRepo, 'Bash', {})?.id, 'ws'); // beats the global rule

  // ...but not a sibling that merely shares a prefix
  assert.deepEqual(scopedMatchers([m({ id: 'ws', tool: 'B', workspace: '/repo' })], '/repo-old').map((x) => x.id), []);

  const inSession = scopedMatchers(all, '/repo', 'proj/a.jsonl');
  assert.equal(matchTool(inSession, 'Bash', {})?.id, 'sess'); // session beats workspace

  // separators and case do not decide scope on Windows paths
  assert.equal(scopedMatchers([m({ id: 'w', tool: 'B', workspace: 'C:\\Repo' })], 'c:/repo/sub').length, 1);
  assert.equal(matchTool([], 'Bash', {}), undefined);
});
