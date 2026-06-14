import type { CheckRun } from './types';

export interface OidCheckSplit { mergeGroup: CheckRun[]; push: CheckRun[]; }

/**
 * Partition the checks attached to a single commit OID by their workflow-run
 * event. A merge-queue head OID becomes the squash-merged main commit, so it
 * carries BOTH the merge_group (queue build) and push (post-merge push:main)
 * suites. Queue-health consumers must see only merge_group; the main lane only
 * push. A re-queued train produces a second merge_group run at the same OID —
 * keep only the latest (max runDatabaseId) so a stale build can't skew stats.
 */
export function splitOidChecks(checks: CheckRun[]): OidCheckSplit {
  const push = checks.filter((c) => c.event === 'push');
  const mg = checks.filter((c) => c.event === 'merge_group');
  let maxRun: number | null = null;
  for (const c of mg) {
    if (c.runDatabaseId != null && (maxRun == null || c.runDatabaseId > maxRun)) maxRun = c.runDatabaseId;
  }
  const mergeGroup = maxRun == null ? mg : mg.filter((c) => c.runDatabaseId === maxRun);
  return { mergeGroup, push };
}
