import type { CheckRun } from './types';

export function canonicalizeCheckName(raw: string): string {
  return raw
    .replace(/\$\{\{[^}]*\}\}/g, 'shard')
    .replace(/\(\s*(?:\d+|shard)\s*\/\s*(\d+)\s*\)/g, '(shard/$1)')
    .trim();
}

/**
 * Drop checks from SUPERSEDED workflow runs before per-name dedupe. GitHub can
 * surface checks from more than one run of the same workflow on a commit (a
 * re-trigger, or a concurrency-cancel + restart): #9681 had CI run #9106 whose
 * `ci` rollup fast-FAILED, plus the live run #9107 still in progress that hadn't
 * produced `ci` yet. Per-name dedupe (`latestRunMembers`) can't fix this — the
 * only `ci` member is the stale failed one, so it survives and the PR reads
 * CI-failed while GitHub's own rollup is PENDING. Fix: within each
 * (workflowName, event) group keep only the latest run (max runNumber) and drop
 * EVERY check from older runs, even names the latest run hasn't produced yet.
 * Only checks with real identity (non-null workflowName AND runNumber)
 * participate — legacy/StatusContext checks keep prior behavior so a null
 * group can't cross-supersede unrelated names.
 */
function dropSupersededRuns(checks: CheckRun[]): CheckRun[] {
  const maxRun = new Map<string, number>();
  for (const c of checks) {
    if (c.workflowName == null || c.runNumber == null) continue;
    const key = `${c.workflowName}::${c.event}`;
    const cur = maxRun.get(key);
    if (cur == null || c.runNumber > cur) maxRun.set(key, c.runNumber);
  }
  return checks.filter((c) => {
    if (c.workflowName == null || c.runNumber == null) return true;
    return c.runNumber === maxRun.get(`${c.workflowName}::${c.event}`);
  });
}

export function dedupeChecks(checks: CheckRun[]): CheckRun[] {
  const groups = new Map<string, CheckRun[]>();
  for (const c of dropSupersededRuns(checks)) {
    // workflowName in the key keeps same-named jobs in different workflows apart
    // (e.g. `ci-gate` in `Auto-merge PRs` vs anything in `CI`); null/'' groups
    // old data without workflow identity exactly as before.
    const key = `${c.workflowName ?? ''}::${c.name}::${c.event}`;
    const arr = groups.get(key);
    if (arr) arr.push(c);
    else groups.set(key, [c]);
  }
  return [...groups.values()].map((members) => aggregateFamily(latestRunMembers(members)));
}

/**
 * One canonical key can collect check runs from DIFFERENT workflow runs on the
 * same commit — re-triggers and queue-recover delete-and-recreate (2026-06-12
 * dispatch stall). Those are re-runs, not matrix shards: aggregating
 * min-start→max-finish across them fabricates a duration spanning the re-run
 * gap (a 20s job read as 51,027s — issue #61) and lets a stale conclusion
 * outrank the latest run's verdict. Keep only the latest run generation
 * (max runNumber). Members without run identity survive only when NO numbered
 * member exists (legacy/StatusContext-era data keeps the old behavior);
 * alongside numbered members they are unattributable and drop.
 */
function latestRunMembers(members: CheckRun[]): CheckRun[] {
  let max: number | null = null;
  for (const c of members) {
    if (c.runNumber != null && (max == null || c.runNumber > max)) max = c.runNumber;
  }
  if (max == null) return members;
  return members.filter((c) => c.runNumber === max);
}

// Conclusion severity for family aggregation: any failing member fails the
// family; SKIPPED never outranks a real result.
const CONCLUSION_SEVERITY: Record<string, number> = {
  FAILURE: 6, TIMED_OUT: 6, STARTUP_FAILURE: 6, ACTION_REQUIRED: 6,
  CANCELLED: 5, SUCCESS: 2, NEUTRAL: 1, SKIPPED: 0,
};

function worstConclusion(conclusions: (string | null)[]): string | null {
  let worst: string | null = null;
  for (const c of conclusions) {
    if (c == null) continue;
    if (worst == null || (CONCLUSION_SEVERITY[c] ?? 3) > (CONCLUSION_SEVERITY[worst] ?? 3)) worst = c;
  }
  return worst;
}

/**
 * Collapse a matrix-shard family (members sharing one canonical key) into a
 * single CheckRun that reflects the WHOLE family: earliest start, latest
 * finish (only once every member completed), worst conclusion, and
 * `shardCount`. Identity fields (rawName/url/isRequired/...) come from the
 * latest-started member. SKIPPED members are excluded from timing/status
 * aggregation — their placeholder timestamps are unreliable (observed
 * completedAt < startedAt in the wild).
 */
function aggregateFamily(members: CheckRun[]): CheckRun {
  let survivor = members[0];
  for (const c of members) {
    if ((c.startedAt ?? '') > (survivor.startedAt ?? '')) survivor = c;
  }
  if (members.length === 1) return { ...survivor, shardCount: 1 };

  const live = members.filter((c) => c.conclusion !== 'SKIPPED');
  const pool = live.length ? live : members;
  const started = pool.map((c) => c.startedAt).filter((s): s is string => s != null);
  const startedAt = started.length ? started.reduce((a, b) => (a < b ? a : b)) : null;
  const allCompleted = pool.every((c) => c.status === 'COMPLETED');
  const completedTimes = pool.map((c) => c.completedAt).filter((s): s is string => s != null);
  const completedAt = allCompleted && completedTimes.length === pool.length
    ? completedTimes.reduce((a, b) => (a > b ? a : b))
    : null;
  const status: CheckRun['status'] = allCompleted
    ? 'COMPLETED'
    : started.length ? 'IN_PROGRESS' : survivor.status;
  const conclusion = allCompleted ? worstConclusion(pool.map((c) => c.conclusion)) : null;
  // earliest workflow-run creation across members — the stall classifier (#39)
  // ages the RUN, so the family must not inherit a late shard's re-run time
  const createds = members.map((c) => c.runCreatedAt).filter((s): s is string => s != null);
  const runCreatedAt = createds.length ? createds.reduce((a, b) => (a < b ? a : b)) : null;
  return { ...survivor, startedAt, completedAt, status, conclusion, runCreatedAt, shardCount: members.length };
}

/**
 * Display name for a (possibly family-collapsed) check. A single check keeps
 * its raw name; a collapsed matrix family is labeled `... (8 shards)` using
 * the matrix denominator from the canonical name — the surviving member's raw
 * name (`Unit Tests (2/8)`) reads like a progress counter and must not show.
 */
export function familyDisplayName(c: CheckRun): string {
  const count = c.shardCount ?? 1;
  if (count <= 1) return c.rawName;
  const m = c.name.match(/\(shard\/(\d+)\)/);
  if (m) return c.name.replace(/\(shard\/(\d+)\)/, `(${m[1]} shards)`);
  return `${c.name} (${count}×)`;
}
