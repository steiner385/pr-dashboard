// Cross-fleet failure clustering (spec 001, Group K3 / FR-038). Pure: scans the
// live state for the same check failing across multiple PRs — a signal that the
// failure is SYSTEMIC (a bad dep, infra, a broken main) rather than N independent
// per-PR problems. Lets the operator treat one incident instead of triaging N PRs.
import type { DashboardState } from '../../types';

const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'stale']);

export interface FailureCluster {
  check: string;
  prCount: number;
  prNumbers: number[];
  repos: string[];
}

/** Checks failing across ≥ minPrs distinct PRs, most-widespread first. */
export function clusterFailures(state: DashboardState, minPrs = 2): FailureCluster[] {
  const byCheck = new Map<string, { prs: Set<number>; repos: Set<string> }>();
  for (const repo of state.repos) {
    for (const pr of repo.prs) {
      for (const c of pr.checks) {
        if (c.conclusion == null || !FAILED.has(c.conclusion)) continue;
        let e = byCheck.get(c.name);
        if (!e) { e = { prs: new Set(), repos: new Set() }; byCheck.set(c.name, e); }
        e.prs.add(pr.number);
        e.repos.add(pr.repo);
      }
    }
  }
  return [...byCheck.entries()]
    .filter(([, e]) => e.prs.size >= minPrs)
    .map(([check, e]) => ({ check, prCount: e.prs.size, prNumbers: [...e.prs].sort((a, b) => a - b), repos: [...e.repos].sort() }))
    .sort((a, b) => b.prCount - a.prCount || a.check.localeCompare(b.check));
}
