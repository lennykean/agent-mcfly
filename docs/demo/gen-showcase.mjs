import fs from 'node:fs';

const cwd = 'C:\\Users\\Lenny\\git\\mcfly';
const retryPath = 'C:\\Users\\Lenny\\git\\mcfly\\docs\\demo\\retry.js';

const V0 = `// Fetch with retries for flaky networks.
const DEFAULT_RETRIES = 3;
const BASE_DELAY_MS = 250;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(url, options = {}) {
  const retries = options.retries ?? DEFAULT_RETRIES;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) throw new Error(\`status \${res.status}\`);
      return res;
    } catch (error) {
      lastError = error;
      await sleep(BASE_DELAY_MS * attempt);
    }
  }
  throw lastError;
}
`;

const V1 = V0.replace(
  '      if (!res.ok) throw new Error(`status ${res.status}`);\n',
  '      if (res.status >= 500) throw new Error(`status ${res.status}`);\n      if (!res.ok) return res; // client errors are not retryable\n',
);
const V2 = V1.replace(
  '      await sleep(BASE_DELAY_MS * attempt);\n',
  '      await sleep(BASE_DELAY_MS * 2 ** attempt + Math.random() * 100);\n',
);

// the file on disk = final state, so waypoints resolve against it
fs.mkdirSync('C:/Users/Lenny/git/mcfly/docs/demo', { recursive: true });
fs.writeFileSync('C:/Users/Lenny/git/mcfly/docs/demo/retry.js', V2);

const H1 = [{
  oldStart: 14, oldLines: 3, newStart: 14, newLines: 4,
  lines: [
    '       const res = await fetch(url, options);',
    '-      if (!res.ok) throw new Error(`status ${res.status}`);',
    '+      if (res.status >= 500) throw new Error(`status ${res.status}`);',
    '+      if (!res.ok) return res; // client errors are not retryable',
    '       return res;',
  ],
}];
const H2 = [{
  oldStart: 20, oldLines: 2, newStart: 20, newLines: 2,
  lines: [
    '       lastError = error;',
    '-      await sleep(BASE_DELAY_MS * attempt);',
    '+      await sleep(BASE_DELAY_MS * 2 ** attempt + Math.random() * 100);',
  ],
}];

const v2lines = V2.split('\n');
const wp = (line, note) => ({
  schema: 'mcfly.data.v1', kind: 'waypoint', path: retryPath, line, note,
  before: v2lines.slice(Math.max(0, line - 4), line - 1),
  anchor: v2lines[line - 1],
  after: v2lines.slice(line, line + 3),
});
const wp1 = wp(16, '**Retry policy.** Client errors (4xx) return to the caller unchanged — only 5xx and network failures retry. Retrying a 404 four times just makes the outage slower.');
const wp2 = wp(21, '**Backoff.** Exponential with 0-100ms of jitter so a fleet of clients does not stampede the server in lockstep. Attempt 0 retries immediately by design.');

const table = {
  schema: 'mcfly.data.v1', kind: 'table',
  command: 'node --test docs/demo | ./tap-to-tsv.sh', cwd, exitCode: 0,
  stdout: 'test\tresult\tduration\nreturns 2xx immediately\tpass\t12ms\ndoes not retry 404\tpass\t9ms\nretries 503 three times\tpass\t1408ms\nretries network failure\tpass\t1371ms\nbackoff includes jitter\tpass\t2204ms\n',
  stderr: '',
  data: {
    columns: ['test', 'result', 'duration'],
    rows: [
      ['returns 2xx immediately', 'pass', '12ms'],
      ['does not retry 404', 'pass', '9ms'],
      ['retries 503 three times', 'pass', '1408ms'],
      ['retries network failure', 'pass', '1371ms'],
      ['backoff includes jitter', 'pass', '2204ms'],
    ],
  },
};

let n = 0;
const t = () => new Date(Date.parse('2026-08-13T16:00:00Z') + (n += 25_000)).toISOString();
const asst = (content) => ({ type: 'assistant', uuid: `a${n}`, timestamp: t(), cwd, message: { role: 'assistant', content } });
const result = (id, content, toolUseResult) => ({ type: 'user', uuid: `u${n}`, timestamp: t(), cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, ...(toolUseResult ? { toolUseResult } : {}) });

