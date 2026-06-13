import { parse } from 'yaml';

interface JobDef {
  name?: unknown;
  uses?: unknown;
  needs?: unknown;
  if?: unknown;
  'runs-on'?: unknown;
  with?: unknown;
  'timeout-minutes'?: unknown;
}

/**
 * Conservative event-activity for a job, derived from its `if:` expression.
 * - 'all'    — no `if:`, no `github.event_name` mention, or a form the heuristic
 *              can't reason about (mixed ==/!=, exotic functions). Safe default.
 * - 'only'   — positive `github.event_name == 'X'` mentions: the job provably
 *              never runs for events outside the set (any non-event clauses are
 *              assumed true, which can only WIDEN activity within the set).
 * - 'except' — negative-only `github.event_name != 'Y'` mentions: treated as
 *              provably inactive for Y, active everywhere else.
 */
export type EventActivity =
  | { mode: 'all' }
  | { mode: 'only'; events: string[] }
  | { mode: 'except'; events: string[] };

export interface CiGraphNode {
  /** Needed node prefixes (same naming rules as `prefixes`). */
  needs: string[];
  /** Which workflow events the job can run for. */
  activity: EventActivity;
  /** Runner-pool label candidates from the job's `runs-on` (issue #34): raw
   *  strings for plain/array forms; for `${{ … && 'a' || 'b' }}` ternaries both
   *  branches are listed. Null when unknowable (no `runs-on`; reusable-workflow
   *  job without an outer label input) or on rows persisted before #34. */
  runsOn: string[] | null;
  /** Job-level `timeout-minutes` (issue #48 timeout lint). Null when absent
   *  (GitHub applies its 360-minute default at runtime — see
   *  GITHUB_DEFAULT_TIMEOUT_MINUTES in estimator/workflow-lint.ts), when set to
   *  an expression/non-positive value (unknowable from this parse), or on rows
   *  persisted before #48. */
  timeoutMinutes: number | null;
}

export interface CiGraph {
  /** Required-check name prefixes (the rollup job's needs-closure, BFS order). */
  prefixes: string[];
  /** Display-name-level nodes: node prefix → { needs, event activity }. */
  nodes: Map<string, CiGraphNode>;
  /** Workflow display name (YAML top-level `name:`, e.g. `CI`); null when absent.
   *  Used to scope the required population to checks from THIS workflow. */
  workflowName: string | null;
}

/** JSON-serializable CiGraph (the `nodes` Map flattened to a plain record) —
 *  the persisted last-known-good shape stored in the history `meta` table. */
export interface CiGraphJson {
  prefixes: string[];
  nodes: Record<string, CiGraphNode>;
  workflowName: string | null;
}

export function ciGraphToJson(g: CiGraph): CiGraphJson {
  return {
    prefixes: [...g.prefixes],
    nodes: Object.fromEntries(g.nodes),
    workflowName: g.workflowName,
  };
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string');

/** Valid persisted/derived timeoutMinutes: a finite positive number. */
const isTimeout = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0;

function isActivity(v: unknown): v is EventActivity {
  if (!v || typeof v !== 'object') return false;
  const a = v as { mode?: unknown; events?: unknown };
  if (a.mode === 'all') return true;
  return (a.mode === 'only' || a.mode === 'except') && isStringArray(a.events);
}

/** Decode a persisted CiGraphJson back into a CiGraph. Null when the value is
 *  not a structurally valid graph (corrupt/legacy row) — callers treat that as
 *  "nothing persisted" rather than restoring garbage. */
export function ciGraphFromJson(raw: unknown): CiGraph | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const g = raw as { prefixes?: unknown; nodes?: unknown; workflowName?: unknown };
  if (!isStringArray(g.prefixes)) return null;
  if (g.workflowName !== null && typeof g.workflowName !== 'string') return null;
  if (!g.nodes || typeof g.nodes !== 'object' || Array.isArray(g.nodes)) return null;
  const nodes = new Map<string, CiGraphNode>();
  for (const [prefix, node] of Object.entries(g.nodes)) {
    const n = node as { needs?: unknown; activity?: unknown; runsOn?: unknown;
      timeoutMinutes?: unknown } | null;
    if (!n || typeof n !== 'object' || !isStringArray(n.needs) || !isActivity(n.activity)) return null;
    // runsOn/timeoutMinutes are tolerant by design: rows persisted before
    // issues #34/#48 lack them, and a corrupt value must not reject an
    // otherwise-valid graph → null.
    const runsOn = isStringArray(n.runsOn) ? n.runsOn : null;
    const timeoutMinutes = isTimeout(n.timeoutMinutes) ? n.timeoutMinutes : null;
    nodes.set(prefix, { needs: n.needs, activity: n.activity, runsOn, timeoutMinutes });
  }
  return { prefixes: g.prefixes, nodes, workflowName: g.workflowName ?? null };
}

