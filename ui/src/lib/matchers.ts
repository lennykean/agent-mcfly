// Data-tool matchers: rules that claim another tool's result for the DATA tab.
// The rules live on the server; the MATCHING happens here, because the client
// already holds the tool name, the params and the result — so adding a rule
// re-renders history immediately instead of waiting for a re-read.

export interface DataMatcher {
  id: string;
  name: string;
  tool: string; // glob against the tool name
  params?: Record<string, string>; // param name -> glob, all must match
  workspace?: string; // applies to this project and below it
  session?: string; // applies to this transcript only
  transform?: string; // JS function body: (data) => value to render
  enabled?: boolean;
}

// Globs, not regexes: the patterns are typed by agents and humans, and `*` is
// what both reach for. Everything else is literal.
const globs = new Map<string, RegExp>();
function glob(pattern: string): RegExp {
  let re = globs.get(pattern);
  if (!re) {
    re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
    globs.set(pattern, re);
  }
  return re;
}

const normPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// A workspace target covers the project itself and anything under it.
const coversWorkspace = (target: string, pwd: string) => {
  const want = normPath(pwd);
  const have = normPath(target);
  return !!have && !!want && (want === have || want.startsWith(`${have}/`));
};

export function scopedMatchers(all: DataMatcher[], pwd?: string, session?: string): DataMatcher[] {
  return all.filter((m) => {
    if (m.enabled === false) return false;
    if (m.workspace && !(pwd && coversWorkspace(m.workspace, pwd))) return false;
    if (m.session && m.session !== session) return false;
    return true;
  });
}

// Params are compared as text so a glob works on numbers and nested objects
// alike; a param the call never sent cannot match.
function paramsMatch(matcher: DataMatcher, params: unknown): boolean {
  if (!matcher.params) return true;
  if (!params || typeof params !== 'object') return false;
  const bag = params as Record<string, unknown>;
  return Object.entries(matcher.params).every(([key, pattern]) => {
    const value = bag[key];
    if (value === undefined || value === null) return false;
    return glob(pattern).test(typeof value === 'object' ? JSON.stringify(value) : String(value));
  });
}

// Most specific wins: a session rule beats a workspace rule beats a global one.
const specificity = (m: DataMatcher) => (m.session ? 4 : 0) + (m.workspace ? 2 : 0) + (m.params ? 1 : 0);

export function matchTool(matchers: DataMatcher[], tool: string, params: unknown): DataMatcher | undefined {
  let best: DataMatcher | undefined;
  for (const m of matchers) {
    if (!glob(m.tool).test(tool) || !paramsMatch(m, params)) continue;
    if (!best || specificity(m) > specificity(best)) best = m;
  }
  return best;
}
