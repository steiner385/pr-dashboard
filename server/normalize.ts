import type { CheckRun } from './types';

export function canonicalizeCheckName(raw: string): string {
  return raw
    .replace(/\$\{\{[^}]*\}\}/g, 'shard')
    .replace(/\(\s*(?:\d+|shard)\s*\/\s*(\d+)\s*\)/g, '(shard/$1)')
    .trim();
}

export function dedupeChecks(checks: CheckRun[]): CheckRun[] {
  const groups = new Map<string, CheckRun[]>();
  for (const c of checks) {
    // workflowName in the key keeps same-named jobs in different workflows apart
    // (e.g. `ci-gate` in `Auto-merge PRs` vs anything in `CI`); null/'' groups
    // old data without workflow identity exactly as before.
    const key = `${c.workflowName ?? ''}::${c.name}::${c.event}`;
    const arr = groups.get(key);
    if (arr) arr.push(c);
    else groups.set(key, [c]);
  }
  return [...groups.values()].map(aggregateFamily);
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
  return { ...survivor, startedAt, completedAt, status, conclusion, shardCount: members.length };
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
