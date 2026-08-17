// Copies the showcase transcript into a session that `claude --resume` accepts,
// so a screenshot can show a terminal and the workbench on the same story.
// Run gen-showcase.mjs first. Prints the new session id.
import fs from 'node:fs';
import crypto from 'node:crypto';

const DIR = 'C:/Users/Lenny/.claude/projects/C--Users-Lenny-git-mcfly';
const CWD = 'C:\\Users\\Lenny\\git\\mcfly';
const MODEL = 'claude-opus-5';

// the CLI rejects a transcript from an older format, so take the version from a
// real session in the same project
const newest = fs.readdirSync(DIR).filter((f) => /^[0-9a-f-]{36}\.jsonl$/.test(f))
  .map((f) => ({ f, t: fs.statSync(`${DIR}/${f}`).mtimeMs })).sort((a, b) => b.t - a.t)[0].f;
const version = fs.readFileSync(`${DIR}/${newest}`, 'utf8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l)).find((e) => e.version)?.version;

const sessionId = crypto.randomUUID();
const base = { isSidechain: false, userType: 'external', cwd: CWD, sessionId, version, gitBranch: 'main' };
let parentUuid = null;
const out = fs.readFileSync(`${DIR}/showcase.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .map((e) => {
    const uuid = crypto.randomUUID();
    const asst = e.type === 'assistant';
    const entry = {
      parentUuid, ...base, type: e.type, uuid, timestamp: e.timestamp,
      message: asst
        ? {
          model: MODEL, id: `msg_${crypto.randomBytes(12).toString('hex')}`, type: 'message', role: 'assistant',
          content: e.message.content,
          stop_reason: e.message.content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn',
          stop_sequence: null, usage: { input_tokens: 4, output_tokens: 120, service_tier: 'standard' },
        }
        : e.message,
      ...(e.toolUseResult ? { toolUseResult: e.toolUseResult } : {}),
      ...(asst ? { requestId: `req_${crypto.randomBytes(10).toString('hex')}` } : {}),
    };
    parentUuid = uuid;
    return entry;
  });
out.push({ type: 'last-prompt', leafUuid: parentUuid, sessionId });
fs.writeFileSync(`${DIR}/${sessionId}.jsonl`, out.map((e) => JSON.stringify(e)).join('\n') + '\n');
console.log(sessionId);
