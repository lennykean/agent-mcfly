// Data-tool matchers: rules that claim ANOTHER tool's result and send it to
// the DATA tab as JSON, so an agent that already emits structured output does
// not have to re-run it through run_table.
//
// Storage is one file beside settings.json. Scope is expressed by two optional
// targets: a matcher with neither is global, one with a workspace applies in
// that project (and below it), one with a session applies to that transcript
// only. Matching itself happens in the UI — it has the tool name, the params
// and the result already, so a new matcher re-renders history immediately
// instead of waiting for a re-read.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = path.join(os.homedir(), '.mcfly', 'data-matchers.json');
const MAX_TRANSFORM = 16 * 1024;

const clean = (value, max = 512) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);

export function listMatchers() {
  try {
    const all = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(all) ? all.filter((m) => m && typeof m.tool === 'string') : [];
  } catch { return []; }
}

function writeAll(all) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, `${JSON.stringify(all, null, 1)}\n`);
  return all;
}

// The params predicate is a flat map of param name -> glob. Values are
// stringified before matching, so it works on numbers and nested objects too.
function cleanParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    const pattern = clean(String(value ?? ''));
    if (clean(key) && pattern) out[key] = pattern;
  }
  return Object.keys(out).length ? out : undefined;
}

export function matcherShape(input = {}) {
  const tool = clean(input.tool);
  if (!tool) throw Object.assign(new Error('tool pattern is required'), { status: 400 });
  const params = cleanParams(input.params);
  const workspace = clean(input.workspace, 4096);
  const session = clean(input.session, 1024);
  const transform = clean(input.transform, MAX_TRANSFORM);
  return {
    id: clean(input.id) ?? crypto.randomBytes(6).toString('hex'),
    name: clean(input.name) ?? tool,
    tool,
    ...(params ? { params } : {}),
    ...(workspace ? { workspace } : {}),
    ...(session ? { session } : {}),
    ...(transform ? { transform } : {}),
    enabled: input.enabled !== false,
  };
}

export function saveMatcher(input) {
  const matcher = matcherShape(input);
  const all = listMatchers();
  const at = all.findIndex((m) => m.id === matcher.id);
  if (at >= 0) all[at] = matcher;
  else all.push(matcher);
  writeAll(all);
  return matcher;
}

export function removeMatcher(id) {
  const all = listMatchers();
  const next = all.filter((m) => m.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}

// Wholesale replace, for the settings tab editing the list as one document.
export function replaceMatchers(input) {
  if (!Array.isArray(input)) throw Object.assign(new Error('expected a list of matchers'), { status: 400 });
  const seen = new Set();
  const all = [];
  for (const item of input) {
    let matcher;
    try { matcher = matcherShape(item); } catch { continue; } // skip the unusable, keep the rest
    if (seen.has(matcher.id)) continue;
    seen.add(matcher.id);
    all.push(matcher);
  }
  return writeAll(all);
}