const out = [
  { type: 'user', uuid: 'u0', timestamp: t(), cwd, message: { role: 'user', content: 'the retry helper hammers the API when things go wrong. audit it, fix what you find, and leave waypoints on anything future readers should know.' } },
  asst([{ type: 'text', text: "Reading the helper first — retry loops usually hide their sins in the error branch." }, { type: 'tool_use', id: 's1', name: 'Read', input: { file_path: retryPath } }]),
  result('s1', 'ok', { file: { filePath: retryPath, content: V0, numLines: 23, startLine: 1, totalLines: 23 } }),
  asst([{ type: 'text', text: 'Found two problems. First: it retries every non-2xx response, including 4xx — a 404 gets retried four times. Client errors are not transient; only 5xx and network failures deserve retries.' }, { type: 'tool_use', id: 's2', name: 'Edit', input: { file_path: retryPath, old_string: 'if (!res.ok) throw', new_string: 'if (res.status >= 500) throw' } }]),
  result('s2', 'ok', { filePath: retryPath, oldString: 'x', newString: 'y', originalFile: V0, structuredPatch: H1 }),
  asst([{ type: 'tool_use', id: 's4a', name: 'Bash', input: { command: 'node --test docs/demo', description: 'Run the retry suite' } }]),
  result('s4a', 'ok', {
    stdout: 'ok 1 - returns 2xx immediately\nok 2 - does not retry 404\nok 3 - retries 503 three times\nok 4 - retries network failure\ntests 5\npass 4\nfail 1\n',
    stderr: 'not ok 5 - backoff includes jitter\n  expected delays to differ between clients, got identical sequences\n',
  }),
  asst([{ type: 'text', text: 'The suite caught the second problem: the jitter test fails because the backoff is linear and identical for every client. Under a real outage, a fleet of these will synchronize and stampede the server the moment it recovers. Switching to exponential backoff with jitter.' }, { type: 'tool_use', id: 's3', name: 'Edit', input: { file_path: retryPath, old_string: 'BASE_DELAY_MS * attempt', new_string: 'BASE_DELAY_MS * 2 ** attempt + jitter' } }]),
  result('s3', 'ok', { filePath: retryPath, oldString: 'x', newString: 'y', originalFile: V1, structuredPatch: H2 }),
  asst([{ type: 'tool_use', id: 's4', name: 'Bash', input: { command: 'node --test docs/demo', description: 'Run the retry suite again' } }]),
  result('s4', 'ok', { stdout: 'ok 1 - returns 2xx immediately\nok 2 - does not retry 404\nok 3 - retries 503 three times\nok 4 - retries network failure\nok 5 - backoff includes jitter\ntests 5\npass 5\nfail 0\n', stderr: '' }),
  asst([{ type: 'tool_use', id: 's5', name: 'mcp__mcfly__run_table', input: { script: 'node --test docs/demo | ./tap-to-tsv.sh', title: 'retry suite results' } }]),
  result('s5', [{ type: 'text', text: JSON.stringify(table) }]),
  asst([{ type: 'tool_use', id: 's6', name: 'mcp__mcfly__waypoint', input: { path: retryPath, line: 16, note: wp1.note } }]),
  result('s6', [{ type: 'text', text: JSON.stringify(wp1) }]),
  asst([{ type: 'tool_use', id: 's7', name: 'mcp__mcfly__waypoint', input: { path: retryPath, line: 21, note: wp2.note } }]),
  result('s7', [{ type: 'text', text: JSON.stringify(wp2) }]),
  asst([{ type: 'text', text: 'Done. Both fixes are in, all five tests pass, and the two waypoints explain the retry policy and the backoff for whoever touches this next.' }]),
];
fs.writeFileSync('C:/Users/Lenny/.claude/projects/C--Users-Lenny-git-mcfly/showcase.jsonl', out.map((l) => JSON.stringify(l)).join('\n') + '\n');
console.log('showcase written, retry.js on disk =', V2.length, 'chars');