/** True unless `activity` PROVES the job never runs for `event`. */
export function activeForEvent(activity: EventActivity, event: string): boolean {
  if (activity.mode === 'only') return activity.events.includes(event);
  if (activity.mode === 'except') return !activity.events.includes(event);
  return true;
}

const ALL: EventActivity = { mode: 'all' };
const EVENT_MENTION = /github\.event_name\s*([!=]=)\s*['"]([^'"]+)['"]/g;

/**
 * Extract an event-activity predicate from a job's `if:` string.
 *
 * Heuristic (deliberately conservative — only prune what is provable):
 * - positive mentions `github.event_name == 'X'` → potentially-active set {X…}.
 *   Non-event clauses compounded with `&&`/`||` are assumed true; that can only
 *   make MORE of the expression true, never activate an event outside the set,
 *   so 'only' remains a sound proof of inactivity for the rest.
 * - negative mentions `github.event_name != 'Y'` count only when there are NO
 *   positive mentions → active for everything except {Y…}. (With an `||` of
 *   non-event clauses this can over-prune — see the caveat in `mode: 'except'` —
 *   but the observed pattern gates advisory jobs outside the rollup closure.)
 * - both kinds present, or `event_name` used in an unrecognized form → 'all'.
 */
function extractActivity(ifExpr: unknown): EventActivity {
  if (typeof ifExpr !== 'string' || !ifExpr.includes('github.event_name')) return ALL;
  const pos = new Set<string>();
  const neg = new Set<string>();
  for (const m of ifExpr.matchAll(EVENT_MENTION)) {
    (m[1] === '==' ? pos : neg).add(m[2]!);
  }
  if (pos.size > 0 && neg.size > 0) return ALL; // mixed — nothing provable
  if (pos.size > 0) return { mode: 'only', events: [...pos] };
  if (neg.size > 0) return { mode: 'except', events: [...neg] };
  return ALL;
}

/** Quoted branch values of a GitHub expression: in
 *  `x == 'merge_group' && 'pool-a' || 'pool-b'` only the strings FOLLOWING
 *  `&&`/`||` are result branches — condition literals (after `==`/`!=`) are not. */
const EXPR_BRANCH = /(?:&&|\|\|)\s*'([^']+)'/g;

/** Label candidates for one runs-on string: plain strings pass through raw;
 *  `${{ … }}` ternaries yield both branches; an expression with no extractable
 *  branches (e.g. `${{ matrix.os }}`) keeps the raw string so nothing is lost. */
function labelCandidates(raw: string): string[] {
  if (!raw.includes('${{')) return [raw];
  const out: string[] = [];
  for (const m of raw.matchAll(EXPR_BRANCH)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out.length ? out : [raw];
}

/** Candidates from a runs-on VALUE (string, array, or {group, labels} form). */
function runsOnCandidates(v: unknown): string[] | null {
  const out: string[] = [];
  const push = (raw: string) => {
    for (const c of labelCandidates(raw)) if (!out.includes(c)) out.push(c);
  };
  if (typeof v === 'string' && v) push(v);
  else if (Array.isArray(v)) {
    for (const e of v) if (typeof e === 'string' && e) push(e);
  } else if (v && typeof v === 'object') {
    const o = v as { group?: unknown; labels?: unknown };
    if (typeof o.group === 'string' && o.group) push(o.group);
    if (typeof o.labels === 'string' && o.labels) push(o.labels);
    if (Array.isArray(o.labels)) for (const e of o.labels) if (typeof e === 'string' && e) push(e);
  }
  return out.length ? out : null;
}

/** A job's runner-pool label candidates (issue #34). Reusable-workflow calls
 *  (`uses:`) carry no `runs-on` — the pool lives in the inner workflow and is
 *  unknowable from this parse → null, EXCEPT when the caller threads it via a
 *  conventional `with:` input (runs-on / runs_on / runner): outer-label fallback. */
function extractRunsOn(job: JobDef): string[] | null {
  if (typeof job.uses === 'string' && job.uses) {
    const w = job.with;
    if (w && typeof w === 'object' && !Array.isArray(w)) {
      for (const key of ['runs-on', 'runs_on', 'runner']) {
        const labels = runsOnCandidates((w as Record<string, unknown>)[key]);
        if (labels) return labels;
      }
    }
    return null;
  }
  return runsOnCandidates(job['runs-on']);
}

/** Union of two runsOn candidate lists (null = unknowable yields the other). */
function mergeRunsOn(a: string[] | null, b: string[] | null): string[] | null {
  if (!a) return b;
  if (!b) return a;
  return [...new Set([...a, ...b])];
}

/** A job's `timeout-minutes` when knowable: YAML numbers pass; expressions,
 *  strings, and non-positive values are unknowable from a static parse → null. */
function extractTimeout(job: JobDef): number | null {
  const t = job['timeout-minutes'];
  return isTimeout(t) ? t : null;
}

/** Two job keys sharing a display name keep the MINIMUM timeout — the stricter
 *  one cancels first, which is what the timeout lint must reason about.
 *  Null = unset yields the other (set beats unknown). */
function mergeTimeout(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

/** Union of two activities (two job keys sharing a display name → one node). */
function mergeActivity(a: EventActivity, b: EventActivity): EventActivity {
  if (a.mode === 'only' && b.mode === 'only') {
    return { mode: 'only', events: [...new Set([...a.events, ...b.events])] };
  }
  if (a.mode === 'except' && b.mode === 'except') {
    return { mode: 'except', events: a.events.filter((e) => b.events.includes(e)) };
  }
  return ALL; // any other mix: can't prove inactivity for anything
}

/**
 * Derive the required-check graph from a GitHub Actions workflow file by
 * walking the rollup job's `needs:` graph — one parse, two outputs.
 *
 * The watched repos gate merges on a single rollup job (`ci`) that `needs:`
 * every blocking job. A PR's blocking checks are therefore exactly the rollup
 * job plus its transitive needs-closure. For each job in the closure the check
 * name prefix is the job's display `name:` (falling back to the job key); jobs
 * that call a reusable workflow (`uses:`) render their checks as
 * `<name> / <inner job>`, so those prefixes get a ` /` suffix to avoid
 * accidentally matching unrelated checks that share the bare name.
 *
 * `nodes` maps each closure node's prefix to the prefixes of the jobs it
 * `needs:` (same naming rules) plus an event-activity predicate parsed from the
 * job's `if:` — used to classify queued checks as waiting-for-runner vs
 * blocked-on-upstream, per event phase (PR CI vs merge_group). `prefixes` stays
 * event-agnostic (the union over all events), as before.
 *
 * Unparseable YAML returns `null` — derivation learned nothing, so callers keep
 * the richer config/derived-so-far/fallback prefixes. VALID yaml with a missing
 * `jobs:` map or missing rollup job degrades to the rollup-only graph (the
 * rollup check itself always exists, and nothing else gates the merge).
 * Cycle-safe via a visited set.
 */
export function deriveCiGraph(ciYamlText: string, rollupJobId = 'ci'): CiGraph | null {
  let doc: unknown;
  try {
    doc = parse(ciYamlText);
  } catch {
    return null;
  }
  const rawName = (doc as { name?: unknown } | null)?.name;
  const workflowName = typeof rawName === 'string' && rawName ? rawName : null;
  const jobs = (doc as { jobs?: unknown } | null)?.jobs;
  const rollupOnly = (): CiGraph =>
    ({ prefixes: [rollupJobId], nodes: new Map([[rollupJobId, { needs: [], activity: ALL, runsOn: null, timeoutMinutes: null }]]), workflowName });
  if (!jobs || typeof jobs !== 'object') return rollupOnly();
  const jobMap = jobs as Record<string, JobDef | null>;
  if (!(rollupJobId in jobMap)) return rollupOnly();

  const prefixOf = (jobKey: string): string => {
    const job = jobMap[jobKey] ?? {};
    const name = typeof job.name === 'string' && job.name ? job.name : jobKey;
    return typeof job.uses === 'string' && job.uses ? `${name} /` : name;
  };

  // BFS over needs, starting at the rollup job (included in the closure)
  const visited = new Set<string>([rollupJobId]);
  const queue = [rollupJobId];
  const prefixes: string[] = [];
  const nodes = new Map<string, CiGraphNode>();
  while (queue.length) {
    const jobKey = queue.shift()!;
    const job = jobMap[jobKey] ?? {};
    const prefix = prefixOf(jobKey);
    if (!prefixes.includes(prefix)) prefixes.push(prefix);
    const rawNeeds = typeof job.needs === 'string' ? [job.needs]
      : Array.isArray(job.needs) ? job.needs : [];
    const neededKeys = rawNeeds.filter((n): n is string => typeof n === 'string' && n in jobMap);
    // two job keys can share a display name — union their needs/activity under one node
    const existing = nodes.get(prefix);
    const neededPrefixes = existing?.needs ?? [];
    for (const k of neededKeys) {
      const np = prefixOf(k);
      if (!neededPrefixes.includes(np)) neededPrefixes.push(np);
    }
    const activity = extractActivity(job.if);
    const runsOn = extractRunsOn(job);
    const timeoutMinutes = extractTimeout(job);
    nodes.set(prefix, {
      needs: neededPrefixes,
      activity: existing ? mergeActivity(existing.activity, activity) : activity,
      runsOn: existing ? mergeRunsOn(existing.runsOn, runsOn) : runsOn,
      timeoutMinutes: existing ? mergeTimeout(existing.timeoutMinutes, timeoutMinutes) : timeoutMinutes,
    });
    for (const k of neededKeys) {
      if (visited.has(k)) continue;
      visited.add(k);
      queue.push(k);
    }
  }
  return { prefixes, nodes, workflowName };
}

/** Required-check name prefixes only (thin wrapper over deriveCiGraph). */
export function derivePrefixes(ciYamlText: string, rollupJobId = 'ci'): string[] | null {
  return deriveCiGraph(ciYamlText, rollupJobId)?.prefixes ?? null;
}

/** True when a workflow file's top-level `jobs:` map actually DEFINES `jobId`.
 *  (deriveCiGraph returns a rollup-only graph even when the job is absent, so it
 *  cannot answer this — discovery needs the stronger "is it really here" test.) */
export function fileDefinesJob(ciYamlText: string, jobId: string): boolean {
  let doc: unknown;
  try {
    doc = parse(ciYamlText);
  } catch {
    return false;
  }
  const jobs = (doc as { jobs?: unknown } | null)?.jobs;
  return !!jobs && typeof jobs === 'object' && jobId in (jobs as Record<string, unknown>);
}

/**
 * Auto-discover which workflow file owns the rollup job, so renaming the file
 * (e.g. `ci.yml` -> `main.yml`) needs no config edit as long as the rollup job
 * id is stable. Given candidate `{path, text}` files (caller supplies the
 * `.github/workflows/` listing), pick the FIRST that genuinely defines
 * `rollupJobId` and return its path + derived graph. Caller controls order;
 * pass the conventional file first to keep ties deterministic. Null when no
 * candidate defines the job (the rollup job itself was renamed — that still
 * needs a one-line `rollupJobId` in `.pr-dashboard.yml`).
 */
export function discoverRollupWorkflow(
  files: { path: string; text: string }[], rollupJobId = 'ci',
): { path: string; graph: CiGraph } | null {
  for (const f of files) {
    if (!fileDefinesJob(f.text, rollupJobId)) continue;
    const graph = deriveCiGraph(f.text, rollupJobId);
    if (graph) return { path: f.path, graph };
  }
  return null;
}
